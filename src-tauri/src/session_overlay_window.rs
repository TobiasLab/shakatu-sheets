// WebKitGTK 2.54 with NVIDIA drew only the hovered control of the transparent
// overlay, so on Linux the overlay is opaque and cannot fade.
const TRANSPARENT: bool = cfg!(not(target_os = "linux"));

#[derive(Default)]
pub(crate) struct OverlayWindowMode(pub bool);

pub(crate) fn create(app: &tauri::AppHandle) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "session-overlay")
        .ok_or(tauri::Error::WindowNotFound)?;
    tauri::WebviewWindowBuilder::from_config(app, config)?
        .transparent(TRANSPARENT)
        .build()?;
    Ok(())
}

#[tauri::command]
pub(crate) fn session_overlay_supports_opacity() -> bool {
    TRANSPARENT
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OverlayAdjustment {
    Move,
    Resize,
    NextMonitor,
}

#[tauri::command]
pub(crate) fn session_overlay_uses_layer_shell(state: tauri::State<'_, OverlayWindowMode>) -> bool {
    state.0
}

// Synchronous Tauri commands run on the main thread, as required by GTK.
#[tauri::command]
pub(crate) fn adjust_session_overlay(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayWindowMode>,
    action: OverlayAdjustment,
    dx: i32,
    dy: i32,
) -> Result<(), String> {
    if window.label() != "session-overlay" || !state.0 {
        return Err("Wayland overlay placement is only available for the session overlay".into());
    }
    #[cfg(target_os = "linux")]
    return crate::linux_window::adjust(&window, action, dx, dy);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (action, dx, dy);
        Err("Wayland overlay placement is unavailable on this platform".into())
    }
}
