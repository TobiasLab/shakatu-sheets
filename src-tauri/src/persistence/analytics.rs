use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{
    market_prices::Region, run_database, sessions::check_history_filters, DatabasePath,
    MAX_SAFE_INTEGER,
};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsQuery {
    /// `None` covers finished sessions from every region.
    pub region: Option<Region>,
    pub grind_spot_id: Option<String>,
    pub finished_from_ms: Option<i64>,
    pub finished_before_ms: Option<i64>,
    /// An item is rare when its average after-tax unit value across the matching sessions with tracked time reaches
    /// this, the same sessions that its rates and the item table cover.
    pub rare_min_unit_value: i64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSession {
    pub id: String,
    pub grind_spot_id: String,
    pub finished_at: i64,
    pub elapsed_ms: i64,
    pub net: f64,
    pub rare_value: f64,
}

/// One item's loot across the matching sessions with tracked time.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsItem {
    pub name: String,
    pub rare: bool,
    pub quantity: f64,
    pub value: f64,
    pub session_count: i64,
    /// Quantity per hour in the sessions where the item dropped.
    pub min_rate: f64,
    pub max_rate: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalytics {
    pub sessions: Vec<AnalyticsSession>,
    pub items: Vec<AnalyticsItem>,
}

pub(super) fn load_history_analytics_records(
    connection: &Connection,
    query: &AnalyticsQuery,
) -> Result<HistoryAnalytics, String> {
    check_history_filters(
        query.grind_spot_id.as_deref(),
        query.finished_from_ms,
        query.finished_before_ms,
    )?;
    if !(1..=MAX_SAFE_INTEGER).contains(&query.rare_min_unit_value) {
        return Err("rare item value must be a positive safe integer".into());
    }
    let region = query.region.map(Region::as_str);
    // Same filters and values as the history list. A literal region predicate keeps
    // sessions_finished_region_time_idx usable. Entries are summed per session and item name first, so a manual and a
    // recognized row of one item count once.
    let filtered = format!(
        "WITH filtered AS (
            SELECT id, grind_spot_id, elapsed_ms, COALESCE(finished_at, updated_at) AS finished_at
            FROM sessions
            WHERE status = 'finished' AND {}
                AND (?2 IS NULL OR COALESCE(finished_at, updated_at) >= ?2)
                AND (?3 IS NULL OR COALESCE(finished_at, updated_at) < ?3)
                AND (?4 IS NULL OR grind_spot_id = ?4)
        ),
        loot AS (
            SELECT e.session_id, e.name, SUM(e.quantity) AS quantity,
                SUM(e.quantity * e.unit_price * e.sale_multiplier) AS value
            FROM session_entries e JOIN filtered f ON f.id = e.session_id
            WHERE e.valuation <> 'expense'
            GROUP BY e.session_id, e.name
        ),
        rare_items AS (
            SELECT l.name FROM loot l JOIN filtered f ON f.id = l.session_id
            WHERE f.elapsed_ms > 0
            GROUP BY l.name HAVING SUM(l.value) >= ?5 * SUM(l.quantity)
        )",
        if region.is_some() {
            "region = ?1"
        } else {
            "?1 IS NULL"
        }
    );
    let parameters = params![
        region,
        query.finished_from_ms,
        query.finished_before_ms,
        query.grind_spot_id,
        query.rare_min_unit_value
    ];
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let sessions = transaction
        .prepare(&format!(
            "{filtered},
            session_net AS (
                SELECT f.id, COALESCE(SUM(CASE WHEN e.valuation = 'expense'
                    THEN -e.quantity * e.unit_price
                    ELSE e.quantity * e.unit_price * e.sale_multiplier END), 0.0) AS net
                FROM filtered f LEFT JOIN session_entries e ON e.session_id = f.id
                GROUP BY f.id
            ),
            session_rare AS (
                SELECT l.session_id, SUM(l.value) AS value
                FROM loot l JOIN rare_items r ON r.name = l.name
                GROUP BY l.session_id
            )
            SELECT f.id, f.grind_spot_id, f.finished_at, f.elapsed_ms, n.net, COALESCE(r.value, 0.0)
            FROM filtered f
                JOIN session_net n ON n.id = f.id
                LEFT JOIN session_rare r ON r.session_id = f.id
            ORDER BY f.finished_at, f.id"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(parameters, |row| {
                    Ok(AnalyticsSession {
                        id: row.get(0)?,
                        grind_spot_id: row.get(1)?,
                        finished_at: row.get(2)?,
                        elapsed_ms: row.get(3)?,
                        net: row.get(4)?,
                        rare_value: row.get(5)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    // Rates need tracked time, so items cover only sessions with some.
    let items = transaction
        .prepare(&format!(
            "{filtered}
            SELECT l.name, l.name IN (SELECT name FROM rare_items), SUM(l.quantity), SUM(l.value), COUNT(*),
                MIN(l.quantity * 3600000.0 / f.elapsed_ms), MAX(l.quantity * 3600000.0 / f.elapsed_ms)
            FROM loot l JOIN filtered f ON f.id = l.session_id
            WHERE f.elapsed_ms > 0
            GROUP BY l.name
            ORDER BY SUM(l.value) DESC, l.name"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(parameters, |row| {
                    Ok(AnalyticsItem {
                        name: row.get(0)?,
                        rare: row.get(1)?,
                        quantity: row.get(2)?,
                        value: row.get(3)?,
                        session_count: row.get(4)?,
                        min_rate: row.get(5)?,
                        max_rate: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(HistoryAnalytics { sessions, items })
}

#[tauri::command]
pub async fn load_history_analytics(
    query: AnalyticsQuery,
    state: State<'_, DatabasePath>,
) -> Result<HistoryAnalytics, String> {
    run_database(state, move |connection| {
        load_history_analytics_records(connection, &query)
    })
    .await
}
