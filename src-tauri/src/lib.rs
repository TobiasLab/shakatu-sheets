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

    let builder = tauri::Builder::default().setup(|app| {
        let database_path =
            persistence::initialize_database(app.handle()).map_err(std::io::Error::other)?;
        app.manage(persistence::DatabasePath(database_path));
        app.manage(garmoth::GarmothOperations::default());
        app.manage(native_capture::NativeCaptureState::default());
        Ok(())
    });

    #[cfg(all(debug_assertions, target_os = "linux"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        persistence::sessions::list_finished_sessions,
        persistence::sessions::load_active_session,
        persistence::market_prices::load_market_prices,
        persistence::sessions::reopen_session,
        persistence::sessions::save_session,
        garmoth::settings::fetch_garmoth_characters,
        garmoth::settings::load_garmoth_settings,
        garmoth::settings::save_garmoth_api_key,
        garmoth::settings::select_garmoth_character,
        garmoth::upload::upload_garmoth_session,
        market::fetch_market_prices,
        native_capture::acknowledge_native_display_frame,
        native_capture::load_loot_capture_settings,
        native_capture::save_loot_capture_settings,
        native_capture::set_native_display_capture_region,
        native_capture::start_native_display_capture,
        native_capture::stop_native_display_capture,
        native_capture::start_debug_roi_sample_collection,
        native_capture::stop_debug_roi_sample_collection,
        native_capture::debug_roi_sample_collection_status
    ]);

    #[cfg(not(all(debug_assertions, target_os = "linux")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        persistence::sessions::list_finished_sessions,
        persistence::sessions::load_active_session,
        persistence::market_prices::load_market_prices,
        persistence::sessions::reopen_session,
        persistence::sessions::save_session,
        garmoth::settings::fetch_garmoth_characters,
        garmoth::settings::load_garmoth_settings,
        garmoth::settings::save_garmoth_api_key,
        garmoth::settings::select_garmoth_character,
        garmoth::upload::upload_garmoth_session,
        market::fetch_market_prices,
        native_capture::acknowledge_native_display_frame,
        native_capture::load_loot_capture_settings,
        native_capture::save_loot_capture_settings,
        native_capture::set_native_display_capture_region,
        native_capture::start_native_display_capture,
        native_capture::stop_native_display_capture
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Shakatu Sheets");
}
mod garmoth;
mod market;
mod native_capture;
mod persistence;

use tauri::Manager;
