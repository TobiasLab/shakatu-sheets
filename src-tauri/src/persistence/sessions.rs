use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::garmoth::GarmothOperations;

use super::{
    garmoth_uploads::{load_garmoth_upload_status, GarmothUploadStatus},
    market_prices::Region,
    open_database, timestamp_ms, DatabasePath,
};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
    Paused,
    Finished,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Valuation {
    Market,
    Vendor,
    Expense,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntrySource {
    Manual,
    Recognition,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub name: String,
    pub quantity: f64,
    pub unit_price: i64,
    pub valuation: Valuation,
    pub sale_multiplier: f64,
    pub source: EntrySource,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub garmoth_consumable_id: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub region: Region,
    pub grind_spot_id: String,
    pub status: SessionStatus,
    pub started_at: Option<i64>,
    pub elapsed_ms: i64,
    pub entries: Vec<SessionEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedSessionRecord {
    pub session: SessionRecord,
    pub finished_at: i64,
    pub garmoth_upload_status: Option<GarmothUploadStatus>,
}

fn region_to_str(region: &Region) -> &'static str {
    match region {
        Region::Eu => "eu",
        Region::Na => "na",
    }
}

fn parse_region(value: &str) -> Result<Region, String> {
    match value {
        "eu" => Ok(Region::Eu),
        "na" => Ok(Region::Na),
        _ => Err(format!("unknown region: {value}")),
    }
}

fn status_to_str(status: &SessionStatus) -> &'static str {
    match status {
        SessionStatus::Idle => "idle",
        SessionStatus::Running => "running",
        SessionStatus::Paused => "paused",
        SessionStatus::Finished => "finished",
    }
}

fn parse_status(value: &str) -> Result<SessionStatus, String> {
    match value {
        "idle" => Ok(SessionStatus::Idle),
        "running" => Ok(SessionStatus::Running),
        "paused" => Ok(SessionStatus::Paused),
        "finished" => Ok(SessionStatus::Finished),
        _ => Err(format!("unknown session status: {value}")),
    }
}

fn valuation_to_str(valuation: &Valuation) -> &'static str {
    match valuation {
        Valuation::Market => "market",
        Valuation::Vendor => "vendor",
        Valuation::Expense => "expense",
    }
}

fn parse_valuation(value: &str) -> Result<Valuation, String> {
    match value {
        "market" => Ok(Valuation::Market),
        "vendor" => Ok(Valuation::Vendor),
        "expense" => Ok(Valuation::Expense),
        _ => Err(format!("unknown valuation: {value}")),
    }
}

fn source_to_str(source: &EntrySource) -> &'static str {
    match source {
        EntrySource::Manual => "manual",
        EntrySource::Recognition => "recognition",
    }
}

fn parse_source(value: &str) -> Result<EntrySource, String> {
    match value {
        "manual" => Ok(EntrySource::Manual),
        "recognition" => Ok(EntrySource::Recognition),
        _ => Err(format!("unknown entry source: {value}")),
    }
}

fn validate_session(session: &SessionRecord) -> Result<(), String> {
    if session.id.trim().is_empty() || session.grind_spot_id.trim().is_empty() {
        return Err("session ID and grind spot ID are required".into());
    }
    if session.elapsed_ms < 0 {
        return Err("elapsed time cannot be negative".into());
    }
    if (session.status == SessionStatus::Running) != session.started_at.is_some() {
        return Err("only running sessions may have a start timestamp".into());
    }

    for entry in &session.entries {
        if entry.id.trim().is_empty() || entry.name.trim().is_empty() {
            return Err("entry ID and name are required".into());
        }
        if !entry.quantity.is_finite() || entry.quantity <= 0.0 || entry.quantity.fract() != 0.0 {
            return Err(format!("invalid quantity for entry {}", entry.id));
        }
        if let Some(id) = entry.garmoth_consumable_id {
            if id <= 0
                || id > 9_007_199_254_740_991
                || entry.valuation != Valuation::Expense
                || entry.source != EntrySource::Manual
                || entry.sale_multiplier != 1.0
                || entry.quantity > 9_007_199_254_740_991.0
                || entry.unit_price > 9_007_199_254_740_991
                || entry.quantity * entry.unit_price as f64 > 9_007_199_254_740_991.0
            {
                return Err("invalid consumable expense".into());
            }
        }
        if entry.unit_price < 0
            || !entry.sale_multiplier.is_finite()
            || !(0.0..=1.0).contains(&entry.sale_multiplier)
        {
            return Err(format!("invalid valuation for entry {}", entry.id));
        }
    }

    Ok(())
}

pub(super) fn save_session_record(
    connection: &mut Connection,
    session: &SessionRecord,
) -> Result<(), String> {
    validate_session(session)?;

    if let Some(existing) = load_session_by_id(connection, &session.id)? {
        if existing.status == SessionStatus::Finished {
            return if existing == *session {
                Ok(())
            } else {
                Err("finished sessions are immutable".into())
            };
        }
    }

    let now = timestamp_ms();
    let finished_at = (session.status == SessionStatus::Finished).then_some(now);
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO sessions (
                id, region, grind_spot_id, status, started_at, elapsed_ms, created_at, updated_at, finished_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                region = excluded.region,
                grind_spot_id = excluded.grind_spot_id,
                status = excluded.status,
                started_at = excluded.started_at,
                elapsed_ms = excluded.elapsed_ms,
                updated_at = excluded.updated_at,
                finished_at = excluded.finished_at",
            params![
                session.id,
                region_to_str(&session.region),
                session.grind_spot_id,
                status_to_str(&session.status),
                session.started_at,
                session.elapsed_ms,
                now,
                finished_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM session_entries WHERE session_id = ?1",
            [&session.id],
        )
        .map_err(|error| error.to_string())?;

    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO session_entries (
                    id, session_id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at, garmoth_consumable_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|error| error.to_string())?;
        for entry in &session.entries {
            statement
                .execute(params![
                    entry.id,
                    session.id,
                    entry.name,
                    entry.quantity,
                    entry.unit_price,
                    valuation_to_str(&entry.valuation),
                    entry.sale_multiplier,
                    source_to_str(&entry.source),
                    entry.created_at,
                    entry.garmoth_consumable_id,
                ])
                .map_err(|error| error.to_string())?;
        }
    }

    transaction.commit().map_err(|error| error.to_string())
}

pub(super) fn load_session_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<SessionRecord>, String> {
    let row = connection
        .query_row(
            "SELECT id, region, grind_spot_id, status, started_at, elapsed_ms
             FROM sessions WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((id, region, grind_spot_id, status, started_at, elapsed_ms)) = row else {
        return Ok(None);
    };

    let mut statement = connection
        .prepare(
            "SELECT id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at, garmoth_consumable_id
             FROM session_entries WHERE session_id = ?1 ORDER BY created_at, rowid",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([&id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<i64>>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        let (
            id,
            name,
            quantity,
            unit_price,
            valuation,
            sale_multiplier,
            source,
            created_at,
            garmoth_consumable_id,
        ) = row.map_err(|error| error.to_string())?;
        entries.push(SessionEntry {
            id,
            name,
            quantity,
            unit_price,
            valuation: parse_valuation(&valuation)?,
            sale_multiplier,
            source: parse_source(&source)?,
            created_at,
            garmoth_consumable_id,
        });
    }

    Ok(Some(SessionRecord {
        id,
        region: parse_region(&region)?,
        grind_spot_id,
        status: parse_status(&status)?,
        started_at,
        elapsed_ms,
        entries,
    }))
}

pub(super) fn load_active_session_record(
    connection: &Connection,
) -> Result<Option<SessionRecord>, String> {
    let id = connection
        .query_row(
            "SELECT id FROM sessions WHERE status != 'finished' ORDER BY updated_at DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    id.map_or(Ok(None), |id| load_session_by_id(connection, &id))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    pub region: Region,
    pub grind_spot_id: Option<String>,
    pub finished_from_ms: Option<i64>,
    pub finished_before_ms: Option<i64>,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotSummary {
    pub grind_spot_id: String,
    pub session_count: i64,
    pub elapsed_ms: i64,
    pub net: f64,
    pub timed_net: f64,
    pub zero_duration_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResult {
    pub records: Vec<FinishedSessionRecord>,
    pub total_count: i64,
    pub offset: i64,
    pub spot_summaries: Vec<SpotSummary>,
}

pub(super) fn list_finished_session_records(
    connection: &Connection,
    query: &HistoryQuery,
) -> Result<HistoryResult, String> {
    if !(1..=100).contains(&query.limit) || query.offset < 0 {
        return Err("history limit must be 1–100 and offset must be nonnegative".into());
    }
    if query
        .grind_spot_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty())
    {
        return Err("grind spot ID cannot be empty".into());
    }
    if [query.finished_from_ms, query.finished_before_ms]
        .into_iter()
        .flatten()
        .any(|time| !(0..=8_640_000_000_000_000).contains(&time))
        || matches!((query.finished_from_ms, query.finished_before_ms), (Some(from), Some(before)) if from >= before)
    {
        return Err("invalid history date range".into());
    }
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let region = region_to_str(&query.region);
    // Aggregate entries per session first: entry joins must not multiply tracked time.
    let mut statement = transaction
        .prepare(
            "WITH session_values AS (
            SELECT s.id, s.grind_spot_id, s.elapsed_ms,
                COALESCE(SUM(CASE WHEN e.valuation = 'expense'
                    THEN -e.quantity * e.unit_price
                    ELSE e.quantity * e.unit_price * e.sale_multiplier END), 0.0) AS net
            FROM sessions s LEFT JOIN session_entries e ON e.session_id = s.id
            WHERE s.status = 'finished' AND s.region = ?1
                AND (?2 IS NULL OR COALESCE(s.finished_at, s.updated_at) >= ?2)
                AND (?3 IS NULL OR COALESCE(s.finished_at, s.updated_at) < ?3)
            GROUP BY s.id
        )
        SELECT grind_spot_id, COUNT(*), SUM(elapsed_ms), SUM(net),
            SUM(CASE WHEN elapsed_ms > 0 THEN net ELSE 0.0 END),
            SUM(CASE WHEN elapsed_ms = 0 THEN 1 ELSE 0 END)
        FROM session_values GROUP BY grind_spot_id ORDER BY grind_spot_id",
        )
        .map_err(|error| error.to_string())?;
    let spot_summaries = statement
        .query_map(
            params![region, query.finished_from_ms, query.finished_before_ms],
            |row| {
                Ok(SpotSummary {
                    grind_spot_id: row.get(0)?,
                    session_count: row.get(1)?,
                    elapsed_ms: row.get(2)?,
                    net: row.get(3)?,
                    timed_net: row.get(4)?,
                    zero_duration_count: row.get(5)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let total_count = spot_summaries
        .iter()
        .filter(|spot| {
            query
                .grind_spot_id
                .as_ref()
                .is_none_or(|id| *id == spot.grind_spot_id)
        })
        .map(|spot| spot.session_count)
        .sum::<i64>();
    let offset = query
        .offset
        .min(((total_count - 1).max(0) / query.limit) * query.limit);
    let mut statement = transaction
        .prepare(
            "SELECT id, COALESCE(finished_at, updated_at) FROM sessions
         WHERE status = 'finished' AND region = ?1
            AND (?2 IS NULL OR COALESCE(finished_at, updated_at) >= ?2)
            AND (?3 IS NULL OR COALESCE(finished_at, updated_at) < ?3)
            AND (?4 IS NULL OR grind_spot_id = ?4)
         ORDER BY COALESCE(finished_at, updated_at) DESC, id ASC LIMIT ?5 OFFSET ?6",
        )
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map(
            params![
                region,
                query.finished_from_ms,
                query.finished_before_ms,
                query.grind_spot_id,
                query.limit,
                offset
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    let records = ids
        .into_iter()
        .map(|(id, finished_at)| {
            let session = load_session_by_id(&transaction, &id)?
                .ok_or_else(|| format!("finished session {id} disappeared"))?;
            Ok(FinishedSessionRecord {
                session,
                finished_at,
                garmoth_upload_status: load_garmoth_upload_status(&transaction, &id)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(HistoryResult {
        records,
        total_count,
        offset,
        spot_summaries,
    })
}

pub(super) fn delete_finished_session_record(
    connection: &Connection,
    id: &str,
) -> Result<(), String> {
    let deleted = connection
        .execute(
            "DELETE FROM sessions WHERE id = ?1 AND status = 'finished'",
            [id],
        )
        .map_err(|error| error.to_string())?;
    if deleted == 1 {
        Ok(())
    } else {
        Err(format!("finished session {id} was not found"))
    }
}

pub(super) async fn delete_finished_session_at_path(
    path: &PathBuf,
    id: &str,
    operations: &GarmothOperations,
) -> Result<(), String> {
    let _guard = operations.lock().await;
    let connection = open_database(path)?;
    delete_finished_session_record(&connection, id)
}

pub(crate) fn load_session_for_upload(
    path: &PathBuf,
    session_id: &str,
) -> Result<SessionRecord, String> {
    let connection = open_database(path)?;
    load_session_by_id(&connection, session_id)?
        .ok_or_else(|| "the selected session no longer exists".into())
}

pub(super) fn reopen_session_record(
    connection: &mut Connection,
    id: &str,
) -> Result<SessionRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let session = load_session_by_id(&transaction, id)?
        .ok_or_else(|| format!("session {id} was not found"))?;
    if session.status != SessionStatus::Finished {
        return Err("only finished sessions can be reopened".into());
    }
    if load_garmoth_upload_status(&transaction, id)?.is_some() {
        return Err("sessions sent to Garmoth cannot be reopened".into());
    }

    if let Some(active) = load_active_session_record(&transaction)? {
        if active.status != SessionStatus::Idle
            || active.elapsed_ms != 0
            || !active.entries.is_empty()
        {
            return Err("finish the current active session before reopening another one".into());
        }
        transaction
            .execute("DELETE FROM sessions WHERE id = ?1", [&active.id])
            .map_err(|error| error.to_string())?;
    }

    transaction
        .execute(
            "UPDATE sessions
             SET status = 'paused', started_at = NULL, updated_at = ?1, finished_at = NULL
             WHERE id = ?2",
            params![timestamp_ms(), id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;

    load_session_by_id(connection, id)?.ok_or_else(|| format!("session {id} disappeared"))
}

pub(super) fn apply_finished_session_consumables_record(
    connection: &mut Connection,
    expected_session: &SessionRecord,
    entries: &[SessionEntry],
) -> Result<SessionRecord, String> {
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let mut session = load_session_by_id(&transaction, &expected_session.id)?
        .ok_or("The session no longer exists.")?;
    if session.status != SessionStatus::Finished {
        return Err("Only finished sessions can be corrected from History.".into());
    }
    match load_garmoth_upload_status(&transaction, &session.id)? {
        Some(GarmothUploadStatus::Unknown) => {
            return Err(
                "Consumables cannot be changed while the upload outcome is unknown.".into(),
            );
        }
        Some(GarmothUploadStatus::Success)
            if session
                .entries
                .iter()
                .any(|entry| entry.garmoth_consumable_id.is_some()) =>
        {
            return Err(
                "Consumables already recorded in an uploaded session cannot be replaced.".into(),
            );
        }
        _ => {}
    }
    if session != *expected_session {
        return Err("The session changed. Reload History before applying a preset.".into());
    }
    if entries.is_empty() || entries.len() > 100 {
        return Err("Choose 1–100 consumables.".into());
    }
    let mut item_ids = std::collections::HashSet::new();
    let mut entry_ids = std::collections::HashSet::new();
    for entry in entries {
        let Some(item_id) = entry.garmoth_consumable_id else {
            return Err("Only consumable expense rows can be applied from History.".into());
        };
        if !item_ids.insert(item_id) || !entry_ids.insert(&entry.id) {
            return Err("Consumable entries must be unique.".into());
        }
    }
    session
        .entries
        .retain(|entry| entry.garmoth_consumable_id.is_none());
    session.entries.extend_from_slice(entries);
    validate_session(&session)?;
    let mut total = 0_i64;
    for entry in entries {
        total = (entry.quantity as i64)
            .checked_mul(entry.unit_price)
            .and_then(|cost| total.checked_add(cost))
            .filter(|cost| *cost <= 9_007_199_254_740_991)
            .ok_or("Consumable cost is too large.")?;
    }
    transaction.execute(
        "DELETE FROM session_entries WHERE session_id = ?1 AND garmoth_consumable_id IS NOT NULL",
        [&session.id],
    ).map_err(|error| error.to_string())?;
    for entry in entries {
        transaction.execute(
            "INSERT INTO session_entries
                (id, session_id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at, garmoth_consumable_id)
             VALUES (?1, ?2, ?3, ?4, ?5, 'expense', 1, 'manual', ?6, ?7)",
            params![entry.id, session.id, entry.name, entry.quantity, entry.unit_price, entry.created_at, entry.garmoth_consumable_id],
        ).map_err(|error| error.to_string())?;
    }
    // Keep completion and fallback timestamps unchanged so correction does not move history rows.
    transaction.commit().map_err(|error| error.to_string())?;
    load_session_by_id(connection, &session.id)?.ok_or("The session no longer exists.".into())
}

pub(super) async fn apply_finished_session_consumables_at_path(
    path: &PathBuf,
    expected_session: &SessionRecord,
    entries: &[SessionEntry],
    operations: &GarmothOperations,
) -> Result<SessionRecord, String> {
    let _guard = operations.lock().await;
    let mut connection = open_database(path)?;
    apply_finished_session_consumables_record(&mut connection, expected_session, entries)
}

#[tauri::command]
pub async fn apply_finished_session_consumables(
    expected_session: SessionRecord,
    entries: Vec<SessionEntry>,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<SessionRecord, String> {
    apply_finished_session_consumables_at_path(&state.0, &expected_session, &entries, &operations)
        .await
}

#[tauri::command]
pub fn load_active_session(
    state: State<'_, DatabasePath>,
) -> Result<Option<SessionRecord>, String> {
    let connection = open_database(&state.0)?;
    load_active_session_record(&connection)
}

#[tauri::command]
pub fn save_session(session: SessionRecord, state: State<'_, DatabasePath>) -> Result<(), String> {
    let mut connection = open_database(&state.0)?;
    save_session_record(&mut connection, &session)
}

#[tauri::command]
pub fn list_finished_sessions(
    query: HistoryQuery,
    state: State<'_, DatabasePath>,
) -> Result<HistoryResult, String> {
    let connection = open_database(&state.0)?;
    list_finished_session_records(&connection, &query)
}

#[tauri::command]
pub async fn delete_finished_session(
    id: String,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<(), String> {
    delete_finished_session_at_path(&state.0, &id, &operations).await
}

#[tauri::command]
pub fn reopen_session(id: String, state: State<'_, DatabasePath>) -> Result<SessionRecord, String> {
    let mut connection = open_database(&state.0)?;
    reopen_session_record(&mut connection, &id)
}
