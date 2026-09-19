use serde_json::{json, Value};
use tauri::State;

use crate::persistence::{load_setting, DatabasePath};

use super::{
    client, parse_stored_characters, response_bytes, stored_api_key, GarmothOperations,
    API_BASE_URL, CHARACTERS_SETTING,
};

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

// Only fixed schema labels cross the boundary; values and arbitrary object keys may contain personal data.
fn field_label(key: &str) -> &str {
    if consumable_field(key) {
        return key;
    }
    match key {
        "id" | "name" | "items" | "item" | "item_id" | "itemId" | "main_key" | "sub_key"
        | "price" | "unit_price" | "unitPrice" | "quantity" | "amount" | "duration"
        | "duration_ms" | "buffs" | "effects" | "preset" | "preset_id" | "presetId" | "data"
        | "enabled" | "active" | "selected" | "icon" | "img" | "cost" => key,
        _ => "[redacted field]",
    }
}

fn shape(value: &Value, depth: usize) -> Value {
    if depth >= 8 {
        return json!({"truncated": true});
    }
    match value {
        Value::Object(fields) => {
            json!({"type": "object", "fields": fields.iter().take(40).map(|(key, value)| {
            json!({"field": field_label(key), "shape": shape(value, depth + 1)})
        }).collect::<Vec<_>>(), "truncated": fields.len() > 40})
        }
        Value::Array(items) => json!({"type": "array", "count": items.len(),
            "samples": items.iter().take(3).map(|item| shape(item, depth + 1)).collect::<Vec<_>>(),
            "truncated": items.len() > 3}),
        Value::Null => json!({"type": "null"}),
        Value::Bool(_) => json!({"type": "boolean"}),
        Value::Number(_) => json!({"type": "number"}),
        Value::String(_) => json!({"type": "string"}),
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
                        matches.push(json!({"field": key, "shape": shape(value, 0)}));
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
        _ => {}
    }
}

fn report(body: &[u8], character_id: &str) -> Result<String, String> {
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
        "reportVersion": 1,
        "valuesIncluded": false,
        "status": if matches.is_empty() { "no recognized consumable fields" } else { "consumable fields found" },
        "truncated": truncated,
        "fields": matches,
    })).map_err(|_| "Could not format the consumable report".into())
}

#[tauri::command]
pub(crate) async fn inspect_garmoth_consumables(
    character_id: String,
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
    let response = client()?
        .get(format!("{API_BASE_URL}/gear-planner/getCharacterBuilds"))
        .query(&[("ids", &character_id)])
        .header("apiKey", stored_api_key(&state.0)?)
        .send()
        .await
        .map_err(|_| "Could not reach Garmoth to inspect consumables".to_string())?;
    report(
        &response_bytes(response, "inspecting consumables").await?,
        &character_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_nested_schema_without_personal_values_or_keys() {
        let body = br#"[{"url":"private-character","name":"Private Name","apiKey":"secret-key","gear":{"private-user":42},"data":{"consumables":{"name":"Private Preset","items":[{"item_id":12345,"price":987654,"private-key":"secret","notes":"private notes"}]}}}]"#;
        let output = report(body, "private-character").unwrap();
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
            assert!(report(body.as_bytes(), "test").unwrap().contains(expected));
        }
        assert!(report(br#"[{"url":"other"}]"#, "test").is_err());
        assert!(report(b"secret invalid response", "test")
            .unwrap_err()
            .find("secret")
            .is_none());
    }

    #[test]
    fn bounds_report_size_and_marks_truncation() {
        let value = json!([{"url":"test","consumables": vec![json!({"id": 42}); 1000]}]);
        let output = report(&serde_json::to_vec(&value).unwrap(), "test").unwrap();
        assert!(output.len() < 3000);
        assert!(output.contains("\"truncated\": true"));
        let mut value = json!(42);
        for _ in 0..12 {
            value = json!({"items": value});
        }
        assert!(shape(&value, 0).to_string().contains("truncated"));
    }
}
