use rusqlite::Connection;
use tauri::State;

use super::{load_setting, open_database, save_settings, DatabasePath};

const OPACITY_KEY: &str = "session_overlay_opacity";

#[tauri::command]
pub fn load_overlay_opacity(state: State<'_, DatabasePath>) -> Result<u8, String> {
    load_overlay_opacity_setting(&open_database(state.path()?)?)
}

pub(super) fn load_overlay_opacity_setting(connection: &Connection) -> Result<u8, String> {
    Ok(load_setting(connection, OPACITY_KEY)?
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|value| (25..=100).contains(value))
        .unwrap_or(100))
}

#[tauri::command]
pub fn save_overlay_opacity(opacity: u8, state: State<'_, DatabasePath>) -> Result<(), String> {
    save_overlay_opacity_setting(&mut open_database(state.path()?)?, opacity)
}

pub(super) fn save_overlay_opacity_setting(
    connection: &mut Connection,
    opacity: u8,
) -> Result<(), String> {
    if !(25..=100).contains(&opacity) {
        return Err("Overlay opacity must be between 25 and 100 percent.".into());
    }
    save_settings(connection, &[(OPACITY_KEY, Some(&opacity.to_string()))])
}
