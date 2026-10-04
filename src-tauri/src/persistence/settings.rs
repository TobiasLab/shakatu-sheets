use std::path::PathBuf;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use super::{open_database, timestamp_ms};

pub(crate) fn load_setting(path: &PathBuf, key: &str) -> Result<Option<String>, String> {
    let connection = open_database(path)?;
    connection
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|error| error.to_string())
}

pub(crate) fn save_settings(
    path: &PathBuf,
    settings: &[(&str, Option<&str>)],
) -> Result<(), String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    write_settings(&transaction, settings)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub(crate) fn save_settings_if_unchanged(
    path: &PathBuf,
    expected_key: &str,
    expected_value: &str,
    settings: &[(&str, Option<&str>)],
) -> Result<bool, String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current = transaction
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [expected_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if current.as_deref() != Some(expected_value) {
        return Ok(false);
    }
    write_settings(&transaction, settings)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

fn write_settings(
    transaction: &Transaction,
    settings: &[(&str, Option<&str>)],
) -> Result<(), String> {
    for (key, value) in settings {
        match value {
            Some(value) => transaction
                .execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, value, timestamp_ms()],
                )
                .map_err(|error| error.to_string())?,
            None => transaction
                .execute("DELETE FROM settings WHERE key = ?1", [key])
                .map_err(|error| error.to_string())?,
        };
    }
    Ok(())
}
