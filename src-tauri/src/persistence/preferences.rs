use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, run_database, save_settings, DatabasePath};

const THEME_KEY: &str = "theme";
const SPOT_PREFERENCES_KEY: &str = "grind_spot_preferences";
const TREND_VIEW_KEY: &str = "trend_view";
#[cfg(debug_assertions)]
const DEBUG_ROI_SAMPLES_KEY: &str = "debug_roi_samples_enabled";
const MAX_FAVORITE_SPOTS: usize = 200;
const MAX_RECENT_SPOTS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
}

/// Which series the session trend plots: cumulative net or the recent silver/hour pace.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrendView {
    Net,
    Pace,
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

#[tauri::command]
pub async fn load_trend_view(state: State<'_, DatabasePath>) -> Result<TrendView, String> {
    run_database(state, |connection| load_trend_view_setting(connection)).await
}

pub(super) fn load_trend_view_setting(connection: &Connection) -> Result<TrendView, String> {
    match load_setting(connection, TREND_VIEW_KEY)?.as_deref() {
        None | Some("net") => Ok(TrendView::Net),
        Some("pace") => Ok(TrendView::Pace),
        Some(_) => Err("Invalid saved graph view.".into()),
    }
}

#[tauri::command]
pub async fn save_trend_view(
    view: TrendView,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    run_database(state, move |connection| {
        save_trend_view_setting(connection, view)
    })
    .await
}

pub(super) fn save_trend_view_setting(
    connection: &mut Connection,
    view: TrendView,
) -> Result<(), String> {
    let value = match view {
        TrendView::Net => "net",
        TrendView::Pace => "pace",
    };
    save_settings(connection, &[(TREND_VIEW_KEY, Some(value))])
}

/// Development builds only: whether ROI samples are recorded while the session timer runs.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn load_debug_roi_samples_enabled(
    state: State<'_, DatabasePath>,
) -> Result<bool, String> {
    run_database(state, |connection| {
        load_debug_roi_samples_setting(connection)
    })
    .await
}

#[cfg(debug_assertions)]
pub(super) fn load_debug_roi_samples_setting(connection: &Connection) -> Result<bool, String> {
    match load_setting(connection, DEBUG_ROI_SAMPLES_KEY)?.as_deref() {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err("Invalid saved ROI sample recording setting.".into()),
    }
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn save_debug_roi_samples_enabled(
    enabled: bool,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    run_database(state, move |connection| {
        save_debug_roi_samples_setting(connection, enabled)
    })
    .await
}

#[cfg(debug_assertions)]
pub(super) fn save_debug_roi_samples_setting(
    connection: &mut Connection,
    enabled: bool,
) -> Result<(), String> {
    let value = if enabled { "true" } else { "false" };
    save_settings(connection, &[(DEBUG_ROI_SAMPLES_KEY, Some(value))])
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
