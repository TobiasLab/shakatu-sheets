use std::{io::Cursor, path::PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::{loot_font::LootFont, open_database, timestamp_ms, DatabasePath};
mod audit;

const MAX_EXAMPLES: i64 = 200;
const MAX_PROFILE_EXAMPLES: i64 = 50;
const MAX_QUANTITY: i64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LearningProfile {
    font: LootFont,
    ui_scale_percent: u32,
    source_width: u32,
    source_height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuantityExampleInput {
    id: String,
    profile: LearningProfile,
    quantity: i64,
    original_quantity: Option<i64>,
    original_text: String,
    audit: Option<Box<audit::Audit>>,
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantityExample {
    #[serde(flatten)]
    input: QuantityExampleInput,
    confirmed_at: i64,
    validation: bool,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuantityLearning {
    enabled: bool,
    auto_allow: bool,
    examples: Vec<QuantityExample>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LearningOperation {
    Load,
    Settings {
        enabled: bool,
        #[serde(rename = "autoAllow")]
        auto_allow: bool,
    },
    Save {
        example: QuantityExampleInput,
    },
    Delete {
        id: String,
    },
    Reset,
}

/// All learning I/O runs off the capture/UI threads and only opens the sibling database.
#[tauri::command]
pub async fn quantity_learning(
    operation: LearningOperation,
    state: State<'_, DatabasePath>,
) -> Result<QuantityLearning, String> {
    let path = learning_path(&state.0);
    tauri::async_runtime::spawn_blocking(move || operate(&path, operation))
        .await
        .map_err(|error| error.to_string())?
}

fn learning_path(session_path: &std::path::Path) -> PathBuf {
    session_path.with_file_name("quantity-learning.sqlite3")
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let version: i64 = tx
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    match version {
        0 => tx
            .execute_batch(
                "CREATE TABLE learning_settings (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
                auto_allow INTEGER NOT NULL CHECK(auto_allow IN (0, 1)),
                sequence INTEGER NOT NULL DEFAULT 0
             );
             INSERT INTO learning_settings(id, enabled, auto_allow) VALUES(1, 0, 0);
             CREATE TABLE quantity_examples (
                id TEXT PRIMARY KEY,
                profile TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK(quantity > 0 AND quantity <= 9007199254740991),
                original_quantity INTEGER,
                original_text TEXT NOT NULL,
                width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 64),
                height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 32),
                png BLOB NOT NULL,
                confirmed_at INTEGER NOT NULL,
                sequence INTEGER NOT NULL UNIQUE,
                validation INTEGER NOT NULL CHECK(validation IN (0, 1))
             );
             PRAGMA user_version = 1;",
            )
            .map_err(|e| e.to_string())?,
        1 | 2 => {}
        _ => {
            return Err(format!(
            "Unsupported quantity learning database version {version}. Session data is unaffected."
        ))
        }
    }
    if version < 2 {
        tx.execute_batch(
            "ALTER TABLE quantity_examples ADD COLUMN audit_json TEXT; PRAGMA user_version = 2;",
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn validate(example: &QuantityExampleInput) -> Result<(), String> {
    if let Some(audit) = &example.audit {
        audit.validate(example.width, example.height)?;
    }
    let profile = &example.profile;
    if example.id.is_empty()
        || example.id.len() > 160
        || example.original_text.chars().count() > 3200
        || !matches!(profile.ui_scale_percent, 80 | 100)
        || !matches!(
            (profile.source_width, profile.source_height),
            (3440, 1440) | (2560, 1440) | (1920, 1080)
        )
        || !(1..=MAX_QUANTITY).contains(&example.quantity)
        || example
            .original_quantity
            .is_some_and(|value| !(1..=MAX_QUANTITY).contains(&value))
        || !(1..=64).contains(&example.width)
        || !(1..=32).contains(&example.height)
        || example.pixels.len() != (example.width * example.height * 4) as usize
    {
        return Err("Invalid quantity learning example.".into());
    }
    let ink: f64 = example
        .pixels
        .as_chunks::<4>()
        .0
        .iter()
        .map(|pixel| {
            let red = f64::from(pixel[0]);
            let green = f64::from(pixel[1]);
            let blue = f64::from(pixel[2]);
            if red.max(green).max(blue) - red.min(green).min(blue) > 65.0 {
                return 0.0;
            }
            let light = (red * 77.0 + green * 150.0 + blue * 29.0) / 256.0;
            ((light - 110.0) / 125.0).clamp(0.0, 1.0).powi(2)
        })
        .sum();
    if ink < 6.0 {
        return Err("The quantity image has too little readable text to learn from.".into());
    }
    Ok(())
}

fn encode(example: &QuantityExampleInput) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, example.width, example.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer
            .write_image_data(&example.pixels)
            .map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

fn decode(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if !(1..=64).contains(&width) || !(1..=32).contains(&height) || bytes.len() > 16_384 {
        return Err("Invalid saved quantity image size.".into());
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits { bytes: 65_536 });
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let info = reader.info();
    if info.width != width
        || info.height != height
        || info.color_type != png::ColorType::Rgba
        || info.bit_depth != png::BitDepth::Eight
    {
        return Err("Invalid saved quantity image format.".into());
    }
    let mut pixels = vec![0; (width * height * 4) as usize];
    reader.next_frame(&mut pixels).map_err(|e| e.to_string())?;
    Ok(pixels)
}

fn load(connection: &Connection) -> Result<QuantityLearning, String> {
    let (enabled, auto_allow) = connection
        .query_row(
            "SELECT enabled, auto_allow FROM learning_settings WHERE id = 1",
            [],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut statement = connection.prepare(
        "SELECT id, profile, quantity, original_quantity, width, height, png, confirmed_at, validation, original_text, audit_json
         FROM quantity_examples ORDER BY sequence DESC LIMIT ?1",
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([MAX_EXAMPLES], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, u32>(4)?,
                row.get::<_, u32>(5)?,
                row.get::<_, Vec<u8>>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, bool>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut examples = Vec::new();
    for row in rows {
        let (
            id,
            profile,
            quantity,
            original_quantity,
            width,
            height,
            png,
            confirmed_at,
            validation,
            original_text,
            audit_json,
        ) = row.map_err(|e| e.to_string())?;
        let input = QuantityExampleInput {
            id,
            profile: serde_json::from_str(&profile).map_err(|e| e.to_string())?,
            quantity,
            original_quantity,
            original_text,
            audit: audit_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|e| e.to_string())?,
            width,
            height,
            pixels: decode(&png, width, height)?,
        };
        validate(&input)?;
        examples.push(QuantityExample {
            input,
            confirmed_at,
            validation,
        });
    }
    Ok(QuantityLearning {
        enabled,
        auto_allow,
        examples,
    })
}

fn operate(path: &PathBuf, operation: LearningOperation) -> Result<QuantityLearning, String> {
    if matches!(operation, LearningOperation::Load) && !path.exists() {
        return Ok(QuantityLearning::default());
    }
    if let LearningOperation::Save { example } = &operation {
        validate(example)?;
    }
    let mut connection = open_database(path)?;
    migrate(&mut connection)?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    match operation {
        LearningOperation::Load => {}
        LearningOperation::Settings {
            enabled,
            auto_allow,
        } => {
            tx.execute(
                "UPDATE learning_settings SET enabled = ?1, auto_allow = ?2 WHERE id = 1",
                params![enabled, enabled && auto_allow],
            )
            .map_err(|e| e.to_string())?;
        }
        LearningOperation::Save { example } => {
            let enabled: bool = tx
                .query_row(
                    "SELECT enabled FROM learning_settings WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if !enabled {
                return Err("Enable quantity learning before saving examples.".into());
            }
            let png = encode(&example)?;
            let profile = serde_json::to_string(&example.profile).map_err(|e| e.to_string())?;
            let existing: Option<i64> = tx.query_row(
                "SELECT quantity FROM quantity_examples WHERE id = ?1 OR (profile = ?2 AND png = ?3) LIMIT 1",
                params![example.id, profile, png], |row| row.get(0),
            ).optional().map_err(|e| e.to_string())?;
            if let Some(quantity) = existing {
                if quantity != example.quantity {
                    return Err("This capture is saved with a different quantity. Delete its example before teaching it again.".into());
                }
                let result = load(&tx)?;
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(result);
            }
            tx.execute(
                "UPDATE learning_settings SET sequence = sequence + 1 WHERE id = 1",
                [],
            )
            .map_err(|e| e.to_string())?;
            let sequence: i64 = tx
                .query_row(
                    "SELECT sequence FROM learning_settings WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO quantity_examples(id, profile, quantity, original_quantity, width, height, png, confirmed_at, sequence, validation, original_text, audit_json)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![example.id, profile, example.quantity, example.original_quantity, example.width, example.height, png, timestamp_ms(), sequence, sequence % 3 == 0, example.original_text, example.audit.as_ref().map(serde_json::to_string).transpose().map_err(|e| e.to_string())?],
            ).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM quantity_examples WHERE profile = ?1 AND id NOT IN (SELECT id FROM quantity_examples WHERE profile = ?1 ORDER BY sequence DESC LIMIT ?2)", params![profile, MAX_PROFILE_EXAMPLES]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM quantity_examples WHERE id NOT IN (SELECT id FROM quantity_examples ORDER BY sequence DESC LIMIT ?1)", [MAX_EXAMPLES]).map_err(|e| e.to_string())?;
        }
        LearningOperation::Delete { id } => {
            tx.execute("DELETE FROM quantity_examples WHERE id = ?1", [id])
                .map_err(|e| e.to_string())?;
        }
        LearningOperation::Reset => {
            tx.execute_batch("DELETE FROM quantity_examples; UPDATE learning_settings SET enabled = 0, auto_allow = 0, sequence = 0 WHERE id = 1;").map_err(|e| e.to_string())?;
        }
    }
    let result = load(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests;
