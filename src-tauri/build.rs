// Declaring the app's commands makes each one require an `allow-<command>` permission, so a window can call only the
// commands its capability in `capabilities/` grants. Debug-only commands are listed too; release builds do not register
// them, so their permissions grant nothing there.
const COMMANDS: &[&str] = &[
    "session_overlay_uses_layer_shell",
    "adjust_session_overlay",
    "delete_finished_session",
    "list_finished_sessions",
    "load_session_trend",
    "load_active_session",
    "load_consumable_presets",
    "save_consumable_presets",
    "load_loot_font",
    "save_loot_font",
    "quantity_learning",
    "load_overlay_opacity",
    "save_overlay_opacity",
    "load_theme",
    "save_theme",
    "load_spot_preferences",
    "save_spot_preferences",
    "load_market_prices",
    "reopen_session",
    "save_session",
    "fetch_garmoth_characters",
    "inspect_garmoth_consumables",
    "load_garmoth_settings",
    "save_garmoth_api_key",
    "select_garmoth_character",
    "resolve_garmoth_upload",
    "upload_garmoth_session",
    "fetch_market_prices",
    "read_normal_loot_layout",
    "native_capture_capabilities",
    "acknowledge_native_display_frame",
    "load_loot_capture_settings",
    "save_loot_capture_settings",
    "set_native_display_capture_preview_enabled",
    "set_native_display_capture_region",
    "start_native_display_capture",
    "stop_native_display_capture",
    "start_debug_roi_sample_collection",
    "stop_debug_roi_sample_collection",
    "debug_roi_sample_collection_status",
    "log_debug_roi_ocr_issue",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
