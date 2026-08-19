use std::{collections::HashSet, time::Duration};

use serde::Deserialize;
use tauri::State;

use crate::database::{
    save_market_price_records, timestamp_ms, DatabasePath, MarketPriceSnapshot, Region,
};

const ARSHA_API_URL: &str = "https://api.arsha.io";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArshaItem {
    id: i64,
    base_price: i64,
}

#[derive(Deserialize)]
struct ArshaError {
    message: String,
}

fn validate_item_ids(item_ids: &[i64]) -> Result<HashSet<i64>, String> {
    if item_ids.is_empty() || item_ids.len() > 100 || item_ids.iter().any(|id| *id <= 0) {
        return Err("between 1 and 100 valid market item IDs are required".into());
    }

    let requested = item_ids.iter().copied().collect::<HashSet<_>>();
    if requested.len() != item_ids.len() {
        return Err("market item IDs must be unique".into());
    }
    Ok(requested)
}

fn parse_market_prices(
    body: &str,
    item_ids: &[i64],
    fetched_at: i64,
) -> Result<Vec<MarketPriceSnapshot>, String> {
    let requested = validate_item_ids(item_ids)?;

    let items = serde_json::from_str::<Vec<ArshaItem>>(body)
        .map_err(|error| format!("invalid Arsha response: {error}"))?;
    let returned = items.iter().map(|item| item.id).collect::<HashSet<_>>();
    if items.len() != requested.len() || returned != requested {
        return Err("Arsha did not return every requested market item".into());
    }
    if items.iter().any(|item| item.base_price < 0) {
        return Err("Arsha returned an invalid market price".into());
    }

    let mut snapshots = items
        .into_iter()
        .map(|item| MarketPriceSnapshot {
            item_id: item.id,
            sub_id: 0,
            base_price: item.base_price,
            fetched_at,
        })
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| snapshot.item_id);
    Ok(snapshots)
}

#[tauri::command]
pub async fn fetch_market_prices(
    region: Region,
    item_ids: Vec<i64>,
    state: State<'_, DatabasePath>,
) -> Result<Vec<MarketPriceSnapshot>, String> {
    validate_item_ids(&item_ids)?;
    let database_path = state.0.clone();
    let ids = item_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("shakatu-sheets/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{ARSHA_API_URL}/v2/{}/search", region.as_str()))
        .query(&[("ids", ids.as_str()), ("lang", "en")])
        .send()
        .await
        .map_err(|error| format!("could not reach Arsha: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("could not read the Arsha response: {error}"))?;

    if !status.is_success() {
        let message = serde_json::from_str::<ArshaError>(&body)
            .map(|error| error.message)
            .unwrap_or_else(|_| "request failed".into());
        return Err(format!("Arsha returned {status}: {message}"));
    }

    let snapshots = parse_market_prices(&body, &item_ids, timestamp_ms())?;
    save_market_price_records(&database_path, region, &snapshots)?;
    Ok(snapshots)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESPONSE: &str = r#"[
        {"name":"Black Stone","id":16001,"currentStock":49617,"basePrice":129000,"totalTrades":3619238972},
        {"name":"Deboreka Ring","id":12094,"currentStock":150,"basePrice":211000000,"totalTrades":2814531}
    ]"#;

    #[test]
    fn parses_a_complete_arsha_response() {
        let prices = parse_market_prices(RESPONSE, &[16_001, 12_094], 1_000).unwrap();

        assert_eq!(
            prices,
            vec![
                MarketPriceSnapshot {
                    item_id: 12_094,
                    sub_id: 0,
                    base_price: 211_000_000,
                    fetched_at: 1_000,
                },
                MarketPriceSnapshot {
                    item_id: 16_001,
                    sub_id: 0,
                    base_price: 129_000,
                    fetched_at: 1_000,
                },
            ]
        );
    }

    #[test]
    fn rejects_an_incomplete_arsha_response() {
        assert_eq!(
            parse_market_prices(RESPONSE, &[16_001, 12_094, 120_061], 1_000).unwrap_err(),
            "Arsha did not return every requested market item"
        );
    }
}
