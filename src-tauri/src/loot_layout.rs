use quick_xml::{events::Event, Reader};
use serde::Serialize;

const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const INVALID_XML: &str =
    "Could not read the XML. Choose Black Desert's account-level gamevariable.xml.";
const NORMAL_PANEL: &str = "159";
const RARE_PANEL: &str = "161";

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PanelPosition {
    Found { x: f64, y: f64 },
    Unavailable { message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LootLayout {
    normal: PanelPosition,
    rare: PanelPosition,
    ui_scale_percent: u32,
}

#[tauri::command]
pub fn read_loot_layout(xml: String) -> Result<LootLayout, String> {
    parse_layout(&xml)
}

fn parse_layout(xml: &str) -> Result<LootLayout, String> {
    if xml.len() > MAX_XML_BYTES {
        return Err("The settings file is too large (maximum 2 MiB).".into());
    }
    // BDO writes several top-level elements rather than one XML document root.
    let mut reader = Reader::from_str(xml.trim_start_matches('\u{feff}'));
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut normal = None;
    let mut rare = None;
    let mut scale = None;
    let mut layouts = 0;
    loop {
        let event = reader.read_event().map_err(|_| INVALID_XML)?;
        let is_start = matches!(event, Event::Start(_));
        match event {
            Event::Start(ref element) | Event::Empty(ref element) => {
                let name = element.name();
                let name = name.as_ref();
                if path.is_empty() && name == b"UIData" {
                    layouts += 1;
                }
                let panel = path.len() == 1 && path[0] == b"UIData" && name == b"UIData";
                let ui_scale =
                    path.len() == 1 && path[0] == b"GameOptionGlobal" && name == b"UiScale";
                if panel || ui_scale {
                    let attrs = element
                        .attributes()
                        .map(|attr| {
                            let attr = attr.map_err(|_| INVALID_XML)?;
                            let value = attr
                                .decoded_and_normalized_value(
                                    quick_xml::XmlVersion::Implicit1_0,
                                    reader.decoder(),
                                )
                                .map_err(|_| INVALID_XML)?;
                            Ok::<_, &str>((attr.key.as_ref().to_vec(), value.into_owned()))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    let get = |key: &[u8]| {
                        attrs
                            .iter()
                            .find(|(k, _)| k == key)
                            .map(|(_, v)| v.as_str())
                    };
                    let slot = match get(b"Index") {
                        Some(NORMAL_PANEL) if panel => Some((&mut normal, "loot stack")),
                        Some(RARE_PANEL) if panel => Some((&mut rare, "rare loot")),
                        _ => None,
                    };
                    if let Some((slot, label)) = slot {
                        if slot.is_some() {
                            return Err(format!(
                                "The settings file contains more than one {label} position."
                            ));
                        }
                        *slot = Some(panel_position(&get, label));
                    }
                    if ui_scale {
                        if scale.is_some() {
                            return Err(INVALID_XML.into());
                        }
                        scale = Some(match get(b"Value").and_then(|v| v.parse::<f64>().ok()) {
                            Some(v) if (v - 0.8).abs() < 0.000001 => 80,
                            Some(v) if (v - 1.0).abs() < 0.000001 => 100,
                            _ => return Err("This layout needs 80% or 100% BDO UI scale.".into()),
                        });
                    }
                }
                if is_start {
                    path.push(name.to_vec());
                }
            }
            Event::End(_) => {
                path.pop().ok_or(INVALID_XML)?;
            }
            Event::DocType(_) => return Err(INVALID_XML.into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if !path.is_empty() || layouts != 1 {
        return Err(INVALID_XML.into());
    }
    let normal = normal.unwrap_or_else(|| missing("loot stack"));
    let rare = rare.unwrap_or_else(|| missing("rare loot"));
    if let (
        PanelPosition::Unavailable { message: normal },
        PanelPosition::Unavailable { message: rare },
    ) = (&normal, &rare)
    {
        return Err(format!(
            "{normal} {rare} Choose Black Desert's account-level gamevariable.xml, not a character file."
        ));
    }
    Ok(LootLayout {
        normal,
        rare,
        ui_scale_percent: scale
            .ok_or("The file has no UI scale. Choose the account-level gamevariable.xml.")?,
    })
}

/// A hidden, unsaved, or invalid panel only skips that panel, so the other one can still be imported.
fn panel_position<'a>(get: &impl Fn(&[u8]) -> Option<&'a str>, label: &str) -> PanelPosition {
    if get(b"IsShow") == Some("false") {
        return PanelPosition::Unavailable {
            message: format!(
                "The {label} notification is hidden in this layout. Enable it in BDO and save again."
            ),
        };
    }
    let number = |key| {
        get(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
    };
    let (Some(x), Some(y)) = (number(b"RelativePosX"), number(b"RelativePosY")) else {
        return PanelPosition::Unavailable {
            message: format!("The file has no valid {label} position."),
        };
    };
    if x == 0.0 && y == 0.0 {
        return PanelPosition::Unavailable {
            message: format!(
                "The {label} position has not been saved. Move it in BDO's Edit UI and save first."
            ),
        };
    }
    PanelPosition::Found { x, y }
}

fn missing(label: &str) -> PanelPosition {
    PanelPosition::Unavailable {
        message: format!("No {label} position was found."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(panels: &str) -> String {
        format!(
            r#"<UIData Version="2">{panels}</UIData><GameOptionGlobal><UiScale Value="0.8"/></GameOptionGlobal>"#
        )
    }
    const NORMAL: &str = r#"<UIData Index="159" IsShow="true" PendingType="LeftBottom" PosX="657" PosY="136" RelativePosX="0.1934883744" RelativePosY="0.8073292375"/>"#;
    const RARE: &str = r#"<UIData Index="161" IsShow="true" PendingType="LeftTop" PosX="96" PosY="483" RelativePosX="0.07112970948" RelativePosY="0.3039378822"/>"#;

    fn found(position: &PanelPosition) -> (f64, f64) {
        match position {
            PanelPosition::Found { x, y } => (*x, *y),
            PanelPosition::Unavailable { message } => panic!("{message}"),
        }
    }

    #[test]
    fn reads_both_active_positions_without_using_anchor_offsets_or_presets() {
        let xml = format!(
            r#"{}<UISettingPreset><UISettingPreset0 Index="159" RelativePosX="0.9" RelativePosY="0.1"/><UISettingPreset1 Index="161" RelativePosX="0.9" RelativePosY="0.1"/></UISettingPreset>"#,
            layout(&format!("{NORMAL}{RARE}"))
        );
        let result = parse_layout(&xml).unwrap();
        assert_eq!(found(&result.normal), (0.1934883744, 0.8073292375));
        assert_eq!(found(&result.rare), (0.07112970948, 0.3039378822));
        assert_eq!(result.ui_scale_percent, 80);
        let moved = parse_layout(
            &xml.replace("LeftBottom", "RightBottom")
                .replace("LeftTop", "RightTop"),
        )
        .unwrap();
        assert_eq!(moved.normal, result.normal);
        assert_eq!(moved.rare, result.rare);
        assert_eq!(
            parse_layout(&xml.replace("Value=\"0.8\"", "Value=\"1.0\""))
                .unwrap()
                .ui_scale_percent,
            100
        );
    }

    #[test]
    fn imports_one_panel_when_the_other_is_missing_hidden_unsaved_or_invalid() {
        for rare in [
            String::new(),
            r#"<UIData Index="161" IsShow="true"/>"#.into(),
            RARE.replace("true", "false"),
            RARE.replace("0.07112970948", "0")
                .replace("0.3039378822", "0"),
            RARE.replace("0.07112970948", "NaN"),
        ] {
            let result = parse_layout(&layout(&format!("{NORMAL}{rare}"))).unwrap();
            assert!(matches!(result.normal, PanelPosition::Found { .. }));
            assert!(matches!(result.rare, PanelPosition::Unavailable { .. }));
        }
        let result = parse_layout(&layout(RARE)).unwrap();
        assert!(matches!(result.normal, PanelPosition::Unavailable { .. }));
        assert_eq!(found(&result.rare), (0.07112970948, 0.3039378822));
    }

    #[test]
    fn rejects_files_without_any_usable_panel() {
        for panels in [
            String::new(),
            r#"<UIData Index="159" IsShow="true"/><UIData Index="161" IsShow="true"/>"#.into(),
            format!(
                "{}{}",
                NORMAL.replace("true", "false"),
                RARE.replace("true", "false")
            ),
            NORMAL.replace("159", "160"),
        ] {
            assert!(parse_layout(&layout(&panels)).is_err());
        }
    }

    #[test]
    fn rejects_invalid_coordinates_scale_and_ambiguous_layouts() {
        for value in ["NaN", "inf", "-0.1", "1.1", "", "garbage"] {
            assert!(parse_layout(&layout(&NORMAL.replace("0.1934883744", value))).is_err());
        }
        let xml = layout(&format!("{NORMAL}{RARE}"));
        for invalid in [
            xml.replace("Value=\"0.8\"", "Value=\"0.9\""),
            xml.replace("<UiScale Value=\"0.8\"/>", ""),
            layout(&format!("{NORMAL}{NORMAL}{RARE}")),
            layout(&format!("{NORMAL}{RARE}{RARE}")),
            format!("{xml}<UIData/>"),
            xml.replace("RelativePosX=", "RelativePosY="),
            xml.replace("</UIData>", "</Wrong>"),
            format!("{xml}<unclosed>"),
            format!("<!DOCTYPE x>{xml}"),
            "x".repeat(MAX_XML_BYTES + 1),
        ] {
            assert!(parse_layout(&invalid).is_err());
        }
    }
}
