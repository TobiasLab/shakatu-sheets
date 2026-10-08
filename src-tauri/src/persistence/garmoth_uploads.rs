use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::timestamp_ms;

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
        _ => Err(format!("Unknown Garmoth upload status: {value}")),
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
    connection: &mut Connection,
    session_id: &str,
    repeat_upload: bool,
) -> Result<bool, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let status = transaction
        .query_row(
            "SELECT status FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "The selected session no longer exists.".to_string())?;
    if status != "finished" {
        return Err("Only finished sessions can be uploaded.".into());
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
            GarmothUploadStatus::Success => "This session was already uploaded to Garmoth.",
            GarmothUploadStatus::Unknown => {
                "This session may already exist on Garmoth; check Garmoth before taking further action."
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

pub(crate) fn finish_garmoth_upload(
    connection: &Connection,
    session_id: &str,
) -> Result<(), String> {
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
        Err("Garmoth upload reservation disappeared.".into())
    }
}

/// Settles an upload Garmoth never confirmed, after the user checked their Garmoth grind tracker: `uploaded` marks it
/// uploaded, otherwise the session becomes uploadable again. Callers hold `GarmothOperations`, so an upload still in
/// flight keeps its reservation.
pub(crate) fn resolve_unknown_garmoth_upload(
    connection: &Connection,
    session_id: &str,
    uploaded: bool,
) -> Result<(), String> {
    let changed = if uploaded {
        connection.execute(
            "UPDATE garmoth_uploads SET status = 'success', updated_at = ?1
             WHERE session_id = ?2 AND status = 'unknown'",
            params![timestamp_ms(), session_id],
        )
    } else {
        connection.execute(
            "DELETE FROM garmoth_uploads WHERE session_id = ?1 AND status = 'unknown'",
            [session_id],
        )
    }
    .map_err(|error| error.to_string())?;
    if changed == 1 {
        Ok(())
    } else {
        Err("This session no longer has an unconfirmed Garmoth upload. Reload History.".into())
    }
}

pub(crate) fn release_garmoth_upload(
    connection: &Connection,
    session_id: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "DELETE FROM garmoth_uploads WHERE session_id = ?1 AND status = 'unknown'",
            [session_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 1 {
        Ok(())
    } else {
        Err("Garmoth upload reservation disappeared.".into())
    }
}
