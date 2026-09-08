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
        #[cfg(target_os = "windows")]
        {
            native_capture::configure_diagnostics(app.handle());
            windows_window::configure(app.handle());
        }
        Ok(())
    });

    let builder = builder.on_window_event(|window, event| {
        if window.label() == "session-overlay" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.hide().is_ok() {
                    let _ = window.emit("session-overlay-visibility-changed", ());
                }
            }
            return;
        }
        #[cfg(target_os = "windows")]
        if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
            let _ = windows_window::fit(window);
        }
        #[cfg(target_os = "windows")]
        if matches!(event, tauri::WindowEvent::Destroyed) {
            native_capture::shutdown(&window.state::<native_capture::NativeCaptureState>());
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            window.app_handle().exit(0);
        }
    });

    #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        persistence::sessions::delete_finished_session,
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
        native_capture::native_capture_capabilities,
        native_capture::acknowledge_native_display_frame,
        native_capture::load_loot_capture_settings,
        native_capture::save_loot_capture_settings,
        native_capture::set_native_display_capture_preview_enabled,
        native_capture::set_native_display_capture_region,
        native_capture::start_native_display_capture,
        native_capture::stop_native_display_capture,
        native_capture::start_debug_roi_sample_collection,
        native_capture::stop_debug_roi_sample_collection,
        native_capture::debug_roi_sample_collection_status,
        native_capture::log_debug_roi_ocr_issue
    ]);

    #[cfg(not(all(debug_assertions, any(target_os = "linux", target_os = "windows"))))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        persistence::sessions::delete_finished_session,
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
        native_capture::native_capture_capabilities,
        native_capture::acknowledge_native_display_frame,
        native_capture::load_loot_capture_settings,
        native_capture::save_loot_capture_settings,
        native_capture::set_native_display_capture_preview_enabled,
        native_capture::set_native_display_capture_region,
        native_capture::start_native_display_capture,
        native_capture::stop_native_display_capture
    ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building Shakatu Sheets")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                native_capture::shutdown(&app.state::<native_capture::NativeCaptureState>());
            }
        });
}
mod garmoth;
mod market;
mod native_capture;
mod persistence;

use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
mod windows_window;
