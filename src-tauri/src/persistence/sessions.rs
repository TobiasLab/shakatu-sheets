use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

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
                    id, session_id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
            "SELECT id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at
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
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, name, quantity, unit_price, valuation, sale_multiplier, source, created_at) =
            row.map_err(|error| error.to_string())?;
        entries.push(SessionEntry {
            id,
            name,
            quantity,
            unit_price,
            valuation: parse_valuation(&valuation)?,
            sale_multiplier,
            source: parse_source(&source)?,
            created_at,
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

pub(super) fn list_finished_session_records(
    connection: &Connection,
) -> Result<Vec<FinishedSessionRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, COALESCE(finished_at, updated_at)
             FROM sessions
             WHERE status = 'finished'
             ORDER BY COALESCE(finished_at, updated_at) DESC, id
             LIMIT 20",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let sessions = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    sessions
        .into_iter()
        .map(|(id, finished_at)| {
            let session = load_session_by_id(connection, &id)?
                .ok_or_else(|| format!("finished session {id} disappeared"))?;
            Ok(FinishedSessionRecord {
                session,
                finished_at,
                garmoth_upload_status: load_garmoth_upload_status(connection, &id)?,
            })
        })
        .collect()
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
    state: State<'_, DatabasePath>,
) -> Result<Vec<FinishedSessionRecord>, String> {
    let connection = open_database(&state.0)?;
    list_finished_session_records(&connection)
}

#[tauri::command]
pub fn reopen_session(id: String, state: State<'_, DatabasePath>) -> Result<SessionRecord, String> {
    let mut connection = open_database(&state.0)?;
    reopen_session_record(&mut connection, &id)
}
