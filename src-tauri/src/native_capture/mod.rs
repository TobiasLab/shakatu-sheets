#[cfg(target_os = "linux")]
mod linux;

use serde::{Deserialize, Serialize};

use crate::persistence::{load_setting, save_settings, DatabasePath};

const LOOT_CAPTURE_SETTINGS_KEY: &str = "loot-capture-settings";
const DEFAULT_UI_SCALE_PERCENT: u32 = 80;
const SUPPORTED_SOURCE_DIMENSIONS: [(u32, u32); 3] = [(3440, 1440), (2560, 1440), (1920, 1080)];
const SEARCH_SOURCE_DIMENSIONS: (u32, u32) = (3440, 1440);
const SEARCH_UI_SCALE_PERCENT: u32 = 80;
const SEARCH_REGION_DIMENSIONS: (u32, u32) = (800, 600);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl NormalizedRegion {
    fn validate(self) -> Result<(), String> {
        if ![self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err("capture region bounds must be finite".into());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return Err("capture region must have a non-negative origin and positive size".into());
        }
        if self.x + self.width > 1.0 || self.y + self.height > 1.0 {
            return Err("capture region must be within normalized bounds".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PixelRegion {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

fn normalized_to_pixel_region(
    region: NormalizedRegion,
    source_width: u32,
    source_height: u32,
) -> Result<PixelRegion, String> {
    region.validate()?;
    if source_width == 0 || source_height == 0 {
        return Err("capture source dimensions must be positive".into());
    }

    let x = pixel_boundary(region.x, source_width, false);
    let y = pixel_boundary(region.y, source_height, false);
    let end_x = pixel_boundary(region.x + region.width, source_width, true).min(source_width);
    let end_y = pixel_boundary(region.y + region.height, source_height, true).min(source_height);
    if x >= end_x || y >= end_y {
        return Err("capture region maps to an empty pixel area".into());
    }

    Ok(PixelRegion {
        x,
        y,
        width: end_x - x,
        height: end_y - y,
    })
}

fn pixel_boundary(normalized: f64, source_size: u32, round_up: bool) -> u32 {
    let scaled = normalized * source_size as f64;
    let nearest = scaled.round();
    let tolerance = f64::EPSILON * scaled.abs().max(1.0) * 4.0;
    let scaled = if (scaled - nearest).abs() <= tolerance {
        nearest
    } else {
        scaled
    };
    if round_up {
        scaled.ceil() as u32
    } else {
        scaled.floor() as u32
    }
}

fn default_ui_scale_percent() -> u32 {
    DEFAULT_UI_SCALE_PERCENT
}

fn loot_region_dimensions(ui_scale_percent: u32) -> Result<(u32, u32), String> {
    match ui_scale_percent {
        80 => Ok((362, 311)),
        100 => Ok((453, 389)),
        _ => Err("loot capture UI scale must be 80 or 100 percent".into()),
    }
}

fn rare_loot_region_dimensions(ui_scale_percent: u32) -> Result<(u32, u32), String> {
    match ui_scale_percent {
        80 => Ok((400, 100)),
        100 => Ok((500, 125)),
        _ => Err("loot capture UI scale must be 80 or 100 percent".into()),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LootCaptureSettings {
    pub region: NormalizedRegion,
    #[serde(default)]
    pub rare_region: Option<NormalizedRegion>,
    #[serde(default)]
    pub rare_region_confirmed: bool,
    pub source_width: u32,
    pub source_height: u32,
    #[serde(default = "default_ui_scale_percent")]
    pub ui_scale_percent: u32,
}

impl LootCaptureSettings {
    fn pixel_region(self) -> Result<PixelRegion, String> {
        self.validated_pixel_region(self.region, loot_region_dimensions, "loot capture region")
    }

    fn rare_pixel_region(self) -> Result<Option<PixelRegion>, String> {
        self.rare_region
            .map(|region| {
                self.validated_pixel_region(
                    region,
                    rare_loot_region_dimensions,
                    "rare loot capture region",
                )
            })
            .transpose()
    }

    fn validated_pixel_region(
        self,
        region: NormalizedRegion,
        dimensions: fn(u32) -> Result<(u32, u32), String>,
        name: &str,
    ) -> Result<PixelRegion, String> {
        if !SUPPORTED_SOURCE_DIMENSIONS.contains(&(self.source_width, self.source_height)) {
            return Err(format!(
                "unsupported loot capture source {}x{}; supported sources are 3440x1440, 2560x1440, and 1920x1080",
                self.source_width, self.source_height
            ));
        }
        let expected = dimensions(self.ui_scale_percent)?;
        let pixels = normalized_to_pixel_region(region, self.source_width, self.source_height)?;
        if (pixels.width, pixels.height) != expected {
            return Err(format!(
                "{name} for {}% UI scale must map to exactly {}x{} pixels; mapped to {}x{}",
                self.ui_scale_percent, expected.0, expected.1, pixels.width, pixels.height
            ));
        }
        Ok(pixels)
    }

    fn validate(self) -> Result<(), String> {
        self.pixel_region()?;
        self.rare_pixel_region()?;
        if self.rare_region_confirmed && self.rare_region.is_none() {
            return Err("confirmed rare loot capture settings require a rare region".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum NativeCaptureSelection {
    Search {
        region: NormalizedRegion,
        source_width: u32,
        source_height: u32,
        ui_scale_percent: u32,
    },
    Regions {
        settings: LootCaptureSettings,
    },
}

impl NativeCaptureSelection {
    fn source_dimensions(self) -> (u32, u32) {
        match self {
            Self::Search {
                source_width,
                source_height,
                ..
            } => (source_width, source_height),
            Self::Regions { settings } => (settings.source_width, settings.source_height),
        }
    }

    fn search_pixel_region(self) -> Result<PixelRegion, String> {
        let Self::Search {
            region,
            source_width,
            source_height,
            ui_scale_percent,
        } = self
        else {
            return Err("capture selection is not in search mode".into());
        };
        if (source_width, source_height) != SEARCH_SOURCE_DIMENSIONS {
            return Err(format!(
                "unsupported search capture source {source_width}x{source_height}; supported source is 3440x1440"
            ));
        }
        if ui_scale_percent != SEARCH_UI_SCALE_PERCENT {
            return Err("search capture UI scale must be 80 percent".into());
        }
        let pixels = normalized_to_pixel_region(region, source_width, source_height)?;
        if (pixels.width, pixels.height) != SEARCH_REGION_DIMENSIONS {
            return Err(format!(
                "search capture region for {ui_scale_percent}% UI scale must map to exactly 800x600 pixels; mapped to {}x{}",
                pixels.width, pixels.height
            ));
        }
        Ok(pixels)
    }

    fn validate(self) -> Result<(), String> {
        match self {
            Self::Search { .. } => self.search_pixel_region().map(|_| ()),
            Self::Regions { settings } => settings.validate(),
        }
    }
}

fn parse_loot_capture_settings(value: &str) -> Result<LootCaptureSettings, String> {
    let settings: LootCaptureSettings = serde_json::from_str(value)
        .map_err(|error| format!("saved loot capture settings are invalid: {error}"))?;
    settings
        .validate()
        .map_err(|error| format!("saved {error}"))?;
    Ok(settings)
}

#[derive(Default)]
pub struct NativeCaptureState {
    #[cfg(target_os = "linux")]
    capture: linux::CaptureState,
}

#[tauri::command]
pub async fn start_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    frames: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    if capture_token == 0 {
        return Err("native display capture token must be positive".into());
    }
    if let Some(selection) = selection {
        selection.validate()?;
    }

    #[cfg(target_os = "linux")]
    return linux::start(&state.capture, frames, capture_token, selection).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, frames, capture_token, selection);
        Err("Native display capture is only available on Linux.".to_string())
    }
}

#[tauri::command]
pub fn set_native_display_capture_region(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
    selection: Option<NativeCaptureSelection>,
) -> Result<(), String> {
    if capture_token == 0 {
        return Err("native display capture token must be positive".into());
    }
    if let Some(selection) = selection {
        selection.validate()?;
    }

    #[cfg(target_os = "linux")]
    return linux::set_selection(&state.capture, capture_token, selection);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, capture_token, selection);
        Err("Native display capture is only available on Linux.".to_string())
    }
}

#[tauri::command]
pub fn load_loot_capture_settings(
    state: tauri::State<'_, DatabasePath>,
) -> Result<Option<LootCaptureSettings>, String> {
    load_setting(&state.0, LOOT_CAPTURE_SETTINGS_KEY)?
        .map(|value| parse_loot_capture_settings(&value))
        .transpose()
}

#[tauri::command]
pub fn save_loot_capture_settings(
    settings: LootCaptureSettings,
    state: tauri::State<'_, DatabasePath>,
) -> Result<(), String> {
    settings.validate()?;
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    save_settings(
        &state.0,
        &[(LOOT_CAPTURE_SETTINGS_KEY, Some(value.as_str()))],
    )
}

#[tauri::command]
pub fn acknowledge_native_display_frame(
    state: tauri::State<'_, NativeCaptureState>,
    capture_id: u32,
    batch_id: u32,
    kind: u32,
) {
    #[cfg(target_os = "linux")]
    linux::acknowledge_frame(&state.capture, capture_id, batch_id, kind);

    #[cfg(not(target_os = "linux"))]
    let _ = (state, capture_id, batch_id, kind);
}

#[tauri::command]
pub fn stop_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    capture_token: u64,
) {
    #[cfg(target_os = "linux")]
    linux::stop(&state.capture, capture_token);

    #[cfg(not(target_os = "linux"))]
    let _ = (state, capture_token);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region() -> NormalizedRegion {
        NormalizedRegion {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
        }
    }

    fn selection_with_dimensions(
        source_width: u32,
        source_height: u32,
        ui_scale_percent: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> LootCaptureSettings {
        LootCaptureSettings {
            region: NormalizedRegion {
                x: x as f64 / source_width as f64,
                y: y as f64 / source_height as f64,
                width: width as f64 / source_width as f64,
                height: height as f64 / source_height as f64,
            },
            rare_region: None,
            rare_region_confirmed: false,
            source_width,
            source_height,
            ui_scale_percent,
        }
    }

    fn selection(
        source_width: u32,
        source_height: u32,
        ui_scale_percent: u32,
        x: u32,
        y: u32,
    ) -> LootCaptureSettings {
        let (width, height) = loot_region_dimensions(ui_scale_percent).unwrap();
        selection_with_dimensions(
            source_width,
            source_height,
            ui_scale_percent,
            x,
            y,
            width,
            height,
        )
    }

    fn search_selection(
        source_width: u32,
        source_height: u32,
        ui_scale_percent: u32,
        width: u32,
        height: u32,
    ) -> NativeCaptureSelection {
        NativeCaptureSelection::Search {
            region: NormalizedRegion {
                x: 100.0 / source_width as f64,
                y: 200.0 / source_height as f64,
                width: width as f64 / source_width as f64,
                height: height as f64 / source_height as f64,
            },
            source_width,
            source_height,
            ui_scale_percent,
        }
    }

    #[test]
    fn validates_normalized_regions() {
        region().validate().unwrap();
        NormalizedRegion {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }
        .validate()
        .unwrap();

        for invalid in [
            NormalizedRegion {
                x: f64::NAN,
                ..region()
            },
            NormalizedRegion {
                x: -0.1,
                ..region()
            },
            NormalizedRegion {
                width: 0.0,
                ..region()
            },
            NormalizedRegion {
                x: 0.8,
                width: 0.3,
                ..region()
            },
            NormalizedRegion {
                y: 0.8,
                height: 0.3,
                ..region()
            },
        ] {
            assert!(invalid.validate().is_err());
        }
    }

    #[test]
    fn loot_capture_settings_json_round_trips_and_uses_camel_case() {
        let settings = selection(2560, 1440, 100, 100, 200);

        let json = serde_json::to_string(&settings).unwrap();
        let parsed = parse_loot_capture_settings(&json).unwrap();

        assert!(json.contains("\"sourceWidth\":2560"));
        assert!(json.contains("\"uiScalePercent\":100"));
        assert!(json.contains("\"rareRegionConfirmed\":false"));
        assert_eq!(
            parsed.pixel_region().unwrap(),
            PixelRegion {
                x: 100,
                y: 200,
                width: 453,
                height: 389,
            }
        );
    }

    #[test]
    fn runtime_selections_deserialize_from_tagged_typescript_shapes() {
        let search: NativeCaptureSelection = serde_json::from_value(serde_json::json!({
            "mode": "search",
            "region": {
                "x": 100.0 / 3440.0,
                "y": 200.0 / 1440.0,
                "width": 800.0 / 3440.0,
                "height": 600.0 / 1440.0
            },
            "sourceWidth": 3440,
            "sourceHeight": 1440,
            "uiScalePercent": 80
        }))
        .unwrap();
        search.validate().unwrap();
        assert_eq!(
            search.search_pixel_region().unwrap(),
            PixelRegion {
                x: 100,
                y: 200,
                width: 800,
                height: 600,
            }
        );

        let settings = selection(2560, 1440, 100, 100, 200);
        let regions: NativeCaptureSelection = serde_json::from_value(serde_json::json!({
            "mode": "regions",
            "settings": settings
        }))
        .unwrap();
        assert_eq!(regions, NativeCaptureSelection::Regions { settings });
        regions.validate().unwrap();
    }

    #[test]
    fn rejects_unsupported_search_sources_scales_and_crop_sizes() {
        assert!(search_selection(2560, 1440, 80, 800, 600)
            .validate()
            .unwrap_err()
            .contains("supported source is 3440x1440"));
        assert!(search_selection(3440, 1440, 100, 800, 600)
            .validate()
            .unwrap_err()
            .contains("must be 80 percent"));
        assert!(search_selection(3440, 1440, 80, 799, 600)
            .validate()
            .unwrap_err()
            .contains("exactly 800x600"));
    }

    #[test]
    fn persisted_settings_keep_the_untagged_schema() {
        let settings = selection(3440, 1440, 80, 100, 200);
        let json = serde_json::to_value(settings).unwrap();

        assert!(json.get("mode").is_none());
        assert!(json.get("settings").is_none());
        let parsed = parse_loot_capture_settings(&json.to_string()).unwrap();
        assert_eq!(parsed.source_width, settings.source_width);
        assert_eq!(parsed.source_height, settings.source_height);
        assert_eq!(parsed.ui_scale_percent, settings.ui_scale_percent);
        assert_eq!(parsed.rare_region, settings.rare_region);
        assert_eq!(
            parsed.pixel_region().unwrap(),
            settings.pixel_region().unwrap()
        );
    }

    #[test]
    fn dual_loot_capture_settings_round_trip() {
        let mut settings = selection(2560, 1440, 100, 100, 200);
        settings.rare_region = Some(NormalizedRegion {
            x: 1200.0 / 2560.0,
            y: 900.0 / 1440.0,
            width: 500.0 / 2560.0,
            height: 125.0 / 1440.0,
        });
        settings.rare_region_confirmed = true;

        let json = serde_json::to_string(&settings).unwrap();
        let parsed = parse_loot_capture_settings(&json).unwrap();

        assert!(json.contains("\"rareRegion\""));
        assert!(json.contains("\"rareRegionConfirmed\":true"));
        assert_eq!(parsed, settings);
        assert_eq!(
            parsed.rare_pixel_region().unwrap(),
            Some(PixelRegion {
                x: 1200,
                y: 900,
                width: 500,
                height: 125,
            })
        );
    }

    #[test]
    fn validates_every_source_and_scale_at_the_bottom_right_boundary() {
        for (source_width, source_height) in SUPPORTED_SOURCE_DIMENSIONS {
            for ui_scale_percent in [80, 100] {
                let (width, height) = loot_region_dimensions(ui_scale_percent).unwrap();
                let expected = PixelRegion {
                    x: source_width - width,
                    y: source_height - height,
                    width,
                    height,
                };
                assert_eq!(
                    selection(
                        source_width,
                        source_height,
                        ui_scale_percent,
                        expected.x,
                        expected.y,
                    )
                    .pixel_region()
                    .unwrap(),
                    expected
                );
            }
        }
    }

    #[test]
    fn rejects_unsupported_sources_scales_and_wrong_crop_sizes() {
        assert!(selection(1280, 720, 80, 10, 10)
            .validate()
            .unwrap_err()
            .contains("unsupported loot capture source"));

        let unsupported_scale = selection_with_dimensions(1920, 1080, 90, 10, 10, 362, 311);
        assert!(unsupported_scale
            .validate()
            .unwrap_err()
            .contains("80 or 100"));

        let wrong_size = selection_with_dimensions(3440, 1440, 100, 10, 10, 452, 389);
        assert!(wrong_size
            .validate()
            .unwrap_err()
            .contains("exactly 453x389"));
    }

    #[test]
    fn legacy_settings_default_to_80_percent() {
        let legacy = selection(3440, 1440, 80, 100, 200);
        let mut json = serde_json::to_value(legacy).unwrap();
        json.as_object_mut().unwrap().remove("uiScalePercent");
        json.as_object_mut().unwrap().remove("rareRegion");
        json.as_object_mut().unwrap().remove("rareRegionConfirmed");

        let parsed = parse_loot_capture_settings(&json.to_string()).unwrap();

        assert_eq!(parsed.ui_scale_percent, 80);
        assert_eq!(parsed.rare_region, None);
        assert!(!parsed.rare_region_confirmed);
        assert_eq!(parsed.pixel_region().unwrap().width, 362);
    }

    #[test]
    fn rejects_an_invalid_rare_region_size() {
        let mut settings = selection(3440, 1440, 80, 100, 200);
        settings.rare_region = Some(NormalizedRegion {
            x: 1000.0 / 3440.0,
            y: 1000.0 / 1440.0,
            width: 399.0 / 3440.0,
            height: 100.0 / 1440.0,
        });

        assert!(settings
            .validate()
            .unwrap_err()
            .contains("rare loot capture region for 80% UI scale must map to exactly 400x100"));

        let mut missing = selection(3440, 1440, 80, 100, 200);
        missing.rare_region_confirmed = true;
        assert!(missing
            .validate()
            .unwrap_err()
            .contains("confirmed rare loot capture settings require a rare region"));
    }

    #[test]
    fn rejects_malformed_saved_settings() {
        assert!(parse_loot_capture_settings("not json").is_err());
        assert!(parse_loot_capture_settings(
            r#"{"region":{"x":0.9,"y":0.0,"width":0.2,"height":1.0},"sourceWidth":3440,"sourceHeight":1440,"uiScalePercent":80}"#,
        )
        .is_err());
        assert!(parse_loot_capture_settings(
            r#"{"region":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"sourceWidth":0,"sourceHeight":1440,"uiScalePercent":80}"#,
        )
        .is_err());
    }
}
