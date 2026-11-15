use std::collections::HashSet;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{load_setting, run_database, save_settings, DatabasePath, MAX_SAFE_INTEGER};

const SETTING: &str = "item_lists";
const MAX_ITEMS: usize = 200;

/// An item the user tracks at every grind spot, valued at a fixed price per unit.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneralItem {
    name: String,
    unit_price: i64,
}

/// Items live recognition ignores, and items it recognizes at every grind spot.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemLists {
    ignored_items: Vec<String>,
    general_items: Vec<GeneralItem>,
}

/// The name as recognition compares it: lowercase ASCII letters and digits only.
fn normalized(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn validate(lists: &ItemLists) -> Result<(), String> {
    if lists.ignored_items.len() > MAX_ITEMS || lists.general_items.len() > MAX_ITEMS {
        return Err(format!("Each item list holds at most {MAX_ITEMS} items."));
    }
    // One name may appear only once across both lists, since recognition cannot both ignore and add it.
    let mut names = HashSet::new();
    let general_names = lists.general_items.iter().map(|item| &item.name);
    for name in lists.ignored_items.iter().chain(general_names) {
        let key = normalized(name);
        if name.trim() != name || name.chars().count() > 100 || key.is_empty() {
            return Err("Item names need 1–100 characters, including a letter or digit.".into());
        }
        if !names.insert(key) {
            return Err(format!("{name} is listed more than once."));
        }
    }
    if lists
        .general_items
        .iter()
        .any(|item| item.unit_price < 0 || item.unit_price > MAX_SAFE_INTEGER)
    {
        return Err("Unit prices must be whole silver amounts of 0 or more.".into());
    }
    Ok(())
}

pub(super) fn load_item_lists_setting(connection: &Connection) -> Result<ItemLists, String> {
    let Some(value) = load_setting(connection, SETTING)? else {
        return Ok(ItemLists::default());
    };
    let lists =
        serde_json::from_str(&value).map_err(|_| "Saved item lists are invalid.".to_string())?;
    validate(&lists)?;
    Ok(lists)
}

pub(super) fn save_item_lists_setting(
    connection: &mut Connection,
    lists: &ItemLists,
) -> Result<(), String> {
    validate(lists)?;
    let value = serde_json::to_string(lists).map_err(|error| error.to_string())?;
    save_settings(connection, &[(SETTING, Some(&value))])
}

#[tauri::command]
pub async fn load_item_lists(state: State<'_, DatabasePath>) -> Result<ItemLists, String> {
    run_database(state, |connection| load_item_lists_setting(connection)).await
}

#[tauri::command]
pub async fn save_item_lists(
    lists: ItemLists,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    run_database(state, move |connection| {
        save_item_lists_setting(connection, &lists)
    })
    .await
}
