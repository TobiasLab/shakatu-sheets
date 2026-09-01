#[cfg(target_os = "linux")]
mod linux;

#[derive(Default)]
pub struct NativeCaptureState {
    #[cfg(target_os = "linux")]
    capture: linux::CaptureState,
}

#[tauri::command]
pub async fn start_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    frames: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::start(&state.capture, frames).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, frames);
        Err("Native display capture is only available on Linux.".to_string())
    }
}

#[tauri::command]
pub fn acknowledge_native_display_frame(state: tauri::State<'_, NativeCaptureState>) {
    #[cfg(target_os = "linux")]
    linux::acknowledge_frame(&state.capture);

    #[cfg(not(target_os = "linux"))]
    let _ = state;
}

#[tauri::command]
pub fn stop_native_display_capture(state: tauri::State<'_, NativeCaptureState>) {
    #[cfg(target_os = "linux")]
    linux::stop(&state.capture);

    #[cfg(not(target_os = "linux"))]
    let _ = state;
}
