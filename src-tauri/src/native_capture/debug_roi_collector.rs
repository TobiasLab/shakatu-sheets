use arc_swap::ArcSwapOption;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::{LootCaptureSettings, NativeCaptureSelection, NormalizedRegion, PixelRegion};

const TARGET_FPS: u32 = 8;
const DURATION_SECONDS: u64 = 300;
const QUEUE_CAPACITY: usize = 8;
const FRAMES_PER_MINUTE: u64 = TARGET_FPS as u64 * 60;
const PHASE_STARTING: u8 = 0;
const PHASE_RUNNING: u8 = 1;
const PHASE_FINISHED: u8 = 2;
const PHASE_FAILED: u8 = 3;
const PHASE_FINALIZING_BASE: u8 = 16;
const FINISH_NONE: u8 = 0;
const FINISH_DEADLINE: u8 = 1;
const FINISH_EXPLICIT: u8 = 2;
const FINISH_CAPTURE_ENDED: u8 = 3;
const FINISH_CAPTURE_REPLACED: u8 = 4;
const FINISH_SOURCE_MISMATCH: u8 = 5;
const FINISH_SELECTION_CHANGED: u8 = 6;
const FINISH_WRITE_FAILED: u8 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DebugRoiSampleCollectionPhase {
    Idle,
    Running,
    Finalizing,
    Finished,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRoiSampleCollectionStatus {
    pub phase: DebugRoiSampleCollectionPhase,
    pub path: Option<String>,
    pub accepted_batch_count: u64,
    pub dropped_batch_count: u64,
    pub written_batch_count: u64,
    pub bytes_written: u64,
    pub error: Option<String>,
    pub finish_reason: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub deadline_at_unix_ms: Option<u64>,
}

impl DebugRoiSampleCollectionStatus {
    fn idle() -> Self {
        Self {
            phase: DebugRoiSampleCollectionPhase::Idle,
            path: None,
            accepted_batch_count: 0,
            dropped_batch_count: 0,
            written_batch_count: 0,
            bytes_written: 0,
            error: None,
            finish_reason: None,
            started_at_unix_ms: None,
            deadline_at_unix_ms: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dimensions {
    width: u32,
    height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PixelGeometry {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

impl From<PixelRegion> for PixelGeometry {
    fn from(region: PixelRegion) -> Self {
        Self {
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CropGeometry {
    normalized: NormalizedRegion,
    pixels: PixelGeometry,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    source_dimensions: Dimensions,
    ui_scale_percent: u32,
    normal_crop: CropGeometry,
    rare_crop: CropGeometry,
    target_fps: u32,
    duration_seconds: u64,
    started_at_unix_ms: u64,
    deadline_at_unix_ms: u64,
    phase: DebugRoiSampleCollectionPhase,
    accepted_batch_count: u64,
    dropped_batch_count: u64,
    written_batch_count: u64,
    bytes_written: u64,
    finish_reason: Option<String>,
    errors: Vec<String>,
}

struct SamplePair {
    batch_id: u32,
    normal_rgba: Vec<u8>,
    rare_rgba: Vec<u8>,
}

pub(super) struct SampledRoiPair<'a> {
    pub capture_id: u32,
    pub selection: NativeCaptureSelection,
    pub source_width: u32,
    pub source_height: u32,
    pub batch_id: u32,
    pub normal_frame: &'a [u8],
    pub rare_frame: &'a [u8],
    pub payload_offset: usize,
}

struct RunOutcome {
    finish_reason: Option<String>,
    errors: Vec<String>,
}

struct Run {
    id: u64,
    capture_id: u32,
    capture_token: u64,
    selection: NativeCaptureSelection,
    settings: LootCaptureSettings,
    normal_pixels: PixelRegion,
    rare_pixels: PixelRegion,
    path: PathBuf,
    sender: SyncSender<SamplePair>,
    queue_capacity: u64,
    deadline: Instant,
    started_at_unix_ms: u64,
    deadline_at_unix_ms: u64,
    duration_seconds: u64,
    phase: AtomicU8,
    accepted: AtomicU64,
    dropped: AtomicU64,
    queued: AtomicU64,
    written: AtomicU64,
    bytes_written: AtomicU64,
    outcome: Mutex<RunOutcome>,
}

impl Run {
    fn request_finish(&self, reason: u8) {
        let reason = if Instant::now() >= self.deadline {
            FINISH_DEADLINE
        } else {
            reason
        };
        let target = finalizing_phase(reason);
        let mut current = self.phase.load(Ordering::Acquire);
        while matches!(current, PHASE_STARTING | PHASE_RUNNING) {
            match self.phase.compare_exchange_weak(
                current,
                target,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    fn activate(&self) {
        let _ = self.phase.compare_exchange(
            PHASE_STARTING,
            PHASE_RUNNING,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    fn admission_open(&self) -> bool {
        self.phase.load(Ordering::Acquire) == PHASE_RUNNING
    }

    fn requested_finish_reason(&self) -> Option<u8> {
        finish_reason_from_phase(self.phase.load(Ordering::Acquire))
    }

    fn snapshot(&self) -> DebugRoiSampleCollectionStatus {
        let outcome = self.outcome.lock().ok();
        let requested_reason = self.requested_finish_reason().and_then(finish_reason);
        DebugRoiSampleCollectionStatus {
            phase: phase(self.phase.load(Ordering::Acquire)),
            path: Some(self.path.to_string_lossy().into_owned()),
            accepted_batch_count: self.accepted.load(Ordering::Acquire),
            dropped_batch_count: self.dropped.load(Ordering::Acquire),
            written_batch_count: self.written.load(Ordering::Acquire),
            bytes_written: self.bytes_written.load(Ordering::Acquire),
            error: outcome
                .as_ref()
                .and_then(|outcome| outcome.errors.first().cloned()),
            finish_reason: outcome
                .as_ref()
                .and_then(|outcome| outcome.finish_reason.clone())
                .or_else(|| requested_reason.map(str::to_string)),
            started_at_unix_ms: Some(self.started_at_unix_ms),
            deadline_at_unix_ms: Some(self.deadline_at_unix_ms),
        }
    }

    fn manifest(&self, manifest_phase: DebugRoiSampleCollectionPhase) -> Manifest {
        let outcome = self.outcome.lock().expect("collector outcome poisoned");
        Manifest {
            version: 1,
            source_dimensions: Dimensions {
                width: self.settings.source_width,
                height: self.settings.source_height,
            },
            ui_scale_percent: self.settings.ui_scale_percent,
            normal_crop: CropGeometry {
                normalized: self.settings.region,
                pixels: self.normal_pixels.into(),
            },
            rare_crop: CropGeometry {
                normalized: self
                    .settings
                    .rare_region
                    .expect("collector runs require a rare region"),
                pixels: self.rare_pixels.into(),
            },
            target_fps: TARGET_FPS,
            duration_seconds: self.duration_seconds,
            started_at_unix_ms: self.started_at_unix_ms,
            deadline_at_unix_ms: self.deadline_at_unix_ms,
            phase: manifest_phase,
            accepted_batch_count: self.accepted.load(Ordering::Acquire),
            dropped_batch_count: self.dropped.load(Ordering::Acquire),
            written_batch_count: self.written.load(Ordering::Acquire),
            bytes_written: self.bytes_written.load(Ordering::Acquire),
            finish_reason: outcome.finish_reason.clone(),
            errors: outcome.errors.clone(),
        }
    }
}

pub(super) struct DebugRoiSampleCollector {
    active: ArcSwapOption<Run>,
    startup: ArcSwapOption<StartupBinding>,
    next_run_id: AtomicU64,
}

impl Default for DebugRoiSampleCollector {
    fn default() -> Self {
        Self {
            active: ArcSwapOption::empty(),
            startup: ArcSwapOption::empty(),
            next_run_id: AtomicU64::new(0),
        }
    }
}

struct StartupBinding {
    capture_id: u32,
    capture_token: u64,
    abort_reason: AtomicU8,
}

impl StartupBinding {
    fn request_abort(&self, reason: u8) {
        let _ = self.abort_reason.compare_exchange(
            FINISH_NONE,
            reason,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

struct StartReservation<'a> {
    collector: &'a DebugRoiSampleCollector,
    binding: Arc<StartupBinding>,
    active: bool,
}

impl StartReservation<'_> {
    fn install(&mut self, run: Arc<Run>) -> Result<(), String> {
        let startup = self.collector.startup.load_full();
        if !startup
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.binding))
        {
            return Err("Debug ROI collector startup reservation was lost.".to_string());
        }
        let reason = self.binding.abort_reason.load(Ordering::Acquire);
        if reason != FINISH_NONE {
            run.request_finish(reason);
        }
        self.collector.active.store(Some(run));
        Ok(())
    }

    fn release(mut self) {
        let expected = Some(self.binding.clone());
        let _ = self.collector.startup.compare_and_swap(&expected, None);
        self.active = false;
    }
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        if self.active {
            let expected = Some(self.binding.clone());
            let _ = self.collector.startup.compare_and_swap(&expected, None);
        }
    }
}

pub(super) struct PendingCollectionStart<'a> {
    run: Arc<Run>,
    reservation: StartReservation<'a>,
}

impl PendingCollectionStart<'_> {
    pub(super) fn complete(self) -> DebugRoiSampleCollectionStatus {
        let reason = self
            .reservation
            .binding
            .abort_reason
            .load(Ordering::Acquire);
        if reason != FINISH_NONE {
            self.run.request_finish(reason);
        }
        self.run.activate();
        let status = self.run.snapshot();
        self.reservation.release();
        status
    }

    pub(super) fn abort(self, reason: u8) -> DebugRoiSampleCollectionStatus {
        self.reservation.binding.request_abort(reason);
        self.run.request_finish(
            self.reservation
                .binding
                .abort_reason
                .load(Ordering::Acquire),
        );
        let status = self.run.snapshot();
        self.reservation.release();
        status
    }
}

#[derive(Clone, Copy)]
struct CollectionStart {
    monotonic: Instant,
    unix_ms: u64,
}

#[derive(Clone, Copy)]
struct CollectionBinding {
    capture_id: u32,
    capture_token: u64,
    selection: NativeCaptureSelection,
    settings: LootCaptureSettings,
}

impl DebugRoiSampleCollector {
    pub(super) fn start(
        &self,
        capture_id: u32,
        capture_token: u64,
        selection: NativeCaptureSelection,
        settings: LootCaptureSettings,
    ) -> Result<PendingCollectionStart<'_>, String> {
        let started = CollectionStart {
            monotonic: Instant::now(),
            unix_ms: unix_ms(SystemTime::now())?,
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "Rust manifest directory has no repository parent.".to_string())?
            .join("dev-samples/live-loot");
        self.start_pending_in_at(
            &root,
            CollectionBinding {
                capture_id,
                capture_token,
                selection,
                settings,
            },
            Duration::from_secs(DURATION_SECONDS),
            started,
        )
    }

    #[cfg(test)]
    fn start_in(
        &self,
        root: &Path,
        capture_id: u32,
        capture_token: u64,
        selection: NativeCaptureSelection,
        settings: LootCaptureSettings,
        duration: Duration,
    ) -> Result<DebugRoiSampleCollectionStatus, String> {
        let started = CollectionStart {
            monotonic: Instant::now(),
            unix_ms: unix_ms(SystemTime::now())?,
        };
        Ok(self
            .start_pending_in_at(
                root,
                CollectionBinding {
                    capture_id,
                    capture_token,
                    selection,
                    settings,
                },
                duration,
                started,
            )?
            .complete())
    }

    #[cfg(test)]
    fn start_in_at(
        &self,
        root: &Path,
        binding: CollectionBinding,
        duration: Duration,
        started: CollectionStart,
    ) -> Result<DebugRoiSampleCollectionStatus, String> {
        Ok(self
            .start_pending_in_at(root, binding, duration, started)?
            .complete())
    }

    fn start_pending_in_at(
        &self,
        root: &Path,
        binding: CollectionBinding,
        duration: Duration,
        started: CollectionStart,
    ) -> Result<PendingCollectionStart<'_>, String> {
        let mut reservation = self.reserve_start(binding)?;

        let normal_pixels = binding.settings.pixel_region()?;
        let rare_pixels = binding
            .settings
            .rare_pixel_region()?
            .ok_or_else(|| "Debug ROI collection requires a configured rare region.".to_string())?;
        let duration_ms = u64::try_from(duration.as_millis())
            .map_err(|_| "Debug ROI collection duration does not fit in 64 bits.".to_string())?;
        let deadline_at_unix_ms = started
            .unix_ms
            .checked_add(duration_ms)
            .ok_or_else(|| "Debug ROI collection deadline overflowed.".to_string())?;
        let id = self.next_run_id.fetch_add(1, Ordering::Relaxed) + 1;
        let path = root.join(format!(
            "run-{}-{}-{id:04}",
            started.unix_ms,
            std::process::id()
        ));
        fs::create_dir_all(root)
            .and_then(|_| fs::create_dir(&path))
            .and_then(|_| fs::create_dir(path.join("normal")))
            .and_then(|_| fs::create_dir(path.join("rare")))
            .map_err(|error| format!("Failed to create debug ROI sample directories: {error}"))?;

        let (sender, receiver) = mpsc::sync_channel(QUEUE_CAPACITY);
        let run = Arc::new(Run {
            id,
            capture_id: binding.capture_id,
            capture_token: binding.capture_token,
            selection: binding.selection,
            settings: binding.settings,
            normal_pixels,
            rare_pixels,
            path,
            sender,
            queue_capacity: QUEUE_CAPACITY as u64,
            deadline: started.monotonic + duration,
            started_at_unix_ms: started.unix_ms,
            deadline_at_unix_ms,
            duration_seconds: duration.as_secs(),
            phase: AtomicU8::new(PHASE_STARTING),
            accepted: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            written: AtomicU64::new(0),
            bytes_written: AtomicU64::new(0),
            outcome: Mutex::new(RunOutcome {
                finish_reason: None,
                errors: Vec::new(),
            }),
        });
        if let Err(error) = write_manifest(&run) {
            return match fs::remove_dir_all(&run.path) {
                Ok(()) => Err(error),
                Err(cleanup_error) => Err(format!(
                    "{error} Failed to clean up the incomplete debug ROI run: {cleanup_error}"
                )),
            };
        }
        reservation.install(run.clone())?;

        let worker_run = run.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("debug-roi-png-{}", run.id))
            .spawn(move || run_worker(worker_run, receiver))
        {
            fail_run(
                &run,
                format!("Failed to start debug ROI encoder thread: {error}"),
            );
            let _ = write_manifest(&run);
        }
        Ok(PendingCollectionStart { run, reservation })
    }

    fn reserve_start(&self, binding: CollectionBinding) -> Result<StartReservation<'_>, String> {
        let startup = Arc::new(StartupBinding {
            capture_id: binding.capture_id,
            capture_token: binding.capture_token,
            abort_reason: AtomicU8::new(FINISH_NONE),
        });
        let empty: Option<Arc<StartupBinding>> = None;
        let previous = self.startup.compare_and_swap(&empty, Some(startup.clone()));
        if previous.is_some() {
            return Err("A debug ROI sample collection is already active.".to_string());
        }

        let reservation = StartReservation {
            collector: self,
            binding: startup,
            active: true,
        };
        if self
            .active
            .load_full()
            .as_ref()
            .is_some_and(|run| run_is_active(run.phase.load(Ordering::Acquire)))
        {
            return Err("A debug ROI sample collection is already active.".to_string());
        }
        Ok(reservation)
    }

    fn current_run(&self) -> Option<Arc<Run>> {
        self.active.load_full()
    }

    pub(super) fn stop(
        &self,
        capture_token: u64,
    ) -> Result<DebugRoiSampleCollectionStatus, String> {
        let startup = self.startup.load_full();
        if let Some(startup) = startup.as_ref() {
            if startup.capture_token == capture_token {
                startup.request_abort(FINISH_EXPLICIT);
            }
        }
        if let Some(run) = self.current_run() {
            if run.capture_token == capture_token {
                run.request_finish(FINISH_EXPLICIT);
            }
            Ok(run.snapshot())
        } else {
            Ok(DebugRoiSampleCollectionStatus::idle())
        }
    }

    pub(super) fn status(&self) -> DebugRoiSampleCollectionStatus {
        self.current_run()
            .map(|run| run.snapshot())
            .unwrap_or_else(DebugRoiSampleCollectionStatus::idle)
    }

    pub(super) fn finish_capture(&self, capture_id: u32, reason: u8) {
        let startup = self.startup.load_full();
        if let Some(startup) = startup.as_ref() {
            if startup.capture_id == capture_id {
                startup.request_abort(reason);
            }
        }
        if let Some(run) = self.current_run() {
            if run.capture_id == capture_id {
                run.request_finish(reason);
            }
        }
    }

    pub(super) fn enqueue_pair(&self, sample: SampledRoiPair<'_>) {
        let Some(run) = self.current_run() else {
            return;
        };
        if run.capture_id != sample.capture_id || !run.admission_open() {
            return;
        }
        if run.deadline <= Instant::now() {
            run.request_finish(FINISH_DEADLINE);
            return;
        }
        if run.selection != sample.selection
            || (sample.source_width, sample.source_height)
                != (run.settings.source_width, run.settings.source_height)
        {
            run.request_finish(FINISH_SOURCE_MISMATCH);
            return;
        }
        if !reserve_queue_slot(&run) {
            run.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if !run.admission_open() {
            run.queued.fetch_sub(1, Ordering::AcqRel);
            return;
        }
        let Some(normal_rgba) = sample.normal_frame.get(sample.payload_offset..) else {
            run.queued.fetch_sub(1, Ordering::AcqRel);
            run.request_finish(FINISH_SOURCE_MISMATCH);
            return;
        };
        let Some(rare_rgba) = sample.rare_frame.get(sample.payload_offset..) else {
            run.queued.fetch_sub(1, Ordering::AcqRel);
            run.request_finish(FINISH_SOURCE_MISMATCH);
            return;
        };
        let pair = SamplePair {
            batch_id: sample.batch_id,
            normal_rgba: normal_rgba.to_vec(),
            rare_rgba: rare_rgba.to_vec(),
        };
        send_reserved_pair(&run, pair);
    }
}

#[cfg(test)]
fn enqueue_to_run(run: &Run, pair: SamplePair) {
    if !reserve_queue_slot(run) {
        run.dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    send_reserved_pair(run, pair);
}

fn reserve_queue_slot(run: &Run) -> bool {
    run.queued
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
            (queued < run.queue_capacity).then_some(queued + 1)
        })
        .is_ok()
}

fn send_reserved_pair(run: &Run, pair: SamplePair) {
    // Publish acceptance before send so a receiving worker cannot finalize stale counters.
    run.accepted.fetch_add(1, Ordering::Release);
    match run.sender.try_send(pair) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            run.accepted.fetch_sub(1, Ordering::AcqRel);
            run.queued.fetch_sub(1, Ordering::AcqRel);
            run.dropped.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {
            run.accepted.fetch_sub(1, Ordering::AcqRel);
            run.queued.fetch_sub(1, Ordering::AcqRel);
            run.request_finish(FINISH_CAPTURE_ENDED);
        }
    }
}

fn run_worker(run: Arc<Run>, receiver: Receiver<SamplePair>) {
    let mut failure = false;
    loop {
        let lifecycle = run.phase.load(Ordering::Acquire);
        if lifecycle == PHASE_STARTING {
            if Instant::now() >= run.deadline {
                run.request_finish(FINISH_DEADLINE);
            } else {
                thread::sleep(Duration::from_millis(10));
            }
            continue;
        }
        if lifecycle != PHASE_RUNNING {
            break;
        }
        let now = Instant::now();
        if now >= run.deadline {
            run.request_finish(FINISH_DEADLINE);
            break;
        }
        let wait = (run.deadline - now).min(Duration::from_millis(50));
        match receiver.recv_timeout(wait) {
            Ok(pair) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
                if let Err(error) = write_pair(&run, &pair) {
                    record_write_failure(&run, error);
                    failure = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                run.request_finish(FINISH_CAPTURE_ENDED);
                break;
            }
        }
    }

    while !failure && run.queued.load(Ordering::Acquire) != 0 {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(pair) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
                if let Err(error) = write_pair(&run, &pair) {
                    record_write_failure(&run, error);
                    failure = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                record_write_failure(
                    &run,
                    "Debug ROI encoder queue disconnected while draining.".to_string(),
                );
                failure = true;
            }
        }
    }
    if failure {
        discard_queued_pairs(&run, &receiver);
    }
    let terminal_phase = if failure {
        DebugRoiSampleCollectionPhase::Failed
    } else {
        let reason = run
            .requested_finish_reason()
            .and_then(finish_reason)
            .unwrap_or("captureEnded")
            .to_string();
        if let Ok(mut outcome) = run.outcome.lock() {
            outcome.finish_reason = Some(reason);
        }
        DebugRoiSampleCollectionPhase::Finished
    };
    if let Err(error) = write_manifest_for_phase(&run, terminal_phase) {
        fail_run(
            &run,
            format!("Failed to finalize debug ROI manifest: {error}"),
        );
        let _ = write_manifest(&run);
    } else {
        run.phase.store(
            match terminal_phase {
                DebugRoiSampleCollectionPhase::Finished => PHASE_FINISHED,
                DebugRoiSampleCollectionPhase::Failed => PHASE_FAILED,
                _ => unreachable!("worker terminal phase must be finished or failed"),
            },
            Ordering::Release,
        );
    }
}

fn record_write_failure(run: &Run, error: String) {
    run.request_finish(FINISH_WRITE_FAILED);
    if let Ok(mut outcome) = run.outcome.lock() {
        outcome.finish_reason = Some("writeFailed".to_string());
        outcome.errors.push(error);
    }
}

fn discard_queued_pairs(run: &Run, receiver: &Receiver<SamplePair>) {
    while run.queued.load(Ordering::Acquire) != 0 {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(_) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                run.queued.store(0, Ordering::Release);
            }
        }
    }
}

fn write_pair(run: &Run, pair: &SamplePair) -> Result<(), String> {
    let sequence = run.written.load(Ordering::Acquire) + 1;
    let minute = (sequence - 1) / FRAMES_PER_MINUTE + 1;
    let normal_dir = run.path.join("normal").join(format!("minute-{minute:02}"));
    let rare_dir = run.path.join("rare").join(format!("minute-{minute:02}"));
    fs::create_dir_all(&normal_dir)
        .and_then(|_| fs::create_dir_all(&rare_dir))
        .map_err(|error| format!("Failed to create debug ROI minute directories: {error}"))?;

    let file_name = format!("frame-{:010}.png", pair.batch_id);
    let normal_path = normal_dir.join(&file_name);
    let rare_path = rare_dir.join(&file_name);
    let normal_temp = normal_dir.join(format!(".{file_name}.tmp"));
    let rare_temp = rare_dir.join(format!(".{file_name}.tmp"));
    let result = (|| {
        write_png(
            &normal_temp,
            run.normal_pixels.width,
            run.normal_pixels.height,
            &pair.normal_rgba,
        )?;
        write_png(
            &rare_temp,
            run.rare_pixels.width,
            run.rare_pixels.height,
            &pair.rare_rgba,
        )?;
        fs::rename(&normal_temp, &normal_path)
            .map_err(|error| format!("Failed to commit normal debug ROI PNG: {error}"))?;
        if let Err(error) = fs::rename(&rare_temp, &rare_path) {
            let _ = fs::remove_file(&normal_path);
            return Err(format!("Failed to commit rare debug ROI PNG: {error}"));
        }
        let bytes = fs::metadata(&normal_path)
            .and_then(|normal| fs::metadata(&rare_path).map(|rare| normal.len() + rare.len()))
            .map_err(|error| format!("Failed to measure debug ROI PNG pair: {error}"))?;
        run.written.fetch_add(1, Ordering::Relaxed);
        run.bytes_written.fetch_add(bytes, Ordering::Relaxed);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(normal_temp);
        let _ = fs::remove_file(rare_temp);
        let _ = fs::remove_file(normal_path);
        let _ = fs::remove_file(rare_path);
    }
    result
}

fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Debug ROI PNG dimensions overflowed.".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "Debug ROI PNG payload has {} bytes; expected {expected}.",
            rgba.len()
        ));
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Failed to create debug ROI PNG: {error}"))?;
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fastest);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("Failed to write debug ROI PNG header: {error}"))?;
    writer
        .write_image_data(rgba)
        .map_err(|error| format!("Failed to encode debug ROI PNG: {error}"))?;
    writer
        .finish()
        .map_err(|error| format!("Failed to finish debug ROI PNG: {error}"))
}

fn write_manifest(run: &Run) -> Result<(), String> {
    write_manifest_for_phase(run, phase(run.phase.load(Ordering::Acquire)))
}

fn write_manifest_for_phase(
    run: &Run,
    manifest_phase: DebugRoiSampleCollectionPhase,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&run.manifest(manifest_phase))
        .map_err(|error| format!("Failed to serialize debug ROI manifest: {error}"))?;
    atomic_write(&run.path.join("manifest.json"), &bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let result = (|| {
        let mut file = File::create(&temp)
            .map_err(|error| format!("Failed to create temporary manifest: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to write temporary manifest: {error}"))?;
        fs::rename(&temp, path)
            .map_err(|error| format!("Failed to commit debug ROI manifest: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn fail_run(run: &Run, error: String) {
    if let Ok(mut outcome) = run.outcome.lock() {
        outcome.finish_reason = Some("writeFailed".to_string());
        outcome.errors.push(error);
    }
    run.phase.store(PHASE_FAILED, Ordering::Release);
}

fn unix_ms(time: SystemTime) -> Result<u64, String> {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System time is before the Unix epoch.".to_string())?
        .as_millis();
    u64::try_from(millis).map_err(|_| "Unix timestamp does not fit in 64 bits.".to_string())
}

fn phase(value: u8) -> DebugRoiSampleCollectionPhase {
    match value {
        PHASE_STARTING | PHASE_RUNNING => DebugRoiSampleCollectionPhase::Running,
        PHASE_FINISHED => DebugRoiSampleCollectionPhase::Finished,
        PHASE_FAILED => DebugRoiSampleCollectionPhase::Failed,
        _ if finish_reason_from_phase(value).is_some() => DebugRoiSampleCollectionPhase::Finalizing,
        _ => DebugRoiSampleCollectionPhase::Idle,
    }
}

fn finalizing_phase(reason: u8) -> u8 {
    PHASE_FINALIZING_BASE + reason
}

fn finish_reason_from_phase(value: u8) -> Option<u8> {
    value
        .checked_sub(PHASE_FINALIZING_BASE)
        .filter(|reason| (1..=FINISH_WRITE_FAILED).contains(reason))
}

fn run_is_active(value: u8) -> bool {
    matches!(value, PHASE_STARTING | PHASE_RUNNING) || finish_reason_from_phase(value).is_some()
}

fn finish_reason(value: u8) -> Option<&'static str> {
    match value {
        FINISH_DEADLINE => Some("deadlineReached"),
        FINISH_EXPLICIT => Some("explicitlyStopped"),
        FINISH_CAPTURE_ENDED => Some("captureEnded"),
        FINISH_CAPTURE_REPLACED => Some("captureReplaced"),
        FINISH_SOURCE_MISMATCH => Some("sourceMismatch"),
        FINISH_SELECTION_CHANGED => Some("selectionChanged"),
        FINISH_WRITE_FAILED => Some("writeFailed"),
        _ => None,
    }
}

pub(super) const CAPTURE_ENDED: u8 = FINISH_CAPTURE_ENDED;
pub(super) const CAPTURE_REPLACED: u8 = FINISH_CAPTURE_REPLACED;
pub(super) const SOURCE_MISMATCH: u8 = FINISH_SOURCE_MISMATCH;
pub(super) const SELECTION_CHANGED: u8 = FINISH_SELECTION_CHANGED;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Barrier;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "shakatu-roi-{name}-{}-{}",
                std::process::id(),
                unix_ms(SystemTime::now()).unwrap()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn settings() -> LootCaptureSettings {
        LootCaptureSettings {
            region: NormalizedRegion {
                x: 10.0 / 1920.0,
                y: 20.0 / 1080.0,
                width: 362.0 / 1920.0,
                height: 311.0 / 1080.0,
            },
            rare_region: Some(NormalizedRegion {
                x: 500.0 / 1920.0,
                y: 600.0 / 1080.0,
                width: 400.0 / 1920.0,
                height: 100.0 / 1080.0,
            }),
            rare_region_confirmed: true,
            source_width: 1920,
            source_height: 1080,
            ui_scale_percent: 80,
        }
    }

    fn wait_for(
        collector: &DebugRoiSampleCollector,
        predicate: impl Fn(&DebugRoiSampleCollectionStatus) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = collector.status();
            if predicate(&status) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for collector: {status:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn writes_valid_paired_pngs_and_final_manifest() {
        let temp = TempDir::new("paired");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let selection = NativeCaptureSelection::Regions { settings };
        collector
            .start_in(&temp.0, 4, 9, selection, settings, Duration::from_secs(30))
            .unwrap();
        let normal = vec![17; 362 * 311 * 4];
        let rare = vec![23; 400 * 100 * 4];
        collector.enqueue_pair(SampledRoiPair {
            capture_id: 4,
            selection,
            source_width: 1920,
            source_height: 1080,
            batch_id: 37,
            normal_frame: &normal,
            rare_frame: &rare,
            payload_offset: 0,
        });
        wait_for(&collector, |status| status.written_batch_count == 1);
        collector.stop(9).unwrap();
        wait_for(&collector, |status| {
            status.phase == DebugRoiSampleCollectionPhase::Finished
        });

        let run_path = PathBuf::from(collector.status().path.unwrap());
        let normal_path = run_path.join("normal/minute-01/frame-0000000037.png");
        let rare_path = run_path.join("rare/minute-01/frame-0000000037.png");
        for (path, dimensions) in [(normal_path, (362, 311)), (rare_path, (400, 100))] {
            let bytes = fs::read(path).unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(
                u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
                dimensions.0
            );
            assert_eq!(
                u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
                dimensions.1
            );
        }
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(run_path.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["version"], 1);
        assert_eq!(manifest["phase"], "finished");
        assert_eq!(manifest["writtenBatchCount"], 1);
        assert_eq!(manifest["finishReason"], "explicitlyStopped");
        assert_eq!(manifest["normalCrop"]["pixels"]["width"], 362);
        assert_eq!(manifest["rareCrop"]["pixels"]["width"], 400);
    }

    #[test]
    fn explicit_stop_writes_an_already_accepted_pair() {
        let temp = TempDir::new("drain");
        let settings = settings();
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        enqueue_to_run(
            &run,
            SamplePair {
                batch_id: 41,
                normal_rgba: vec![17; 362 * 311 * 4],
                rare_rgba: vec![23; 400 * 100 * 4],
            },
        );
        run.request_finish(FINISH_EXPLICIT);

        run_worker(run.clone(), receiver);

        let status = run.snapshot();
        assert_eq!(status.phase, DebugRoiSampleCollectionPhase::Finished);
        assert_eq!(status.accepted_batch_count, 1);
        assert_eq!(status.written_batch_count, 1);
        assert_eq!(status.dropped_batch_count, 0);
        assert!(temp
            .0
            .join("normal/minute-01/frame-0000000041.png")
            .is_file());
        assert!(temp.0.join("rare/minute-01/frame-0000000041.png").is_file());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.0.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["version"], 1);
        assert_eq!(manifest["acceptedBatchCount"], 1);
        assert_eq!(manifest["writtenBatchCount"], 1);
        assert_eq!(manifest["finishReason"], "explicitlyStopped");
    }

    #[test]
    fn bounded_queue_drops_whole_pairs() {
        let temp = TempDir::new("bounded");
        let settings = settings();
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = test_run(&temp.0, sender, settings);
        enqueue_to_run(
            &run,
            SamplePair {
                batch_id: 1,
                normal_rgba: vec![1],
                rare_rgba: vec![2],
            },
        );
        enqueue_to_run(
            &run,
            SamplePair {
                batch_id: 2,
                normal_rgba: vec![3],
                rare_rgba: vec![4],
            },
        );

        assert_eq!(run.accepted.load(Ordering::Acquire), 1);
        assert_eq!(run.dropped.load(Ordering::Acquire), 1);
        let pair = receiver.try_recv().unwrap();
        assert_eq!(pair.batch_id, 1);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn stop_is_capture_token_scoped_and_idempotent() {
        let temp = TempDir::new("stop");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let (sender, _receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        collector.active.store(Some(run.clone()));

        assert_eq!(
            collector.stop(8).unwrap().phase,
            DebugRoiSampleCollectionPhase::Running
        );
        assert_eq!(run.requested_finish_reason(), None);
        assert_eq!(
            collector.stop(9).unwrap().phase,
            DebugRoiSampleCollectionPhase::Finalizing
        );
        assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
        collector.finish_capture(4, FINISH_CAPTURE_REPLACED);
        assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
        collector.finish_capture(3, FINISH_CAPTURE_ENDED);
        assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
    }

    #[test]
    fn writer_failure_closes_admission_before_queue_cleanup() {
        let temp = TempDir::new("writer-failure");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let selection = NativeCaptureSelection::Regions { settings };
        let (sender, _receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        collector.active.store(Some(run.clone()));

        record_write_failure(&run, "PNG encoding failed".to_string());
        collector.enqueue_pair(SampledRoiPair {
            capture_id: 4,
            selection,
            source_width: 1920,
            source_height: 1080,
            batch_id: 42,
            normal_frame: &[],
            rare_frame: &[],
            payload_offset: 0,
        });

        let status = collector.status();
        assert_eq!(status.phase, DebugRoiSampleCollectionPhase::Finalizing);
        assert_eq!(status.finish_reason.as_deref(), Some("writeFailed"));
        assert_eq!(status.error.as_deref(), Some("PNG encoding failed"));
        assert_eq!(status.accepted_batch_count, 0);
        assert_eq!(status.dropped_batch_count, 0);
        assert_eq!(run.queued.load(Ordering::Acquire), 0);
    }

    #[test]
    fn failure_cleanup_waits_for_an_in_flight_accepted_pair() {
        let temp = TempDir::new("failure-in-flight");
        let settings = settings();
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        assert!(reserve_queue_slot(&run));
        record_write_failure(&run, "PNG encoding failed".to_string());

        let producer_run = run.clone();
        let producer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            send_reserved_pair(
                &producer_run,
                SamplePair {
                    batch_id: 43,
                    normal_rgba: vec![1],
                    rare_rgba: vec![2],
                },
            );
        });
        discard_queued_pairs(&run, &receiver);
        producer.join().unwrap();

        assert_eq!(run.accepted.load(Ordering::Acquire), 1);
        assert_eq!(run.written.load(Ordering::Acquire), 0);
        assert_eq!(run.dropped.load(Ordering::Acquire), 0);
        assert_eq!(run.queued.load(Ordering::Acquire), 0);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn startup_reservation_rejects_overlap_and_clears_on_drop() {
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let binding = CollectionBinding {
            capture_id: 4,
            capture_token: 9,
            selection: NativeCaptureSelection::Regions { settings },
            settings,
        };
        let first = collector.reserve_start(binding).unwrap();

        assert!(collector.reserve_start(binding).is_err());
        assert!(collector.startup.load_full().is_some());
        drop(first);

        assert!(collector.startup.load_full().is_none());
        drop(collector.reserve_start(binding).unwrap());
    }

    #[test]
    fn installed_run_keeps_startup_reserved_until_revalidation_completes() {
        let temp = TempDir::new("pending-start");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let pending = collector
            .start_pending_in_at(
                &temp.0,
                CollectionBinding {
                    capture_id: 4,
                    capture_token: 9,
                    selection: NativeCaptureSelection::Regions { settings },
                    settings,
                },
                Duration::from_secs(30),
                CollectionStart {
                    monotonic: Instant::now(),
                    unix_ms: unix_ms(SystemTime::now()).unwrap(),
                },
            )
            .unwrap();

        assert!(collector
            .reserve_start(CollectionBinding {
                capture_id: 4,
                capture_token: 9,
                selection: NativeCaptureSelection::Regions { settings },
                settings,
            })
            .is_err());
        assert!(collector.active.load_full().is_some());
        let status = pending.abort(FINISH_CAPTURE_REPLACED);
        assert!(matches!(
            status.phase,
            DebugRoiSampleCollectionPhase::Finalizing | DebugRoiSampleCollectionPhase::Finished
        ));
        assert!(collector.startup.load_full().is_none());
        wait_for(&collector, |status| {
            status.phase == DebugRoiSampleCollectionPhase::Finished
        });
    }

    #[test]
    fn preinstall_lifecycle_event_aborts_the_installed_run() {
        let temp = TempDir::new("preinstall-abort");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let binding = CollectionBinding {
            capture_id: 4,
            capture_token: 9,
            selection: NativeCaptureSelection::Regions { settings },
            settings,
        };
        let mut reservation = collector.reserve_start(binding).unwrap();
        collector.finish_capture(4, FINISH_SELECTION_CHANGED);
        let (sender, _receiver) = mpsc::sync_channel(1);
        let mut starting_run = test_run(&temp.0, sender, settings);
        starting_run.phase = AtomicU8::new(PHASE_STARTING);
        let run = Arc::new(starting_run);

        reservation.install(run.clone()).unwrap();
        collector.enqueue_pair(SampledRoiPair {
            capture_id: 4,
            selection: binding.selection,
            source_width: 1920,
            source_height: 1080,
            batch_id: 47,
            normal_frame: &[1],
            rare_frame: &[2],
            payload_offset: 0,
        });

        assert_eq!(
            reservation.binding.abort_reason.load(Ordering::Acquire),
            FINISH_SELECTION_CHANGED
        );
        assert_eq!(
            run.requested_finish_reason(),
            Some(FINISH_SELECTION_CHANGED)
        );
        assert_eq!(
            phase(run.phase.load(Ordering::Acquire)),
            DebugRoiSampleCollectionPhase::Finalizing
        );
        assert_eq!(run.accepted.load(Ordering::Acquire), 0);
        assert_eq!(run.queued.load(Ordering::Acquire), 0);
        reservation.release();
    }

    #[test]
    fn explicit_stop_is_recorded_during_startup() {
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let reservation = collector
            .reserve_start(CollectionBinding {
                capture_id: 4,
                capture_token: 9,
                selection: NativeCaptureSelection::Regions { settings },
                settings,
            })
            .unwrap();

        assert_eq!(
            collector.stop(9).unwrap(),
            DebugRoiSampleCollectionStatus::idle()
        );
        assert_eq!(
            reservation.binding.abort_reason.load(Ordering::Acquire),
            FINISH_EXPLICIT
        );
    }

    #[test]
    fn setup_time_consumes_the_collection_deadline() {
        let temp = TempDir::new("deadline");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let started_at_unix_ms = unix_ms(SystemTime::now()).unwrap().saturating_sub(2_000);
        let status = collector
            .start_in_at(
                &temp.0,
                CollectionBinding {
                    capture_id: 4,
                    capture_token: 9,
                    selection: NativeCaptureSelection::Regions { settings },
                    settings,
                },
                Duration::from_secs(1),
                CollectionStart {
                    monotonic: Instant::now().checked_sub(Duration::from_secs(2)).unwrap(),
                    unix_ms: started_at_unix_ms,
                },
            )
            .unwrap();

        assert_eq!(status.started_at_unix_ms, Some(started_at_unix_ms));
        assert_eq!(status.deadline_at_unix_ms, Some(started_at_unix_ms + 1_000));
        wait_for(&collector, |status| {
            status.phase == DebugRoiSampleCollectionPhase::Finished
        });
        assert_eq!(
            collector.status().finish_reason.as_deref(),
            Some("deadlineReached")
        );
    }

    #[test]
    fn sample_uses_the_lock_free_active_run_snapshot() {
        let temp = TempDir::new("active-snapshot");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let selection = NativeCaptureSelection::Regions { settings };
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        collector.active.store(Some(run.clone()));
        collector.enqueue_pair(SampledRoiPair {
            capture_id: 4,
            selection,
            source_width: 1920,
            source_height: 1080,
            batch_id: 44,
            normal_frame: &[1],
            rare_frame: &[2],
            payload_offset: 0,
        });

        assert_eq!(run.accepted.load(Ordering::Acquire), 1);
        assert_eq!(run.dropped.load(Ordering::Acquire), 0);
        assert_eq!(receiver.try_recv().unwrap().batch_id, 44);
    }

    #[test]
    fn finish_transition_cannot_be_overwritten_by_startup_activation() {
        let temp = TempDir::new("finish-admission");
        let collector = DebugRoiSampleCollector::default();
        let settings = settings();
        let selection = NativeCaptureSelection::Regions { settings };
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        run.phase.store(PHASE_STARTING, Ordering::Release);
        let barrier = Arc::new(Barrier::new(3));
        thread::scope(|scope| {
            let activation_run = run.clone();
            let activation_barrier = barrier.clone();
            scope.spawn(move || {
                activation_barrier.wait();
                activation_run.activate();
            });
            let finish_run = run.clone();
            let finish_barrier = barrier.clone();
            scope.spawn(move || {
                finish_barrier.wait();
                finish_run.request_finish(FINISH_EXPLICIT);
            });
            barrier.wait();
        });
        collector.active.store(Some(run.clone()));

        collector.enqueue_pair(SampledRoiPair {
            capture_id: 4,
            selection,
            source_width: 1920,
            source_height: 1080,
            batch_id: 45,
            normal_frame: &[1],
            rare_frame: &[2],
            payload_offset: 0,
        });

        assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
        assert_eq!(run.accepted.load(Ordering::Acquire), 0);
        assert_eq!(run.queued.load(Ordering::Acquire), 0);
        assert!(matches!(
            receiver.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
    }

    #[test]
    fn producer_reserved_before_finish_is_accepted_and_drained() {
        let temp = TempDir::new("finish-reservation");
        let settings = settings();
        let (sender, receiver) = mpsc::sync_channel(1);
        let run = Arc::new(test_run(&temp.0, sender, settings));
        assert!(run.admission_open());
        assert!(reserve_queue_slot(&run));
        assert!(run.admission_open());
        run.request_finish(FINISH_EXPLICIT);

        send_reserved_pair(
            &run,
            SamplePair {
                batch_id: 46,
                normal_rgba: vec![17; 362 * 311 * 4],
                rare_rgba: vec![23; 400 * 100 * 4],
            },
        );
        run_worker(run.clone(), receiver);

        let status = run.snapshot();
        assert_eq!(status.accepted_batch_count, 1);
        assert_eq!(status.written_batch_count, 1);
        assert_eq!(status.dropped_batch_count, 0);
        assert_eq!(status.finish_reason.as_deref(), Some("explicitlyStopped"));
    }

    #[test]
    fn elapsed_deadline_wins_over_later_lifecycle_stop() {
        let temp = TempDir::new("deadline-reason");
        let settings = settings();
        let (sender, _receiver) = mpsc::sync_channel(1);
        let mut run = test_run(&temp.0, sender, settings);
        run.deadline = Instant::now()
            .checked_sub(Duration::from_millis(1))
            .unwrap();

        run.request_finish(FINISH_CAPTURE_ENDED);

        assert_eq!(run.requested_finish_reason(), Some(FINISH_DEADLINE));
        assert_eq!(
            run.snapshot().finish_reason.as_deref(),
            Some("deadlineReached")
        );
    }

    #[test]
    fn status_serialization_is_camel_case() {
        let value = serde_json::to_value(DebugRoiSampleCollectionStatus {
            phase: DebugRoiSampleCollectionPhase::Running,
            path: Some("sample".to_string()),
            accepted_batch_count: 2,
            dropped_batch_count: 3,
            written_batch_count: 1,
            bytes_written: 99,
            error: None,
            finish_reason: None,
            started_at_unix_ms: Some(10),
            deadline_at_unix_ms: Some(20),
        })
        .unwrap();

        assert_eq!(value["phase"], "running");
        assert_eq!(value["acceptedBatchCount"], 2);
        assert_eq!(value["bytesWritten"], 99);
        assert_eq!(value["startedAtUnixMs"], 10);
        assert!(value.get("accepted_batch_count").is_none());
    }

    fn test_run(path: &Path, sender: SyncSender<SamplePair>, settings: LootCaptureSettings) -> Run {
        Run {
            id: 1,
            capture_id: 4,
            capture_token: 9,
            selection: NativeCaptureSelection::Regions { settings },
            settings,
            normal_pixels: settings.pixel_region().unwrap(),
            rare_pixels: settings.rare_pixel_region().unwrap().unwrap(),
            path: path.to_path_buf(),
            sender,
            queue_capacity: 1,
            deadline: Instant::now() + Duration::from_secs(30),
            started_at_unix_ms: 1,
            deadline_at_unix_ms: 301_000,
            duration_seconds: 300,
            phase: AtomicU8::new(PHASE_RUNNING),
            accepted: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            queued: AtomicU64::new(0),
            written: AtomicU64::new(0),
            bytes_written: AtomicU64::new(0),
            outcome: Mutex::new(RunOutcome {
                finish_reason: None,
                errors: Vec::new(),
            }),
        }
    }
}
