use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{open_database, DatabasePath};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Region {
    Eu,
    Na,
}

impl Region {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Eu => "eu",
            Self::Na => "na",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPriceSnapshot {
    pub item_id: i64,
    pub sub_id: i64,
    pub base_price: i64,
    pub fetched_at: i64,
}

pub(super) fn load_market_price_records(
    connection: &Connection,
    region: Region,
) -> Result<Vec<MarketPriceSnapshot>, String> {
    let mut statement = connection
        .prepare(
            "SELECT item_id, sub_id, base_price, fetched_at
             FROM price_snapshots
             WHERE id IN (
                 SELECT MAX(id)
                 FROM price_snapshots
                 WHERE session_id IS NULL AND region = ?1
                 GROUP BY item_id, sub_id
             )
             ORDER BY item_id, sub_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([region.as_str()], |row| {
            Ok(MarketPriceSnapshot {
                item_id: row.get(0)?,
                sub_id: row.get(1)?,
                base_price: row.get(2)?,
                fetched_at: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn save_market_price_records(
    path: &PathBuf,
    region: Region,
    snapshots: &[MarketPriceSnapshot],
) -> Result<(), String> {
    if snapshots.is_empty()
        || snapshots.iter().any(|snapshot| {
            snapshot.item_id <= 0
                || snapshot.sub_id < 0
                || snapshot.base_price < 0
                || snapshot.fetched_at <= 0
        })
    {
        return Err("market price snapshots are invalid".into());
    }

    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO price_snapshots (
                    session_id, region, item_id, sub_id, base_price, fetched_at
                 ) VALUES (NULL, ?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|error| error.to_string())?;
        for snapshot in snapshots {
            statement
                .execute(params![
                    region.as_str(),
                    snapshot.item_id,
                    snapshot.sub_id,
                    snapshot.base_price,
                    snapshot.fetched_at,
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_market_prices(
    region: Region,
    state: State<'_, DatabasePath>,
) -> Result<Vec<MarketPriceSnapshot>, String> {
    let connection = open_database(state.path()?)?;
    load_market_price_records(&connection, region)
}
