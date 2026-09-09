#[cfg(any(target_os = "linux", target_os = "windows"))]
mod control;
#[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
mod debug_roi_collector;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod diagnostics;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod protocol;
#[cfg(target_os = "windows")]
mod windows;

mod geometry;
use geometry::parse_loot_capture_settings;
#[cfg(all(
    any(target_os = "linux", target_os = "windows"),
    any(debug_assertions, test)
))]
use geometry::NormalizedRegion;
#[cfg(any(
    all(debug_assertions, any(target_os = "linux", target_os = "windows")),
    all(test, target_os = "linux")
))]
use geometry::PixelRegion;
pub use geometry::{LootCaptureSettings, NativeCaptureSelection};

use crate::persistence::{load_setting, save_settings, DatabasePath};

const LOOT_CAPTURE_SETTINGS_KEY: &str = "loot-capture-settings";
#[derive(Default)]
pub struct NativeCaptureState {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    capture: control::CaptureState,
}

#[tauri::command]
pub async fn start_native_display_capture(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, NativeCaptureState>,
    frames: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    if capture_token == 0 {
        return Err("native display capture token must be positive".into());
    }
    if let Some(selection) = selection {
        selection.validate()?;
    }

    #[cfg(not(target_os = "windows"))]
    let _ = window;
    #[cfg(target_os = "windows")]
    return windows::start(&state.capture, window, frames, capture_token, selection).await;
    #[cfg(target_os = "linux")]
    return linux::start(&state.capture, frames, capture_token, selection).await;

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, frames, capture_token, selection);
        Err("Native display capture is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub fn set_native_display_capture_region(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    if capture_token == 0 {
        return Err("native display capture token must be positive".into());
    }
    if let Some(selection) = selection {
        selection.validate()?;
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    return control::set_selection(&state.capture, capture_token, selection);

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, capture_token, selection);
        Err("Native display capture is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub fn set_native_display_capture_preview_enabled(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
    enabled: bool,
) -> Result<(), String> {
    if capture_token == 0 {
        return Err("native display capture token must be positive".into());
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    return control::set_preview_enabled(&state.capture, capture_token, enabled);

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, capture_token, enabled);
        Err("Native display capture is not supported on this platform.".to_string())
    }
}

#[tauri::command]
pub fn load_loot_capture_settings(
    state: tauri::State<'_, DatabasePath>,
) -> Result<Option<LootCaptureSettings>, String> {
    load_setting(&state.0, LOOT_CAPTURE_SETTINGS_KEY)?
        .map(|value| parse_loot_capture_settings(&value))
        .transpose()
}

#[tauri::command]
pub fn save_loot_capture_settings(
    settings: LootCaptureSettings,
    state: tauri::State<'_, DatabasePath>,
) -> Result<(), String> {
    settings.validate()?;
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    save_settings(
        &state.0,
        &[(LOOT_CAPTURE_SETTINGS_KEY, Some(value.as_str()))],
    )
}

#[tauri::command]
pub fn acknowledge_native_display_frame(
    state: tauri::State<'_, NativeCaptureState>,
    capture_id: u32,
    batch_id: u32,
    kind: u32,
) {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    control::acknowledge_frame(&state.capture, capture_id, batch_id, kind);

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = (state, capture_id, batch_id, kind);
}

#[tauri::command]
pub fn stop_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    control::stop(&state.capture, capture_token);

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = (state, capture_token);
}

#[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
#[tauri::command]
pub fn start_debug_roi_sample_collection(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) -> Result<debug_roi_collector::DebugRoiSampleCollectionStatus, String> {
    control::start_debug_roi_sample_collection(&state.capture, capture_token)
}

#[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
#[tauri::command]
pub fn stop_debug_roi_sample_collection(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) -> Result<debug_roi_collector::DebugRoiSampleCollectionStatus, String> {
    state.capture.debug_collector.stop(capture_token)
}

#[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
#[tauri::command]
pub fn debug_roi_sample_collection_status(
    state: tauri::State<'_, NativeCaptureState>,
) -> debug_roi_collector::DebugRoiSampleCollectionStatus {
    state.capture.debug_collector.status()
}

#[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
#[tauri::command]
pub async fn log_debug_roi_ocr_issue(
    state: tauri::State<'_, NativeCaptureState>,
    issue: debug_roi_collector::OcrIssue,
) -> Result<bool, String> {
    let collector = std::sync::Arc::clone(&state.capture.debug_collector);
    tauri::async_runtime::spawn_blocking(move || collector.log_ocr_issue(issue))
        .await
        .map_err(|error| format!("OCR diagnostic task failed: {error}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureCapabilities {
    backend: Option<&'static str>,
    available: bool,
    reason: Option<String>,
    debug_roi_samples: bool,
}

#[tauri::command]
pub fn native_capture_capabilities() -> NativeCaptureCapabilities {
    #[cfg(target_os = "windows")]
    let (backend, reason) = (Some("windows"), windows::unavailable_reason());
    #[cfg(target_os = "linux")]
    let (backend, reason) = (Some("linux"), None);
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let (backend, reason) = (
        None,
        Some("Native capture is unavailable on this platform.".to_string()),
    );
    let available = backend.is_some() && reason.is_none();
    NativeCaptureCapabilities {
        backend,
        available,
        reason,
        debug_roi_samples: available && cfg!(debug_assertions),
    }
}

pub fn shutdown(state: &NativeCaptureState) {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    control::shutdown(&state.capture);
    #[cfg(target_os = "windows")]
    windows::shutdown();
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let _ = state;
}

#[cfg(target_os = "windows")]
pub fn configure_diagnostics(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(path) = app.path().app_log_dir() {
        diagnostics::set_log_directory(path);
        windows::log_environment();
    }
}
