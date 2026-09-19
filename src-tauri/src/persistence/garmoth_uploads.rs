use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::{open_database, timestamp_ms};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GarmothUploadStatus {
    Unknown,
    Success,
}

fn parse_garmoth_upload_status(value: &str) -> Result<GarmothUploadStatus, String> {
    match value {
        "unknown" => Ok(GarmothUploadStatus::Unknown),
        "success" => Ok(GarmothUploadStatus::Success),
        _ => Err(format!("unknown Garmoth upload status: {value}")),
    }
}

pub(super) fn load_garmoth_upload_status(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<GarmothUploadStatus>, String> {
    connection
        .query_row(
            "SELECT status FROM garmoth_uploads WHERE session_id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(|status| parse_garmoth_upload_status(&status))
        .transpose()
}

pub(crate) fn claim_garmoth_upload(
    path: &PathBuf,
    session_id: &str,
    repeat_upload: bool,
) -> Result<bool, String> {
    let mut connection = open_database(path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let status = transaction
        .query_row(
            "SELECT status FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "the selected session no longer exists".to_string())?;
    if status != "finished" {
        return Err("only finished sessions can be uploaded".into());
    }
    let previous = load_garmoth_upload_status(&transaction, session_id)?;
    if repeat_upload && previous == Some(GarmothUploadStatus::Success) {
        transaction.execute(
            "UPDATE garmoth_uploads SET status = 'unknown', updated_at = ?1 WHERE session_id = ?2",
            params![timestamp_ms(), session_id],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(true);
    }
    if let Some(status) = previous {
        return Err(match status {
            GarmothUploadStatus::Success => "this session was already uploaded to Garmoth",
            GarmothUploadStatus::Unknown => {
                "this session may already exist on Garmoth; check Garmoth before taking further action"
            }
        }
        .into());
    }
    transaction
        .execute(
            "INSERT INTO garmoth_uploads (session_id, status, updated_at) VALUES (?1, 'unknown', ?2)",
            params![session_id, timestamp_ms()],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(false)
}

pub(crate) fn finish_garmoth_upload(path: &PathBuf, session_id: &str) -> Result<(), String> {
    let connection = open_database(path)?;
    let changed = connection
        .execute(
            "UPDATE garmoth_uploads SET status = 'success', updated_at = ?1
             WHERE session_id = ?2 AND status = 'unknown'",
            params![timestamp_ms(), session_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 1 {
        Ok(())
    } else {
        Err("Garmoth upload reservation disappeared".into())
    }
}

pub(crate) fn release_garmoth_upload(path: &PathBuf, session_id: &str) -> Result<(), String> {
    let connection = open_database(path)?;
    let changed = connection
        .execute(
            "DELETE FROM garmoth_uploads WHERE session_id = ?1 AND status = 'unknown'",
            [session_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 1 {
        Ok(())
    } else {
        Err("Garmoth upload reservation disappeared".into())
    }
}
