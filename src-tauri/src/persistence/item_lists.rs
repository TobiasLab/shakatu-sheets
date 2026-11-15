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

/// The name as recognition compares it: lowercased first, as the frontend does (some non-ASCII letters lowercase to
/// ASCII ones), then ASCII letters and digits only.
fn normalized(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn valid_name(name: &str) -> bool {
    name.trim() == name && name.chars().count() <= 100 && !normalized(name).is_empty()
}

fn valid_price(unit_price: i64) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&unit_price)
}

/// What still validates in a stored value, so a row that a later version rejects, or a corrupt one, never locks the
/// lists: invalid or repeated entries and anything past the limit are dropped, everything else is kept as saved.
fn lenient(value: &str) -> ItemLists {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(value) else {
        return ItemLists::default();
    };
    let entries = |key: &str| {
        json.get(key)
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut names = HashSet::new();
    let mut keep = |name: &str| valid_name(name) && names.insert(normalized(name));
    let ignored_items = entries("ignoredItems")
        .iter()
        .filter_map(serde_json::Value::as_str)
        .filter(|name| keep(name))
        .take(MAX_ITEMS)
        .map(str::to_owned)
        .collect();
    let general_items = entries("generalItems")
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?;
            let unit_price = item.get("unitPrice")?.as_i64()?;
            (valid_price(unit_price) && keep(name)).then(|| GeneralItem {
                name: name.to_owned(),
                unit_price,
            })
        })
        .take(MAX_ITEMS)
        .collect();
    ItemLists {
        ignored_items,
        general_items,
    }
}

fn validate(lists: &ItemLists) -> Result<(), String> {
    if lists.ignored_items.len() > MAX_ITEMS || lists.general_items.len() > MAX_ITEMS {
        return Err(format!("Each item list holds at most {MAX_ITEMS} items."));
    }
    // One name may appear only once across both lists, since recognition cannot both ignore and add it.
    let mut names = HashSet::new();
    let general_names = lists.general_items.iter().map(|item| &item.name);
    for name in lists.ignored_items.iter().chain(general_names) {
        if !valid_name(name) {
            return Err("Item names need 1–100 characters, including a letter or digit.".into());
        }
        if !names.insert(normalized(name)) {
            return Err(format!("{name} is listed more than once."));
        }
    }
    if lists
        .general_items
        .iter()
        .any(|item| !valid_price(item.unit_price))
    {
        return Err("Unit prices must be whole silver amounts of 0 or more.".into());
    }
    Ok(())
}

pub(super) fn load_item_lists_setting(connection: &Connection) -> Result<ItemLists, String> {
    let Some(value) = load_setting(connection, SETTING)? else {
        return Ok(ItemLists::default());
    };
    Ok(lenient(&value))
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
