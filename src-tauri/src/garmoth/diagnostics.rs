use serde_json::{json, Value};
use tauri::State;

use crate::persistence::{load_setting, DatabasePath};

use super::{get, parse_stored_characters, stored_api_key, GarmothOperations, CHARACTERS_SETTING};

fn consumable_field(key: &str) -> bool {
    matches!(
        key,
        "consumables"
            | "consumable"
            | "consumable_preset"
            | "consumablePreset"
            | "consumable_presets"
            | "consumablePresets"
    )
}

// Unknown keys can contain personal data; showing them requires an explicit UI opt-in.
fn field_label(key: &str, include_field_names: bool) -> &str {
    if include_field_names {
        if key.is_empty() || key.len() > 80 || key.chars().any(char::is_control) {
            return "[redacted field]";
        }
        if key.bytes().all(|byte| byte.is_ascii_digit()) {
            return "[numeric key]";
        }
        return key;
    }
    if consumable_field(key) {
        return key;
    }
    match key {
        "id" | "name" | "items" | "item" | "item_id" | "itemId" | "main_key" | "sub_key"
        | "price" | "unit_price" | "unitPrice" | "quantity" | "amount" | "duration"
        | "duration_ms" | "buffs" | "effects" | "preset" | "preset_id" | "presetId" | "data"
        | "enabled" | "active" | "selected" | "icon" | "img" | "cost" | "build" | "builds"
        | "presets" | "character" | "characters" | "settings" | "equipment" | "loadout"
        | "loadouts" | "buff" | "consumable_ids" | "consumableIds" | "consumable_id"
        | "consumableId" | "consumable_data" | "consumableData" | "preset_data" | "presetData"
        | "class" | "spec" => key,
        _ => "[redacted field]",
    }
}

fn shape(value: &Value, depth: usize, include_field_names: bool) -> Value {
    if depth >= 8 {
        return json!({"truncated": true});
    }
    match value {
        Value::Object(fields) => {
            json!({"type": "object", "fields": fields.iter().take(40).map(|(key, value)| {
            json!({"field": field_label(key, include_field_names), "shape": shape(value, depth + 1, include_field_names)})
        }).collect::<Vec<_>>(), "truncated": fields.len() > 40})
        }
        Value::Array(items) => json!({"type": "array", "count": items.len(),
            "samples": items.iter().take(3).map(|item| shape(item, depth + 1, include_field_names)).collect::<Vec<_>>(),
            "truncated": items.len() > 3}),
        Value::Null => json!({"type": "null"}),
        Value::Bool(_) => json!({"type": "boolean"}),
        Value::Number(_) => json!({"type": "number"}),
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(decoded) if decoded.is_object() || decoded.is_array() => {
                json!({"type": "json-string", "shape": shape(&decoded, depth + 1, include_field_names)})
            }
            _ => json!({"type": "string"}),
        },
    }
}

fn collect(value: &Value, depth: usize, matches: &mut Vec<Value>, truncated: &mut bool) {
    if depth >= 16 || matches.len() >= 20 {
        *truncated = true;
        return;
    }
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if consumable_field(key) {
                    if matches.len() < 20 {
                        matches.push(json!({"field": key, "shape": shape(value, 0, false)}));
                    } else {
                        *truncated = true;
                    }
                } else {
                    collect(value, depth + 1, matches, truncated);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect(item, depth + 1, matches, truncated);
            }
        }
        Value::String(text) => {
            if let Ok(decoded) = serde_json::from_str::<Value>(text) {
                if decoded.is_object() || decoded.is_array() {
                    collect(&decoded, depth + 1, matches, truncated);
                }
            }
        }
        _ => {}
    }
}

fn report(body: &[u8], character_id: &str, include_field_names: bool) -> Result<String, String> {
    let response: Value = serde_json::from_slice(body)
        .map_err(|_| "Garmoth returned invalid character JSON".to_string())?;
    let rows = response
        .as_array()
        .ok_or("Garmoth returned an unexpected character response")?;
    if rows.len() != 1 || rows[0].get("url").and_then(Value::as_str) != Some(character_id) {
        return Err("Garmoth did not return the requested character".into());
    }
    let mut matches = Vec::new();
    let mut truncated = false;
    collect(&rows[0], 0, &mut matches, &mut truncated);
    serde_json::to_string_pretty(&json!({
        "reportVersion": 3,
        "fieldNamesIncluded": include_field_names,
        "responseShape": shape(&rows[0], 0, include_field_names),
        "valuesIncluded": false,
        "status": if matches.is_empty() { "no recognized consumable fields" } else { "consumable fields found" },
        "truncated": truncated,
        "fields": matches,
    })).map_err(|_| "Could not format the consumable report".into())
}

#[tauri::command]
pub(crate) async fn inspect_garmoth_consumables(
    character_id: String,
    include_field_names: bool,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<String, String> {
    let _guard = operations.lock().await;
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    if !characters
        .iter()
        .any(|character| character.id == character_id)
    {
        return Err("Select a fetched Garmoth character first".into());
    }
    let response = get(
        "/gear-planner/getCharacterBuilds",
        &[("ids", &character_id)],
        &stored_api_key(&state.0)?,
        "inspecting consumables",
    )
    .await?;
    report(&response, &character_id, include_field_names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_nested_schema_without_personal_values_or_keys() {
        let body = br#"[{"url":"private-character","name":"Private Name","apiKey":"secret-key","gear":{"private-user":42},"data":{"consumables":{"name":"Private Preset","items":[{"item_id":12345,"price":987654,"private-key":"secret","notes":"private notes"}]}}}]"#;
        let output = report(body, "private-character", false).unwrap();
        for secret in [
            "private", "Private", "secret", "12345", "987654", "apiKey", "gear", "notes",
        ] {
            assert!(!output.contains(secret), "leaked {secret}");
        }
        assert!(output.contains("item_id"));
        assert!(output.contains("price"));
        assert!(output.contains("number"));
    }

    #[test]
    fn distinguishes_missing_empty_and_null_fields() {
        for (field, expected) in [
            ("", "no recognized"),
            (",\"consumables\":[]", "array"),
            (",\"consumables\":null", "null"),
        ] {
            let body = format!("[{{\"url\":\"test\"{field}}}]");
            assert!(report(body.as_bytes(), "test", false)
                .unwrap()
                .contains(expected));
        }
        assert!(report(br#"[{"url":"other"}]"#, "test", false).is_err());
        assert!(report(b"secret invalid response", "test", false)
            .unwrap_err()
            .find("secret")
            .is_none());
    }

    #[test]
    fn missing_consumables_still_reports_build_structure() {
        let body = br#"[{"url":"private-character","build":{"presets":[{"buffs":[12],"name":"Secret Preset"}]}}]"#;
        let output = report(body, "private-character", false).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["reportVersion"], 3);
        assert_eq!(value["fields"], json!([]));
        assert!(output.contains("responseShape"));
        assert!(output.contains("presets"));
        assert!(output.contains("buffs"));
        assert!(!output.contains("Secret Preset"));
        assert!(!output.contains("private-character"));
    }

    #[test]
    fn inspects_json_encoded_data_without_exposing_values() {
        let body = serde_json::to_vec(&json!([{
            "url": "test",
            "data": json!({"consumables": [{"item_id": 987654, "name": "Secret"}]}).to_string()
        }]))
        .unwrap();
        let output = report(&body, "test", false).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["fields"].as_array().unwrap().len(), 1);
        assert!(output.contains("json-string"));
        assert!(output.contains("item_id"));
        assert!(!output.contains("987654"));
        assert!(!output.contains("Secret"));
    }

    #[test]
    fn field_names_require_opt_in_and_values_remain_redacted() {
        let body = serde_json::to_vec(&json!([{
            "url": "private-character",
            "builds": [{"gear": {"123456": {"main_key": 987654}}, "food_setup": "private-preset"}],
            "apiKey": "secret-token",
            "data": json!({"unknown_field": "private-value"}).to_string()
        }]))
        .unwrap();
        let private = report(&body, "private-character", false).unwrap();
        assert!(!private.contains("food_setup"));
        assert!(!private.contains("unknown_field"));
        let output = report(&body, "private-character", true).unwrap();
        assert!(output.contains("food_setup"));
        assert!(output.contains("unknown_field"));
        assert!(output.contains("[numeric key]"));
        for secret in [
            "private-character",
            "private-preset",
            "private-value",
            "secret-token",
            "123456",
            "987654",
        ] {
            assert!(!output.contains(secret));
        }
        assert_eq!(field_label(&"x".repeat(81), true), "[redacted field]");
        assert_eq!(field_label("bad\nkey", true), "[redacted field]");
    }

    #[test]
    fn bounds_report_size_and_marks_truncation() {
        let value = json!([{"url":"test","consumables": vec![json!({"id": 42}); 1000]}]);
        let output = report(&serde_json::to_vec(&value).unwrap(), "test", false).unwrap();
        assert!(output.len() < 6000);
        assert!(output.contains("\"truncated\": true"));
        let mut value = json!(42);
        for _ in 0..12 {
            value = json!({"items": value});
        }
        assert!(shape(&value, 0, false).to_string().contains("truncated"));
    }
}
