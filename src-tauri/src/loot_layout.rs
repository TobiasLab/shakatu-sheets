use quick_xml::{events::Event, Reader};
use serde::Serialize;

const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const INVALID_XML: &str =
    "Could not read the XML. Choose Black Desert's account-level gamevariable.xml.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LootLayoutPosition {
    x: f64,
    y: f64,
    ui_scale_percent: u32,
}

#[tauri::command]
pub fn read_normal_loot_layout(xml: String) -> Result<LootLayoutPosition, String> {
    parse_layout(&xml)
}

fn parse_layout(xml: &str) -> Result<LootLayoutPosition, String> {
    if xml.len() > MAX_XML_BYTES {
        return Err("The settings file is too large (maximum 2 MiB).".into());
    }
    // BDO writes several top-level elements rather than one XML document root.
    let mut reader = Reader::from_str(xml.trim_start_matches('\u{feff}'));
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut position = None;
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
                    if panel && get(b"Index") == Some("159") {
                        if position.is_some() {
                            return Err(
                                "The settings file contains more than one normal loot position."
                                    .into(),
                            );
                        }
                        if get(b"IsShow") == Some("false") {
                            return Err("Normal loot notifications are hidden in this layout. Enable them in BDO and save again.".into());
                        }
                        let number = |key| {
                            get(key)
                                .and_then(|v| v.parse::<f64>().ok())
                                .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
                        };
                        let x = number(b"RelativePosX").ok_or("The file has no valid normal loot position. Choose the account-level gamevariable.xml, not a character file.")?;
                        let y = number(b"RelativePosY").ok_or("The file has no valid normal loot position. Choose the account-level gamevariable.xml, not a character file.")?;
                        if x == 0.0 && y == 0.0 {
                            return Err("The normal loot position has not been saved. Move it in BDO's Edit UI and save first.".into());
                        }
                        position = Some((x, y));
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
    let (x, y) = position.ok_or(
        "No normal loot position was found. Choose Black Desert's account-level gamevariable.xml.",
    )?;
    Ok(LootLayoutPosition {
        x,
        y,
        ui_scale_percent: scale
            .ok_or("The file has no UI scale. Choose the account-level gamevariable.xml.")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(panel: &str) -> String {
        format!(
            r#"<UIData Version="2">{panel}</UIData><GameOptionGlobal><UiScale Value="0.8"/></GameOptionGlobal>"#
        )
    }
    const PANEL: &str = r#"<UIData Index="159" IsShow="true" PendingType="LeftBottom" PosX="657" PosY="136" RelativePosX="0.1934883744" RelativePosY="0.8073292375"/>"#;

    #[test]
    fn reads_active_position_without_using_anchor_offsets_or_presets() {
        let xml = format!(
            r#"{}<UISettingPreset><UISettingPreset0 Index="159" RelativePosX="0.9" RelativePosY="0.1"/></UISettingPreset>"#,
            layout(PANEL)
        );
        let result = parse_layout(&xml).unwrap();
        assert_eq!(result.x, 0.1934883744);
        assert_eq!(result.y, 0.8073292375);
        assert_eq!(result.ui_scale_percent, 80);
        assert_eq!(
            parse_layout(&xml.replace("LeftBottom", "RightBottom"))
                .unwrap()
                .x,
            result.x
        );
        assert_eq!(
            parse_layout(&xml.replace("Value=\"0.8\"", "Value=\"1.0\""))
                .unwrap()
                .ui_scale_percent,
            100
        );
    }

    #[test]
    fn rejects_character_files_missing_hidden_and_unsaved_panels() {
        for panel in [
            String::new(),
            r#"<UIData Index="159" IsShow="true"/>"#.into(),
            PANEL.replace("true", "false"),
            PANEL
                .replace("0.1934883744", "0")
                .replace("0.8073292375", "0"),
            PANEL.replace("159", "161"),
        ] {
            assert!(parse_layout(&layout(&panel)).is_err());
        }
    }

    #[test]
    fn rejects_invalid_coordinates_scale_and_ambiguous_layouts() {
        for value in ["NaN", "inf", "-0.1", "1.1", "", "garbage"] {
            assert!(parse_layout(&layout(&PANEL.replace("0.1934883744", value))).is_err());
        }
        let xml = layout(PANEL);
        for invalid in [
            xml.replace("0.8", "0.9"),
            xml.replace("<UiScale Value=\"0.8\"/>", ""),
            layout(&format!("{PANEL}{PANEL}")),
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
