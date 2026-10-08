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
        app.manage(persistence::DatabasePath(persistence::initialize_database(
            app.handle(),
        )));
        app.manage(garmoth::GarmothOperations::default());
        app.manage(native_capture::NativeCaptureState::default());
        #[cfg(target_os = "linux")]
        app.manage(session_overlay_window::OverlayWindowMode(
            linux_window::configure_session_overlay(app.handle())?,
        ));
        #[cfg(not(target_os = "linux"))]
        app.manage(session_overlay_window::OverlayWindowMode::default());
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

    let builder = builder.invoke_handler(tauri::generate_handler![
        session_overlay_window::session_overlay_uses_layer_shell,
        session_overlay_window::adjust_session_overlay,
        persistence::sessions::delete_finished_session,
        persistence::sessions::list_finished_sessions,
        persistence::sessions::load_session_trend,
        persistence::sessions::load_active_session,
        persistence::consumable_presets::load_consumable_presets,
        persistence::consumable_presets::save_consumable_presets,
        persistence::loot_font::load_loot_font,
        persistence::loot_font::save_loot_font,
        persistence::quantity_learning::quantity_learning,
        persistence::overlay::load_overlay_opacity,
        persistence::overlay::save_overlay_opacity,
        persistence::preferences::load_theme,
        persistence::preferences::save_theme,
        persistence::preferences::load_spot_preferences,
        persistence::preferences::save_spot_preferences,
        persistence::market_prices::load_market_prices,
        persistence::sessions::reopen_session,
        persistence::sessions::save_session,
        garmoth::settings::fetch_garmoth_characters,
        #[cfg(debug_assertions)]
        garmoth::diagnostics::inspect_garmoth_consumables,
        garmoth::settings::load_garmoth_settings,
        garmoth::settings::save_garmoth_api_key,
        garmoth::settings::select_garmoth_character,
        garmoth::upload::resolve_garmoth_upload,
        garmoth::upload::upload_garmoth_session,
        market::fetch_market_prices,
        loot_layout::read_normal_loot_layout,
        native_capture::native_capture_capabilities,
        native_capture::acknowledge_native_display_frame,
        native_capture::load_loot_capture_settings,
        native_capture::save_loot_capture_settings,
        native_capture::set_native_display_capture_preview_enabled,
        native_capture::set_native_display_capture_region,
        native_capture::start_native_display_capture,
        native_capture::stop_native_display_capture,
        #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
        native_capture::start_debug_roi_sample_collection,
        #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
        native_capture::stop_debug_roi_sample_collection,
        #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
        native_capture::debug_roi_sample_collection_status,
        #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
        native_capture::log_debug_roi_ocr_issue
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
mod loot_layout;
mod market;
mod native_capture;
mod persistence;
mod session_overlay_window;

use tauri::{Emitter, Manager};

#[cfg(target_os = "linux")]
mod linux_window;

#[cfg(target_os = "windows")]
mod windows_window;
