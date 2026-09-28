use std::collections::BTreeSet;

use serde::Deserialize;

#[derive(Deserialize)]
struct GrindBuff {
    id: i64,
    rate: i64,
    uncapped: bool,
    amount: i64,
    group: Option<String>,
}

// Capped buffs add up to at most 300%; uncapped buffs such as Blessing of the Morning and Eye of Arsha add on top.
const DROP_RATE_CAP: i64 = 300;

#[derive(Debug, PartialEq)]
pub(super) struct DropTotals {
    pub(super) rate: i64,
    pub(super) amount: i64,
}

/// Checks a buff selection against the bundled catalog and returns its drop rate and drop amount.
pub(super) fn drop_totals(buff_ids: &[i64]) -> Result<DropTotals, String> {
    let catalog = serde_json::from_str::<Vec<GrindBuff>>(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/data/garmothBuffs.json"
    )))
    .map_err(|_| "the bundled Garmoth buffs are invalid".to_string())?;
    let mut ids = BTreeSet::new();
    let mut groups = BTreeSet::new();
    let mut capped = 0;
    let mut uncapped = 0;
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
        if buff.uncapped {
            uncapped += buff.rate;
        } else {
            capped += buff.rate;
        }
        amount += buff.amount;
    }
    Ok(DropTotals {
        rate: capped.min(DROP_RATE_CAP) + uncapped,
        amount,
    })
}

/// The remembered selection starts empty when it no longer fits the bundled catalog, for example after a buff was
/// retired on Garmoth.
pub(super) fn parse_stored_buffs(value: Option<String>) -> Vec<i64> {
    value
        .and_then(|value| serde_json::from_str::<Vec<i64>>(&value).ok())
        .filter(|ids| drop_totals(ids).is_ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totals_drop_rate_with_the_cap_and_drop_amount() {
        assert_eq!(drop_totals(&[]), Ok(DropTotals { rate: 0, amount: 0 }));
        // Loot scroll Lv. 2, Adventurer's Luck V, Blessing of Old Moon Scroll.
        assert_eq!(
            drop_totals(&[2, 8, 138]),
            Ok(DropTotals {
                rate: 250,
                amount: 200
            })
        );
        // Capped buffs past 300%, then Blessing of the Morning, Eye of Arsha, and Edania Buff on top.
        let capped = [2, 8, 138, 3, 79];
        assert_eq!(drop_totals(&capped).unwrap().rate, 300);
        let with_uncapped = [&capped[..], &[46, 36, 77]].concat();
        assert_eq!(drop_totals(&with_uncapped).unwrap().rate, 470);
        // Blessing of Agris Scroll also adds past the cap.
        let with_agris = [&with_uncapped[..], &[218]].concat();
        assert_eq!(drop_totals(&with_agris).unwrap().rate, 520);
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
            assert!(drop_totals(&ids).is_err(), "{ids:?}");
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
