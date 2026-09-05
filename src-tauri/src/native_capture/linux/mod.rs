use super::control::*;
use super::diagnostics::CaptureDiagnostics;
use super::protocol::*;
mod frame;
mod stream;
use frame::*;
use stream::run_pipewire;

use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

#[cfg(debug_assertions)]
use super::debug_roi_collector::{
    DebugRoiSampleCollector, SampledRoiPair, CAPTURE_ENDED, CAPTURE_REPLACED, SOURCE_MISMATCH,
};
use super::{LootCaptureSettings, NativeCaptureSelection};
#[cfg(test)]
use super::{NormalizedRegion, PixelRegion};

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

fn portal_error(control: &Arc<CaptureControl>, error: impl std::fmt::Display) -> String {
    close_pending_session(control);
    capture_error(error)
}

fn capture_error(error: impl std::fmt::Display) -> String {
    format!("Native display capture failed: {error}")
}

#[cfg(test)]
mod tests;
