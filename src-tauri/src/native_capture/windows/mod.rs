mod capture;
mod frame;

use super::control::*;
use super::protocol::error_frame;
use super::NativeCaptureSelection;
use std::future::IntoFuture;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use windows::{
    core::Interface,
    Graphics::Capture::{GraphicsCapturePicker, GraphicsCaptureSession},
    Win32::{
        System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Shell::IInitializeWithWindow,
    },
};

#[cfg(debug_assertions)]
use super::debug_roi_collector::{CAPTURE_ENDED, CAPTURE_REPLACED};

pub(super) struct Apartment(bool);
impl Apartment {
    pub(super) fn enter() -> Result<Self, String> {
        match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
            Ok(()) => Ok(Self(true)),
            // The Tauri UI thread already owns an STA apartment.
            Err(error) if error.code() == windows::Win32::Foundation::RPC_E_CHANGED_MODE => {
                Ok(Self(false))
            }
            Err(error) => Err(capture_error("initializing Windows capture", error)),
        }
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                RoUninitialize();
            }
        }
    }
}

pub(super) fn unavailable_reason() -> Option<String> {
    let _apartment = match Apartment::enter() {
        Ok(apartment) => apartment,
        Err(error) => return Some(error),
    };
    match GraphicsCaptureSession::IsSupported() {
        Ok(true) => None,
        Ok(false) => Some(
            "Windows Graphics Capture is unavailable on this device or disabled by policy.".into(),
        ),
        Err(error) => Some(capture_error("checking capture support", error)),
    }
}

pub(super) async fn start(
    state: &CaptureState,
    window: tauri::WebviewWindow,
    frames: Channel<InvokeResponseBody>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    if let Some(reason) = unavailable_reason() {
        return Err(reason);
    }
    let (control, previous) = state
        .inner
        .lock()
        .map_err(|_| "Capture state is unavailable.")?
        .install_capture(capture_token, selection)?;
    if let Some(previous) = previous {
        #[cfg(debug_assertions)]
        state
            .debug_collector
            .finish_capture(previous.capture_id, CAPTURE_REPLACED);
        cancel(&previous);
    }
    let mut guard = CaptureStartupGuard {
        control: control.clone(),
        worker_started: false,
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    let picker_control = control.clone();
    window
        .run_on_main_thread(move || {
            let operation = (|| {
                if picker_control.cancelled.load(Ordering::Acquire) {
                    return Err("Screen sharing was cancelled.".to_string());
                }
                let picker = GraphicsCapturePicker::new()
                    .map_err(|e| capture_error("creating the monitor/window picker", e))?;
                let initializer: IInitializeWithWindow = picker
                    .cast()
                    .map_err(|e| capture_error("initializing the source picker", e))?;
                let hwnd = owner
                    .hwnd()
                    .map_err(|e| capture_error("getting the picker owner window", e))?;
                unsafe { initializer.Initialize(windows::Win32::Foundation::HWND(hwnd.0)) }
                    .map_err(|e| capture_error("attaching the source picker to the app", e))?;
                picker
                    .PickSingleItemAsync()
                    .map_err(|e| capture_error("opening the monitor/window picker", e))
            })();
            let _ = sender.send(operation);
        })
        .map_err(|e| capture_error("scheduling the source picker", e))?;
    let operation = receiver
        .await
        .map_err(|_| "The capture window closed during source selection.")??;
    let mut result = Box::pin(operation.clone().into_future());
    let item = loop {
        if control.cancelled.load(Ordering::Acquire) {
            let _ = operation.Cancel();
            return Err("Screen sharing was cancelled.".into());
        }
        match tokio::time::timeout(Duration::from_millis(100), &mut result).await {
            Ok(result) => {
                break nullable_result(result)
                    .map_err(|error| {
                        if error.code() == windows::Win32::Foundation::E_ABORT {
                            "Screen sharing was cancelled.".to_string()
                        } else {
                            capture_error("reading the selected monitor or window", error)
                        }
                    })?
                    .ok_or_else(|| "Screen sharing was cancelled.".to_string())?
            }
            Err(_) => continue,
        }
    };
    if control.cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".into());
    }
    let worker_control = control.clone();
    #[cfg(debug_assertions)]
    let collector = state.debug_collector.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = capture::run(
            item,
            &frames,
            &worker_control,
            #[cfg(debug_assertions)]
            &collector,
        );
        #[cfg(debug_assertions)]
        {
            worker_control.healthy.store(false, Ordering::Release);
            collector.finish_capture(worker_control.capture_id, CAPTURE_ENDED);
        }
        worker_control.finished.store(true, Ordering::Release);
        if !worker_control.cancelled.load(Ordering::Acquire) {
            if let Err(error) = result {
                let _ = frames.send(InvokeResponseBody::Raw(error_frame(&error)));
            }
        }
    });
    guard.worker_started = true;
    Ok(())
}

// windows-core 0.61 represents a successful null interface as Error::empty (S_OK).
// Only use this adapter for WinRT methods whose documented result is nullable.
pub(super) fn nullable_result<T>(
    result: windows::core::Result<T>,
) -> windows::core::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code() == windows::Win32::Foundation::S_OK => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn capture_error(stage: &str, error: impl std::fmt::Display) -> String {
    format!(
        "Windows capture failed while {stage}: {error}. Choose a monitor or window and try again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        core::Type,
        Graphics::Capture::{Direct3D11CaptureFrame, GraphicsCaptureItem},
        Win32::Foundation::{E_ACCESSDENIED, E_POINTER},
    };

    #[test]
    fn empty_frame_pool_and_cancelled_picker_are_nullable_successes() {
        let frame = unsafe {
            <Direct3D11CaptureFrame as Type<Direct3D11CaptureFrame>>::from_abi(std::ptr::null_mut())
        };
        let item = unsafe {
            <GraphicsCaptureItem as Type<GraphicsCaptureItem>>::from_abi(std::ptr::null_mut())
        };
        assert!(nullable_result(frame).unwrap().is_none());
        assert!(nullable_result(item).unwrap().is_none());
        assert_eq!(nullable_result(Ok(42)).unwrap(), Some(42));
    }

    #[test]
    fn nullable_results_preserve_real_failures() {
        for code in [E_ACCESSDENIED, E_POINTER] {
            let result = nullable_result::<()>(Err(windows::core::Error::from_hresult(code)));
            assert_eq!(result.unwrap_err().code(), code);
        }
    }
}
