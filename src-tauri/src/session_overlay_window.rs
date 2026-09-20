#[derive(Default)]
pub(crate) struct OverlayWindowMode(pub bool);

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
