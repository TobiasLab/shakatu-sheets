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
        apply_finished_session_consumables_record, delete_finished_session_at_path,
        delete_finished_session_record, list_finished_session_records, load_active_session_record,
        load_session_by_id, reopen_session_record, save_session_record, EntrySource, HistoryQuery,
        SessionEntry, SessionRecord, SessionStatus, Valuation,
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
            garmoth_consumable_id: None,
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
    assert!(list_finished_session_records(&connection, &history_query())
        .unwrap()
        .records
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
        list_finished_session_records(&connection, &history_query())
            .unwrap()
            .records[0]
            .session,
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

    let records = list_finished_session_records(&connection, &history_query())
        .unwrap()
        .records;

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
        list_finished_session_records(&connection, &history_query())
            .unwrap()
            .records[0]
            .garmoth_upload_status,
        Some(GarmothUploadStatus::Unknown)
    );
}

#[test]
fn transitions_garmoth_upload_reservations_without_duplicates() {
    let (path, mut connection) = temporary_database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    drop(connection);

    claim_garmoth_upload(&path, &finished.id, false).unwrap();
    assert_eq!(
        claim_garmoth_upload(&path, &finished.id, false).unwrap_err(),
        "this session may already exist on Garmoth; check Garmoth before taking further action"
    );
    release_garmoth_upload(&path, &finished.id).unwrap();
    claim_garmoth_upload(&path, &finished.id, false).unwrap();
    finish_garmoth_upload(&path, &finished.id).unwrap();

    let connection = open_database(&path).unwrap();
    assert_eq!(
        load_garmoth_upload_status(&connection, &finished.id).unwrap(),
        Some(GarmothUploadStatus::Success)
    );
    drop(connection);
    assert_eq!(
        claim_garmoth_upload(&path, &finished.id, false).unwrap_err(),
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
        .execute("DROP INDEX sessions_finished_region_time_idx", [])
        .unwrap();
    connection
        .execute(
            "ALTER TABLE session_entries DROP COLUMN garmoth_consumable_id",
            [],
        )
        .unwrap();
    connection
        .execute("DELETE FROM schema_migrations WHERE version >= 2", [])
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
        4
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

#[test]
fn overlay_opacity_persists_and_rejects_invalid_values() {
    use super::overlay::{load_overlay_opacity_at_path, save_overlay_opacity_at_path};

    let (path, connection) = temporary_database();
    drop(connection);
    assert_eq!(load_overlay_opacity_at_path(&path).unwrap(), 100);
    save_overlay_opacity_at_path(&path, 55).unwrap();
    for invalid in [0, 24, 101, 255] {
        assert!(save_overlay_opacity_at_path(&path, invalid).is_err());
        assert_eq!(load_overlay_opacity_at_path(&path).unwrap(), 55);
    }
    for value in [25, 100] {
        save_overlay_opacity_at_path(&path, value).unwrap();
        assert_eq!(load_overlay_opacity_at_path(&path).unwrap(), value);
    }
    save_settings(&path, &[("session_overlay_opacity", Some("invalid"))]).unwrap();
    assert_eq!(load_overlay_opacity_at_path(&path).unwrap(), 100);
    remove_temporary_database(&path);
}

#[test]
fn loot_font_defaults_persists_and_rejects_unknown_values() {
    use super::loot_font::{load_loot_font_at_path, save_loot_font_at_path, LootFont};
    let (path, connection) = temporary_database();
    drop(connection);
    assert_eq!(load_loot_font_at_path(&path).unwrap(), LootFont::Korean);
    for font in [LootFont::StrongSword, LootFont::Korean] {
        save_loot_font_at_path(&path, font).unwrap();
        assert_eq!(load_loot_font_at_path(&path).unwrap(), font);
        assert_eq!(
            serde_json::from_str::<LootFont>(&serde_json::to_string(&font).unwrap()).unwrap(),
            font
        );
    }
    assert!(serde_json::from_str::<LootFont>("\"unknown\"").is_err());
    save_settings(&path, &[("loot_font", Some("unknown"))]).unwrap();
    assert!(load_loot_font_at_path(&path).is_err());
    remove_temporary_database(&path);
}

fn history_query() -> HistoryQuery {
    HistoryQuery {
        region: Region::Eu,
        grind_spot_id: None,
        finished_from_ms: None,
        finished_before_ms: None,
        offset: 0,
        limit: 20,
    }
}

fn history_fixture(connection: &mut Connection, id: &str, spot: &str, time: i64, elapsed: i64) {
    let mut record = session(SessionStatus::Finished);
    record.id = id.into();
    record.grind_spot_id = spot.into();
    record.elapsed_ms = elapsed;
    record.entries[0].id = format!("{id}-entry");
    save_session_record(connection, &record).unwrap();
    connection
        .execute(
            "UPDATE sessions SET finished_at = ?1, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![time, id],
        )
        .unwrap();
}

#[test]
fn history_pages_all_sessions_and_filters_before_paging() {
    let mut connection = database();
    for index in 0..45 {
        history_fixture(
            &mut connection,
            &format!("s-{index:02}"),
            if index < 4 { "older" } else { "newer" },
            1000 + index / 2,
            1000,
        );
    }
    history_fixture(&mut connection, "na", "other", 5000, 1000);
    connection
        .execute("UPDATE sessions SET region = 'na' WHERE id = 'na'", [])
        .unwrap();
    let mut query = history_query();
    let first = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(first.total_count, 45);
    assert_eq!(first.records.len(), 20);
    assert_eq!(
        first
            .spot_summaries
            .iter()
            .map(|s| s.session_count)
            .sum::<i64>(),
        45
    );
    let expected_summaries = serde_json::to_value(&first.spot_summaries).unwrap();
    let mut ids = Vec::new();
    for offset in [0, 20, 40] {
        query.offset = offset;
        let page = list_finished_session_records(&connection, &query).unwrap();
        assert_eq!(
            serde_json::to_value(&page.spot_summaries).unwrap(),
            expected_summaries
        );
        ids.extend(page.records.into_iter().map(|record| record.session.id));
    }
    assert_eq!(ids.len(), 45);
    assert_eq!(ids[0], "s-44");
    assert_eq!(ids[1], "s-42");
    assert_eq!(ids[2], "s-43");
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 45);
    query.grind_spot_id = Some("older".into());
    let older = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(older.offset, 0);
    assert_eq!(older.total_count, 4);
    assert_eq!(older.records.len(), 4);
    assert_eq!(older.spot_summaries.len(), 2);
    query.finished_from_ms = Some(1001);
    query.finished_before_ms = Some(1002);
    let dated = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(
        dated
            .records
            .iter()
            .map(|r| r.session.id.as_str())
            .collect::<Vec<_>>(),
        ["s-02", "s-03"]
    );
    connection
        .execute(
            "UPDATE sessions SET finished_at = NULL WHERE id = 's-02'",
            [],
        )
        .unwrap();
    assert_eq!(
        list_finished_session_records(&connection, &query)
            .unwrap()
            .total_count,
        2
    );
    query = history_query();
    query.region = Region::Na;
    assert_eq!(
        list_finished_session_records(&connection, &query)
            .unwrap()
            .total_count,
        1
    );
    query.grind_spot_id = Some("missing".into());
    let empty = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(empty.total_count, 0);
    assert!(empty.records.is_empty());
}

#[test]
fn history_aggregates_stored_values_without_multiplying_duration() {
    let mut connection = database();
    let mut record = session(SessionStatus::Finished);
    record.elapsed_ms = 1_800_000;
    record.entries[0].quantity = 2.0;
    record.entries[0].unit_price = 101;
    record.entries[0].valuation = Valuation::Market;
    record.entries[0].sale_multiplier = 0.845;
    let mut vendor = record.entries[0].clone();
    vendor.id = "vendor".into();
    vendor.quantity = 3.0;
    vendor.unit_price = 10;
    vendor.valuation = Valuation::Vendor;
    vendor.sale_multiplier = 1.0;
    let mut expense = vendor.clone();
    expense.id = "expense".into();
    expense.quantity = 1.0;
    expense.unit_price = 250;
    expense.valuation = Valuation::Expense;
    expense.sale_multiplier = 0.0;
    record.entries.extend([vendor, expense]);
    save_session_record(&mut connection, &record).unwrap();
    history_fixture(&mut connection, "zero", &record.grind_spot_id, 1000, 0);
    history_fixture(
        &mut connection,
        "empty",
        &record.grind_spot_id,
        1000,
        5_400_000,
    );
    connection
        .execute("DELETE FROM session_entries WHERE session_id = 'empty'", [])
        .unwrap();
    let query = history_query();
    let before = list_finished_session_records(&connection, &query).unwrap();
    let spot = &before.spot_summaries[0];
    assert_eq!(spot.session_count, 3);
    assert_eq!(spot.zero_duration_count, 1);
    assert_eq!(spot.elapsed_ms, 7_200_000);
    assert!((spot.timed_net - -49.31).abs() < 1e-8);
    assert!((spot.net - (1_079_000.0 - 49.31)).abs() < 1e-8);
    connection.execute("INSERT INTO price_snapshots (region, item_id, sub_id, base_price, fetched_at) VALUES ('eu', 16001, 0, 999999, 9000)", []).unwrap();
    let after = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(
        serde_json::to_value(before).unwrap(),
        serde_json::to_value(after).unwrap()
    );
    let mut active = session(SessionStatus::Paused);
    active.id = "active".into();
    active.entries.clear();
    save_session_record(&mut connection, &active).unwrap();
    assert_eq!(
        list_finished_session_records(&connection, &query)
            .unwrap()
            .total_count,
        3
    );
}

#[test]
fn history_refreshes_after_reopen_refinish_and_last_page_deletion() {
    let mut connection = database();
    for index in 0..21 {
        history_fixture(
            &mut connection,
            &format!("s-{index:02}"),
            "spot",
            1000 + index,
            1000,
        );
    }
    let mut query = history_query();
    query.offset = 20;
    delete_finished_session_record(&connection, "s-00").unwrap();
    let page = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(page.total_count, 20);
    assert_eq!(page.offset, 0);
    assert_eq!(page.records.len(), 20);
    let mut reopened = reopen_session_record(&mut connection, "s-01").unwrap();
    assert_eq!(
        list_finished_session_records(&connection, &query)
            .unwrap()
            .total_count,
        19
    );
    reopened.status = SessionStatus::Finished;
    save_session_record(&mut connection, &reopened).unwrap();
    let page = list_finished_session_records(&connection, &query).unwrap();
    assert_eq!(page.total_count, 20);
    assert_eq!(page.records[0].session.id, "s-01");
    assert!(page.records[0].finished_at > 1020);
    assert_eq!(page.spot_summaries[0].session_count, 20);
}

#[test]
fn history_rejects_invalid_queries() {
    let connection = database();
    for limit in [0, 101, -1] {
        let mut query = history_query();
        query.limit = limit;
        assert!(list_finished_session_records(&connection, &query).is_err());
    }
    let mut query = history_query();
    query.offset = -1;
    assert!(list_finished_session_records(&connection, &query).is_err());
    query = history_query();
    query.finished_from_ms = Some(2000);
    query.finished_before_ms = Some(2000);
    assert!(list_finished_session_records(&connection, &query).is_err());
    query = history_query();
    query.finished_from_ms = Some(-1);
    assert!(list_finished_session_records(&connection, &query).is_err());
    query = history_query();
    query.grind_spot_id = Some(" ".into());
    assert!(list_finished_session_records(&connection, &query).is_err());
}

#[test]
fn history_index_migration_preserves_populated_version_two_database() {
    let mut connection = database();
    history_fixture(&mut connection, "existing", "spot", 1000, 1000);
    connection.execute_batch("DROP INDEX sessions_finished_region_time_idx; ALTER TABLE session_entries DROP COLUMN garmoth_consumable_id; DELETE FROM schema_migrations WHERE version >= 3;").unwrap();
    migrate(&mut connection).unwrap();
    migrate(&mut connection).unwrap();
    assert_eq!(
        list_finished_session_records(&connection, &history_query())
            .unwrap()
            .records[0]
            .session
            .id,
        "existing"
    );
    let plan: String = connection.query_row("EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE status='finished' AND region='eu' ORDER BY COALESCE(finished_at, updated_at) DESC, id ASC LIMIT 20", [], |row| row.get(3)).unwrap();
    assert!(plan.contains("sessions_finished_region_time_idx"), "{plan}");
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version=3",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[test]
fn explicit_reupload_keeps_unknown_blocked_and_restores_prior_success() {
    let (path, mut connection) = temporary_database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    assert!(!claim_garmoth_upload(&path, &finished.id, false).unwrap());
    finish_garmoth_upload(&path, &finished.id).unwrap();
    assert!(claim_garmoth_upload(&path, &finished.id, false).is_err());
    assert!(claim_garmoth_upload(&path, &finished.id, true).unwrap());
    assert_eq!(
        load_garmoth_upload_status(&connection, &finished.id).unwrap(),
        Some(GarmothUploadStatus::Unknown)
    );
    assert!(claim_garmoth_upload(&path, &finished.id, true).is_err());
    // A connect failure on a repeat restores success instead of removing the old marker.
    finish_garmoth_upload(&path, &finished.id).unwrap();
    assert_eq!(
        load_garmoth_upload_status(&connection, &finished.id).unwrap(),
        Some(GarmothUploadStatus::Success)
    );
    assert!(reopen_session_record(&mut connection, &finished.id).is_err());
    drop(connection);
    remove_temporary_database(&path);
}

#[test]
fn consumable_migration_preserves_old_rows_and_finished_price_snapshots() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection.execute_batch("ALTER TABLE session_entries DROP COLUMN garmoth_consumable_id; DELETE FROM schema_migrations WHERE version = 4;").unwrap();
    migrate(&mut connection).unwrap();
    migrate(&mut connection).unwrap();
    assert_eq!(
        load_session_by_id(&connection, &finished.id).unwrap(),
        Some(finished)
    );

    let mut record = session(SessionStatus::Idle);
    record.id = "consumable-session".into();
    record.entries[0].id = "consumable-entry".into();
    record.entries[0].valuation = Valuation::Expense;
    record.entries[0].garmoth_consumable_id = Some(1411);
    record.entries[0].quantity = 3.0;
    record.entries[0].unit_price = 50;
    save_session_record(&mut connection, &record).unwrap();
    assert_eq!(
        load_session_by_id(&connection, &record.id).unwrap(),
        Some(record.clone())
    );
    record.status = SessionStatus::Finished;
    save_session_record(&mut connection, &record).unwrap();
    record.entries[0].unit_price = 100;
    assert!(save_session_record(&mut connection, &record).is_err());
    let stored = load_session_by_id(&connection, &record.id)
        .unwrap()
        .unwrap();
    assert_eq!(stored.entries[0].unit_price, 50);
    assert_eq!(stored.entries[0].garmoth_consumable_id, Some(1411));
}

#[test]
fn rejects_invalid_consumable_session_metadata() {
    let mut connection = database();
    let mut record = session(SessionStatus::Idle);
    record.entries[0].garmoth_consumable_id = Some(1411);
    assert!(save_session_record(&mut connection, &record).is_err());
    record.entries[0].valuation = Valuation::Expense;
    for id in [0, -1, 9_007_199_254_740_992] {
        record.entries[0].garmoth_consumable_id = Some(id);
        assert!(save_session_record(&mut connection, &record).is_err());
    }
    record.entries[0].garmoth_consumable_id = Some(1411);
    record.entries[0].unit_price = 9_007_199_254_740_991;
    assert!(save_session_record(&mut connection, &record).is_err());
}

#[test]
fn consumable_presets_persist_and_invalid_saves_do_not_replace_them() {
    use super::consumable_presets::{load_at_path, save_at_path, ConsumablePreset};
    let (path, connection) = temporary_database();
    drop(connection);
    assert!(load_at_path(&path).unwrap().is_empty());
    let value = serde_json::json!({"id":"preset", "name":"Cheapo123", "region":"eu", "items":[
        {"itemId":1411,"name":"Perfume of Envy","quantity":3,"unitPrice":50},
        {"itemId":100001510,"name":"Wind buff","quantity":1,"unitPrice":0}
    ]});
    let preset = serde_json::from_value::<ConsumablePreset>(value.clone()).unwrap();
    save_at_path(&path, std::slice::from_ref(&preset)).unwrap();
    assert_eq!(load_at_path(&path).unwrap(), vec![preset.clone()]);
    for (field, invalid) in [
        ("quantity", 0),
        ("unitPrice", -1),
        ("itemId", 0),
        ("unitPrice", i64::MAX),
    ] {
        let mut changed = value.clone();
        changed["items"][0][field] = serde_json::json!(invalid);
        let invalid = serde_json::from_value::<ConsumablePreset>(changed).unwrap();
        assert!(save_at_path(&path, &[invalid]).is_err());
        assert_eq!(load_at_path(&path).unwrap(), vec![preset.clone()]);
    }
    assert!(save_at_path(&path, &[preset.clone(), preset.clone()]).is_err());
    save_at_path(&path, &[]).unwrap();
    assert!(load_at_path(&path).unwrap().is_empty());
    remove_temporary_database(&path);
}

fn consumable_expense(id: &str) -> SessionEntry {
    SessionEntry {
        id: id.into(),
        name: "Perfume of Envy".into(),
        quantity: 3.0,
        unit_price: 50,
        valuation: Valuation::Expense,
        sale_multiplier: 1.0,
        source: EntrySource::Manual,
        created_at: 5_000,
        garmoth_consumable_id: Some(1411),
    }
}

#[test]
fn history_consumable_correction_preserves_session_and_unrelated_entries() {
    let mut connection = database();
    let mut finished = session(SessionStatus::Finished);
    let mut manual = consumable_expense("manual-expense");
    manual.garmoth_consumable_id = None;
    finished.entries.push(manual);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "UPDATE sessions SET updated_at=12345, finished_at=NULL WHERE id=?1",
            [&finished.id],
        )
        .unwrap();
    let mut active = session(SessionStatus::Running);
    active.id = "active".into();
    active.entries[0].id = "active-loot".into();
    save_session_record(&mut connection, &active).unwrap();
    let before = list_finished_session_records(&connection, &history_query()).unwrap();
    let updated = apply_finished_session_consumables_record(
        &mut connection,
        &finished,
        &[consumable_expense("new")],
    )
    .unwrap();
    assert_eq!(updated.status, SessionStatus::Finished);
    assert_eq!(updated.elapsed_ms, finished.elapsed_ms);
    assert_eq!(updated.region, finished.region);
    assert_eq!(&updated.entries[..2], &finished.entries[..]);
    assert_eq!(
        load_active_session_record(&connection).unwrap(),
        Some(active)
    );
    let after = list_finished_session_records(&connection, &history_query()).unwrap();
    assert_eq!(after.records[0].finished_at, 12345);
    assert_eq!(
        after.spot_summaries[0].elapsed_ms,
        before.spot_summaries[0].elapsed_ms
    );
    assert_eq!(
        after.spot_summaries[0].net,
        before.spot_summaries[0].net - 150.0
    );
    assert_eq!(
        after.spot_summaries[0].timed_net,
        before.spot_summaries[0].timed_net - 150.0
    );
    let reapplied = apply_finished_session_consumables_record(
        &mut connection,
        &updated,
        &[consumable_expense("replacement")],
    )
    .unwrap();
    assert_eq!(reapplied.entries.len(), 3);
    assert!(save_session_record(&mut connection, &finished).is_err());
    save_session_record(&mut connection, &reapplied).unwrap();
    assert!(apply_finished_session_consumables_record(
        &mut connection,
        &updated,
        &[consumable_expense("stale")]
    )
    .unwrap_err()
    .contains("changed"));
}

#[test]
fn history_consumable_correction_rejects_unknown_unfinished_and_invalid_rows() {
    let mut connection = database();
    let active = session(SessionStatus::Idle);
    save_session_record(&mut connection, &active).unwrap();
    assert!(apply_finished_session_consumables_record(
        &mut connection,
        &active,
        &[consumable_expense("new")]
    )
    .is_err());
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "INSERT INTO garmoth_uploads (session_id,status,updated_at) VALUES (?1,'unknown',0)",
            [&finished.id],
        )
        .unwrap();
    assert!(apply_finished_session_consumables_record(
        &mut connection,
        &finished,
        &[consumable_expense("new")]
    )
    .is_err());
    connection
        .execute("DELETE FROM garmoth_uploads", [])
        .unwrap();
    for rows in [
        vec![],
        vec![finished.entries[0].clone()],
        vec![consumable_expense("a"), consumable_expense("b")],
    ] {
        assert!(
            apply_finished_session_consumables_record(&mut connection, &finished, &rows).is_err()
        );
    }
    let mut negative = consumable_expense("negative");
    negative.unit_price = -1;
    assert!(
        apply_finished_session_consumables_record(&mut connection, &finished, &[negative]).is_err()
    );
    assert_eq!(
        load_session_by_id(&connection, &finished.id).unwrap(),
        Some(finished)
    );
}

#[test]
fn uploaded_session_can_add_missing_consumables_without_clearing_upload_marker() {
    let mut connection = database();
    let finished = session(SessionStatus::Finished);
    save_session_record(&mut connection, &finished).unwrap();
    connection
        .execute(
            "INSERT INTO garmoth_uploads (session_id,status,updated_at) VALUES (?1,'success',0)",
            [&finished.id],
        )
        .unwrap();
    let updated = apply_finished_session_consumables_record(
        &mut connection,
        &finished,
        &[consumable_expense("new")],
    )
    .unwrap();
    assert_eq!(updated.entries.len(), finished.entries.len() + 1);
    assert_eq!(updated.status, SessionStatus::Finished);
    let status: String = connection
        .query_row(
            "SELECT status FROM garmoth_uploads WHERE session_id = ?1",
            [&finished.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "success");
    assert!(apply_finished_session_consumables_record(
        &mut connection,
        &updated,
        &[consumable_expense("replacement")],
    )
    .unwrap_err()
    .contains("cannot be replaced"));
    assert!(reopen_session_record(&mut connection, &finished.id).is_err());
}

#[test]
fn history_consumable_correction_rolls_back_failed_insertions() {
    let mut connection = database();
    let mut finished = session(SessionStatus::Finished);
    finished.entries.push(consumable_expense("old"));
    save_session_record(&mut connection, &finished).unwrap();
    let first = consumable_expense("new");
    let mut colliding = consumable_expense("entry-1");
    colliding.garmoth_consumable_id = Some(9692);
    assert!(apply_finished_session_consumables_record(
        &mut connection,
        &finished,
        &[first, colliding]
    )
    .is_err());
    assert_eq!(
        load_session_by_id(&connection, &finished.id).unwrap(),
        Some(finished)
    );
}

#[test]
fn reviewed_upload_keeps_saved_expenses_on_connect_failure_and_can_retry() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            use crate::garmoth::upload::{save_and_send_upload, GarmothUploadInput};
            let (path, mut connection) = temporary_database();
            let mut finished = session(SessionStatus::Finished);
            finished.grind_spot_id = "stars-end-revamp".into();
            finished.elapsed_ms = 3_600_000;
            finished.entries[0].name = "Corrupted Sanguine Crystal".into();
            finished.entries[0].quantity = 10.0;
            finished.entries[0].unit_price = 100;
            save_session_record(&mut connection, &finished).unwrap();
            let mut drops = serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../src/data/garmothMappings.json"
            ))
            .unwrap()["stars-end-revamp"]["drops"]
                .as_object()
                .unwrap()
                .values()
                .map(|key| (key.as_str().unwrap().to_string(), 0_i64))
                .collect::<std::collections::BTreeMap<_, _>>();
            drops.insert("56339_0".into(), 10);
            let expense = consumable_expense("review-expense");
            let net = 1000 - expense.quantity as i64 * expense.unit_price;
            let mut json = serde_json::json!({"sessionId":finished.id,"expectedSession":finished,
            "grindspotId":200,"minutes":60,"hourly":net,"total":net,"drops":drops,"global":true,
            "agris":-1,"rate":250.25,"consumableEntries":[expense]});
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            drop(listener);
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(100))
                .build()
                .unwrap();
            let make_request = || client.post(format!("http://{address}")).build().unwrap();
            let state = super::DatabasePath(path.clone());
            let operations = GarmothOperations::default();
            let input: GarmothUploadInput = serde_json::from_value(json.clone()).unwrap();
            // A stale draft must fail before changing any local entries or upload marker.
            json["expectedSession"]["elapsedMs"] = serde_json::json!(1);
            let stale = serde_json::from_value(json.clone()).unwrap();
            assert!(
                save_and_send_upload(&stale, &state, client.clone(), make_request())
                    .await
                    .is_err()
            );
            assert_eq!(
                load_session_by_id(&connection, &finished.id).unwrap(),
                Some(finished.clone())
            );
            let guard = operations.lock().await;
            let pending = async {
                let _guard = operations.lock().await;
                save_and_send_upload(&input, &state, client.clone(), make_request()).await
            };
            tokio::pin!(pending);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut pending)
                    .await
                    .is_err()
            );
            claim_garmoth_upload(&path, &finished.id, false).unwrap();
            drop(guard);
            assert!(pending.await.is_err());
            assert_eq!(
                load_session_by_id(&connection, &finished.id).unwrap(),
                Some(finished.clone())
            );
            release_garmoth_upload(&path, &finished.id).unwrap();
            let result = serde_json::to_value(
                save_and_send_upload(&input, &state, client.clone(), make_request())
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(result["status"], "failed");
            assert!(result["message"]
                .as_str()
                .unwrap()
                .contains("Consumables saved"));
            assert_eq!(
                result["savedSession"]["entries"].as_array().unwrap().len(),
                2
            );
            assert_eq!(
                load_garmoth_upload_status(&connection, &finished.id).unwrap(),
                None
            );
            // Retry uses the returned snapshot; it does not duplicate the saved expenses.
            json["expectedSession"] = result["savedSession"].clone();
            json.as_object_mut().unwrap().remove("consumableEntries");
            let input = serde_json::from_value(json).unwrap();
            let result = serde_json::to_value(
                save_and_send_upload(&input, &state, client.clone(), make_request())
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(result["status"], "failed");
            assert!(result["savedSession"].is_null());
            assert_eq!(
                load_session_by_id(&connection, &finished.id)
                    .unwrap()
                    .unwrap()
                    .entries
                    .len(),
                2
            );
            drop(connection);
            remove_temporary_database(&path);
        });
}
