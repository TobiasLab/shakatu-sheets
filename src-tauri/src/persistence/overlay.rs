use std::path::PathBuf;

use tauri::State;

use super::{load_setting, save_settings, DatabasePath};

const OPACITY_KEY: &str = "session_overlay_opacity";

#[tauri::command]
pub fn load_overlay_opacity(state: State<'_, DatabasePath>) -> Result<u8, String> {
    load_overlay_opacity_at_path(state.path()?)
}

pub(super) fn load_overlay_opacity_at_path(path: &PathBuf) -> Result<u8, String> {
    Ok(load_setting(path, OPACITY_KEY)?
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|value| (25..=100).contains(value))
        .unwrap_or(100))
}

#[tauri::command]
pub fn save_overlay_opacity(opacity: u8, state: State<'_, DatabasePath>) -> Result<(), String> {
    save_overlay_opacity_at_path(state.path()?, opacity)
}

pub(super) fn save_overlay_opacity_at_path(path: &PathBuf, opacity: u8) -> Result<(), String> {
    if !(25..=100).contains(&opacity) {
        return Err("Overlay opacity must be between 25 and 100 percent.".into());
    }
    save_settings(path, &[(OPACITY_KEY, Some(&opacity.to_string()))])
}
