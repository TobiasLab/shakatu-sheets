mod capture;
mod frame;
mod session;

use super::control::*;
use super::protocol::error_frame;
use super::NativeCaptureSelection;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use windows::{
    core::{h, Interface},
    Foundation::Metadata::ApiInformation,
    Graphics::Capture::{
        Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind,
        GraphicsCaptureItem, GraphicsCapturePicker, GraphicsCaptureSession,
        IDirect3D11CaptureFramePoolStatics2,
    },
    Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus,
    Win32::{
        System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
        UI::Shell::IInitializeWithWindow,
    },
};
use windows_future::{AsyncStatus, IAsyncOperation};

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
    if let Err(error) =
        windows::core::factory::<Direct3D11CaptureFramePool, IDirect3D11CaptureFramePoolStatics2>()
    {
        return Some(
            if error.code() == windows::Win32::Foundation::E_NOINTERFACE {
                "Screen capture requires Windows 10 version 1809 or later.".into()
            } else {
                capture_error("checking frame pool support", error)
            },
        );
    }
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
    let result = start_capture(state, window, frames, capture_token, selection).await;
    if let Err(error) = &result {
        log_lifecycle(error);
    }
    result
}

async fn start_capture(
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
    // Awaited after installation so a stop during the request cancels the picker.
    request_borderless_access().await;
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
    // Finish selection and create the capture session in the picker's UI
    // apartment. The selected item never passes through a Tokio thread.
    let prepared = loop {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let operation = operation.clone();
        let picker_control = control.clone();
        let owner = window.clone();
        window
            .run_on_main_thread(move || {
                let result =
                    poll_picker(&operation, picker_control.cancelled.load(Ordering::Acquire))
                        .and_then(|item| {
                            item.map(|item| {
                                session::start(
                                    item,
                                    move |capture_id| {
                                        let _ = owner
                                            .run_on_main_thread(move || session::close(capture_id));
                                    },
                                    &picker_control,
                                )
                            })
                            .transpose()
                        });
                let _ = sender.send(result);
            })
            .map_err(|e| capture_error("scheduling the source picker result", e))?;
        if let Some(prepared) = receiver
            .await
            .map_err(|_| "The capture window closed during source selection.")??
        {
            break prepared;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    if control.cancelled.load(Ordering::Acquire) {
        return Err("Screen sharing was cancelled.".into());
    }
    let worker_control = control.clone();
    #[cfg(debug_assertions)]
    let collector = state.debug_collector.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = capture::run(
            prepared,
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
                log_lifecycle(&format!("capture {}: {error}", worker_control.capture_id));
                let _ = frames.send(InvokeResponseBody::Raw(error_frame(&error)));
            }
        }
    });
    guard.worker_started = true;
    Ok(())
}

// Windows 11 hides the yellow capture border only after borderless access is
// granted; Windows 10 always draws it. The border is cosmetic, so failures are
// logged and capture continues with it.
async fn request_borderless_access() {
    let supported = ApiInformation::IsPropertyPresent(
        h!("Windows.Graphics.Capture.GraphicsCaptureSession"),
        h!("IsBorderRequired"),
    );
    if !matches!(supported, Ok(true)) {
        return;
    }
    let status =
        match GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless) {
            Ok(operation) => operation.await,
            Err(error) => Err(error),
        };
    match status {
        Ok(AppCapabilityAccessStatus::Allowed) => {}
        Ok(status) => log_lifecycle(&format!(
            "Borderless capture access was not granted: {status:?}"
        )),
        Err(error) => log_lifecycle(&format!(
            "Borderless capture access request failed: {error}"
        )),
    }
}

// Must be called on the UI thread that opened the picker. None means pending;
// a completed null result or E_ABORT means the user cancelled selection.
fn poll_picker(
    operation: &IAsyncOperation<GraphicsCaptureItem>,
    cancelled: bool,
) -> Result<Option<GraphicsCaptureItem>, String> {
    if cancelled {
        let _ = operation.Cancel();
        return Err("Screen sharing was cancelled.".into());
    }
    if operation
        .Status()
        .map_err(|e| capture_error("checking source selection", e))?
        == AsyncStatus::Started
    {
        return Ok(None);
    }
    let item = nullable_result(operation.GetResults())
        .map_err(|error| {
            if error.code() == windows::Win32::Foundation::E_ABORT {
                "Screen sharing was cancelled.".to_string()
            } else {
                capture_error("reading the selected monitor or window", error)
            }
        })?
        .ok_or_else(|| "Screen sharing was cancelled.".to_string())?;
    Ok(Some(item))
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
        "Windows capture failed while {stage}: {error}. [wgc-ui-2] Choose a monitor or window and try again."
    )
}

pub(super) fn shutdown() {
    session::shutdown();
}

pub(super) fn log_environment() {
    use windows::{
        Wdk::System::SystemServices::RtlGetVersion,
        Win32::System::SystemInformation::OSVERSIONINFOW,
    };
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut version) }.is_ok() {
        log_lifecycle(&format!(
            "Windows {}.{} build {}",
            version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber
        ));
    }
}

fn log_lifecycle(message: &str) {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    super::diagnostics::emit(&format!(
        "{timestamp} wgc-ui-2 {:?}: {message}",
        std::thread::current().id()
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        core::Type,
        Graphics::Capture::{Direct3D11CaptureFrame, GraphicsCaptureItem},
        Win32::Foundation::{E_ABORT, E_ACCESSDENIED, E_POINTER, RPC_E_WRONG_THREAD},
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

    #[test]
    fn pending_picker_can_be_cancelled_without_reading_results() {
        let _apartment = Apartment::enter().unwrap();
        let (_complete, receiver) = std::sync::mpsc::channel::<()>();
        let operation = IAsyncOperation::<GraphicsCaptureItem>::spawn(move || {
            let _ = receiver.recv();
            Err(windows::core::Error::from_hresult(E_ABORT))
        });
        assert!(poll_picker(&operation, false).unwrap().is_none());
        assert_eq!(
            poll_picker(&operation, true).unwrap_err(),
            "Screen sharing was cancelled."
        );
    }

    #[test]
    fn completed_picker_cancellation_does_not_start_capture() {
        let _apartment = Apartment::enter().unwrap();
        let null_item = unsafe {
            <GraphicsCaptureItem as Type<GraphicsCaptureItem>>::from_abi(std::ptr::null_mut())
        };
        for result in [null_item, Err(windows::core::Error::from_hresult(E_ABORT))] {
            let operation = IAsyncOperation::ready(result);
            assert_eq!(
                poll_picker(&operation, false).unwrap_err(),
                "Screen sharing was cancelled."
            );
        }
    }

    #[test]
    fn picker_failures_preserve_the_operation_and_hresult() {
        let _apartment = Apartment::enter().unwrap();
        for code in [E_ACCESSDENIED, E_POINTER, RPC_E_WRONG_THREAD] {
            let operation = IAsyncOperation::<GraphicsCaptureItem>::ready(Err(
                windows::core::Error::from_hresult(code),
            ));
            let error = poll_picker(&operation, false).unwrap_err();
            assert!(error.contains("reading the selected monitor or window"));
            assert!(error.contains(&format!("0x{:08X}", code.0 as u32)));
        }
    }
}
