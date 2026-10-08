use std::{collections::BTreeMap, path::PathBuf};

use crate::persistence::sessions::SessionRecord;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::persistence::{
    apply_finished_session_consumables_record, claim_garmoth_upload, finish_garmoth_upload,
    load_session_for_upload, load_setting, open_database, release_garmoth_upload,
    resolve_unknown_garmoth_upload, save_settings, DatabasePath, GarmothUploadStatus, SessionEntry,
    SessionStatus, Valuation, MAX_SAFE_INTEGER,
};

use super::{
    buffs::drop_totals, client, parse_selected_character_id, parse_stored_characters,
    stored_api_key, GarmothOperations, API_BASE_URL, BUFFS_SETTING, CHARACTERS_SETTING,
    SELECTED_CHARACTER_SETTING,
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
    repeat_upload: bool,
    grindspot_id: i64,
    minutes: i64,
    hourly: i64,
    total: i64,
    drops: BTreeMap<String, i64>,
    global: bool,
    agris: Option<i64>,
    #[serde(default)]
    buffs: Vec<i64>,
    expected_session: SessionRecord,
    consumable_entries: Option<Vec<SessionEntry>>,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    agris: Option<i64>,
    #[serde(skip_serializing_if = "<[i64]>::is_empty")]
    buffs: &'a [i64],
    #[serde(skip_serializing_if = "Option::is_none")]
    rate: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    amount: Option<i64>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GarmothUploadResultStatus {
    Success,
    Unknown,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothUploadOutcome {
    status: GarmothUploadResultStatus,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothUploadResult {
    #[serde(flatten)]
    outcome: GarmothUploadOutcome,
    saved_session: Option<SessionRecord>,
}

fn validate_upload(input: &GarmothUploadInput) -> Result<(), String> {
    if input.session_id.trim().is_empty()
        || input.grindspot_id <= 0
        || input.minutes <= 0
        || input.hourly < 0
        || input.total < 0
        || input.drops.is_empty()
        || input.drops.len() > 200
    {
        return Err("The Garmoth upload payload is invalid.".into());
    }
    if input
        .agris
        .is_some_and(|value| value != -1 && !(1..=MAX_SAFE_INTEGER).contains(&value))
    {
        return Err("Agris must be -1 for unknown usage or a positive whole amount.".into());
    }
    for (key, quantity) in &input.drops {
        let Some((main, sub)) = key.split_once('_') else {
            return Err("The Garmoth upload contains an invalid drop key.".into());
        };
        if *quantity < 0
            || main.is_empty()
            || sub.is_empty()
            || !main.bytes().all(|byte| byte.is_ascii_digit())
            || !sub.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err("The Garmoth upload contains invalid drops.".into());
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
        return Err("The bundled Garmoth drop mappings are invalid.".into());
    }
    for entry in entries {
        if entry.valuation == Valuation::Expense {
            continue;
        }
        // Keep unsupported loot in the saved session and totals, but omit it from Garmoth's item list.
        let Some(key) = mapping.drops.get(&entry.name) else {
            continue;
        };
        if entry.quantity >= i64::MAX as f64 {
            return Err("A session drop quantity is too large for Garmoth.".into());
        }
        let quantity = entry.quantity as i64;
        let current = drops
            .get_mut(key)
            .ok_or_else(|| "The bundled Garmoth drop mappings are invalid.".to_string())?;
        *current = current
            .checked_add(quantity)
            .ok_or_else(|| "A session drop quantity is too large for Garmoth.".to_string())?;
    }
    Ok(drops)
}

fn session_consumables(entries: &[SessionEntry]) -> Result<Vec<[i64; 2]>, String> {
    let mut quantities = BTreeMap::<i64, i64>::new();
    for entry in entries {
        let Some(id) = entry.garmoth_consumable_id else {
            continue;
        };
        if entry.valuation != Valuation::Expense
            || id <= 0
            || id > MAX_SAFE_INTEGER
            || !entry.quantity.is_finite()
            || entry.quantity <= 0.0
            || entry.quantity.fract() != 0.0
            || entry.quantity > MAX_SAFE_INTEGER as f64
        {
            return Err("Invalid saved consumable quantity.".into());
        }
        let quantity = quantities.entry(id).or_default();
        *quantity = quantity
            .checked_add(entry.quantity as i64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or("Consumable quantity is too large.")?;
    }
    if quantities.len() > 100 {
        return Err("Upload at most 100 consumables.".into());
    }
    Ok(quantities
        .into_iter()
        .map(|(id, quantity)| [id, quantity])
        .collect())
}

fn verify_session_values(
    input: &GarmothUploadInput,
    session: &SessionRecord,
) -> Result<Vec<[i64; 2]>, String> {
    if session.status != SessionStatus::Finished {
        return Err("Only finished sessions can be uploaded.".into());
    }
    let mappings =
        serde_json::from_str::<BTreeMap<String, GrindSpotMapping>>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/data/garmothMappings.json"
        )))
        .map_err(|_| "The bundled Garmoth mappings are invalid.".to_string())?;
    let mapping = mappings
        .get(&session.grind_spot_id)
        .ok_or_else(|| "The session uses an unsupported Garmoth grind spot.".to_string())?;
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
        return Err("The upload no longer matches the saved session.".into());
    }
    session_consumables(&session.entries)
}

fn reviewed_consumables(
    input: &GarmothUploadInput,
    session: &SessionRecord,
) -> Result<Vec<[i64; 2]>, String> {
    if *session != input.expected_session {
        return Err("The session changed. Close the review and reload History.".into());
    }
    let mut proposed = session.clone();
    if let Some(entries) = &input.consumable_entries {
        proposed
            .entries
            .retain(|entry| entry.garmoth_consumable_id.is_none());
        proposed.entries.extend_from_slice(entries);
    }
    verify_session_values(input, &proposed)
}

#[tauri::command]
pub(crate) async fn upload_garmoth_session(
    input: GarmothUploadInput,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<GarmothUploadResult, String> {
    let _guard = operations.lock().await;
    upload(&input, state.path()?, client()?, API_BASE_URL).await
}

#[tauri::command]
pub(crate) async fn resolve_garmoth_upload(
    session_id: String,
    uploaded: bool,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<Option<GarmothUploadStatus>, String> {
    let _guard = operations.lock().await;
    let mut connection = open_database(state.path()?)?;
    resolve_unknown_garmoth_upload(&mut connection, &session_id, uploaded)
}

/// Callers hold `GarmothOperations`, which serializes the upload with Garmoth settings changes and finished-session
/// deletion. Claiming the upload rechecks that the session is still finished.
pub(crate) async fn upload(
    input: &GarmothUploadInput,
    path: &PathBuf,
    client: reqwest::Client,
    base_url: &str,
) -> Result<GarmothUploadResult, String> {
    validate_upload(input)?;
    let totals = drop_totals(&input.buffs)?;
    // Buffs rarely change between sessions, so the next review starts from the selection submitted here, even when
    // this upload then fails.
    let buffs = serde_json::to_string(&input.buffs).map_err(|error| error.to_string())?;
    let mut connection = open_database(path)?;
    save_settings(&mut connection, &[(BUFFS_SETTING, Some(&buffs))])?;
    let session = load_session_for_upload(&connection, &input.session_id)?;
    let consumables = reviewed_consumables(input, &session)?;
    let api_key = stored_api_key(&connection)?;
    let characters = parse_stored_characters(load_setting(&connection, CHARACTERS_SETTING)?)?;
    let selected_id =
        parse_selected_character_id(load_setting(&connection, SELECTED_CHARACTER_SETTING)?)?
            .ok_or_else(|| "Select a Garmoth character in Settings first.".to_string())?;
    let character = characters
        .iter()
        .find(|character| character.id == selected_id)
        .ok_or_else(|| "The selected Garmoth character is no longer available.".to_string())?;
    let payload = CreateSessionPayload {
        grindspot_id: input.grindspot_id,
        minutes: input.minutes,
        hourly: input.hourly,
        total: input.total,
        drops: &input.drops,
        global: input.global,
        class_id: character.class_id,
        spec: character.spec.as_deref(),
        consumables: &consumables,
        agris: input.agris,
        buffs: &input.buffs,
        rate: (totals.rate > 0).then_some(totals.rate),
        amount: (totals.amount > 0).then_some(totals.amount),
    };
    let body = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not prepare the Garmoth upload: {error}"))?;
    let request = client
        .post(format!("{base_url}/grind-tracker/sessions/create"))
        .header("apiKey", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .build()
        .map_err(|error| format!("Could not prepare the Garmoth upload: {error}"))?;

    let saved_session = input
        .consumable_entries
        .as_ref()
        .map(|entries| {
            apply_finished_session_consumables_record(&mut connection, &session, entries)
        })
        .transpose()?;
    let outcome = match send_upload(input, &mut connection, client, request).await {
        Ok(outcome) => outcome,
        Err(error) => GarmothUploadOutcome {
            status: GarmothUploadResultStatus::Failed,
            message: if saved_session.is_some() {
                format!("Consumables saved. Upload failed: {error}")
            } else {
                error
            },
        },
    };
    Ok(GarmothUploadResult {
        outcome,
        saved_session,
    })
}

async fn send_upload(
    input: &GarmothUploadInput,
    connection: &mut Connection,
    client: reqwest::Client,
    request: reqwest::Request,
) -> Result<GarmothUploadOutcome, String> {
    let was_uploaded = claim_garmoth_upload(connection, &input.session_id, input.repeat_upload)?;
    let response = client.execute(request).await;

    let response = match response {
        Ok(response) => response,
        // Only a connect failure proves the request was never sent.
        Err(error) if error.is_connect() => {
            let restored = if was_uploaded {
                finish_garmoth_upload(connection, &input.session_id)
            } else {
                release_garmoth_upload(connection, &input.session_id)
            };
            if restored.is_ok() {
                return Err(
                    "Could not connect to Garmoth; check your connection and try again.".into(),
                );
            }
            return Ok(GarmothUploadOutcome {
                status: GarmothUploadResultStatus::Unknown,
                message: "The Garmoth request was not sent, but the local upload reservation could not be cleared. This session will not be retried automatically.".into(),
            });
        }
        Err(_) => {
            return Ok(GarmothUploadOutcome {
                status: GarmothUploadResultStatus::Unknown,
                message: "Garmoth did not confirm the upload. Check your Garmoth grind tracker; this session will not be retried automatically.".into(),
            });
        }
    };
    let status = response.status();
    if status.is_success() {
        if finish_garmoth_upload(connection, &input.session_id).is_err() {
            return Ok(GarmothUploadOutcome {
                status: GarmothUploadResultStatus::Unknown,
                message: "Garmoth confirmed the upload, but Shakatu Sheets could not save that confirmation. Check your Garmoth grind tracker; this session will not be retried automatically.".into(),
            });
        }
        return Ok(GarmothUploadOutcome {
            status: GarmothUploadResultStatus::Success,
            message: "Session uploaded to Garmoth.".into(),
        });
    }
    Ok(GarmothUploadOutcome {
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
        let consumables = [
            [99999900, 1],
            [9692, 1],
            [1411, 3],
            [1407, 3],
            [761879, 1],
            [767969, 1],
            [100001510, 1],
        ];
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
            consumables: &consumables,
            agris: None,
            buffs: &[],
            rate: None,
            amount: None,
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

    fn sample_input() -> GarmothUploadInput {
        serde_json::from_value(serde_json::json!({
            "sessionId":"review", "grindspotId":200, "minutes":60,
            "total":100, "hourly":100, "drops":{"56339_0":1}, "global":true,
            "expectedSession": { "id":"review", "region":"eu", "grindSpotId":"stars-end-revamp",
                "status":"finished", "startedAt":null, "elapsedMs":3600000, "entries":[] }
        }))
        .unwrap()
    }

    #[test]
    fn omits_unsupported_loot_without_changing_session_totals_or_validation() {
        let mappings: BTreeMap<String, GrindSpotMapping> =
            serde_json::from_str(include_str!("../../../src/data/garmothMappings.json")).unwrap();
        let mapping = &mappings["stars-end-revamp"];
        for name in [
            "Laila's Petal",
            "Pure Forest Breath",
            "[Event] Bountiful Autumn Lunchbox",
            "Custom loot",
        ] {
            for include_supported in [false, true] {
                let mut input = sample_input();
                let entry = SessionEntry {
                    id: "unsupported".into(),
                    name: name.into(),
                    quantity: 2.0,
                    unit_price: 500,
                    valuation: Valuation::Vendor,
                    sale_multiplier: 1.0,
                    source: crate::persistence::sessions::EntrySource::Manual,
                    created_at: 0,
                    garmoth_consumable_id: None,
                };
                input.expected_session.entries = vec![entry.clone()];
                input.total = 1000;
                input.drops = mapping.drops.values().map(|key| (key.clone(), 0)).collect();
                if include_supported {
                    input.expected_session.entries.push(SessionEntry {
                        id: "supported".into(),
                        name: "Corrupted Sanguine Crystal".into(),
                        quantity: 3.0,
                        unit_price: 100,
                        ..entry.clone()
                    });
                    input.drops.insert("56339_0".into(), 3);
                    input.total += 300;
                }
                input.expected_session.entries.push(SessionEntry {
                    id: "expense".into(),
                    name: "Tent buff".into(),
                    quantity: 1.0,
                    unit_price: 50,
                    valuation: Valuation::Expense,
                    ..entry
                });
                input.total -= 50;
                input.hourly = input.total;
                let saved = input.expected_session.clone();
                assert!(validate_upload(&input).is_ok());
                assert!(reviewed_consumables(&input, &saved).unwrap().is_empty());
                assert_eq!(saved, input.expected_session);

                // Omissions never permit extra keys, altered totals, or missing supported loot.
                input.drops.insert("54031_0".into(), 2);
                assert!(reviewed_consumables(&input, &saved).is_err());
                input.drops.remove("54031_0");
                input.total -= 1000;
                assert!(reviewed_consumables(&input, &saved).is_err());
                input.total += 1000;
                input.drops.remove("56339_0");
                assert!(reviewed_consumables(&input, &saved).is_err());
            }
        }
    }

    #[test]
    fn validates_agris_option() {
        let mut input = sample_input();
        assert!(validate_upload(&input).is_ok());
        for value in [-1, 1, 20000] {
            input.agris = Some(value);
            assert!(validate_upload(&input).is_ok());
        }
        for value in [-2, 0, 9_007_199_254_740_992] {
            input.agris = Some(value);
            assert!(validate_upload(&input).is_err());
        }
    }

    #[test]
    fn serializes_global_agris_buffs_and_drop_totals() {
        let drops = BTreeMap::new();
        let payload = CreateSessionPayload {
            grindspot_id: 200,
            minutes: 60,
            hourly: 100,
            total: 100,
            drops: &drops,
            global: true,
            class_id: 6,
            spec: None,
            consumables: &[],
            agris: Some(-1),
            buffs: &[2, 8],
            rate: Some(150),
            amount: Some(100),
        };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["global"], true);
        assert_eq!(json["agris"], -1);
        assert_eq!(json["buffs"], serde_json::json!([2, 8]));
        assert_eq!(json["rate"], 150);
        assert_eq!(json["amount"], 100);
    }

    #[test]
    fn rejects_stale_review_even_when_income_matches() {
        let input = sample_input();
        let mut changed = input.expected_session.clone();
        changed.entries.push(SessionEntry {
            id: "free-buff".into(),
            name: "Buff".into(),
            quantity: 1.0,
            unit_price: 0,
            valuation: Valuation::Expense,
            sale_multiplier: 1.0,
            source: crate::persistence::sessions::EntrySource::Manual,
            created_at: 0,
            garmoth_consumable_id: Some(1411),
        });
        assert!(reviewed_consumables(&input, &changed)
            .unwrap_err()
            .contains("changed"));
    }

    #[test]
    fn uploads_only_saved_consumables_and_sums_quantities_across_prices() {
        let expense = SessionEntry {
            id: "expense".into(),
            name: "Perfume".into(),
            quantity: 3.0,
            unit_price: 100,
            valuation: Valuation::Expense,
            sale_multiplier: 1.0,
            source: crate::persistence::sessions::EntrySource::Manual,
            created_at: 0,
            garmoth_consumable_id: Some(1411),
        };
        let mut different_price = expense.clone();
        different_price.unit_price = 200;
        different_price.quantity = 2.0;
        let mut manual = expense.clone();
        manual.garmoth_consumable_id = None;
        let mut free_buff = expense.clone();
        free_buff.garmoth_consumable_id = Some(100001510);
        free_buff.unit_price = 0;
        free_buff.quantity = 1.0;
        assert_eq!(
            session_consumables(&[expense.clone(), different_price, manual.clone(), free_buff])
                .unwrap(),
            vec![[1411, 5], [100001510, 1]]
        );
        assert!(session_consumables(&[manual]).unwrap().is_empty());
        assert!(session_consumables(&[]).unwrap().is_empty());
        for quantity in [
            0.0,
            -1.0,
            0.5,
            f64::NAN,
            f64::INFINITY,
            9_007_199_254_740_992.0,
        ] {
            let mut invalid = expense.clone();
            invalid.quantity = quantity;
            assert!(session_consumables(&[invalid]).is_err());
        }
        let mut overflowing = expense;
        overflowing.quantity = crate::persistence::MAX_SAFE_INTEGER as f64;
        assert!(session_consumables(&[overflowing.clone(), overflowing]).is_err());
    }

    #[test]
    fn only_connect_failures_prove_the_request_was_not_sent() {
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
                assert!(connect_error.is_connect());

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
                assert!(!timeout_error.is_connect());
                server.join().unwrap();

                // A server that never answers the TLS handshake stalls before the request is sent.
                for (connect_timeout, retryable) in
                    [(None, false), (Some(Duration::from_millis(20)), true)]
                {
                    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                    let address = listener.local_addr().unwrap();
                    let server = thread::spawn(move || {
                        let _connection = listener.accept().unwrap();
                        thread::sleep(Duration::from_millis(200));
                    });
                    let mut builder = Client::builder().timeout(Duration::from_millis(100));
                    if let Some(connect_timeout) = connect_timeout {
                        builder = builder.connect_timeout(connect_timeout);
                    }
                    let handshake_error = builder
                        .build()
                        .unwrap()
                        .get(format!("https://{address}"))
                        .send()
                        .await
                        .unwrap_err();
                    assert!(handshake_error.is_timeout());
                    assert_eq!(handshake_error.is_connect(), retryable);
                    server.join().unwrap();
                }
            });
    }
}
