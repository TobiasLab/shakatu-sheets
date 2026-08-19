use std::{fs, path::PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

const DATABASE_VERSION: i64 = 1;

pub struct DatabasePath(pub PathBuf);

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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub name: String,
    pub quantity: f64,
    pub unit_price: i64,
    pub valuation: Valuation,
    pub sale_multiplier: f64,
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

pub fn initialize_database(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;

    let path = app_data_dir.join("shakatu-sheets.sqlite3");
    let mut connection = open_database(&path)?;
    migrate(&mut connection)?;
    Ok(path)
}

fn open_database(path: &PathBuf) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    configure_connection(&connection)?;
    Ok(connection)
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

    if current_version != DATABASE_VERSION {
        return Err(format!(
            "database migration stopped at version {current_version}; expected {DATABASE_VERSION}"
        ));
    }

    Ok(())
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

fn save_session_record(connection: &mut Connection, session: &SessionRecord) -> Result<(), String> {
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
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual', ?8)",
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
                    entry.created_at,
                ])
                .map_err(|error| error.to_string())?;
        }
    }

    transaction.commit().map_err(|error| error.to_string())
}

fn load_session_by_id(connection: &Connection, id: &str) -> Result<Option<SessionRecord>, String> {
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
            "SELECT id, name, quantity, unit_price, valuation, sale_multiplier, created_at
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
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    for row in rows {
        let (id, name, quantity, unit_price, valuation, sale_multiplier, created_at) =
            row.map_err(|error| error.to_string())?;
        entries.push(SessionEntry {
            id,
            name,
            quantity,
            unit_price,
            valuation: parse_valuation(&valuation)?,
            sale_multiplier,
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

fn load_active_session_record(connection: &Connection) -> Result<Option<SessionRecord>, String> {
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

fn load_market_price_records(
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

pub(crate) fn timestamp_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as i64)
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
pub fn load_market_prices(
    region: Region,
    state: State<'_, DatabasePath>,
) -> Result<Vec<MarketPriceSnapshot>, String> {
    let connection = open_database(&state.0)?;
    load_market_price_records(&connection, region)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(status: SessionStatus) -> SessionRecord {
        SessionRecord {
            id: "session-1".into(),
            region: Region::Eu,
            grind_spot_id: "sycraia-lower-revamp".into(),
            status,
            started_at: (status == SessionStatus::Running).then_some(1_000),
            elapsed_ms: 5_000,
            entries: vec![SessionEntry {
                id: "entry-1".into(),
                name: "Ancient Undersea Weapon Power Stone".into(),
                quantity: 10.0,
                unit_price: 107_900,
                valuation: Valuation::Vendor,
                sale_multiplier: 1.0,
                created_at: 2_000,
            }],
        }
    }

    fn database() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        configure_connection(&connection).expect("configure database");
        migrate(&mut connection).expect("migrate database");
        connection
    }

    #[test]
    fn migrates_and_round_trips_an_active_session() {
        let mut connection = database();
        let expected = session(SessionStatus::Running);

        save_session_record(&mut connection, &expected).expect("save session");

        assert_eq!(
            load_active_session_record(&connection).unwrap(),
            Some(expected)
        );
    }

    #[test]
    fn finished_sessions_are_immutable() {
        let mut connection = database();
        let finished = session(SessionStatus::Finished);
        save_session_record(&mut connection, &finished).expect("finish session");

        assert_eq!(load_active_session_record(&connection).unwrap(), None);
        assert_eq!(
            load_session_by_id(&connection, &finished.id).unwrap(),
            Some(finished.clone())
        );

        let mut changed = finished;
        changed.elapsed_ms += 1;
        assert_eq!(
            save_session_record(&mut connection, &changed).unwrap_err(),
            "finished sessions are immutable"
        );
    }

    #[test]
    fn rejects_invalid_timer_state() {
        let mut connection = database();
        let mut invalid = session(SessionStatus::Paused);
        invalid.started_at = Some(1_000);

        assert_eq!(
            save_session_record(&mut connection, &invalid).unwrap_err(),
            "only running sessions may have a start timestamp"
        );
    }

    #[test]
    fn loads_the_latest_market_prices_for_each_region() {
        let connection = database();
        connection
            .execute(
                "INSERT INTO price_snapshots (region, item_id, sub_id, base_price, fetched_at)
                 VALUES ('eu', 16001, 0, 100000, 1000),
                        ('eu', 16001, 0, 129000, 2000),
                        ('na', 16001, 0, 218000, 3000)",
                [],
            )
            .unwrap();

        assert_eq!(
            load_market_price_records(&connection, Region::Eu).unwrap(),
            vec![MarketPriceSnapshot {
                item_id: 16_001,
                sub_id: 0,
                base_price: 129_000,
                fetched_at: 2_000,
            }]
        );
        assert_eq!(
            load_market_price_records(&connection, Region::Na).unwrap()[0].base_price,
            218_000
        );
    }
}
