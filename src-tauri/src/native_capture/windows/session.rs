use super::{capture_error, frame::create_device, log_lifecycle};
use crate::native_capture::{control::CaptureControl, protocol::SAMPLE_INTERVAL};
use std::{
    cell::RefCell,
    collections::HashMap,
    marker::PhantomData,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
};
use windows::{
    core::{AgileReference, IInspectable},
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::*,
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::Foundation::E_NOINTERFACE,
};

// The picker and all session lifecycle calls use the same Tauri UI apartment.
// Only the device and free-threaded pool are exposed to the frame-processing worker.
thread_local! {
    static SESSIONS: RefCell<HashMap<u32, Session>> = RefCell::new(HashMap::new());
}

struct Session {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrival: Option<i64>,
    closed: Option<i64>,
    _thread: PhantomData<Rc<()>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(token) = self.arrival {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed {
            let _ = self.item.RemoveClosed(token);
        }
        if let Err(error) = self.session.Close() {
            log_lifecycle(&capture_error(
                "closing the capture session on the UI thread",
                error,
            ));
        }
        if let Err(error) = self.pool.Close() {
            log_lifecycle(&capture_error(
                "closing the capture frame pool on the UI thread",
                error,
            ));
        }
    }
}

pub(super) struct FrameSource {
    pub(super) pool: AgileReference<Direct3D11CaptureFramePool>,
    pub(super) size: SizeInt32,
    pub(super) producer_limited: bool,
    pub(super) receiver: mpsc::Receiver<()>,
    pub(super) closed: Arc<AtomicBool>,
}

pub(super) struct PreparedCapture {
    pub(super) device: AgileReference<IDirect3DDevice>,
    pub(super) source: FrameSource,
    pub(super) session: SessionGuard,
}

pub(super) struct SessionGuard {
    schedule_close: Box<dyn Fn(u32) + Send>,
    capture_id: u32,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        // The frame worker has released its frames before queuing teardown.
        // If the event loop has exited, shutdown() already cleared the sessions.
        (self.schedule_close)(self.capture_id);
    }
}

// Called on the picker UI thread; schedule_close must dispatch close back there.
pub(super) fn start(
    item: GraphicsCaptureItem,
    schedule_close: impl Fn(u32) + Send + 'static,
    control: &CaptureControl,
) -> Result<PreparedCapture, String> {
    if control.cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".into());
    }
    log_lifecycle(&format!(
        "capture {}: creating session on UI thread",
        control.capture_id
    ));
    let winrt = create_device()?;
    let device = AgileReference::new(&winrt)
        .map_err(|e| capture_error("marshalling the capture device", e))?;
    let (session, source) = create(item, &winrt, &control.cancelled)?;
    // StartCapture may pump UI messages, including stop or window destruction.
    if control.cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".into());
    }
    SESSIONS.with(|sessions| sessions.borrow_mut().insert(control.capture_id, session));
    Ok(PreparedCapture {
        device,
        source,
        session: SessionGuard {
            schedule_close: Box::new(schedule_close),
            capture_id: control.capture_id,
        },
    })
}

pub(super) fn close(capture_id: u32) {
    let session = SESSIONS.with(|sessions| sessions.borrow_mut().remove(&capture_id));
    if session.is_some() {
        drop(session);
        log_lifecycle(&format!(
            "capture {capture_id}: session closed on UI thread"
        ));
    }
}

// Called by the app's UI-thread window/exit handlers before COM teardown.
pub(super) fn shutdown() {
    let sessions = SESSIONS.with(|sessions| std::mem::take(&mut *sessions.borrow_mut()));
    drop(sessions);
}

// Missing optional interfaces are expected on older Windows 10 builds. Other
// failures (including wrong-thread and access-denied errors) must remain visible.
fn optional_setting(result: windows::core::Result<()>) -> windows::core::Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.code() == E_NOINTERFACE => Ok(false),
        Err(error) => Err(error),
    }
}

// Producer throttling is only an optimization. Preserve capture on systems
// that expose this interface but reject the setting, using the consumer gate.
fn update_interval_supported(result: windows::core::Result<()>) -> bool {
    match result {
        Ok(()) => true,
        Err(error) => {
            if error.code() != E_NOINTERFACE {
                log_lifecycle(&format!(
                    "Capture update interval rejected: {error}; using the consumer sampling gate"
                ));
            }
            false
        }
    }
}

fn create(
    item: GraphicsCaptureItem,
    device: &IDirect3DDevice,
    cancelled: &AtomicBool,
) -> Result<(Session, FrameSource), String> {
    let size = item
        .Size()
        .map_err(|e| capture_error("reading the selected source size", e))?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err("The selected capture source is empty.".into());
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )
    .map_err(|e| capture_error("creating the free-threaded frame pool", e))?;
    let session = match pool.CreateCaptureSession(&item) {
        Ok(session) => session,
        Err(error) => {
            let _ = pool.Close();
            return Err(capture_error("creating the capture session", error));
        }
    };
    let mut resources = Session {
        item,
        pool,
        session,
        arrival: None,
        closed: None,
        _thread: std::marker::PhantomData,
    };
    optional_setting(resources.session.SetIsCursorCaptureEnabled(false))
        .map_err(|e| capture_error("disabling cursor capture", e))?;
    let producer_limited =
        update_interval_supported(resources.session.SetMinUpdateInterval(TimeSpan {
            Duration: (SAMPLE_INTERVAL.as_nanos() / 100) as i64,
        }));
    let (wake, receiver) = mpsc::sync_channel(1);
    resources.arrival = Some(
        resources
            .pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |_, _| {
                    let _ = wake.try_send(());
                    Ok(())
                }),
            )
            .map_err(|e| capture_error("subscribing to capture frames", e))?,
    );
    let closed = Arc::new(AtomicBool::new(false));
    let closed_callback = closed.clone();
    resources.closed = Some(
        resources
            .item
            .Closed(
                &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                    closed_callback.store(true, Ordering::Release);
                    Ok(())
                }),
            )
            .map_err(|e| capture_error("subscribing to source closure", e))?,
    );
    if cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".into());
    }
    let pool = AgileReference::new(&resources.pool)
        .map_err(|e| capture_error("marshalling the capture frame pool", e))?;
    resources
        .session
        .StartCapture()
        .map_err(|e| capture_error("starting the capture session", e))?;
    Ok((
        resources,
        FrameSource {
            pool,
            size,
            producer_limited,
            receiver,
            closed,
        },
    ))
}

#[cfg(test)]
mod tests;
