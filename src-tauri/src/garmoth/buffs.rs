use std::collections::BTreeSet;

use serde::Deserialize;

#[derive(Deserialize)]
struct GrindBuff {
    id: i64,
    amount: i64,
    group: Option<String>,
}

/// Checks a buff selection against the bundled catalog and returns its total drop amount.
pub(super) fn drop_amount(buff_ids: &[i64]) -> Result<i64, String> {
    let catalog = serde_json::from_str::<Vec<GrindBuff>>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/data/garmothBuffs.json"
    )))
    .map_err(|_| "the bundled Garmoth buffs are invalid".to_string())?;
    let mut ids = BTreeSet::new();
    let mut groups = BTreeSet::new();
    let mut amount = 0;
    for id in buff_ids {
        let buff = catalog
            .iter()
            .find(|buff| buff.id == *id)
            .ok_or_else(|| "the upload contains an unknown Garmoth buff".to_string())?;
        if !ids.insert(id)
            || buff
                .group
                .as_ref()
                .is_some_and(|group| !groups.insert(group))
        {
            return Err("choose each buff once, and one tier of each buff".into());
        }
        amount += buff.amount;
    }
    Ok(amount)
}

/// The remembered selection starts empty when it no longer fits the bundled catalog, for example after a buff was
/// retired on Garmoth.
pub(super) fn parse_stored_buffs(value: Option<String>) -> Vec<i64> {
    value
        .and_then(|value| serde_json::from_str::<Vec<i64>>(&value).ok())
        .filter(|ids| drop_amount(ids).is_ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_drop_amounts_of_known_buffs() {
        assert_eq!(drop_amount(&[]), Ok(0));
        // Loot scroll Lv. 2, Adventurer's Luck V, Blessing of Old Moon Scroll.
        assert_eq!(drop_amount(&[2, 8, 138]), Ok(200));
    }

    #[test]
    fn rejects_unknown_repeated_or_combined_tiers() {
        for ids in [
            vec![999_999],
            vec![8, 8],
            vec![1, 2],
            vec![12, 8],
            vec![61, 65],
            vec![215, 51],
        ] {
            assert!(drop_amount(&ids).is_err(), "{ids:?}");
        }
    }

    #[test]
    fn stored_selection_falls_back_to_empty() {
        assert_eq!(parse_stored_buffs(Some("[2,8]".into())), vec![2, 8]);
        assert!(parse_stored_buffs(None).is_empty());
        assert!(parse_stored_buffs(Some("[1,2]".into())).is_empty());
        assert!(parse_stored_buffs(Some("[999999]".into())).is_empty());
        assert!(parse_stored_buffs(Some("not json".into())).is_empty());
    }
}
