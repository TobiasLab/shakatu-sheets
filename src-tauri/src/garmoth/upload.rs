use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::persistence::{
    claim_garmoth_upload, finish_garmoth_upload, load_session_for_upload, load_setting,
    release_garmoth_upload, DatabasePath, SessionEntry, SessionStatus, Valuation,
};

use super::{
    client, parse_selected_character_id, parse_stored_characters, stored_api_key,
    GarmothOperations, API_BASE_URL, CHARACTERS_SETTING, SELECTED_CHARACTER_SETTING,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrindSpotMapping {
    garmoth_id: i64,
    drops: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothUploadInput {
    session_id: String,
    #[serde(default)]
    repeat_for_testing: bool,
    grindspot_id: i64,
    minutes: i64,
    hourly: i64,
    total: i64,
    drops: BTreeMap<String, i64>,
    global: bool,
}

// Branch-only experiment: test the working website pairs without a preset build reference.
const EXPERIMENTAL_CONSUMABLES: [[i64; 2]; 7] = [
    [99999900, 1],
    [9692, 1],
    [1411, 3],
    [1407, 3],
    [761879, 1],
    [767969, 1],
    [100001510, 1],
];

#[derive(Serialize)]
struct CreateSessionPayload<'a> {
    grindspot_id: i64,
    minutes: i64,
    hourly: i64,
    total: i64,
    drops: &'a BTreeMap<String, i64>,
    global: bool,
    class_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    spec: Option<&'a str>,
    consumables: &'a [[i64; 2]],
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GarmothUploadResultStatus {
    Success,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothUploadResult {
    status: GarmothUploadResultStatus,
    message: String,
}

#[derive(Debug, PartialEq)]
enum RequestFailure {
    Retryable,
    Unknown,
}

fn classify_request_failure(error: &reqwest::Error) -> RequestFailure {
    if error.is_connect() {
        RequestFailure::Retryable
    } else {
        RequestFailure::Unknown
    }
}

fn validate_upload(input: &GarmothUploadInput) -> Result<(), String> {
    if input.session_id.trim().is_empty()
        || input.grindspot_id <= 0
        || input.minutes <= 0
        || input.hourly < 0
        || input.total < 0
        || input.drops.is_empty()
        || input.drops.len() > 200
        || input.global
    {
        return Err("the Garmoth upload payload is invalid".into());
    }
    for (key, quantity) in &input.drops {
        let Some((main, sub)) = key.split_once('_') else {
            return Err("the Garmoth upload contains an invalid drop key".into());
        };
        if *quantity < 0
            || main.is_empty()
            || sub.is_empty()
            || !main.bytes().all(|byte| byte.is_ascii_digit())
            || !sub.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("the Garmoth upload contains invalid drops".into());
        }
    }
    Ok(())
}

fn expected_drops(
    mapping: &GrindSpotMapping,
    entries: &[SessionEntry],
) -> Result<BTreeMap<String, i64>, String> {
    let mut drops = mapping
        .drops
        .values()
        .map(|key| (key.clone(), 0_i64))
        .collect::<BTreeMap<_, _>>();
    if drops.len() != mapping.drops.len() {
        return Err("the bundled Garmoth drop mappings are invalid".into());
    }
    for entry in entries {
        if entry.valuation == Valuation::Expense {
            continue;
        }
        let key = mapping
            .drops
            .get(&entry.name)
            .ok_or_else(|| format!("{} has no Garmoth drop mapping", entry.name))?;
        if entry.quantity >= i64::MAX as f64 {
            return Err("a session drop quantity is too large for Garmoth".into());
        }
        let quantity = entry.quantity as i64;
        let current = drops
            .get_mut(key)
            .ok_or_else(|| "the bundled Garmoth drop mappings are invalid".to_string())?;
        *current = current
            .checked_add(quantity)
            .ok_or_else(|| "a session drop quantity is too large for Garmoth".to_string())?;
    }
    Ok(drops)
}

fn verify_session_values(input: &GarmothUploadInput, state: &DatabasePath) -> Result<(), String> {
    let session = load_session_for_upload(&state.0, &input.session_id)?;
    if session.status != SessionStatus::Finished {
        return Err("only finished sessions can be uploaded".into());
    }
    let mappings =
        serde_json::from_str::<BTreeMap<String, GrindSpotMapping>>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/data/garmothMappings.json"
        )))
        .map_err(|_| "the bundled Garmoth mappings are invalid".to_string())?;
    let mapping = mappings
        .get(&session.grind_spot_id)
        .ok_or_else(|| "the session uses an unsupported Garmoth grind spot".to_string())?;
    let drops = expected_drops(mapping, &session.entries)?;
    let minutes =
        (session.elapsed_ms / 60_000 + i64::from(session.elapsed_ms % 60_000 >= 30_000)).max(1);
    let mut expenses = 0.0;
    let mut net_revenue = 0.0;
    for entry in &session.entries {
        let value = entry.quantity * entry.unit_price as f64;
        if entry.valuation == Valuation::Expense {
            expenses += value;
        } else {
            net_revenue += value * entry.sale_multiplier;
        }
    }
    let net = net_revenue - expenses;
    let hourly = net / (session.elapsed_ms as f64 / 3_600_000.0);
    if !net.is_finite()
        || !hourly.is_finite()
        || net < 0.0
        || hourly < 0.0
        || net > i64::MAX as f64
        || hourly > i64::MAX as f64
        || input.grindspot_id != mapping.garmoth_id
        || input.minutes != minutes
        || input.total != net.round() as i64
        || input.hourly != hourly.round() as i64
        || input.drops != drops
    {
        return Err("the upload no longer matches the saved session".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn upload_garmoth_session(
    input: GarmothUploadInput,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<GarmothUploadResult, String> {
    let _guard = operations.lock().await;
    validate_upload(&input)?;
    verify_session_values(&input, &state)?;
    let api_key = stored_api_key(&state.0)?;
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    let selected_id =
        parse_selected_character_id(load_setting(&state.0, SELECTED_CHARACTER_SETTING)?)?
            .ok_or_else(|| "select a Garmoth character in Settings first".to_string())?;
    let character = characters
        .iter()
        .find(|character| character.id == selected_id)
        .ok_or_else(|| "the selected Garmoth character is no longer available".to_string())?;
    let payload = CreateSessionPayload {
        grindspot_id: input.grindspot_id,
        minutes: input.minutes,
        hourly: input.hourly,
        total: input.total,
        drops: &input.drops,
        global: input.global,
        class_id: character.class_id,
        spec: character.spec.as_deref(),
        consumables: &EXPERIMENTAL_CONSUMABLES,
    };
    let body = serde_json::to_vec(&payload)
        .map_err(|error| format!("could not prepare the Garmoth upload: {error}"))?;
    let client = client()?;
    let request = client
        .post(format!("{API_BASE_URL}/grind-tracker/sessions/create"))
        .header("apiKey", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .build()
        .map_err(|error| format!("could not prepare the Garmoth upload: {error}"))?;

    let was_uploaded = claim_garmoth_upload(&state.0, &input.session_id, input.repeat_for_testing)?;
    let response = client.execute(request).await;

    let response = match response {
        Ok(response) => response,
        Err(error) if classify_request_failure(&error) == RequestFailure::Retryable => {
            let restored = if was_uploaded {
                finish_garmoth_upload(&state.0, &input.session_id)
            } else {
                release_garmoth_upload(&state.0, &input.session_id)
            };
            if restored.is_ok() {
                return Err(
                    "could not connect to Garmoth; check your connection and try again".into(),
                );
            }
            return Ok(GarmothUploadResult {
                status: GarmothUploadResultStatus::Unknown,
                message: "The Garmoth request was not sent, but the local upload reservation could not be cleared. This session will not be retried automatically.".into(),
            });
        }
        Err(_) => {
            return Ok(GarmothUploadResult {
                status: GarmothUploadResultStatus::Unknown,
                message: "Garmoth did not confirm the upload. Check your Garmoth grind tracker; this session will not be retried automatically.".into(),
            });
        }
    };
    let status = response.status();
    if status.is_success() {
        if finish_garmoth_upload(&state.0, &input.session_id).is_err() {
            return Ok(GarmothUploadResult {
                status: GarmothUploadResultStatus::Unknown,
                message: "Garmoth confirmed the upload, but Shakatu Sheets could not save that confirmation. Check your Garmoth grind tracker; this session will not be retried automatically.".into(),
            });
        }
        return Ok(GarmothUploadResult {
            status: GarmothUploadResultStatus::Success,
            message: "Session uploaded to Garmoth.".into(),
        });
    }
    Ok(GarmothUploadResult {
        status: GarmothUploadResultStatus::Unknown,
        message: format!(
            "Garmoth returned {status} without confirming the upload. Check your Garmoth grind tracker; this session will not be retried automatically."
        ),
    })
}

#[cfg(test)]
mod tests {
    use std::{net::TcpListener, thread, time::Duration};

    use reqwest::Client;

    use super::*;

    #[test]
    fn serializes_upload_with_consumable_pairs_without_build_reference() {
        let drops = BTreeMap::from([("16001_0".into(), 12)]);
        let payload = CreateSessionPayload {
            grindspot_id: 200,
            minutes: 90,
            hourly: 1_000_000_000,
            total: 1_500_000_000,
            drops: &drops,
            global: false,
            class_id: 8,
            spec: Some("awak"),
            consumables: &EXPERIMENTAL_CONSUMABLES,
        };

        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "grindspot_id": 200,
                "minutes": 90,
                "hourly": 1_000_000_000_i64,
                "total": 1_500_000_000_i64,
                "drops": {"16001_0": 12},
                "global": false,
                "class_id": 8,
                "spec": "awak",
                "consumables": [
                    [99999900, 1], [9692, 1], [1411, 3], [1407, 3],
                    [761879, 1], [767969, 1], [100001510, 1]
                ]
            })
        );
    }

    #[test]
    fn classifies_connect_failures_as_retryable_and_timeouts_as_unknown() {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let closed_address = listener.local_addr().unwrap();
                drop(listener);
                let connect_error = Client::builder()
                    .timeout(Duration::from_millis(100))
                    .build()
                    .unwrap()
                    .get(format!("http://{closed_address}"))
                    .send()
                    .await
                    .unwrap_err();
                assert_eq!(
                    classify_request_failure(&connect_error),
                    RequestFailure::Retryable
                );

                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                let server = thread::spawn(move || {
                    let _connection = listener.accept().unwrap();
                    thread::sleep(Duration::from_millis(100));
                });
                let timeout_error = Client::builder()
                    .timeout(Duration::from_millis(20))
                    .build()
                    .unwrap()
                    .get(format!("http://{address}"))
                    .send()
                    .await
                    .unwrap_err();
                assert!(timeout_error.is_timeout());
                assert_eq!(
                    classify_request_failure(&timeout_error),
                    RequestFailure::Unknown
                );
                server.join().unwrap();
            });
    }
}
