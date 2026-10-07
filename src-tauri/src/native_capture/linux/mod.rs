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

    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(capture_error)?;
    *control
        .portal_connection
        .lock()
        .map_err(|_| "Capture session state is unavailable.")? = Some(connection.clone());
    ensure_active(&control)?;
    let portal = Screencast::with_connection(connection)
        .await
        .map_err(capture_error)?;
    let session = portal
        .create_session(Default::default())
        .await
        .map_err(capture_error)?;
    ensure_active(&control)?;

    let select_request = portal
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Hidden)
                .set_sources(Some(SourceType::Monitor.into()))
                .set_multiple(false),
        )
        .await;
    ensure_active(&control)?;
    select_request
        .map_err(capture_error)?
        .response()
        .map_err(capture_error)?;

    let start_request = portal.start(&session, None, Default::default()).await;
    ensure_active(&control)?;
    let response = start_request
        .map_err(capture_error)?
        .response()
        .map_err(capture_error)?;
    let stream = response
        .streams()
        .first()
        .ok_or("The screen capture portal returned no monitor stream.")?;
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
        .map_err(capture_error)?;
    ensure_active(&control)?;
    // This backend exposes the selected node only after the portal proxies are released. The connection stays open
    // until capture ends, so closing it still ends the portal session.
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
        close_portal(&worker_control);
        #[cfg(debug_assertions)]
        worker_control.healthy.store(false, Ordering::Release);
        worker_control.finished.store(true, Ordering::Release);
        #[cfg(debug_assertions)]
        debug_collector.finish_capture(worker_control.capture_id, CAPTURE_ENDED);
        if let Err(error) = result {
            eprintln!("Native display capture stopped: {error}");
            if !worker_control.cancelled.load(Ordering::Acquire) {
                let _ = errors.send(InvokeResponseBody::Raw(error_frame(&error)));
            }
        }
    });
    startup_guard.worker_started = true;
    Ok(())
}

/// Startup awaits the portal; a capture stopped or replaced meanwhile must not continue. The startup guard closes the
/// portal connection when startup returns early.
fn ensure_active(control: &CaptureControl) -> Result<(), String> {
    if control.cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".to_string());
    }
    Ok(())
}

fn capture_error(error: impl std::fmt::Display) -> String {
    format!("Native display capture failed: {error}")
}

#[cfg(test)]
mod tests;
