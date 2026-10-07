use std::collections::HashSet;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, open_database, save_settings, DatabasePath, Region, MAX_SAFE_INTEGER};

const SETTING: &str = "consumable_presets";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumablePresetItem {
    item_id: i64,
    name: String,
    quantity: i64,
    unit_price: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumablePreset {
    id: String,
    name: String,
    region: Region,
    items: Vec<ConsumablePresetItem>,
}

fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 100
}

fn validate(presets: &[ConsumablePreset]) -> Result<(), String> {
    if presets.len() > 20 {
        return Err("Save at most 20 consumable presets.".into());
    }
    let mut ids = HashSet::new();
    for preset in presets {
        if !valid_name(&preset.id)
            || !ids.insert(&preset.id)
            || !valid_name(&preset.name)
            || preset.items.is_empty()
            || preset.items.len() > 100
        {
            return Err("Invalid consumable preset.".into());
        }
        let mut item_ids = HashSet::new();
        let mut total = 0_i64;
        for item in &preset.items {
            if item.item_id <= 0
                || item.item_id > MAX_SAFE_INTEGER
                || !item_ids.insert(item.item_id)
                || !valid_name(&item.name)
                || item.quantity <= 0
                || item.quantity > MAX_SAFE_INTEGER
                || item.unit_price < 0
                || item.unit_price > MAX_SAFE_INTEGER
            {
                return Err("Invalid consumable preset item.".into());
            }
            total = item
                .quantity
                .checked_mul(item.unit_price)
                .and_then(|value| total.checked_add(value))
                .filter(|value| *value <= MAX_SAFE_INTEGER)
                .ok_or("Consumable cost is too large.")?;
        }
    }
    Ok(())
}

pub(super) fn load_presets(connection: &Connection) -> Result<Vec<ConsumablePreset>, String> {
    let Some(value) = load_setting(connection, SETTING)? else {
        return Ok(Vec::new());
    };
    let presets = serde_json::from_str::<Vec<ConsumablePreset>>(&value)
        .map_err(|_| "Saved consumable presets are invalid.".to_string())?;
    validate(&presets)?;
    Ok(presets)
}

pub(super) fn save_presets(
    connection: &mut Connection,
    presets: &[ConsumablePreset],
) -> Result<(), String> {
    validate(presets)?;
    let value = serde_json::to_string(presets).map_err(|error| error.to_string())?;
    save_settings(connection, &[(SETTING, Some(&value))])
}

#[tauri::command]
pub fn load_consumable_presets(
    state: State<'_, DatabasePath>,
) -> Result<Vec<ConsumablePreset>, String> {
    load_presets(&open_database(state.path()?)?)
}

#[tauri::command]
pub fn save_consumable_presets(
    presets: Vec<ConsumablePreset>,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    save_presets(&mut open_database(state.path()?)?, &presets)
}
