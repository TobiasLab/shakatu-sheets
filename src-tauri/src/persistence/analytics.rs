use rusqlite::{params, Connection, ToSql, Transaction};
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
    /// this, the same sessions that its rates and the item table cover. Its value is rounded to whole silver first,
    /// as the trend's rare drop markers do.
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
    /// The part of the quantity and value recorded at a market price, which today's prices revalue.
    pub market_quantity: f64,
    pub market_value: f64,
}

/// A rare item's total quantity in one session with tracked time.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RareLoot {
    pub session_id: String,
    pub name: String,
    pub quantity: f64,
}

/// Rare items recorded as dropping at one elapsed time of a session with drop timing.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RareEvent {
    pub session_id: String,
    pub name: String,
    pub elapsed_ms: i64,
    pub quantity: i64,
}

/// Pacing measures sessions in stretches of this many milliseconds.
pub const PACING_STRETCH_MS: i64 = 15 * 60_000;
/// Longer sessions are left out of pacing: their hours were almost certainly typed in, and each would add a mark per
/// stretch.
const PACING_MAX_SESSION_MS: i64 = 24 * 3_600_000;

/// A timed session's net, held at its latest sample, at every whole stretch of elapsed time from 0.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPacing {
    pub session_id: String,
    pub marks: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryAnalytics {
    pub sessions: Vec<AnalyticsSession>,
    pub items: Vec<AnalyticsItem>,
    pub rare_loot: Vec<RareLoot>,
    pub rare_events: Vec<RareEvent>,
    pub pacing: Vec<SessionPacing>,
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
            SELECT id, grind_spot_id, elapsed_ms, COALESCE(finished_at, updated_at) AS finished_at,
                created_at >= (
                    SELECT CAST(applied_at AS INTEGER) FROM schema_migrations WHERE version = 7
                ) AS has_drop_timing,
                created_at >= (
                    SELECT CAST(applied_at AS INTEGER) FROM schema_migrations WHERE version = 5
                ) AS has_net_samples
            FROM sessions
            WHERE status = 'finished' AND {}
                AND (?2 IS NULL OR COALESCE(finished_at, updated_at) >= ?2)
                AND (?3 IS NULL OR COALESCE(finished_at, updated_at) < ?3)
                AND (?4 IS NULL OR grind_spot_id = ?4)
        ),
        loot AS (
            SELECT e.session_id, e.name, SUM(e.quantity) AS quantity,
                SUM(e.quantity * e.unit_price * e.sale_multiplier) AS value,
                SUM(CASE WHEN e.valuation = 'market' THEN e.quantity ELSE 0 END) AS market_quantity,
                SUM(CASE WHEN e.valuation = 'market' THEN e.quantity * e.unit_price * e.sale_multiplier ELSE 0 END)
                    AS market_value
            FROM session_entries e JOIN filtered f ON f.id = e.session_id
            WHERE e.valuation <> 'expense'
            GROUP BY e.session_id, e.name
        ),
        rare_items AS (
            SELECT l.name FROM loot l JOIN filtered f ON f.id = l.session_id
            WHERE f.elapsed_ms > 0
            GROUP BY l.name HAVING ROUND(SUM(l.value)) >= ?5 * SUM(l.quantity)
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
                MIN(l.quantity * 3600000.0 / f.elapsed_ms), MAX(l.quantity * 3600000.0 / f.elapsed_ms),
                SUM(l.market_quantity), SUM(l.market_value)
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
                        market_quantity: row.get(7)?,
                        market_value: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    // Rare drops follow the same timed sessions and are shown for one spot only. Events record only increases while
    // the timer had started, so a session's events can cover less than its quantity; the rest has no time. Sessions
    // created before migration 7 have no events, as in the trend.
    let (rare_loot, rare_events) = if query.grind_spot_id.is_some() {
        load_rare_drops(&transaction, &filtered, parameters)?
    } else {
        (Vec::new(), Vec::new())
    };
    // Pacing is also shown for one spot only, and reads every net sample of its sessions.
    let pacing = if query.grind_spot_id.is_some() {
        load_pacing(&transaction, &filtered, parameters)?
    } else {
        Vec::new()
    };
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(HistoryAnalytics {
        sessions,
        items,
        rare_loot,
        rare_events,
        pacing,
    })
}

/// Sessions with at least one whole stretch and net samples (created after migration 5, as for the trend), reduced
/// to their net at each stretch mark so only a few numbers per session leave the database. A session counts only
/// when one of its samples falls strictly between its start and its end: samples are saved at the elapsed time of
/// each save, so a session whose hours were typed in (a Marni import, or loot added before entering hours) has its
/// net only at 0 or at its end and says nothing about when the silver came in. A session whose net never changed has
/// no samples and cannot be told apart from those, so it is left out too.
fn load_pacing(
    transaction: &Transaction,
    filtered: &str,
    parameters: &[&dyn ToSql],
) -> Result<Vec<SessionPacing>, String> {
    let samples = transaction
        .prepare(&format!(
            "{filtered}
            SELECT f.id, f.elapsed_ms, s.elapsed_ms, s.net
            FROM filtered f JOIN session_net_samples s ON s.session_id = f.id
            WHERE f.elapsed_ms BETWEEN {PACING_STRETCH_MS} AND {PACING_MAX_SESSION_MS} AND f.has_net_samples
                AND EXISTS (
                    SELECT 1 FROM session_net_samples inside
                    WHERE inside.session_id = f.id AND inside.elapsed_ms > 0 AND inside.elapsed_ms < f.elapsed_ms
                )
            ORDER BY f.finished_at, f.id, s.elapsed_ms"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(parameters, |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    let mut pacing: Vec<SessionPacing> = Vec::new();
    for (session_id, elapsed_ms, at_ms, net) in samples {
        if pacing
            .last()
            .is_none_or(|last| last.session_id != session_id)
        {
            pacing.push(SessionPacing {
                session_id,
                marks: vec![0; (elapsed_ms / PACING_STRETCH_MS + 1) as usize],
            });
        }
        let marks = &mut pacing.last_mut().expect("pushed above").marks;
        // Net holds from a sample until the next one, so the sample sets every mark at or after its time.
        let first = (at_ms + PACING_STRETCH_MS - 1) / PACING_STRETCH_MS;
        for mark in marks.iter_mut().skip(first as usize) {
            *mark = net;
        }
    }
    Ok(pacing)
}

fn load_rare_drops(
    transaction: &Transaction,
    filtered: &str,
    parameters: &[&dyn ToSql],
) -> Result<(Vec<RareLoot>, Vec<RareEvent>), String> {
    let rare_loot = transaction
        .prepare(&format!(
            "{filtered}
            SELECT l.session_id, l.name, l.quantity
            FROM loot l JOIN filtered f ON f.id = l.session_id JOIN rare_items r ON r.name = l.name
            WHERE f.elapsed_ms > 0
            ORDER BY f.finished_at, f.id, l.name"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(parameters, |row| {
                    Ok(RareLoot {
                        session_id: row.get(0)?,
                        name: row.get(1)?,
                        quantity: row.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    let rare_events = transaction
        .prepare(&format!(
            "{filtered}
            SELECT ev.session_id, en.name, ev.elapsed_ms, SUM(ev.quantity)
            FROM filtered f
                JOIN session_loot_events ev ON ev.session_id = f.id
                JOIN session_entries en ON en.id = ev.entry_id AND en.session_id = ev.session_id
            WHERE f.elapsed_ms > 0 AND f.has_drop_timing AND en.valuation <> 'expense'
                AND en.name IN (SELECT name FROM rare_items)
            GROUP BY ev.session_id, en.name, ev.elapsed_ms
            ORDER BY f.finished_at, f.id, ev.elapsed_ms, en.name"
        ))
        .and_then(|mut statement| {
            statement
                .query_map(parameters, |row| {
                    Ok(RareEvent {
                        session_id: row.get(0)?,
                        name: row.get(1)?,
                        elapsed_ms: row.get(2)?,
                        quantity: row.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    Ok((rare_loot, rare_events))
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
