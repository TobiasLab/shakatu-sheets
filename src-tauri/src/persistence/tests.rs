use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;

use crate::garmoth::GarmothOperations;

use super::{
    configure_connection,
    garmoth_uploads::{
        claim_garmoth_upload, finish_garmoth_upload, load_garmoth_upload_status,
        release_garmoth_upload, GarmothUploadStatus,
    },
    market_prices::{load_market_price_records, MarketPriceSnapshot, Region},
    migrate, open_database,
    sessions::{
        delete_finished_session_at_path, delete_finished_session_record,
        list_finished_session_records, load_active_session_record, load_session_by_id,
        reopen_session_record, save_session_record, EntrySource, SessionEntry, SessionRecord,
        SessionStatus, Valuation,
    },
    settings::{load_setting, save_settings, save_settings_if_unchanged},
};

fn temporary_database() -> (PathBuf, Connection) {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "shakatu-sheets-test-{}-{nonce}.sqlite3",
        std::process::id()
    ));
    let mut connection = open_database(&path).expect("open temporary database");
    migrate(&mut connection).expect("migrate temporary database");
    (path, connection)
}

fn remove_temporary_database(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

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
            source: EntrySource::Manual,
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
    let mut expected = session(SessionStatus::Running);
    expected.entries[0].source = EntrySource::Recognition;

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
fn reopens_a_finished_session_and_replaces_an_empty_placeholder() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    let mut placeholder = session(SessionStatus::Idle);
    placeholder.id = "placeholder".into();
    placeholder.elapsed_ms = 0;
    placeholder.entries.clear();
    save_session_record(&mut connection, &placeholder).unwrap();

    let reopened = reopen_session_record(&mut connection, &finished.id).unwrap();

    assert_eq!(reopened.status, SessionStatus::Paused);
    assert_eq!(
        load_active_session_record(&connection).unwrap(),
        Some(reopened)
    );
    assert_eq!(
        load_session_by_id(&connection, &placeholder.id).unwrap(),
        None
    );
    assert!(list_finished_session_records(&connection)
        .unwrap()
        .is_empty());
}

#[test]
fn refuses_to_replace_an_active_session_with_progress() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    let mut active = session(SessionStatus::Paused);
    active.id = "active".into();
    active.entries[0].id = "active-entry".into();
    save_session_record(&mut connection, &active).unwrap();

    assert_eq!(
        reopen_session_record(&mut connection, &finished.id).unwrap_err(),
        "finish the current active session before reopening another one"
    );
    assert_eq!(
        load_active_session_record(&connection).unwrap(),
        Some(active)
    );
    assert_eq!(
        list_finished_session_records(&connection).unwrap()[0].session,
        finished
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

#[test]
fn lists_finished_sessions_with_their_timestamps() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();

    let records = list_finished_session_records(&connection).unwrap();

    assert_eq!(records.len(), 1);
    assert_eq!(records[0].session, finished);
    assert!(records[0].finished_at > 0);
}

#[test]
fn deletes_a_finished_session_without_touching_the_active_session() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "INSERT INTO garmoth_uploads (session_id, status, updated_at)
             VALUES (?1, 'success', 1000)",
            [&finished.id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO price_snapshots (session_id, region, item_id, sub_id, base_price, fetched_at)
             VALUES (?1, 'eu', 1, 0, 100, 1000),
                    (NULL, 'eu', 2, 0, 200, 1000)",
            [&finished.id],
        )
        .unwrap();
    let mut active = session(SessionStatus::Paused);
    active.id = "active".into();
    active.entries[0].id = "active-entry".into();
    save_session_record(&mut connection, &active).unwrap();

    delete_finished_session_record(&connection, &finished.id).unwrap();

    assert_eq!(load_session_by_id(&connection, &finished.id).unwrap(), None);
    assert_eq!(
        load_active_session_record(&connection).unwrap(),
        Some(active)
    );
    assert_eq!(
        load_garmoth_upload_status(&connection, &finished.id).unwrap(),
        None
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM session_entries WHERE session_id = ?1",
                [&finished.id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM price_snapshots", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn refuses_to_delete_unfinished_sessions() {
    let mut connection = database();
    for (index, status) in [
        SessionStatus::Idle,
        SessionStatus::Running,
        SessionStatus::Paused,
    ]
    .into_iter()
    .enumerate()
    {
        let mut active = session(status);
        active.id = format!("active-{index}");
        active.entries[0].id = format!("active-entry-{index}");
        save_session_record(&mut connection, &active).unwrap();

        assert_eq!(
            delete_finished_session_record(&connection, &active.id).unwrap_err(),
            format!("finished session {} was not found", active.id)
        );
        assert_eq!(
            load_session_by_id(&connection, &active.id).unwrap(),
            Some(active)
        );
    }
}

#[test]
fn serializes_session_deletion_with_garmoth_operations() {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(async {
            let (path, mut connection) = temporary_database();
            let finished = session(SessionStatus::Finished);
            save_session_record(&mut connection, &finished).unwrap();
            drop(connection);
            let operations = GarmothOperations::default();
            let guard = operations.lock().await;
            let deletion = delete_finished_session_at_path(&path, &finished.id, &operations);
            tokio::pin!(deletion);

            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut deletion)
                    .await
                    .is_err()
            );
            drop(guard);
            deletion.await.unwrap();

            let connection = open_database(&path).unwrap();
            assert_eq!(load_session_by_id(&connection, &finished.id).unwrap(), None);
            drop(connection);
            remove_temporary_database(&path);
        });
}

#[test]
fn refuses_to_reopen_a_session_reserved_for_garmoth() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "INSERT INTO garmoth_uploads (session_id, status, updated_at)
             VALUES (?1, 'unknown', 1000)",
            [&finished.id],
        )
        .unwrap();

    assert_eq!(
        reopen_session_record(&mut connection, &finished.id).unwrap_err(),
        "sessions sent to Garmoth cannot be reopened"
    );
    assert_eq!(
        list_finished_session_records(&connection).unwrap()[0].garmoth_upload_status,
        Some(GarmothUploadStatus::Unknown)
    );
}

#[test]
fn transitions_garmoth_upload_reservations_without_duplicates() {
    let (path, mut connection) = temporary_database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    drop(connection);

    claim_garmoth_upload(&path, &finished.id).unwrap();
    assert_eq!(
        claim_garmoth_upload(&path, &finished.id).unwrap_err(),
        "this session may already exist on Garmoth; check Garmoth before taking further action"
    );
    release_garmoth_upload(&path, &finished.id).unwrap();
    claim_garmoth_upload(&path, &finished.id).unwrap();
    finish_garmoth_upload(&path, &finished.id).unwrap();

    let connection = open_database(&path).unwrap();
    assert_eq!(
        load_garmoth_upload_status(&connection, &finished.id).unwrap(),
        Some(GarmothUploadStatus::Success)
    );
    drop(connection);
    assert_eq!(
        claim_garmoth_upload(&path, &finished.id).unwrap_err(),
        "this session was already uploaded to Garmoth"
    );
    remove_temporary_database(&path);
}

#[test]
fn upgrades_a_populated_version_one_database() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('existing', 'value', 1000)",
            [],
        )
        .unwrap();
    connection
        .execute("DROP TABLE garmoth_uploads", [])
        .unwrap();
    connection
        .execute("DELETE FROM schema_migrations WHERE version = 2", [])
        .unwrap();

    migrate(&mut connection).unwrap();

    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'existing'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "value"
    );
    assert_eq!(
        load_session_by_id(&connection, &finished.id).unwrap(),
        Some(finished)
    );
    assert_eq!(
        connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
}

#[test]
fn conditionally_saves_settings_only_for_the_expected_key() {
    let (path, connection) = temporary_database();
    drop(connection);
    save_settings(&path, &[("api-key", Some("old"))]).unwrap();

    assert!(save_settings_if_unchanged(
        &path,
        "api-key",
        "old",
        &[("characters", Some("old-account"))],
    )
    .unwrap());
    save_settings(&path, &[("api-key", Some("new"))]).unwrap();
    assert!(
        !save_settings_if_unchanged(&path, "api-key", "old", &[("characters", Some("stale"))],)
            .unwrap()
    );
    assert_eq!(
        load_setting(&path, "characters").unwrap().as_deref(),
        Some("old-account")
    );
    remove_temporary_database(&path);
}

#[cfg(unix)]
#[test]
fn restricts_local_database_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let (path, connection) = temporary_database();
    drop(connection);

    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    remove_temporary_database(&path);
}
