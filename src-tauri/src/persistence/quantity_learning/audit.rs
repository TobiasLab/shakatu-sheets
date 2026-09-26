use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Bounds {
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Pass {
    threshold: u16,
    scale: u8,
    region: String,
    text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Frame {
    frame: u32,
    capture_token: Option<u64>,
    batch_id: Option<u64>,
    roi_width: u32,
    roi_height: u32,
    quantity_bounds: Option<Bounds>,
    readings: Vec<String>,
    passes: Vec<Pass>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Audit {
    version: u8,
    session_id: Option<String>,
    generation: Option<u32>,
    event_id: String,
    status: String,
    reason: String,
    crop_frame: Frame,
    frames: Vec<Frame>,
}

impl Frame {
    fn valid(&self) -> bool {
        (1..=4096).contains(&self.roi_width)
            && (1..=4096).contains(&self.roi_height)
            && self.capture_token.is_some() == self.batch_id.is_some()
            && self
                .capture_token
                .is_none_or(|value| value <= 9_007_199_254_740_991)
            && self
                .batch_id
                .is_none_or(|value| value <= 9_007_199_254_740_991)
            && self.quantity_bounds.as_ref().is_none_or(|b| {
                b.left < b.right
                    && b.top < b.bottom
                    && b.right <= self.roi_width
                    && b.bottom <= self.roi_height
            })
            && self.readings.len() <= 3
            && self.readings.iter().all(|text| text.chars().count() <= 512)
            && self.passes.len() <= 9
            && self.passes.iter().all(|pass| {
                matches!(pass.threshold, 130 | 150 | 170)
                    && matches!(pass.scale, 2 | 4)
                    && matches!(pass.region.as_str(), "line" | "quantity")
                    && pass.text.chars().count() <= 512
            })
    }
}

impl Audit {
    pub(super) fn validate(&self, width: u32, height: u32) -> Result<(), String> {
        let reason_valid = match self.status.as_str() {
            "withheld" => matches!(
                self.reason.as_str(),
                "insufficient-observations"
                    | "item-not-recognized"
                    | "quantity-not-recognized"
                    | "consensus-withheld"
            ),
            "failed" => self.reason == "ocr-failure",
            _ => false,
        };
        if self.version != 1
            || self.event_id.is_empty()
            || self.event_id.len() > 160
            || self
                .session_id
                .as_ref()
                .is_some_and(|id| id.is_empty() || id.len() > 160)
            || !reason_valid
            || !self.crop_frame.valid()
            || self.frames.len() > 5
            || !self
                .crop_frame
                .quantity_bounds
                .as_ref()
                .is_some_and(|b| b.right - b.left == width && b.bottom - b.top == height)
            || self.frames.iter().any(|frame| !frame.valid())
            || self.frames.iter().enumerate().any(|(index, frame)| {
                self.frames[..index]
                    .iter()
                    .any(|previous| previous.frame == frame.frame)
            })
            || (!self.frames.is_empty() && !self.frames.contains(&self.crop_frame))
        {
            return Err("Invalid self-improvement audit trail.".into());
        }
        Ok(())
    }
}
