use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, run_database, save_settings, DatabasePath};

const FONT_KEY: &str = "loot_font";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LootFont {
    #[default]
    Korean,
    StrongSword,
}

#[tauri::command]
pub async fn load_loot_font(state: State<'_, DatabasePath>) -> Result<LootFont, String> {
    run_database(state, |connection| load_loot_font_setting(connection)).await
}

pub(super) fn load_loot_font_setting(connection: &Connection) -> Result<LootFont, String> {
    match load_setting(connection, FONT_KEY)?.as_deref() {
        None | Some("korean") => Ok(LootFont::Korean),
        Some("strong-sword") => Ok(LootFont::StrongSword),
        Some(_) => Err("Invalid saved in-game font.".into()),
    }
}

#[tauri::command]
pub async fn save_loot_font(font: LootFont, state: State<'_, DatabasePath>) -> Result<(), String> {
    run_database(state, move |connection| {
        save_loot_font_setting(connection, font)
    })
    .await
}

pub(super) fn save_loot_font_setting(
    connection: &mut Connection,
    font: LootFont,
) -> Result<(), String> {
    let value = match font {
        LootFont::Korean => "korean",
        LootFont::StrongSword => "strong-sword",
    };
    save_settings(connection, &[(FONT_KEY, Some(value))])
}
