#[cfg(target_os = "linux")]
fn configure_linux_webview() {
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        // WebKitGTK's DMA-BUF renderer can terminate with a Wayland protocol error on NVIDIA.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    configure_linux_webview();

    tauri::Builder::default()
        .on_permission_request(|webview, permission| {
            if cfg!(target_os = "linux")
                && webview.label() == "main"
                && permission == tauri::webview::PermissionKind::DisplayCapture
            {
                tauri::webview::PermissionResponse::Allow
            } else {
                tauri::webview::PermissionResponse::Default
            }
        })
        .setup(|app| {
            let database_path =
                database::initialize_database(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database::DatabasePath(database_path));
            app.manage(garmoth::GarmothOperations::default());
            app.manage(native_capture::NativeCaptureState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::list_finished_sessions,
            database::load_active_session,
            database::load_market_prices,
            database::reopen_session,
            database::save_session,
            garmoth::fetch_garmoth_characters,
            garmoth::load_garmoth_settings,
            garmoth::save_garmoth_api_key,
            garmoth::select_garmoth_character,
            garmoth::upload_garmoth_session,
            market::fetch_market_prices,
            native_capture::start_native_display_capture,
            native_capture::stop_native_display_capture
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shakatu Sheets");
}
mod database;
mod garmoth;
mod market;
mod native_capture;

use tauri::Manager;
