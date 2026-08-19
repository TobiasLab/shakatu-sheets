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
        .setup(|app| {
            let database_path =
                database::initialize_database(app.handle()).map_err(std::io::Error::other)?;
            app.manage(database::DatabasePath(database_path));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::load_active_session,
            database::save_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shakatu Sheets");
}
mod database;

use tauri::Manager;
