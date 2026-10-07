use std::time::Duration;

use reqwest::{redirect::Policy, Client, StatusCode};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::persistence::load_setting;

pub(crate) mod buffs;
pub(crate) mod diagnostics;
pub(crate) mod settings;
pub(crate) mod upload;

#[derive(Default)]
pub(crate) struct GarmothOperations(tokio::sync::Mutex<()>);

impl GarmothOperations {
    pub(crate) async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.lock().await
    }
}

pub(super) const API_BASE_URL: &str = "https://api.garmoth.com/api/external";
pub(super) const API_KEY_SETTING: &str = "garmoth.api_key";
pub(super) const CHARACTER_IDS_SETTING: &str = "garmoth.character_ids";
pub(super) const CHARACTERS_SETTING: &str = "garmoth.characters";
pub(super) const SELECTED_CHARACTER_SETTING: &str = "garmoth.selected_character_id";
pub(super) const BUFFS_SETTING: &str = "garmoth.buffs";
const MAX_RESPONSE_BYTES: u64 = 1_000_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GarmothCharacter {
    id: String,
    name: String,
    class_id: i64,
    spec: Option<String>,
}

pub(super) fn client() -> Result<Client, String> {
    // A connect timeout keeps DNS, TCP, and TLS stalls classified as connect errors, which prove nothing was sent.
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .user_agent(concat!("shakatu-sheets/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not prepare the Garmoth request: {error}"))
}

pub(super) fn valid_character_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) fn parse_stored_characters(
    value: Option<String>,
) -> Result<Vec<GarmothCharacter>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&value).map_err(|_| "Saved Garmoth character data is invalid.".into())
}

pub(super) fn parse_selected_character_id(value: Option<String>) -> Result<Option<String>, String> {
    if value.as_deref().is_some_and(|id| !valid_character_id(id)) {
        return Err("Saved Garmoth character selection is invalid.".into());
    }
    Ok(value)
}

pub(super) fn stored_api_key(connection: &Connection) -> Result<String, String> {
    let api_key = load_setting(connection, API_KEY_SETTING)?
        .ok_or_else(|| "Save a Garmoth API key in Settings first.".to_string())?;
    settings::validate_api_key(&api_key).map(str::to_string)
}

pub(super) async fn get(
    path: &str,
    query: &[(&str, &str)],
    api_key: &str,
    purpose: &str,
) -> Result<Vec<u8>, String> {
    let response = client()?
        .get(format!("{API_BASE_URL}{path}"))
        .query(query)
        .header("apiKey", api_key)
        .send()
        .await
        .map_err(|error| format!("Could not reach Garmoth: {}", error.without_url()))?;
    response_bytes(response, purpose).await
}

async fn response_bytes(mut response: reqwest::Response, purpose: &str) -> Result<Vec<u8>, String> {
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
        return Err("Garmoth returned an unexpectedly large response.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the Garmoth response: {error}"))?
    {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES as usize {
            return Err("Garmoth returned an unexpectedly large response.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use reqwest::Client;

    use super::*;

    #[test]
    fn rejects_chunked_responses_over_the_size_limit() {
        tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap();
                let server = thread::spawn(move || {
                    let (mut connection, _) = listener.accept().unwrap();
                    let mut request = [0; 1_024];
                    let _ = connection.read(&mut request);
                    connection
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                        )
                        .unwrap();
                    let body = vec![b'x'; MAX_RESPONSE_BYTES as usize + 1];
                    let _ = write!(connection, "{:x}\r\n", body.len());
                    let _ = connection.write_all(&body);
                    let _ = connection.write_all(b"\r\n0\r\n\r\n");
                });
                let response = Client::new()
                    .get(format!("http://{address}"))
                    .send()
                    .await
                    .unwrap();

                assert_eq!(
                    response_bytes(response, "testing response bounds")
                        .await
                        .unwrap_err(),
                    "Garmoth returned an unexpectedly large response."
                );
                server.join().unwrap();
            });
    }
}
