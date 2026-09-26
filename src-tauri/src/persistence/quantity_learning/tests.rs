use super::*;
use std::fs;

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("quantity-learning-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn learning(&self) -> PathBuf {
        self.0.join("quantity-learning.sqlite3")
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn example(index: u32) -> QuantityExampleInput {
    let mut pixels = vec![255; 8 * 16 * 4];
    pixels[0..4].copy_from_slice(&index.to_le_bytes());
    QuantityExampleInput {
        id: format!("event-{index}"),
        profile: LearningProfile {
            font: LootFont::Korean,
            ui_scale_percent: 80,
            source_width: 3440,
            source_height: 1440,
        },
        quantity: 6,
        item_name: None,
        item_image: None,
        original_quantity: None,
        original_text: "Black Stone x &".into(),
        audit: None,
        width: 8,
        height: 16,
        pixels,
    }
}

fn enable(path: &PathBuf) {
    operate(
        path,
        LearningOperation::Settings {
            enabled: true,
            auto_allow: false,
        },
    )
    .unwrap();
}

fn audit_value() -> serde_json::Value {
    let frame = serde_json::json!({
        "frame": 12, "captureToken": 123, "batchId": 456, "roiWidth": 362, "roiHeight": 311,
        "quantityBounds": {"left": 120, "right": 128, "top": 50, "bottom": 66},
        "readings": ["Black Stone x 9", "Black Stone x &"],
        "passes": [{"threshold": 150, "scale": 2, "region": "line", "text": "Black Stone x 9"}]
    });
    serde_json::json!({"version":1,"sessionId":"session-1","generation":3,"eventId":"normal-12",
        "status":"withheld","reason":"consensus-withheld","cropFrame":frame,"frames":[frame]})
}

#[test]
fn audit_round_trips_exact_frame_evidence_and_rejects_mismatched_or_oversized_history() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    let audit = audit_value();
    let mut input = example(1);
    input.audit = Some(serde_json::from_value(audit.clone()).unwrap());
    let result = operate(&path, LearningOperation::Save { example: input }).unwrap();
    assert_eq!(
        serde_json::to_value(&result.examples[0].input.audit).unwrap(),
        audit
    );
    assert_eq!(result.examples[0].input.quantity, 6);
    let result = operate(&path, LearningOperation::Load).unwrap();
    assert_eq!(
        serde_json::to_value(&result.examples[0].input.audit).unwrap(),
        audit
    );
    for kind in 0..5 {
        let mut invalid = audit.clone();
        match kind {
            0 => invalid["cropFrame"]["quantityBounds"]["right"] = serde_json::json!(129),
            1 => invalid["frames"][0]["frame"] = serde_json::json!(99),
            2 => invalid["frames"] = serde_json::json!(vec![audit["cropFrame"].clone(); 6]),
            3 => invalid["cropFrame"]["passes"][0]["text"] = serde_json::json!("x".repeat(513)),
            _ => invalid["status"] = serde_json::json!("recognized"),
        }
        let mut input = example(kind + 2);
        input.audit = Some(serde_json::from_value(invalid).unwrap());
        assert!(operate(&path, LearningOperation::Save { example: input }).is_err());
    }
    assert_eq!(
        operate(&path, LearningOperation::Load)
            .unwrap()
            .examples
            .len(),
        1
    );
}

#[test]
fn audit_migration_preserves_version_one_examples_and_settings() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    operate(
        &path,
        LearningOperation::Save {
            example: example(1),
        },
    )
    .unwrap();
    {
        let db = open_database(&path).unwrap();
        db.execute_batch(
            "ALTER TABLE quantity_examples DROP COLUMN audit_json; ALTER TABLE quantity_examples DROP COLUMN item_name; ALTER TABLE quantity_examples DROP COLUMN item_width; ALTER TABLE quantity_examples DROP COLUMN item_height; ALTER TABLE quantity_examples DROP COLUMN item_png; PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let upgraded = operate(&path, LearningOperation::Load).unwrap();
    assert!(upgraded.enabled);
    assert_eq!(upgraded.examples.len(), 1);
    assert_eq!(upgraded.examples[0].input.pixels, example(1).pixels);
    assert_eq!(upgraded.examples[0].input.quantity, 6);
    assert!(upgraded.examples[0].input.audit.is_none());
    let db = open_database(&path).unwrap();
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn learning_does_not_modify_the_session_database_and_main_can_reopen_it() {
    let dir = TestDirectory::new();
    let session_path = dir.0.join("shakatu-sheets.sqlite3");
    {
        let mut connection = open_database(&session_path).unwrap();
        crate::persistence::migrate(&mut connection).unwrap();
        connection.execute_batch(
            "INSERT INTO sessions(id,region,grind_spot_id,status,elapsed_ms,created_at,updated_at) VALUES('existing','eu','spot','paused',100,1,1);
             INSERT INTO session_entries(id,session_id,name,quantity,unit_price,valuation,sale_multiplier,source,created_at) VALUES('entry','existing','Loot',9,100,'vendor',1,'manual',1);
             INSERT INTO settings VALUES('existing-preference','unchanged',1);
             PRAGMA wal_checkpoint(TRUNCATE);"
        ).unwrap();
    }
    let before = fs::read(&session_path).unwrap();
    assert_eq!(learning_path(&session_path), dir.learning());
    assert!(
        !operate(&dir.learning(), LearningOperation::Load)
            .unwrap()
            .enabled
    );
    assert!(
        !dir.learning().exists(),
        "loading defaults must not create a file"
    );
    enable(&dir.learning());
    operate(
        &dir.learning(),
        LearningOperation::Save {
            example: example(1),
        },
    )
    .unwrap();
    operate(
        &dir.learning(),
        LearningOperation::Delete {
            id: "event-1".into(),
        },
    )
    .unwrap();
    operate(&dir.learning(), LearningOperation::Reset).unwrap();
    assert_eq!(before, fs::read(&session_path).unwrap());
    // These are the unchanged main-branch migration and session read/write paths.
    let mut main = open_database(&session_path).unwrap();
    crate::persistence::migrate(&mut main).unwrap();
    let mut session = crate::persistence::sessions::load_active_session_record(&main)
        .unwrap()
        .unwrap();
    assert_eq!(session.entries[0].quantity, 9.0);
    session.entries[0].quantity = 10.0;
    crate::persistence::sessions::save_session_record(&mut main, &session).unwrap();
    assert_eq!(
        crate::persistence::sessions::load_active_session_record(&main)
            .unwrap()
            .unwrap()
            .entries[0]
            .quantity,
        10.0
    );
    assert_eq!(
        main.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn round_trip_png_validation_split_settings_and_reset() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    assert!(operate(
        &path,
        LearningOperation::Save {
            example: example(1)
        }
    )
    .is_err());
    enable(&path);
    for index in 1..=3 {
        operate(
            &path,
            LearningOperation::Save {
                example: example(index),
            },
        )
        .unwrap();
    }
    let loaded = operate(&path, LearningOperation::Load).unwrap();
    assert_eq!(loaded.examples.len(), 3);
    assert!(loaded.examples[0].validation);
    assert!(!loaded.examples[1].validation);
    assert_eq!(loaded.examples[0].input.pixels, example(3).pixels);
    assert_eq!(loaded.examples[0].input.original_text, "Black Stone x &");
    let repeated = operate(
        &path,
        LearningOperation::Save {
            example: example(3),
        },
    )
    .unwrap();
    assert_eq!(repeated.examples.len(), 3, "retries must be idempotent");
    assert!(loaded.examples[0].confirmed_at > 0);
    let off = operate(
        &path,
        LearningOperation::Settings {
            enabled: false,
            auto_allow: true,
        },
    )
    .unwrap();
    assert!(!off.auto_allow);
    assert_eq!(off.examples.len(), 3);
    assert!(operate(
        &path,
        LearningOperation::Save {
            example: example(4)
        }
    )
    .is_err());
    let reset = operate(&path, LearningOperation::Reset).unwrap();
    assert!(!reset.enabled && !reset.auto_allow && reset.examples.is_empty());
}

#[test]
fn invalid_input_duplicate_images_and_future_schemas_are_rejected() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    for bad in [0, -1, MAX_QUANTITY + 1] {
        let mut input = example(1);
        input.quantity = bad;
        assert!(operate(&path, LearningOperation::Save { example: input }).is_err());
    }
    let mut bad = example(1);
    bad.width = 65;
    assert!(operate(&path, LearningOperation::Save { example: bad }).is_err());
    let mut bad = example(1);
    bad.profile.ui_scale_percent = 90;
    assert!(operate(&path, LearningOperation::Save { example: bad }).is_err());
    let mut bad = example(1);
    bad.pixels.pop();
    assert!(operate(&path, LearningOperation::Save { example: bad }).is_err());
    let mut blank = example(1);
    blank.pixels.fill(0);
    assert!(operate(&path, LearningOperation::Save { example: blank }).is_err());
    operate(
        &path,
        LearningOperation::Save {
            example: example(1),
        },
    )
    .unwrap();
    let mut duplicate = example(1);
    duplicate.id = "another-event".into();
    duplicate.quantity = 9;
    assert!(operate(&path, LearningOperation::Save { example: duplicate }).is_err());
    let db = open_database(&path).unwrap();
    db.execute_batch("PRAGMA user_version = 4").unwrap();
    assert!(operate(&path, LearningOperation::Reset)
        .unwrap_err()
        .contains("version 4"));
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM quantity_examples", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn storage_is_bounded_per_profile_and_globally() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    for index in 0..260 {
        let mut input = example(index);
        let group = index / 52;
        input.profile.font = if group % 2 == 0 {
            LootFont::Korean
        } else {
            LootFont::StrongSword
        };
        input.profile.ui_scale_percent = if group < 2 { 80 } else { 100 };
        input.profile.source_width = if group == 4 { 2560 } else { 3440 };
        operate(&path, LearningOperation::Save { example: input }).unwrap();
    }
    let db = open_database(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM quantity_examples", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        MAX_EXAMPLES
    );
    assert!(
        db.query_row(
            "SELECT MAX(n) FROM (SELECT COUNT(*) n FROM quantity_examples GROUP BY profile)",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap()
            <= MAX_PROFILE_EXAMPLES
    );
    assert_eq!(
        operate(&path, LearningOperation::Load).unwrap().examples[0]
            .input
            .id,
        "event-259"
    );
}

fn named_example(index: u32, name: &str) -> QuantityExampleInput {
    let mut input = example(index);
    input.item_name = Some(name.into());
    input.item_image = Some(Box::new(LearningImage {
        width: 80,
        height: 16,
        pixels: vec![255; 80 * 16 * 4],
    }));
    let mut audit = audit_value();
    let bounds = serde_json::json!({"left":20,"right":100,"top":50,"bottom":66});
    audit["cropFrame"]["itemBounds"] = bounds.clone();
    audit["frames"][0]["itemBounds"] = bounds;
    input.audit = Some(serde_json::from_value(audit).unwrap());
    input
}

#[test]
fn item_images_round_trip_and_conflicting_item_labels_are_rejected() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    let first = named_example(1, "Black Stone");
    let saved = operate(
        &path,
        LearningOperation::Save {
            example: first.clone(),
        },
    )
    .unwrap();
    assert_eq!(
        saved.examples[0].input.item_name.as_deref(),
        Some("Black Stone")
    );
    assert_eq!(
        saved.examples[0].input.item_image.as_ref().unwrap().pixels,
        first.item_image.as_ref().unwrap().pixels
    );
    let repeated = operate(&path, LearningOperation::Save { example: first }).unwrap();
    assert_eq!(repeated.examples.len(), 1);
    // The same item with a different quantity is valid; its repeated name crop is deduplicated by the matcher.
    let mut different_quantity = named_example(2, "Black Stone");
    different_quantity.quantity = 9;
    assert_eq!(
        operate(
            &path,
            LearningOperation::Save {
                example: different_quantity
            }
        )
        .unwrap()
        .examples
        .len(),
        2
    );
    assert!(operate(
        &path,
        LearningOperation::Save {
            example: named_example(3, "Caphras Stone")
        }
    )
    .is_err());
    // A repeated number crop must not discard a newly confirmed item image.
    let mut different_item = named_example(1, "Caphras Stone");
    different_item.id = "new-item".into();
    different_item.item_image.as_mut().unwrap().pixels[0] = 0;
    let saved = operate(
        &path,
        LearningOperation::Save {
            example: different_item,
        },
    )
    .unwrap();
    assert_eq!(saved.examples.len(), 3);
    assert_eq!(
        operate(&path, LearningOperation::Load)
            .unwrap()
            .examples
            .len(),
        3
    );
}

#[test]
fn malformed_item_images_labels_and_source_bounds_are_rejected() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    for case in 0..7 {
        let mut input = named_example(case + 1, "Black Stone");
        match case {
            0 => input.item_name = None,
            1 => input.item_name = Some(" ".into()),
            2 => input.item_name = Some("x".repeat(161)),
            3 => input.item_image.as_mut().unwrap().width = 513,
            4 => {
                input.item_image.as_mut().unwrap().pixels.pop();
            }
            5 => input.item_image.as_mut().unwrap().pixels.fill(0),
            _ => {
                let mut audit = serde_json::to_value(&input.audit).unwrap();
                audit["cropFrame"]["itemBounds"]["right"] = serde_json::json!(99);
                input.audit = Some(serde_json::from_value(audit).unwrap());
            }
        }
        assert!(operate(&path, LearningOperation::Save { example: input }).is_err());
    }
    assert!(operate(&path, LearningOperation::Load)
        .unwrap()
        .examples
        .is_empty());
}

#[test]
fn item_migration_preserves_old_audits_and_disables_previously_enabled_auto_allow() {
    let dir = TestDirectory::new();
    let path = dir.learning();
    enable(&path);
    let mut input = example(1);
    input.audit = Some(serde_json::from_value(audit_value()).unwrap());
    operate(&path, LearningOperation::Save { example: input }).unwrap();
    {
        let db = open_database(&path).unwrap();
        db.execute_batch(
            "ALTER TABLE quantity_examples DROP COLUMN item_name;
            ALTER TABLE quantity_examples DROP COLUMN item_width;
            ALTER TABLE quantity_examples DROP COLUMN item_height;
            ALTER TABLE quantity_examples DROP COLUMN item_png;
            UPDATE learning_settings SET auto_allow = 1;
            PRAGMA user_version = 2;",
        )
        .unwrap();
    }
    let loaded = operate(&path, LearningOperation::Load).unwrap();
    assert!(loaded.enabled);
    assert!(!loaded.auto_allow);
    assert_eq!(loaded.examples[0].input.pixels, example(1).pixels);
    assert_eq!(
        serde_json::to_value(&loaded.examples[0].input.audit).unwrap(),
        audit_value()
    );
    assert!(loaded.examples[0].input.item_name.is_none());
    assert!(loaded.examples[0].input.item_image.is_none());
    operate(
        &path,
        LearningOperation::Settings {
            enabled: true,
            auto_allow: true,
        },
    )
    .unwrap();
    assert!(operate(&path, LearningOperation::Load).unwrap().auto_allow);
}
