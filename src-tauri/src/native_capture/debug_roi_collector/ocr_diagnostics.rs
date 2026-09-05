use super::{
    unix_ms, DebugRoiSampleCollector, Run, FRAMES_PER_MINUTE, PHASE_FAILED, PHASE_FINISHED,
};
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::Ordering;
use std::time::SystemTime;

const MAX_LOG_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticFrame {
    frame: Option<u32>,
    batch_id: Option<u32>,
    readings: Vec<String>,
    center_y: Option<u32>,
    bounds: Option<Bounds>,
    quantity_bounds: Option<Bounds>,
    text_color: Option<String>,
    #[serde(default)]
    passes: Vec<OcrPass>,
    #[serde(skip_deserializing)]
    file: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bounds {
    left: u32,
    right: u32,
    top: u32,
    bottom: u32,
}

impl Bounds {
    fn valid(&self) -> bool {
        self.left < self.right
            && self.top < self.bottom
            && self.right <= 4096
            && self.bottom <= 4096
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OcrPass {
    threshold: u32,
    scale: u32,
    region: String,
    text: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcrIssue {
    capture_token: u64,
    collection_path: String,
    source: Source,
    generation: u32,
    event_id: Option<String>,
    status: Status,
    reason: Option<String>,
    item_name: Option<String>,
    quantity: Option<u64>,
    first_frame: DiagnosticFrame,
    selected_frames: Vec<DiagnosticFrame>,
    last_frame: Option<DiagnosticFrame>,
    count: u32,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    Normal,
    Rare,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Recognized,
    Withheld,
    Failed,
    Dropped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u32,
    logged_at_unix_ms: u64,
    #[serde(flatten)]
    issue: OcrIssue,
}

impl OcrIssue {
    fn validate(&self) -> Result<(), String> {
        let valid_reason = match self.status {
            Status::Recognized => {
                self.reason.is_none()
                    && self.event_id.is_some()
                    && self.count == 1
                    && self.item_name.as_ref().is_some_and(|name| !name.is_empty())
                    && self
                        .quantity
                        .is_some_and(|quantity| quantity > 0 && quantity <= 9_007_199_254_740_991)
            }
            Status::Withheld => matches!(
                self.reason.as_deref().unwrap_or(""),
                "insufficient-observations"
                    | "item-not-recognized"
                    | "quantity-not-recognized"
                    | "consensus-withheld"
            ),
            Status::Failed => matches!(
                self.reason.as_deref().unwrap_or(""),
                "ocr-failure" | "frame-analysis-failure" | "ocr-startup-failure"
            ),
            Status::Dropped => matches!(
                self.reason.as_deref().unwrap_or(""),
                "backpressure-summary" | "result-overflow-summary" | "mixed-overflow-summary"
            ),
        };
        if !valid_reason
            || (!matches!(self.status, Status::Recognized)
                && (self.item_name.is_some() || self.quantity.is_some()))
            || self
                .item_name
                .as_ref()
                .is_some_and(|name| name.len() > 2048)
            || self.count == 0
            || self.selected_frames.len() > 5
            || self.event_id.as_ref().is_some_and(|id| id.len() > 128)
            || self.error.as_ref().is_some_and(|error| error.len() > 4096)
            || self.collection_path.len() > 4096
            || std::iter::once(&self.first_frame)
                .chain(&self.selected_frames)
                .chain(&self.last_frame)
                .any(|frame| {
                    frame.readings.len() > 3
                        || frame.readings.iter().any(|text| text.len() > 2048)
                        || frame.center_y.is_some_and(|y| y > 4096)
                        || frame.bounds.as_ref().is_some_and(|bounds| !bounds.valid())
                        || frame
                            .quantity_bounds
                            .as_ref()
                            .is_some_and(|bounds| !bounds.valid())
                        || frame
                            .text_color
                            .as_ref()
                            .is_some_and(|color| !matches!(color.as_str(), "white" | "gold"))
                        || frame.passes.len() > 9
                        || frame.passes.iter().any(|pass| {
                            !matches!(pass.threshold, 130 | 150 | 170)
                                || !matches!(pass.scale, 2 | 4)
                                || !matches!(pass.region.as_str(), "line" | "quantity")
                                || pass.text.len() > 2048
                        })
                })
        {
            return Err("Invalid or oversized OCR diagnostic record".into());
        }
        Ok(())
    }
}

impl DebugRoiSampleCollector {
    pub(in crate::native_capture) fn log_ocr_issue(&self, issue: OcrIssue) -> Result<bool, String> {
        issue.validate()?;
        let Some(run) = self.current_run() else {
            return Ok(false);
        };
        if issue.capture_token != run.capture_token
            || issue.collection_path != run.path.to_string_lossy()
        {
            return Ok(false);
        }
        let crop = match issue.source {
            Source::Normal => run.normal_pixels,
            Source::Rare => run.rare_pixels,
        };
        if std::iter::once(&issue.first_frame)
            .chain(&issue.selected_frames)
            .chain(&issue.last_frame)
            .any(|frame| {
                frame.center_y.is_some_and(|y| y >= crop.height)
                    || [&frame.bounds, &frame.quantity_bounds]
                        .into_iter()
                        .flatten()
                        .any(|bounds| bounds.right > crop.width || bounds.bottom > crop.height)
            })
        {
            return Err("OCR diagnostic coordinates exceed the collected ROI".into());
        }
        write_issue(&run, issue)
    }
}

fn write_issue(run: &Run, mut issue: OcrIssue) -> Result<bool, String> {
    // Separate from capture/PNG locks; this is called on Tauri's blocking pool.
    let _guard = run
        .diagnostic_writer
        .lock()
        .map_err(|_| "OCR diagnostic writer lock poisoned")?;
    let source = match issue.source {
        Source::Normal => "normal",
        Source::Rare => "rare",
    };
    let finalized = matches!(
        run.phase.load(Ordering::Acquire),
        PHASE_FINISHED | PHASE_FAILED
    );
    let minutes = run.written.load(Ordering::Acquire) / FRAMES_PER_MINUTE + 1;
    for frame in std::iter::once(&mut issue.first_frame)
        .chain(&mut issue.selected_frames)
        .chain(&mut issue.last_frame)
    {
        if let Some(batch) = frame.batch_id {
            frame.file = (1..=minutes)
                .map(|minute| format!("{source}/minute-{minute:02}/frame-{batch:010}.png"))
                .find(|relative| run.path.join(relative).is_file());
        }
    }
    // During finalization, referenced PNGs may still be queued for writing.
    if finalized
        && std::iter::once(&issue.first_frame)
            .chain(&issue.selected_frames)
            .chain(&issue.last_frame)
            .all(|frame| frame.file.is_none())
    {
        return Ok(false);
    }
    let record = Record {
        version: 2,
        logged_at_unix_ms: unix_ms(SystemTime::now())?,
        issue,
    };
    let mut bytes = serde_json::to_vec(&record)
        .map_err(|error| format!("Could not serialize OCR diagnostic: {error}"))?;
    bytes.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(run.path.join("ocr-issues.jsonl"))
        .map_err(|error| format!("Could not open OCR diagnostic log: {error}"))?;
    if file.metadata().map_err(|error| error.to_string())?.len() + bytes.len() as u64
        > MAX_LOG_BYTES
    {
        return Err("OCR diagnostic log reached its 64 MiB limit".into());
    }
    file.write_all(&bytes)
        .map_err(|error| format!("Could not write OCR diagnostic log: {error}"))?;
    Ok(true)
}
