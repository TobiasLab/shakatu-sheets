use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, save_settings, DatabasePath};

const FONT_KEY: &str = "loot_font";

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LootFont {
    #[default]
    Korean,
    StrongSword,
}

#[tauri::command]
pub fn load_loot_font(state: State<'_, DatabasePath>) -> Result<LootFont, String> {
    load_loot_font_at_path(state.path()?)
}

pub(super) fn load_loot_font_at_path(path: &PathBuf) -> Result<LootFont, String> {
    match load_setting(path, FONT_KEY)?.as_deref() {
        None | Some("korean") => Ok(LootFont::Korean),
        Some("strong-sword") => Ok(LootFont::StrongSword),
        Some(_) => Err("Invalid saved in-game font.".into()),
    }
}

#[tauri::command]
pub fn save_loot_font(font: LootFont, state: State<'_, DatabasePath>) -> Result<(), String> {
    save_loot_font_at_path(state.path()?, font)
}

pub(super) fn save_loot_font_at_path(path: &PathBuf, font: LootFont) -> Result<(), String> {
    let value = match font {
        LootFont::Korean => "korean",
        LootFont::StrongSword => "strong-sword",
    };
    save_settings(path, &[(FONT_KEY, Some(value))])
}
