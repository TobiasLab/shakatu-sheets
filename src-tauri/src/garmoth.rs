use std::{collections::BTreeMap, time::Duration};

use reqwest::{redirect::Policy, Client, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::database::{
    claim_garmoth_upload, finish_garmoth_upload, load_session_for_upload, load_setting,
    save_settings, DatabasePath, SessionEntry, SessionStatus, Valuation,
};

const API_BASE_URL: &str = "https://api.garmoth.com/api/external";
const API_KEY_SETTING: &str = "garmoth.api_key";
const CHARACTER_IDS_SETTING: &str = "garmoth.character_ids";
const CHARACTERS_SETTING: &str = "garmoth.characters";
const SELECTED_CHARACTER_SETTING: &str = "garmoth.selected_character_id";
const MAX_RESPONSE_BYTES: u64 = 1_000_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarmothCharacter {
    id: i64,
    name: String,
    class_id: i64,
    spec: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarmothSettings {
    api_key_configured: bool,
    character_ids: Vec<i64>,
    characters: Vec<GarmothCharacter>,
    selected_character_id: Option<i64>,
}

#[derive(Deserialize)]
struct GarmothProfile {
    id: i64,
}

#[derive(Deserialize)]
struct CharacterResponse {
    id: i64,
    name: String,
    class_id: i64,
    #[serde(default)]
    spec: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrindSpotMapping {
    garmoth_id: i64,
    drops: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GarmothUploadInput {
    session_id: String,
    grindspot_id: i64,
    minutes: i64,
    hourly: i64,
    total: i64,
    drops: BTreeMap<String, i64>,
    global: bool,
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
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GarmothUploadResultStatus {
    Success,
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarmothUploadResult {
    status: GarmothUploadResultStatus,
    message: String,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent(concat!("shakatu-sheets/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("could not prepare the Garmoth request: {error}"))
}

fn validate_api_key(api_key: &str) -> Result<&str, String> {
    let api_key = api_key.trim();
    if api_key.is_empty()
        || api_key.len() > 512
        || api_key
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("enter a valid Garmoth API key".into());
    }
    Ok(api_key)
}

fn parse_character_ids(value: &str) -> Result<Vec<i64>, String> {
    let ids = value
        .split(',')
        .map(str::trim)
        .map(|id| id.parse::<i64>())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "character IDs must be positive numbers separated by commas".to_string())?;
    if ids.is_empty() || ids.len() > 20 || ids.iter().any(|id| *id <= 0) {
        return Err("enter between 1 and 20 positive character IDs".into());
    }
    let mut unique = ids.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != ids.len() {
        return Err("character IDs must be unique".into());
    }
    Ok(ids)
}

fn parse_characters(body: &[u8], requested_ids: &[i64]) -> Result<Vec<GarmothCharacter>, String> {
    let characters = serde_json::from_slice::<Vec<CharacterResponse>>(body)
        .map_err(|error| format!("Garmoth returned an invalid character response: {error}"))?;
    if characters.is_empty() {
        return Err("Garmoth returned no character builds for those IDs".into());
    }

    let mut parsed = Vec::with_capacity(characters.len());
    for character in characters {
        let name = character.name.trim();
        if !requested_ids.contains(&character.id)
            || character.id <= 0
            || character.class_id <= 0
            || name.is_empty()
            || name.len() > 100
            || !matches!(
                character.spec.as_deref(),
                None | Some("awak") | Some("succ")
            )
            || parsed
                .iter()
                .any(|existing: &GarmothCharacter| existing.id == character.id)
        {
            return Err("Garmoth returned invalid character data".into());
        }
        parsed.push(GarmothCharacter {
            id: character.id,
            name: name.into(),
            class_id: character.class_id,
            spec: character.spec,
        });
    }
    Ok(parsed)
}

fn parse_stored_characters(value: Option<String>) -> Result<Vec<GarmothCharacter>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|_| "saved Garmoth character data is invalid".into())
}

fn parse_stored_character_ids(value: Option<String>) -> Result<Vec<i64>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|_| "saved Garmoth character IDs are invalid".into())
}

fn parse_selected_character_id(value: Option<String>) -> Result<Option<i64>, String> {
    value
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| "saved Garmoth character selection is invalid".to_string())
        })
        .transpose()
}

fn stored_api_key(path: &std::path::PathBuf) -> Result<String, String> {
    let api_key = load_setting(path, API_KEY_SETTING)?
        .ok_or_else(|| "save a Garmoth API key in Settings first".to_string())?;
    validate_api_key(&api_key).map(str::to_string)
}

async fn response_bytes(response: reqwest::Response, purpose: &str) -> Result<Vec<u8>, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                "Garmoth rejected the API key. Update it in Settings.".into()
            }
            StatusCode::TOO_MANY_REQUESTS => {
                "Garmoth is rate limiting requests. Wait before trying again.".into()
            }
            _ => format!("Garmoth returned {status} while {purpose}"),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err("Garmoth returned an unexpectedly large response".into());
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("could not read the Garmoth response: {error}"))?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return Err("Garmoth returned an unexpectedly large response".into());
    }
    Ok(body.to_vec())
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
    let mappings = serde_json::from_str::<BTreeMap<String, GrindSpotMapping>>(include_str!(
        "../../src/data/garmothMappings.json"
    ))
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
pub fn load_garmoth_settings(state: State<'_, DatabasePath>) -> Result<GarmothSettings, String> {
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    let selected_character_id =
        parse_selected_character_id(load_setting(&state.0, SELECTED_CHARACTER_SETTING)?)?;
    if selected_character_id
        .is_some_and(|id| !characters.iter().any(|character| character.id == id))
    {
        return Err("saved Garmoth character selection was not found".into());
    }
    Ok(GarmothSettings {
        api_key_configured: load_setting(&state.0, API_KEY_SETTING)?.is_some(),
        character_ids: parse_stored_character_ids(load_setting(&state.0, CHARACTER_IDS_SETTING)?)?,
        characters,
        selected_character_id,
    })
}

#[tauri::command]
pub async fn save_garmoth_api_key(
    api_key: String,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    let api_key = validate_api_key(&api_key)?;
    let response = client()?
        .get(format!("{API_BASE_URL}/user/profile"))
        .header("apiKey", api_key)
        .send()
        .await
        .map_err(|error| format!("could not reach Garmoth: {error}"))?;
    let profile = serde_json::from_slice::<GarmothProfile>(
        &response_bytes(response, "validating the API key").await?,
    )
    .map_err(|error| format!("Garmoth returned an invalid profile response: {error}"))?;
    if profile.id <= 0 {
        return Err("Garmoth returned an invalid profile response".into());
    }

    save_settings(
        &state.0,
        &[
            (API_KEY_SETTING, Some(api_key)),
            (CHARACTER_IDS_SETTING, None),
            (CHARACTERS_SETTING, None),
            (SELECTED_CHARACTER_SETTING, None),
        ],
    )
}

#[tauri::command]
pub async fn fetch_garmoth_characters(
    character_ids: String,
    state: State<'_, DatabasePath>,
) -> Result<Vec<GarmothCharacter>, String> {
    let api_key = stored_api_key(&state.0)?;
    let character_ids = parse_character_ids(&character_ids)?;
    let ids = character_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let response = client()?
        .get(format!("{API_BASE_URL}/gear-planner/getCharacterBuilds"))
        .query(&[("ids", ids)])
        .header("apiKey", api_key)
        .send()
        .await
        .map_err(|error| format!("could not reach Garmoth: {error}"))?;
    let characters = parse_characters(
        &response_bytes(response, "fetching character builds").await?,
        &character_ids,
    )?;
    let ids_json = serde_json::to_string(&character_ids).map_err(|error| error.to_string())?;
    let characters_json = serde_json::to_string(&characters).map_err(|error| error.to_string())?;
    let current_selection =
        parse_selected_character_id(load_setting(&state.0, SELECTED_CHARACTER_SETTING)?)?;
    let selected = current_selection
        .filter(|id| characters.iter().any(|character| character.id == *id))
        .map(|id| id.to_string());
    save_settings(
        &state.0,
        &[
            (CHARACTER_IDS_SETTING, Some(&ids_json)),
            (CHARACTERS_SETTING, Some(&characters_json)),
            (SELECTED_CHARACTER_SETTING, selected.as_deref()),
        ],
    )?;
    Ok(characters)
}

#[tauri::command]
pub fn select_garmoth_character(
    character_id: i64,
    state: State<'_, DatabasePath>,
) -> Result<(), String> {
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    if !characters
        .iter()
        .any(|character| character.id == character_id)
    {
        return Err("select a fetched Garmoth character".into());
    }
    let character_id = character_id.to_string();
    save_settings(
        &state.0,
        &[(SELECTED_CHARACTER_SETTING, Some(&character_id))],
    )
}

#[tauri::command]
pub async fn upload_garmoth_session(
    input: GarmothUploadInput,
    state: State<'_, DatabasePath>,
) -> Result<GarmothUploadResult, String> {
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
    };
    let body = serde_json::to_vec(&payload)
        .map_err(|error| format!("could not prepare the Garmoth upload: {error}"))?;
    let client = client()?;

    claim_garmoth_upload(&state.0, &input.session_id)?;
    let response = client
        .post(format!("{API_BASE_URL}/grind-tracker/sessions/create"))
        .header("apiKey", api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(_) => {
            return Ok(GarmothUploadResult {
                status: GarmothUploadResultStatus::Unknown,
                message: "Garmoth did not confirm the upload. Check your Garmoth grind tracker; this session will not be retried automatically.".into(),
            });
        }
    };
    let status = response.status();
    if status.is_success() {
        finish_garmoth_upload(&state.0, &input.session_id)?;
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
    use super::*;

    #[test]
    fn parses_and_validates_character_responses() {
        let characters = parse_characters(
            br#"[{"id":42,"name":"Main","class_id":8,"spec":"awak"}]"#,
            &[42],
        )
        .unwrap();

        assert_eq!(
            characters,
            vec![GarmothCharacter {
                id: 42,
                name: "Main".into(),
                class_id: 8,
                spec: Some("awak".into()),
            }]
        );
        assert!(parse_characters(
            br#"[{"id":42,"name":"Main","class_id":8,"spec":"invalid"}]"#,
            &[42],
        )
        .is_err());
    }

    #[test]
    fn serializes_the_documented_upload_contract() {
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
                "spec": "awak"
            })
        );
    }

    #[test]
    fn rejects_duplicate_or_malformed_character_ids() {
        assert_eq!(parse_character_ids("4, 8").unwrap(), vec![4, 8]);
        assert!(parse_character_ids("4,4").is_err());
        assert!(parse_character_ids("4,nope").is_err());
    }
}
