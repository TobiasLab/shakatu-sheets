use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub(crate) mod consumable_presets;
mod garmoth_uploads;
pub(crate) mod loot_font;
pub(crate) mod market_prices;
pub(crate) mod overlay;
pub(crate) mod quantity_learning;
pub(crate) mod sessions;
mod settings;

pub(crate) use garmoth_uploads::{
    claim_garmoth_upload, finish_garmoth_upload, release_garmoth_upload,
};
pub(crate) use market_prices::{save_market_price_records, MarketPriceSnapshot, Region};
pub(crate) use sessions::{load_session_for_upload, SessionEntry, SessionStatus, Valuation};
pub(crate) use settings::{load_setting, save_settings, save_settings_if_unchanged};

const DATABASE_VERSION: i64 = 5;

pub struct DatabasePath(pub PathBuf);

/// Managed instead of `DatabasePath` when startup cannot open the database, so the window can report why.
pub struct DatabaseInitError(pub String);

pub fn initialize_database(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = match std::env::var_os("SHAKATU_DATA_DIR") {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("SHAKATU_DATA_DIR must be an absolute directory path.".into());
            }
            path
        }
        None => app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?,
    };
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    secure_directory(&app_data_dir)?;

    let path = app_data_dir.join("shakatu-sheets.sqlite3");
    let mut connection = open_database(&path)?;
    migrate(&mut connection)?;
    Ok(path)
}

fn open_database(path: &PathBuf) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    configure_connection(&connection)?;
    secure_database_files(path)?;
    Ok(connection)
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_database_files(path: &Path) -> Result<(), String> {
    use std::{ffi::OsString, os::unix::fs::PermissionsExt};

    for suffix in ["", "-wal", "-shm"] {
        let mut file = OsString::from(path.as_os_str());
        file.push(suffix);
        let file = PathBuf::from(file);
        match fs::set_permissions(&file, fs::Permissions::from_mode(0o600)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn secure_database_files(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;",
        )
        .map_err(|error| error.to_string())
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );",
        )
        .map_err(|error| error.to_string())?;

    let mut current_version = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;

    if current_version > DATABASE_VERSION {
        return Err(format!(
            "database version {current_version} is newer than supported version {DATABASE_VERSION}"
        ));
    }

    if current_version < 1 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    region TEXT NOT NULL CHECK (region IN ('eu', 'na')),
                    grind_spot_id TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'paused', 'finished')),
                    started_at INTEGER,
                    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    finished_at INTEGER
                );

                CREATE TABLE session_entries (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    quantity REAL NOT NULL CHECK (quantity > 0),
                    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
                    valuation TEXT NOT NULL CHECK (valuation IN ('market', 'vendor', 'expense')),
                    sale_multiplier REAL NOT NULL CHECK (sale_multiplier >= 0 AND sale_multiplier <= 1),
                    source TEXT NOT NULL CHECK (source IN ('manual', 'recognition')),
                    created_at INTEGER NOT NULL
                );

                CREATE TABLE price_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                    region TEXT NOT NULL,
                    item_id INTEGER NOT NULL,
                    sub_id INTEGER NOT NULL DEFAULT 0,
                    base_price INTEGER NOT NULL CHECK (base_price >= 0),
                    fetched_at INTEGER NOT NULL
                );

                CREATE TABLE settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );

                CREATE INDEX sessions_status_updated_idx ON sessions(status, updated_at DESC);
                CREATE INDEX session_entries_session_idx ON session_entries(session_id, created_at);
                CREATE INDEX price_snapshots_lookup_idx
                    ON price_snapshots(region, item_id, sub_id, fetched_at DESC);",
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations (version, applied_at)
                 VALUES (1, unixepoch('subsec') * 1000)",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        current_version = 1;
    }

    if current_version < 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "CREATE TABLE garmoth_uploads (
                    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
                    status TEXT NOT NULL CHECK (status IN ('unknown', 'success')),
                    updated_at INTEGER NOT NULL
                );

                INSERT INTO schema_migrations (version, applied_at)
                VALUES (2, unixepoch('subsec') * 1000);",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        current_version = 2;
    }

    if current_version < 3 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                "CREATE INDEX sessions_finished_region_time_idx
                ON sessions(region, COALESCE(finished_at, updated_at) DESC, id ASC)
                WHERE status = 'finished';
             INSERT INTO schema_migrations (version, applied_at)
                VALUES (3, unixepoch('subsec') * 1000);",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        current_version = 3;
    }

    if current_version < 4 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction.execute_batch(
            "ALTER TABLE session_entries ADD COLUMN garmoth_consumable_id INTEGER
                CHECK (garmoth_consumable_id IS NULL OR
                    (garmoth_consumable_id > 0 AND garmoth_consumable_id <= 9007199254740991 AND valuation = 'expense'));
             INSERT INTO schema_migrations (version, applied_at)
                VALUES (4, unixepoch('subsec') * 1000);"
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        current_version = 4;
    }

    if current_version < 5 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        // Net silver over elapsed session time, recorded whenever an active session's net changes.
        transaction
            .execute_batch(
                "CREATE TABLE session_net_samples (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
                    net INTEGER NOT NULL,
                    PRIMARY KEY (session_id, elapsed_ms)
                ) WITHOUT ROWID;
             INSERT INTO schema_migrations (version, applied_at)
                VALUES (5, unixepoch('subsec') * 1000);",
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        current_version = 5;
    }

    if current_version != DATABASE_VERSION {
        return Err(format!(
            "database migration stopped at version {current_version}; expected {DATABASE_VERSION}"
        ));
    }

    Ok(())
}

pub(crate) fn timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
}

#[cfg(test)]
mod tests;
