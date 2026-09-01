#[cfg(target_os = "linux")]
mod linux;

use serde::{Deserialize, Serialize};

use crate::persistence::{load_setting, save_settings, DatabasePath};

const LOOT_CAPTURE_SETTINGS_KEY: &str = "loot-capture-settings";
const LOOT_SOURCE_WIDTH: u32 = 3440;
const LOOT_SOURCE_HEIGHT: u32 = 1440;
const LOOT_REGION_WIDTH: u32 = 362;
const LOOT_REGION_HEIGHT: u32 = 311;

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

fn validate_loot_region(region: NormalizedRegion) -> Result<PixelRegion, String> {
    let pixels = normalized_to_pixel_region(region, LOOT_SOURCE_WIDTH, LOOT_SOURCE_HEIGHT)?;
    if pixels.width != LOOT_REGION_WIDTH || pixels.height != LOOT_REGION_HEIGHT {
        return Err(format!(
            "loot capture region must map to exactly {LOOT_REGION_WIDTH}x{LOOT_REGION_HEIGHT} pixels; mapped to {}x{}",
            pixels.width, pixels.height
        ));
    }
    Ok(pixels)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LootCaptureSettings {
    pub region: NormalizedRegion,
    pub source_width: u32,
    pub source_height: u32,
}

impl LootCaptureSettings {
    fn validate(&self) -> Result<(), String> {
        if self.source_width != LOOT_SOURCE_WIDTH || self.source_height != LOOT_SOURCE_HEIGHT {
            return Err(format!(
                "loot capture settings require a {LOOT_SOURCE_WIDTH}x{LOOT_SOURCE_HEIGHT} source"
            ));
        }
        validate_loot_region(self.region).map(|_| ())
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
    region: Option<NormalizedRegion>,
) -> Result<(), String> {
    if let Some(region) = region {
        validate_loot_region(region)?;
    }

    #[cfg(target_os = "linux")]
    return linux::start(&state.capture, frames, region).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, frames, region);
        Err("Native display capture is only available on Linux.".to_string())
    }
}

#[tauri::command]
pub fn set_native_display_capture_region(
    state: tauri::State<'_, NativeCaptureState>,
    region: Option<NormalizedRegion>,
) -> Result<(), String> {
    if let Some(region) = region {
        validate_loot_region(region)?;
    }

    #[cfg(target_os = "linux")]
    return linux::set_region(&state.capture, region);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, region);
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
pub fn stop_native_display_capture(state: tauri::State<'_, NativeCaptureState>) {
    #[cfg(target_os = "linux")]
    linux::stop(&state.capture);

    #[cfg(not(target_os = "linux"))]
    let _ = state;
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

    fn loot_region(x: u32, y: u32) -> NormalizedRegion {
        NormalizedRegion {
            x: x as f64 / LOOT_SOURCE_WIDTH as f64,
            y: y as f64 / LOOT_SOURCE_HEIGHT as f64,
            width: LOOT_REGION_WIDTH as f64 / LOOT_SOURCE_WIDTH as f64,
            height: LOOT_REGION_HEIGHT as f64 / LOOT_SOURCE_HEIGHT as f64,
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
        let settings = LootCaptureSettings {
            region: loot_region(100, 200),
            source_width: LOOT_SOURCE_WIDTH,
            source_height: LOOT_SOURCE_HEIGHT,
        };

        let json = serde_json::to_string(&settings).unwrap();
        let parsed = parse_loot_capture_settings(&json).unwrap();

        assert!(json.contains("\"sourceWidth\":3440"));
        assert_eq!(parsed.source_width, settings.source_width);
        assert_eq!(parsed.source_height, settings.source_height);
        assert_eq!(
            validate_loot_region(parsed.region).unwrap(),
            PixelRegion {
                x: 100,
                y: 200,
                width: LOOT_REGION_WIDTH,
                height: LOOT_REGION_HEIGHT,
            }
        );
    }

    #[test]
    fn accepts_a_loot_region_on_the_bottom_right_boundary() {
        assert_eq!(
            validate_loot_region(loot_region(
                LOOT_SOURCE_WIDTH - LOOT_REGION_WIDTH,
                LOOT_SOURCE_HEIGHT - LOOT_REGION_HEIGHT,
            ))
            .unwrap(),
            PixelRegion {
                x: LOOT_SOURCE_WIDTH - LOOT_REGION_WIDTH,
                y: LOOT_SOURCE_HEIGHT - LOOT_REGION_HEIGHT,
                width: LOOT_REGION_WIDTH,
                height: LOOT_REGION_HEIGHT,
            }
        );
    }

    #[test]
    fn rejects_oversized_loot_regions_and_non_production_sources() {
        let mut oversized = loot_region(100, 200);
        oversized.width = (LOOT_REGION_WIDTH + 1) as f64 / LOOT_SOURCE_WIDTH as f64;
        assert!(validate_loot_region(oversized)
            .unwrap_err()
            .contains("exactly 362x311"));

        let settings = LootCaptureSettings {
            region: loot_region(100, 200),
            source_width: 2560,
            source_height: LOOT_SOURCE_HEIGHT,
        };
        assert!(settings.validate().unwrap_err().contains("3440x1440"));
    }

    #[test]
    fn rejects_malformed_saved_settings() {
        assert!(parse_loot_capture_settings("not json").is_err());
        assert!(parse_loot_capture_settings(
            r#"{"region":{"x":0.9,"y":0.0,"width":0.2,"height":1.0},"sourceWidth":3440,"sourceHeight":1440}"#,
        )
        .is_err());
        assert!(parse_loot_capture_settings(
            r#"{"region":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"sourceWidth":0,"sourceHeight":1440}"#,
        )
        .is_err());
    }
}
