mod writer;
use writer::{run_worker, write_manifest};

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
const DURATION_SECONDS: u64 = 30 * 60;
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
mod tests;
