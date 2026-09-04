mod diagnostics;
use diagnostics::CaptureDiagnostics;
mod frame;
mod stream;
use frame::*;
use stream::run_pipewire;

use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    Session,
};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

#[cfg(debug_assertions)]
use super::debug_roi_collector::{
    DebugRoiSampleCollectionStatus, DebugRoiSampleCollector, SampledRoiPair, CAPTURE_ENDED,
    CAPTURE_REPLACED, SELECTION_CHANGED, SOURCE_MISMATCH,
};
use super::{LootCaptureSettings, NativeCaptureSelection};
#[cfg(test)]
use super::{NormalizedRegion, PixelRegion};

const FRAME_HEADER_BYTES: usize = 40;
const FRAME_PROTOCOL_VERSION: u32 = 3;
const FRAME_KIND_ERROR: u32 = 0;
const FRAME_KIND_PREVIEW: u32 = 1;
const FRAME_KIND_REGION: u32 = 2;
const FRAME_KIND_RARE_REGION: u32 = 3;
const FRAME_KIND_SEARCH_REGION: u32 = 4;
const MAX_PREVIEW_WIDTH: u32 = 640;
const MAX_PREVIEW_HEIGHT: u32 = 360;
const SAMPLE_INTERVAL: Duration = Duration::from_millis(125);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const FRAME_ACK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct BatchIdentity {
    capture_id: u32,
    batch_id: u32,
}

struct FrameHeader {
    kind: u32,
    batch: BatchIdentity,
    output_width: u32,
    output_height: u32,
    source_width: u32,
    source_height: u32,
    crop_x: u32,
    crop_y: u32,
}

#[derive(Default)]
pub(super) struct CaptureState {
    inner: Mutex<CaptureStateInner>,
    #[cfg(debug_assertions)]
    pub(super) debug_collector: Arc<DebugRoiSampleCollector>,
}

#[derive(Default)]
struct CaptureStateInner {
    capture: Option<Arc<CaptureControl>>,
    last_capture_id: u32,
    latest_capture_token: u64,
}

impl CaptureStateInner {
    fn next_capture_id(&mut self) -> Result<u32, String> {
        let capture_id = self
            .last_capture_id
            .checked_add(1)
            .ok_or_else(|| "Native display capture exhausted its capture IDs.".to_string())?;
        self.last_capture_id = capture_id;
        Ok(capture_id)
    }

    fn install_capture(
        &mut self,
        capture_token: u64,
        selection: Option<NativeCaptureSelection>,
    ) -> Result<(Arc<CaptureControl>, Option<Arc<CaptureControl>>), String> {
        if capture_token <= self.latest_capture_token {
            return Err("Native display capture request is no longer active.".to_string());
        }
        self.latest_capture_token = capture_token;
        let capture_id = self.next_capture_id()?;
        let control = Arc::new(CaptureControl::new(capture_id, capture_token, selection));
        let previous = self.capture.replace(control.clone());
        Ok((control, previous))
    }
}

struct CaptureControl {
    capture_id: u32,
    capture_token: u64,
    cancelled: AtomicBool,
    finished: AtomicBool,
    preview_enabled: AtomicBool,
    batches: Mutex<BatchState>,
    pending_session: Mutex<Option<Arc<Session<Screencast>>>>,
    selection: Mutex<Option<NativeCaptureSelection>>,
    #[cfg(debug_assertions)]
    healthy: AtomicBool,
    #[cfg(debug_assertions)]
    source_dimensions: Mutex<Option<(u32, u32)>>,
}

impl CaptureControl {
    fn new(capture_id: u32, capture_token: u64, selection: Option<NativeCaptureSelection>) -> Self {
        Self {
            capture_id,
            capture_token,
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            preview_enabled: AtomicBool::new(true),
            batches: Mutex::new(BatchState::default()),
            pending_session: Mutex::new(None),
            selection: Mutex::new(selection),
            #[cfg(debug_assertions)]
            healthy: AtomicBool::new(false),
            #[cfg(debug_assertions)]
            source_dimensions: Mutex::new(None),
        }
    }

    fn begin_batch(
        &self,
        selection: Option<NativeCaptureSelection>,
        preview_enabled: bool,
    ) -> Result<Option<(u32, bool)>, String> {
        let mut batches = self
            .batches
            .lock()
            .map_err(|_| "Capture batch state is unavailable.")?;
        if batches.pending.is_some() || (selection.is_none() && !preview_enabled) {
            return Ok(None);
        }
        let batch_id = batches
            .last_batch_id
            .checked_add(1)
            .ok_or_else(|| "Native display capture exhausted its batch IDs.".to_string())?;
        batches.last_batch_id = batch_id;
        let (search_pending, region_pending, rare_region_pending) = match selection {
            Some(NativeCaptureSelection::Search { .. }) => (true, false, false),
            Some(NativeCaptureSelection::Regions { settings }) => {
                (false, true, settings.rare_region.is_some())
            }
            None => (false, false, false),
        };
        let preview_pending = preview_enabled;
        batches.pending = Some(PendingBatch {
            batch_id,
            started_at: Instant::now(),
            preview_pending,
            search_pending,
            region_pending,
            rare_region_pending,
        });
        Ok(Some((batch_id, preview_pending)))
    }

    fn acknowledge(&self, capture_id: u32, batch_id: u32, kind: u32) {
        if capture_id != self.capture_id {
            return;
        }
        let Ok(mut batches) = self.batches.lock() else {
            return;
        };
        let Some(pending) = batches.pending.as_mut() else {
            return;
        };
        if pending.batch_id != batch_id {
            return;
        }
        match kind {
            FRAME_KIND_PREVIEW => pending.preview_pending = false,
            FRAME_KIND_REGION => pending.region_pending = false,
            FRAME_KIND_RARE_REGION => pending.rare_region_pending = false,
            FRAME_KIND_SEARCH_REGION => pending.search_pending = false,
            _ => return,
        }
        if !pending.preview_pending
            && !pending.search_pending
            && !pending.region_pending
            && !pending.rare_region_pending
        {
            batches.pending = None;
        }
    }

    fn clear_batch(&self, batch_id: u32) {
        if let Ok(mut batches) = self.batches.lock() {
            if batches
                .pending
                .as_ref()
                .is_some_and(|pending| pending.batch_id == batch_id)
            {
                batches.pending = None;
            }
        }
    }

    fn pending_batch_age(&self) -> Result<Option<Duration>, String> {
        let batches = self
            .batches
            .lock()
            .map_err(|_| "Capture batch state is unavailable.")?;
        Ok(batches
            .pending
            .as_ref()
            .map(|pending| pending.started_at.elapsed()))
    }
}

struct CaptureStartupGuard {
    control: Arc<CaptureControl>,
    worker_started: bool,
}

impl Drop for CaptureStartupGuard {
    fn drop(&mut self) {
        if !self.worker_started {
            self.control.finished.store(true, Ordering::Release);
        }
    }
}

#[derive(Default)]
struct BatchState {
    last_batch_id: u32,
    pending: Option<PendingBatch>,
}

struct PendingBatch {
    batch_id: u32,
    started_at: Instant,
    preview_pending: bool,
    search_pending: bool,
    region_pending: bool,
    rare_region_pending: bool,
}

struct StreamData {
    format: spa::param::video::VideoInfoRaw,
    next_sample: Option<Instant>,
    published_source_dimensions: Option<(u32, u32)>,
    diagnostics: Option<CaptureDiagnostics>,
}

struct SourceFrame<'a> {
    pixels: &'a [u8],
    width: u32,
    height: u32,
    stride: u32,
    format: spa::param::video::VideoFormat,
}

pub(super) async fn start(
    state: &CaptureState,
    frames: Channel<InvokeResponseBody>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    let (control, previous) = {
        let mut state = state
            .inner
            .lock()
            .map_err(|_| "Capture state is unavailable.")?;
        state.install_capture(capture_token, selection)?
    };
    if let Some(previous) = previous {
        #[cfg(debug_assertions)]
        state
            .debug_collector
            .finish_capture(previous.capture_id, CAPTURE_REPLACED);
        cancel(&previous);
    }
    let mut startup_guard = CaptureStartupGuard {
        control: control.clone(),
        worker_started: false,
    };

    let portal = Screencast::new().await.map_err(capture_error)?;
    let session = Arc::new(
        portal
            .create_session(Default::default())
            .await
            .map_err(capture_error)?,
    );
    *control
        .pending_session
        .lock()
        .map_err(|_| "Capture session state is unavailable.")? = Some(session.clone());
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }

    let select_request = portal
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Hidden)
                .set_sources(Some(SourceType::Monitor.into()))
                .set_multiple(false),
        )
        .await;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    select_request
        .map_err(|error| portal_error(&control, error))?
        .response()
        .map_err(|error| portal_error(&control, error))?;

    let start_request = portal.start(&session, None, Default::default()).await;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    let response = start_request
        .map_err(|error| portal_error(&control, error))?
        .response()
        .map_err(|error| portal_error(&control, error))?;
    let stream = response.streams().first().ok_or_else(|| {
        close_pending_session(&control);
        "The screen capture portal returned no monitor stream.".to_string()
    })?;
    let node_id = stream.pipe_wire_node_id();
    eprintln!(
            "Native display capture portal stream: node_id={node_id}, size={:?}, position={:?}, source_type={:?}",
            stream.size(),
            stream.position(),
            stream.source_type()
        );
    let fd = portal
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|error| portal_error(&control, error))?;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    // This backend exposes the selected node only after the portal proxies are released.
    control
        .pending_session
        .lock()
        .map_err(|_| "Capture session state is unavailable.")?
        .take();
    drop(session);
    drop(portal);

    let errors = frames.clone();
    let worker_control = control.clone();
    #[cfg(debug_assertions)]
    let debug_collector = state.debug_collector.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = run_pipewire(
            node_id,
            fd,
            frames,
            worker_control.clone(),
            #[cfg(debug_assertions)]
            debug_collector.clone(),
        );
        #[cfg(debug_assertions)]
        worker_control.healthy.store(false, Ordering::Release);
        worker_control.finished.store(true, Ordering::Release);
        #[cfg(debug_assertions)]
        debug_collector.finish_capture(worker_control.capture_id, CAPTURE_ENDED);
        if let Err(error) = result {
            eprintln!("Native display capture stopped: {error}");
            let _ = errors.send(InvokeResponseBody::Raw(error_frame(&error)));
        }
    });
    startup_guard.worker_started = true;
    Ok(())
}

pub(super) fn stop(state: &CaptureState, capture_token: u64) {
    let control = state.inner.lock().ok().and_then(|mut inner| {
        inner.latest_capture_token = inner.latest_capture_token.max(capture_token);
        if inner
            .capture
            .as_ref()
            .is_some_and(|control| control.capture_token == capture_token)
        {
            inner.capture.take()
        } else {
            None
        }
    });
    if let Some(control) = control {
        #[cfg(debug_assertions)]
        state
            .debug_collector
            .finish_capture(control.capture_id, CAPTURE_ENDED);
        cancel(&control);
    }
}

pub(super) fn acknowledge_frame(state: &CaptureState, capture_id: u32, batch_id: u32, kind: u32) {
    if let Ok(state) = state.inner.lock() {
        if let Some(control) = state.capture.as_ref() {
            control.acknowledge(capture_id, batch_id, kind);
        }
    }
}

pub(super) fn set_selection(
    state: &CaptureState,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Capture state is unavailable.")?;
    let control = inner
        .capture
        .as_ref()
        .ok_or_else(|| "Native display capture is not running.".to_string())?;
    if control.capture_token != capture_token {
        return Err("Native display capture request is no longer active.".to_string());
    }
    if control.cancelled.load(Ordering::Acquire) || control.finished.load(Ordering::Acquire) {
        return Err("Native display capture is not running.".to_string());
    }
    let mut current_selection = control
        .selection
        .lock()
        .map_err(|_| "Capture selection state is unavailable.")?;
    if *current_selection != selection {
        #[cfg(debug_assertions)]
        state
            .debug_collector
            .finish_capture(control.capture_id, SELECTION_CHANGED);
        *current_selection = selection;
    }
    Ok(())
}

pub(super) fn set_preview_enabled(
    state: &CaptureState,
    capture_token: u64,
    enabled: bool,
) -> Result<(), String> {
    let inner = state
        .inner
        .lock()
        .map_err(|_| "Capture state is unavailable.")?;
    let control = inner
        .capture
        .as_ref()
        .ok_or_else(|| "Native display capture is not running.".to_string())?;
    if control.capture_token != capture_token {
        return Err("Native display capture request is no longer active.".to_string());
    }
    if control.cancelled.load(Ordering::Acquire) || control.finished.load(Ordering::Acquire) {
        return Err("Native display capture is not running.".to_string());
    }
    control.preview_enabled.store(enabled, Ordering::Release);
    Ok(())
}

#[cfg(debug_assertions)]
pub(super) fn start_debug_roi_sample_collection(
    state: &CaptureState,
    capture_token: u64,
) -> Result<DebugRoiSampleCollectionStatus, String> {
    let control = state
        .inner
        .lock()
        .map_err(|_| "Capture state is unavailable.".to_string())?
        .capture
        .clone()
        .ok_or_else(|| "Native display capture is not running.".to_string())?;
    if control.capture_token != capture_token {
        return Err("Native display capture request is no longer active.".to_string());
    }
    if control.cancelled.load(Ordering::Acquire)
        || control.finished.load(Ordering::Acquire)
        || !control.healthy.load(Ordering::Acquire)
    {
        return Err("Native display capture is not healthy.".to_string());
    }
    let selection = *control
        .selection
        .lock()
        .map_err(|_| "Capture selection state is unavailable.".to_string())?;
    let NativeCaptureSelection::Regions { settings } = selection
        .ok_or_else(|| "Debug ROI collection requires an active regions selection.".to_string())?
    else {
        return Err("Debug ROI collection requires an active regions selection.".to_string());
    };
    if settings.rare_region.is_none() || !settings.rare_region_confirmed {
        return Err(
            "Debug ROI collection requires configured and confirmed normal and rare regions."
                .to_string(),
        );
    }
    let source_dimensions = *control
        .source_dimensions
        .lock()
        .map_err(|_| "Capture source state is unavailable.".to_string())?;
    if source_dimensions != Some((settings.source_width, settings.source_height)) {
        return Err(
            "Native display capture source does not match the regions selection.".to_string(),
        );
    }
    let pending = state.debug_collector.start(
        control.capture_id,
        capture_token,
        NativeCaptureSelection::Regions { settings },
        settings,
    )?;

    if let Err((reason, error)) = revalidate_debug_roi_capture(
        state,
        &control,
        NativeCaptureSelection::Regions { settings },
        source_dimensions,
    ) {
        let status = pending.abort(reason);
        return Err(format!(
            "Debug ROI sample collection stopped during startup: {error} Status: {:?}, finish reason: {:?}.",
            status.phase, status.finish_reason
        ));
    }

    Ok(pending.complete())
}

#[cfg(debug_assertions)]
fn revalidate_debug_roi_capture(
    state: &CaptureState,
    control: &Arc<CaptureControl>,
    expected_selection: NativeCaptureSelection,
    expected_source_dimensions: Option<(u32, u32)>,
) -> Result<(), (u8, String)> {
    let inner = state.inner.lock().map_err(|_| {
        (
            CAPTURE_ENDED,
            "capture state became unavailable".to_string(),
        )
    })?;
    if !inner
        .capture
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, control))
    {
        return Err((CAPTURE_REPLACED, "native capture was replaced".to_string()));
    }
    if control.cancelled.load(Ordering::Acquire)
        || control.finished.load(Ordering::Acquire)
        || !control.healthy.load(Ordering::Acquire)
    {
        return Err((
            CAPTURE_ENDED,
            "native capture is no longer healthy".to_string(),
        ));
    }
    let selection = *control.selection.lock().map_err(|_| {
        (
            SELECTION_CHANGED,
            "capture selection became unavailable".to_string(),
        )
    })?;
    if selection != Some(expected_selection) {
        return Err((SELECTION_CHANGED, "capture selection changed".to_string()));
    }
    let source_dimensions = *control.source_dimensions.lock().map_err(|_| {
        (
            SOURCE_MISMATCH,
            "capture source dimensions became unavailable".to_string(),
        )
    })?;
    if source_dimensions != expected_source_dimensions {
        return Err((
            SOURCE_MISMATCH,
            "capture source dimensions changed".to_string(),
        ));
    }
    Ok(())
}

fn cancel(control: &Arc<CaptureControl>) {
    control.cancelled.store(true, Ordering::Release);
    control.finished.store(true, Ordering::Release);
    close_pending_session(control);
}

fn close_pending_session(control: &Arc<CaptureControl>) {
    let session = control
        .pending_session
        .lock()
        .ok()
        .and_then(|mut session| session.take());
    if let Some(session) = session {
        tauri::async_runtime::spawn(async move {
            let _ = session.close().await;
        });
    }
}

fn portal_error(control: &Arc<CaptureControl>, error: impl std::fmt::Display) -> String {
    close_pending_session(control);
    capture_error(error)
}

fn capture_error(error: impl std::fmt::Display) -> String {
    format!("Native display capture failed: {error}")
}

#[cfg(test)]
mod tests;

fn sample_due(deadline: Option<Instant>, now: Instant) -> bool {
    deadline.is_none_or(|deadline| now + Duration::from_millis(3) >= deadline)
}

fn next_sample_deadline(previous: Option<Instant>, now: Instant) -> Instant {
    let next = previous
        .map(|deadline| deadline + SAMPLE_INTERVAL)
        .unwrap_or(now + SAMPLE_INTERVAL);
    if next <= now {
        now + SAMPLE_INTERVAL
    } else {
        next
    }
}
