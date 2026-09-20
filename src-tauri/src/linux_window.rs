use gtk::{gdk::WindowTypeHint, prelude::GtkWindowExt};
use tauri::Manager;

pub(crate) fn configure_session_overlay(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(overlay) = app.get_webview_window("session-overlay") {
        // The configured overlay starts hidden, so this runs before its first show.
        // Ask X11/XWayland window managers to treat it as a floating utility.
        // GTK's native Wayland backend does not expose this type to the compositor;
        // neither this hint nor keep-above guarantees placement over fullscreen games.
        overlay.gtk_window()?.set_type_hint(WindowTypeHint::Utility);
    }
    Ok(())
}
