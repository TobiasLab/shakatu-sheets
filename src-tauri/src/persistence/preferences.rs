use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, run_database, save_settings, DatabasePath};

const THEME_KEY: &str = "theme";
const SPOT_PREFERENCES_KEY: &str = "grind_spot_preferences";
const MAX_FAVORITE_SPOTS: usize = 200;
const MAX_RECENT_SPOTS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpotPreferences {
    favorites: Vec<String>,
    recent: Vec<String>,
}

/// `None` means the theme was never saved in SQLite.
#[tauri::command]
pub async fn load_theme(state: State<'_, DatabasePath>) -> Result<Option<Theme>, String> {
    run_database(state, |connection| load_theme_setting(connection)).await
}

pub(super) fn load_theme_setting(connection: &Connection) -> Result<Option<Theme>, String> {
    match load_setting(connection, THEME_KEY)?.as_deref() {
        None => Ok(None),
        Some("light") => Ok(Some(Theme::Light)),
        Some("dark") => Ok(Some(Theme::Dark)),
        Some(_) => Err("Invalid saved theme.".into()),
    }
}

#[tauri::command]
pub async fn save_theme(theme: Theme, state: State<'_, DatabasePath>) -> Result<(), String> {
    run_database(state, move |connection| {
        save_theme_setting(connection, theme)
    })
    .await
}

pub(super) fn save_theme_setting(connection: &mut Connection, theme: Theme) -> Result<(), String> {
    let value = match theme {
        Theme::Light => "light",
        Theme::Dark => "dark",
    };
    save_settings(connection, &[(THEME_KEY, Some(value))])
}

/// `None` means the grind-spot favorites and recents were never saved in SQLite.
#[tauri::command]
pub async fn load_spot_preferences(
    state: State<'_, DatabasePath>,
) -> Result<Option<SpotPreferences>, String> {
    run_database(state, |connection| {
        load_spot_preferences_setting(connection)
    })
    .await
}

pub(super) fn load_spot_preferences_setting(
    connection: &Connection,
) -> Result<Option<SpotPreferences>, String> {
    let Some(value) = load_setting(connection, SPOT_PREFERENCES_KEY)? else {
        return Ok(None);
    };
    let preferences = serde_json::from_str(&value)
        .map_err(|_| "Saved grind spot favorites are invalid.".to_string())?;
    validate_spot_preferences(&preferences)?;
    Ok(Some(preferences))
}

#[tauri::command]
pub async fn save_spot_preferences(
    preferences: SpotPreferences,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    run_database(state, move |connection| {
        save_spot_preferences_setting(connection, &preferences)
    })
    .await
}

pub(super) fn save_spot_preferences_setting(
    connection: &mut Connection,
    preferences: &SpotPreferences,
) -> Result<(), String> {
    validate_spot_preferences(preferences)?;
    let value = serde_json::to_string(preferences).map_err(|error| error.to_string())?;
    save_settings(connection, &[(SPOT_PREFERENCES_KEY, Some(&value))])
}

fn validate_spot_preferences(preferences: &SpotPreferences) -> Result<(), String> {
    let valid_id = |id: &String| {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    };
    if preferences.favorites.len() > MAX_FAVORITE_SPOTS
        || preferences.recent.len() > MAX_RECENT_SPOTS
        || !preferences.favorites.iter().all(valid_id)
        || !preferences.recent.iter().all(valid_id)
    {
        return Err("Grind spot favorites are invalid.".into());
    }
    Ok(())
}
