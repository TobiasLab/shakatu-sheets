#[cfg(debug_assertions)]
use super::debug_roi_collector::{
    DebugRoiSampleCollectionStatus, DebugRoiSampleCollector, CAPTURE_ENDED, CAPTURE_REPLACED,
    SELECTION_CHANGED, SOURCE_MISMATCH,
};
use super::protocol::*;
use super::NativeCaptureSelection;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
#[derive(Default)]
pub(super) struct CaptureState {
    pub(super) inner: Mutex<CaptureStateInner>,
    #[cfg(debug_assertions)]
    pub(super) debug_collector: Arc<DebugRoiSampleCollector>,
}

#[derive(Default)]
pub(super) struct CaptureStateInner {
    pub(super) capture: Option<Arc<CaptureControl>>,
    pub(super) last_capture_id: u32,
    pub(super) latest_capture_token: u64,
}

impl CaptureStateInner {
    pub(super) fn next_capture_id(&mut self) -> Result<u32, String> {
        let capture_id = self
            .last_capture_id
            .checked_add(1)
            .ok_or_else(|| "Native display capture exhausted its capture IDs.".to_string())?;
        self.last_capture_id = capture_id;
        Ok(capture_id)
    }

    pub(super) fn install_capture(
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

pub(super) struct CaptureControl {
    pub(super) capture_id: u32,
    pub(super) capture_token: u64,
    pub(super) cancelled: AtomicBool,
    pub(super) finished: AtomicBool,
    pub(super) preview_enabled: AtomicBool,
    pub(super) batches: Mutex<BatchState>,
    /// This capture's own D-Bus connection to the screen-cast portal; closing it ends the portal session.
    #[cfg(target_os = "linux")]
    pub(super) portal_connection: Mutex<Option<ashpd::zbus::Connection>>,
    pub(super) selection: Mutex<Option<NativeCaptureSelection>>,
    #[cfg(debug_assertions)]
    pub(super) healthy: AtomicBool,
    #[cfg(debug_assertions)]
    pub(super) source_dimensions: Mutex<Option<(u32, u32)>>,
}

impl CaptureControl {
    pub(super) fn new(
        capture_id: u32,
        capture_token: u64,
        selection: Option<NativeCaptureSelection>,
    ) -> Self {
        Self {
            capture_id,
            capture_token,
            cancelled: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            preview_enabled: AtomicBool::new(true),
            batches: Mutex::new(BatchState::default()),
            #[cfg(target_os = "linux")]
            portal_connection: Mutex::new(None),
            selection: Mutex::new(selection),
            #[cfg(debug_assertions)]
            healthy: AtomicBool::new(false),
            #[cfg(debug_assertions)]
            source_dimensions: Mutex::new(None),
        }
    }

    pub(super) fn begin_batch(
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

    pub(super) fn acknowledge(&self, capture_id: u32, batch_id: u32, kind: u32) {
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

    #[cfg(any(target_os = "linux", test))]
    pub(super) fn clear_batch(&self, batch_id: u32) {
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

    pub(super) fn pending_batch_age(&self) -> Result<Option<Duration>, String> {
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

pub(super) struct CaptureStartupGuard {
    pub(super) control: Arc<CaptureControl>,
    pub(super) worker_started: bool,
}

impl Drop for CaptureStartupGuard {
    fn drop(&mut self) {
        if !self.worker_started {
            self.control.finished.store(true, Ordering::Release);
            #[cfg(target_os = "linux")]
            close_portal(&self.control);
        }
    }
}

#[derive(Default)]
pub(super) struct BatchState {
    pub(super) last_batch_id: u32,
    pub(super) pending: Option<PendingBatch>,
}

pub(super) struct PendingBatch {
    pub(super) batch_id: u32,
    pub(super) started_at: Instant,
    pub(super) preview_pending: bool,
    pub(super) search_pending: bool,
    pub(super) region_pending: bool,
    pub(super) rare_region_pending: bool,
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
pub(super) fn revalidate_debug_roi_capture(
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

pub(super) fn cancel(control: &Arc<CaptureControl>) {
    control.cancelled.store(true, Ordering::Release);
    control.finished.store(true, Ordering::Release);
    #[cfg(target_os = "linux")]
    close_portal(control);
}

/// The portal ends a screen-cast session, and the desktop's sharing indicator, only on Close from the connection that
/// created it or when that connection disconnects, so each capture owns its connection and closes it when it ends.
#[cfg(target_os = "linux")]
pub(super) fn close_portal(control: &CaptureControl) {
    let connection = control
        .portal_connection
        .lock()
        .ok()
        .and_then(|mut connection| connection.take());
    if let Some(connection) = connection {
        tauri::async_runtime::spawn(async move {
            let _ = connection.close().await;
        });
    }
}

pub(super) fn sample_due(deadline: Option<Instant>, now: Instant) -> bool {
    deadline.is_none_or(|deadline| now + Duration::from_millis(3) >= deadline)
}

pub(super) fn next_sample_deadline(previous: Option<Instant>, now: Instant) -> Instant {
    let next = previous
        .map(|deadline| deadline + SAMPLE_INTERVAL)
        .unwrap_or(now + SAMPLE_INTERVAL);
    if next <= now {
        now + SAMPLE_INTERVAL
    } else {
        next
    }
}

impl Drop for CaptureState {
    fn drop(&mut self) {
        if let Ok(inner) = self.inner.get_mut() {
            if let Some(control) = inner.capture.take() {
                cancel(&control);
            }
        }
    }
}

pub(super) fn shutdown(state: &CaptureState) {
    let token = state
        .inner
        .lock()
        .ok()
        .and_then(|inner| inner.capture.as_ref().map(|c| c.capture_token));
    if let Some(token) = token {
        stop(state, token);
    }
}

pub(super) fn selection_for_source(
    selection: Option<NativeCaptureSelection>,
    source_width: u32,
    source_height: u32,
) -> Result<Option<NativeCaptureSelection>, String> {
    let Some(selection) = selection else {
        return Ok(None);
    };
    if (source_width, source_height) != selection.source_dimensions() {
        return Ok(None);
    }
    selection.validate()?;
    Ok(Some(selection))
}

#[cfg(test)]
mod tests;
