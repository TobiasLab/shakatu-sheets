#[cfg(all(debug_assertions, target_os = "linux"))]
mod debug_roi_collector;
#[cfg(target_os = "linux")]
mod linux;

mod geometry;
use geometry::parse_loot_capture_settings;
#[cfg(all(target_os = "linux", any(debug_assertions, test)))]
use geometry::NormalizedRegion;
#[cfg(all(target_os = "linux", any(debug_assertions, test)))]
use geometry::PixelRegion;
pub use geometry::{LootCaptureSettings, NativeCaptureSelection};

use crate::persistence::{load_setting, save_settings, DatabasePath};

const LOOT_CAPTURE_SETTINGS_KEY: &str = "loot-capture-settings";
#[derive(Default)]
pub struct NativeCaptureState {
    #[cfg(target_os = "linux")]
    capture: linux::CaptureState,
}

#[tauri::command]
pub async fn start_native_display_capture(
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

    #[cfg(target_os = "linux")]
    return linux::start(&state.capture, frames, capture_token, selection).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, frames, capture_token, selection);
        Err("Native display capture is only available on Linux.".to_string())
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

    #[cfg(target_os = "linux")]
    return linux::set_selection(&state.capture, capture_token, selection);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, capture_token, selection);
        Err("Native display capture is only available on Linux.".to_string())
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

    #[cfg(target_os = "linux")]
    return linux::set_preview_enabled(&state.capture, capture_token, enabled);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, capture_token, enabled);
        Err("Native display capture is only available on Linux.".to_string())
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
    #[cfg(target_os = "linux")]
    linux::acknowledge_frame(&state.capture, capture_id, batch_id, kind);

    #[cfg(not(target_os = "linux"))]
    let _ = (state, capture_id, batch_id, kind);
}

#[tauri::command]
pub fn stop_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) {
    #[cfg(target_os = "linux")]
    linux::stop(&state.capture, capture_token);

    #[cfg(not(target_os = "linux"))]
    let _ = (state, capture_token);
}

#[cfg(all(debug_assertions, target_os = "linux"))]
#[tauri::command]
pub fn start_debug_roi_sample_collection(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) -> Result<debug_roi_collector::DebugRoiSampleCollectionStatus, String> {
    linux::start_debug_roi_sample_collection(&state.capture, capture_token)
}

#[cfg(all(debug_assertions, target_os = "linux"))]
#[tauri::command]
pub fn stop_debug_roi_sample_collection(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) -> Result<debug_roi_collector::DebugRoiSampleCollectionStatus, String> {
    state.capture.debug_collector.stop(capture_token)
}

#[cfg(all(debug_assertions, target_os = "linux"))]
#[tauri::command]
pub fn debug_roi_sample_collection_status(
    state: tauri::State<'_, NativeCaptureState>,
) -> debug_roi_collector::DebugRoiSampleCollectionStatus {
    state.capture.debug_collector.status()
}
