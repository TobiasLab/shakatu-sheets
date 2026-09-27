use serde::{Deserialize, Serialize};
use tauri::State;

use crate::persistence::{load_setting, save_settings, save_settings_if_unchanged, DatabasePath};

use super::{
    buffs::parse_stored_buffs, client, parse_selected_character_id, parse_stored_characters,
    response_bytes, stored_api_key, valid_character_id, GarmothCharacter, GarmothOperations,
    API_BASE_URL, API_KEY_SETTING, BUFFS_SETTING, CHARACTERS_SETTING, CHARACTER_IDS_SETTING,
    SELECTED_CHARACTER_SETTING,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothSettings {
    api_key_configured: bool,
    character_ids: Vec<String>,
    characters: Vec<GarmothCharacter>,
    selected_character_id: Option<String>,
    buff_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct GarmothProfile {
    id: i64,
}

#[derive(Deserialize)]
struct CharacterResponse {
    url: String,
    name: String,
    #[serde(rename = "class")]
    class_id: i64,
    #[serde(default)]
    spec: Option<String>,
}

pub(super) fn validate_api_key(api_key: &str) -> Result<&str, String> {
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

fn parse_character_ids(value: &str) -> Result<Vec<String>, String> {
    let ids = value
        .split(',')
        .map(str::trim)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if ids.is_empty() || ids.len() > 20 || ids.iter().any(|id| !valid_character_id(id)) {
        return Err("enter between 1 and 20 valid character URL IDs".into());
    }
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != ids.len() {
        return Err("character IDs must be unique".into());
    }
    Ok(ids)
}

fn parse_characters(
    body: &[u8],
    requested_ids: &[String],
) -> Result<Vec<GarmothCharacter>, String> {
    let characters = serde_json::from_slice::<Vec<CharacterResponse>>(body)
        .map_err(|error| format!("Garmoth returned an invalid character response: {error}"))?;
    if characters.is_empty() {
        return Err("Garmoth returned no character builds for those IDs".into());
    }

    let mut parsed = Vec::with_capacity(characters.len());
    for character in characters {
        let name = character.name.trim();
        if !requested_ids.contains(&character.url)
            || !valid_character_id(&character.url)
            || character.class_id <= 0
            || name.is_empty()
            || name.len() > 100
            || !matches!(
                character.spec.as_deref(),
                None | Some("awak") | Some("succ")
            )
            || parsed
                .iter()
                .any(|existing: &GarmothCharacter| existing.id == character.url)
        {
            return Err("Garmoth returned invalid character data".into());
        }
        parsed.push(GarmothCharacter {
            id: character.url,
            name: name.into(),
            class_id: character.class_id,
            spec: character.spec,
        });
    }
    if parsed.len() != requested_ids.len() {
        return Err("Garmoth did not return every requested character build".into());
    }
    Ok(parsed)
}

fn parse_stored_character_ids(value: Option<String>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|_| "saved Garmoth character IDs are invalid".into())
}

#[tauri::command]
pub(crate) async fn load_garmoth_settings(
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<GarmothSettings, String> {
    let _guard = operations.lock().await;
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    let selected_character_id =
        parse_selected_character_id(load_setting(&state.0, SELECTED_CHARACTER_SETTING)?)?;
    if selected_character_id
        .as_ref()
        .is_some_and(|id| !characters.iter().any(|character| character.id == *id))
    {
        return Err("saved Garmoth character selection was not found".into());
    }
    Ok(GarmothSettings {
        api_key_configured: load_setting(&state.0, API_KEY_SETTING)?.is_some(),
        character_ids: parse_stored_character_ids(load_setting(&state.0, CHARACTER_IDS_SETTING)?)?,
        characters,
        selected_character_id,
        buff_ids: parse_stored_buffs(load_setting(&state.0, BUFFS_SETTING)?),
    })
}

#[tauri::command]
pub(crate) async fn save_garmoth_api_key(
    api_key: String,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<(), String> {
    let _guard = operations.lock().await;
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
pub(crate) async fn fetch_garmoth_characters(
    character_ids: String,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<Vec<GarmothCharacter>, String> {
    let _guard = operations.lock().await;
    let api_key = stored_api_key(&state.0)?;
    let character_ids = parse_character_ids(&character_ids)?;
    let ids = character_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(",");
    let response = client()?
        .get(format!("{API_BASE_URL}/gear-planner/getCharacterBuilds"))
        .query(&[("ids", ids)])
        .header("apiKey", &api_key)
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
    let selected =
        current_selection.filter(|id| characters.iter().any(|character| character.id == *id));
    if !save_settings_if_unchanged(
        &state.0,
        API_KEY_SETTING,
        &api_key,
        &[
            (CHARACTER_IDS_SETTING, Some(&ids_json)),
            (CHARACTERS_SETTING, Some(&characters_json)),
            (SELECTED_CHARACTER_SETTING, selected.as_deref()),
        ],
    )? {
        return Err(
            "the Garmoth API key changed while fetching characters; fetch them again".into(),
        );
    }
    Ok(characters)
}

#[tauri::command]
pub(crate) async fn select_garmoth_character(
    character_id: String,
    state: State<'_, DatabasePath>,
    operations: State<'_, GarmothOperations>,
) -> Result<(), String> {
    let _guard = operations.lock().await;
    let characters = parse_stored_characters(load_setting(&state.0, CHARACTERS_SETTING)?)?;
    if !characters
        .iter()
        .any(|character| character.id == character_id)
    {
        return Err("select a fetched Garmoth character".into());
    }
    save_settings(
        &state.0,
        &[(SELECTED_CHARACTER_SETTING, Some(&character_id))],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_character_responses() {
        let characters = parse_characters(
            br#"[{"id":42,"url":"dNTbRAtHn1","name":"Main","class":8,"spec":"awak"}]"#,
            &["dNTbRAtHn1".into()],
        )
        .unwrap();

        assert_eq!(
            characters,
            vec![GarmothCharacter {
                id: "dNTbRAtHn1".into(),
                name: "Main".into(),
                class_id: 8,
                spec: Some("awak".into()),
            }]
        );
        assert!(parse_characters(
            br#"[{"id":42,"url":"dNTbRAtHn1","name":"Main","class":8,"spec":"invalid"}]"#,
            &["dNTbRAtHn1".into()],
        )
        .is_err());
        assert_eq!(
            parse_characters(
                br#"[{"id":42,"url":"dNTbRAtHn1","name":"Main","class":8,"spec":"awak"}]"#,
                &["dNTbRAtHn1".into(), "missing-id".into()],
            )
            .unwrap_err(),
            "Garmoth did not return every requested character build"
        );
    }

    #[test]
    fn rejects_duplicate_or_malformed_character_ids() {
        assert_eq!(
            parse_character_ids("dNTbRAtHn1, another-id").unwrap(),
            vec!["dNTbRAtHn1", "another-id"]
        );
        assert!(parse_character_ids("dNTbRAtHn1,dNTbRAtHn1").is_err());
        assert!(parse_character_ids("not/a/path").is_err());
    }
}
