use ashpd::desktop::{
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType},
    Session,
};
use pipewire as pw;
use pw::{properties::properties, spa};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::{
    validate_loot_region, NormalizedRegion, PixelRegion, LOOT_REGION_HEIGHT, LOOT_REGION_WIDTH,
    LOOT_SOURCE_HEIGHT, LOOT_SOURCE_WIDTH,
};

const FRAME_HEADER_BYTES: usize = 40;
const FRAME_PROTOCOL_VERSION: u32 = 1;
const FRAME_KIND_ERROR: u32 = 0;
const FRAME_KIND_PREVIEW: u32 = 1;
const FRAME_KIND_REGION: u32 = 2;
const MAX_PREVIEW_WIDTH: u32 = 640;
const MAX_PREVIEW_HEIGHT: u32 = 360;
const SAMPLE_INTERVAL: Duration = Duration::from_millis(125);
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
struct BatchIdentity {
    capture_id: u32,
    batch_id: u32,
}

struct FrameHeader {
    kind: u32,
    batch: BatchIdentity,
    output_width: u32,
    output_height: u32,
    source_width: u32,
    source_height: u32,
    crop_x: u32,
    crop_y: u32,
}

#[derive(Default)]
pub(super) struct CaptureState(Mutex<CaptureStateInner>);

#[derive(Default)]
struct CaptureStateInner {
    capture: Option<Arc<CaptureControl>>,
    last_capture_id: u32,
}

impl CaptureStateInner {
    fn next_capture_id(&mut self) -> Result<u32, String> {
        let capture_id = self
            .last_capture_id
            .checked_add(1)
            .ok_or_else(|| "Native display capture exhausted its capture IDs.".to_string())?;
        self.last_capture_id = capture_id;
        Ok(capture_id)
    }
}

struct CaptureControl {
    capture_id: u32,
    cancelled: AtomicBool,
    batches: Mutex<BatchState>,
    pending_session: Mutex<Option<Arc<Session<Screencast>>>>,
    region: Mutex<Option<NormalizedRegion>>,
}

impl CaptureControl {
    fn new(capture_id: u32, region: Option<NormalizedRegion>) -> Self {
        Self {
            capture_id,
            cancelled: AtomicBool::new(false),
            batches: Mutex::new(BatchState::default()),
            pending_session: Mutex::new(None),
            region: Mutex::new(region),
        }
    }

    fn begin_batch(&self, has_region: bool) -> Result<Option<u32>, String> {
        let mut batches = self
            .batches
            .lock()
            .map_err(|_| "Capture batch state is unavailable.")?;
        if batches.pending.is_some() {
            return Ok(None);
        }
        let batch_id = batches
            .last_batch_id
            .checked_add(1)
            .ok_or_else(|| "Native display capture exhausted its batch IDs.".to_string())?;
        batches.last_batch_id = batch_id;
        batches.pending = Some(PendingBatch {
            batch_id,
            preview_pending: true,
            region_pending: has_region,
        });
        Ok(Some(batch_id))
    }

    fn acknowledge(&self, capture_id: u32, batch_id: u32, kind: u32) {
        if capture_id != self.capture_id {
            return;
        }
        let Ok(mut batches) = self.batches.lock() else {
            return;
        };
        let Some(pending) = batches.pending.as_mut() else {
            return;
        };
        if pending.batch_id != batch_id {
            return;
        }
        match kind {
            FRAME_KIND_PREVIEW => pending.preview_pending = false,
            FRAME_KIND_REGION => pending.region_pending = false,
            _ => return,
        }
        if !pending.preview_pending && !pending.region_pending {
            batches.pending = None;
        }
    }

    fn clear_batch(&self, batch_id: u32) {
        if let Ok(mut batches) = self.batches.lock() {
            if batches
                .pending
                .as_ref()
                .is_some_and(|pending| pending.batch_id == batch_id)
            {
                batches.pending = None;
            }
        }
    }
}

#[derive(Default)]
struct BatchState {
    last_batch_id: u32,
    pending: Option<PendingBatch>,
}

struct PendingBatch {
    batch_id: u32,
    preview_pending: bool,
    region_pending: bool,
}

struct StreamData {
    format: spa::param::video::VideoInfoRaw,
    last_sample: Option<Instant>,
}

pub(super) async fn start(
    state: &CaptureState,
    frames: Channel<InvokeResponseBody>,
    region: Option<NormalizedRegion>,
) -> Result<(), String> {
    let (control, previous) = {
        let mut state = state
            .0
            .lock()
            .map_err(|_| "Capture state is unavailable.")?;
        let capture_id = state.next_capture_id()?;
        let control = Arc::new(CaptureControl::new(capture_id, region));
        let previous = state.capture.replace(control.clone());
        (control, previous)
    };
    if let Some(previous) = previous {
        cancel(&previous);
    }

    let portal = Screencast::new().await.map_err(capture_error)?;
    let session = Arc::new(
        portal
            .create_session(Default::default())
            .await
            .map_err(capture_error)?,
    );
    *control
        .pending_session
        .lock()
        .map_err(|_| "Capture session state is unavailable.")? = Some(session.clone());
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }

    let select_request = portal
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Hidden)
                .set_sources(Some(SourceType::Monitor.into()))
                .set_multiple(false),
        )
        .await;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    select_request
        .map_err(|error| portal_error(&control, error))?
        .response()
        .map_err(|error| portal_error(&control, error))?;

    let start_request = portal.start(&session, None, Default::default()).await;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    let response = start_request
        .map_err(|error| portal_error(&control, error))?
        .response()
        .map_err(|error| portal_error(&control, error))?;
    let stream = response.streams().first().ok_or_else(|| {
        close_pending_session(&control);
        "The screen capture portal returned no monitor stream.".to_string()
    })?;
    let node_id = stream.pipe_wire_node_id();
    eprintln!(
            "Native display capture portal stream: node_id={node_id}, size={:?}, position={:?}, source_type={:?}",
            stream.size(),
            stream.position(),
            stream.source_type()
        );
    let fd = portal
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|error| portal_error(&control, error))?;
    if control.cancelled.load(Ordering::Acquire) {
        close_pending_session(&control);
        return Err("Screen sharing was cancelled.".to_string());
    }
    // This backend exposes the selected node only after the portal proxies are released.
    control
        .pending_session
        .lock()
        .map_err(|_| "Capture session state is unavailable.")?
        .take();
    drop(session);
    drop(portal);

    let errors = frames.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_pipewire(node_id, fd, frames, control.clone()) {
            eprintln!("Native display capture stopped: {error}");
            let _ = errors.send(InvokeResponseBody::Raw(error_frame(&error)));
        }
    });
    Ok(())
}

pub(super) fn stop(state: &CaptureState) {
    let control = state
        .0
        .lock()
        .ok()
        .and_then(|mut state| state.capture.take());
    if let Some(control) = control {
        cancel(&control);
    }
}

pub(super) fn acknowledge_frame(state: &CaptureState, capture_id: u32, batch_id: u32, kind: u32) {
    if let Ok(state) = state.0.lock() {
        if let Some(control) = state.capture.as_ref() {
            control.acknowledge(capture_id, batch_id, kind);
        }
    }
}

pub(super) fn set_region(
    state: &CaptureState,
    region: Option<NormalizedRegion>,
) -> Result<(), String> {
    let state = state
        .0
        .lock()
        .map_err(|_| "Capture state is unavailable.")?;
    let control = state
        .capture
        .as_ref()
        .ok_or_else(|| "Native display capture is not running.".to_string())?;
    *control
        .region
        .lock()
        .map_err(|_| "Capture region state is unavailable.")? = region;
    Ok(())
}

fn cancel(control: &Arc<CaptureControl>) {
    control.cancelled.store(true, Ordering::Release);
    close_pending_session(control);
}

fn close_pending_session(control: &Arc<CaptureControl>) {
    let session = control
        .pending_session
        .lock()
        .ok()
        .and_then(|mut session| session.take());
    if let Some(session) = session {
        tauri::async_runtime::spawn(async move {
            let _ = session.close().await;
        });
    }
}

fn portal_error(control: &Arc<CaptureControl>, error: impl std::fmt::Display) -> String {
    close_pending_session(control);
    capture_error(error)
}

fn run_pipewire(
    node_id: u32,
    fd: std::os::fd::OwnedFd,
    frames: Channel<InvokeResponseBody>,
    control: Arc<CaptureControl>,
) -> Result<(), String> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(capture_error)?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(capture_error)?;
    let core = context.connect_fd_rc(fd, None).map_err(capture_error)?;
    let stream = pw::stream::StreamBox::new(
        &core,
        "shakatu-sheets-display-capture",
        properties! {
            *pw::keys::MEDIA_TYPE => "Video",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Screen",
        },
    )
    .map_err(capture_error)?;

    let loop_for_frames = mainloop.clone();
    let control_for_frames = control.clone();
    let last_frame = Rc::new(Cell::new(None));
    let last_frame_in_process = last_frame.clone();
    let stream_error = Rc::new(RefCell::new(None));
    let stream_error_in_callback = stream_error.clone();
    let stream_error_in_process = stream_error.clone();
    let loop_for_error = mainloop.clone();
    let _listener = stream
            .add_local_listener_with_user_data(StreamData {
                format: Default::default(),
                last_sample: None,
            })
            .state_changed(move |_, _, old, state| {
                eprintln!("Native display capture PipeWire state: {old:?} -> {state:?}");
                if let pw::stream::StreamState::Error(message) = state {
                    *stream_error_in_callback.borrow_mut() =
                        Some(format!("PipeWire stream error: {message}"));
                    loop_for_error.quit();
                }
            })
            .param_changed(|_, data, id, parameter| {
                let Some(parameter) = parameter else { return };
                if id != spa::param::ParamType::Format.as_raw() {
                    return;
                }
                let Ok((media_type, media_subtype)) =
                    spa::param::format_utils::parse_format(parameter)
                else {
                    return;
                };
                if media_type == spa::param::format::MediaType::Video
                    && media_subtype == spa::param::format::MediaSubtype::Raw
                    && data.format.parse(parameter).is_ok()
                {
                    let size = data.format.size();
                    let framerate = data.format.framerate();
                    let max_framerate = data.format.max_framerate();
                    eprintln!(
                        "Native display capture negotiated format={:?}, size={}x{}, framerate={}/{}, max_framerate={}/{}, flags={:?}, modifier={}",
                        data.format.format(),
                        size.width,
                        size.height,
                        framerate.num,
                        framerate.denom,
                        max_framerate.num,
                        max_framerate.denom,
                        data.format.flags(),
                        data.format.modifier()
                    );
                }
            })
            .process(move |stream, data| {
                if control_for_frames.cancelled.load(Ordering::Acquire) {
                    loop_for_frames.quit();
                    return;
                }
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                if data
                    .last_sample
                    .is_some_and(|last| last.elapsed() < SAMPLE_INTERVAL)
                {
                    return;
                }
                let Some(plane) = buffer.datas_mut().first_mut() else {
                    return;
                };
                let size = data.format.size();
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let stride = match validated_stride(plane.chunk().stride(), size.width) {
                    Ok(stride) => stride,
                    Err(error) => {
                        *stream_error_in_process.borrow_mut() = Some(error);
                        loop_for_frames.quit();
                        return;
                    }
                };
                let offset = plane.chunk().offset() as usize;
                let available = plane.chunk().size() as usize;
                let memory_type = plane.type_();
                let Some(source) = plane.data() else { return };
                let end = match offset.checked_add(available) {
                    Some(end) => end.min(source.len()),
                    None => {
                        *stream_error_in_process.borrow_mut() =
                            Some("PipeWire frame offset and size overflowed.".to_string());
                        loop_for_frames.quit();
                        return;
                    }
                };
                let Some(pixels) = source.get(offset..end) else {
                    *stream_error_in_process.borrow_mut() =
                        Some("PipeWire frame offset is outside mapped memory.".to_string());
                    loop_for_frames.quit();
                    return;
                };
                let region = match control_for_frames.region.lock() {
                    Ok(region) => *region,
                    Err(_) => {
                        *stream_error_in_process.borrow_mut() =
                            Some("Capture region state is unavailable.".to_string());
                        loop_for_frames.quit();
                        return;
                    }
                };
                let region = match region_for_source(region, size.width, size.height) {
                    Ok(region) => region,
                    Err(error) => {
                        *stream_error_in_process.borrow_mut() = Some(error);
                        loop_for_frames.quit();
                        return;
                    }
                };
                let batch_id = match control_for_frames.begin_batch(region.is_some()) {
                    Ok(Some(batch_id)) => batch_id,
                    Ok(None) => return,
                    Err(error) => {
                        *stream_error_in_process.borrow_mut() = Some(error);
                        loop_for_frames.quit();
                        return;
                    }
                };
                let preview = match preview_frame(
                    pixels,
                    size.width,
                    size.height,
                    stride,
                    data.format.format(),
                    control_for_frames.capture_id,
                    batch_id,
                ) {
                    Ok(frame) => frame,
                    Err(error) => {
                        control_for_frames.clear_batch(batch_id);
                        *stream_error_in_process.borrow_mut() = Some(error);
                        loop_for_frames.quit();
                        return;
                    }
                };
                let region_frame = match region {
                    Some(region) => match crop_region_frame(
                        pixels,
                        size.width,
                        size.height,
                        stride,
                        data.format.format(),
                        region,
                        BatchIdentity {
                            capture_id: control_for_frames.capture_id,
                            batch_id,
                        },
                    ) {
                        Ok(frame) => Some(frame),
                        Err(error) => {
                            control_for_frames.clear_batch(batch_id);
                            *stream_error_in_process.borrow_mut() = Some(error);
                            loop_for_frames.quit();
                            return;
                        }
                    },
                    None => None,
                };
                if frames.send(InvokeResponseBody::Raw(preview)).is_err() {
                    control_for_frames.clear_batch(batch_id);
                    loop_for_frames.quit();
                    return;
                }
                if let Some(frame) = region_frame {
                    if frames.send(InvokeResponseBody::Raw(frame)).is_err() {
                        control_for_frames.clear_batch(batch_id);
                        loop_for_frames.quit();
                        return;
                    }
                }
                if last_frame_in_process.get().is_none() {
                    eprintln!(
                        "Native display capture received first frame: memory={memory_type:?}, bytes={}, stride={stride}",
                        pixels.len()
                    );
                }
                let now = Instant::now();
                last_frame_in_process.set(Some(now));
                data.last_sample = Some(now);
            })
            .register()
            .map_err(capture_error)?;

    let loop_for_timer = mainloop.clone();
    let stream_error_in_timer = stream_error.clone();
    let connection_started = Instant::now();
    let _stop_timer = mainloop.loop_().add_timer(move |_| {
        if control.cancelled.load(Ordering::Acquire) {
            loop_for_timer.quit();
        } else if let Some(last_frame) = last_frame.get() {
            if last_frame.elapsed() >= FIRST_FRAME_TIMEOUT {
                *stream_error_in_timer.borrow_mut() =
                    Some("The selected monitor stopped producing PipeWire frames.".to_string());
                loop_for_timer.quit();
            }
        } else if connection_started.elapsed() >= FIRST_FRAME_TIMEOUT {
            *stream_error_in_timer.borrow_mut() = Some(
                "The selected monitor did not produce a PipeWire frame within 10 seconds."
                    .to_string(),
            );
            loop_for_timer.quit();
        }
    });
    _stop_timer.update_timer(
        Some(Duration::from_millis(100)),
        Some(Duration::from_millis(100)),
    );

    let format = video_format_parameter();
    let mut parameters = [spa::pod::Pod::from_bytes(&format)
        .ok_or_else(|| "Native display capture produced an invalid format request.".to_string())?];
    stream
        .connect(
            spa::utils::Direction::Input,
            Some(node_id),
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut parameters,
        )
        .map_err(capture_error)?;
    mainloop.run();
    if let Some(error) = stream_error.borrow_mut().take() {
        return Err(error);
    }
    Ok(())
}

fn video_format_parameter() -> Vec<u8> {
    let format = pw::spa::pod::object!(
        pw::spa::utils::SpaTypes::ObjectParamFormat,
        pw::spa::param::ParamType::EnumFormat,
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaType,
            Id,
            pw::spa::param::format::MediaType::Video
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::MediaSubtype,
            Id,
            pw::spa::param::format::MediaSubtype::Raw
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFormat,
            Choice,
            Enum,
            Id,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::BGRx,
            pw::spa::param::video::VideoFormat::BGRA,
            pw::spa::param::video::VideoFormat::RGBx,
            pw::spa::param::video::VideoFormat::RGBA
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoSize,
            Choice,
            Range,
            Rectangle,
            pw::spa::utils::Rectangle {
                width: 1920,
                height: 1080
            },
            pw::spa::utils::Rectangle {
                width: 1,
                height: 1
            },
            pw::spa::utils::Rectangle {
                width: 16384,
                height: 16384
            }
        ),
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            pw::spa::utils::Fraction { num: 8, denom: 1 },
            pw::spa::utils::Fraction { num: 0, denom: 1 },
            pw::spa::utils::Fraction {
                num: 1000,
                denom: 1
            }
        ),
    );
    pw::spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &pw::spa::pod::Value::Object(format),
    )
    .expect("static PipeWire format must serialize")
    .0
    .into_inner()
}

fn preview_frame(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    source_stride: u32,
    format: spa::param::video::VideoFormat,
    capture_id: u32,
    batch_id: u32,
) -> Result<Vec<u8>, String> {
    if source_width == 0 || source_height == 0 {
        return Err("PipeWire provided empty source dimensions.".into());
    }
    let mut output_width = source_width.min(MAX_PREVIEW_WIDTH);
    let mut output_height =
        ((source_height as u64 * output_width as u64) / source_width as u64).max(1) as u32;
    if output_height > MAX_PREVIEW_HEIGHT {
        output_height = MAX_PREVIEW_HEIGHT;
        output_width =
            ((source_width as u64 * output_height as u64) / source_height as u64).max(1) as u32;
    }
    let mut frame = allocate_frame(FrameHeader {
        kind: FRAME_KIND_PREVIEW,
        batch: BatchIdentity {
            capture_id,
            batch_id,
        },
        output_width,
        output_height,
        source_width,
        source_height,
        crop_x: 0,
        crop_y: 0,
    })?;
    let output_stride = output_width
        .checked_mul(4)
        .ok_or_else(|| "preview output stride overflowed".to_string())?;
    for y in 0..output_height {
        let source_y = y as u64 * source_height as u64 / output_height as u64;
        for x in 0..output_width {
            let source_x = x as u64 * source_width as u64 / output_width as u64;
            let input = pixel_offset(source_y as u32, source_x as u32, source_stride)?;
            let output = FRAME_HEADER_BYTES
                .checked_add(pixel_offset(y, x, output_stride)?)
                .ok_or_else(|| "preview output offset overflowed".to_string())?;
            let pixel = converted_pixel(source, input, format)?;
            frame[output..output + 4].copy_from_slice(&pixel);
        }
    }
    Ok(frame)
}

fn crop_region_frame(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    source_stride: u32,
    format: spa::param::video::VideoFormat,
    region: PixelRegion,
    batch: BatchIdentity,
) -> Result<Vec<u8>, String> {
    if source_width != LOOT_SOURCE_WIDTH || source_height != LOOT_SOURCE_HEIGHT {
        return Err(format!(
            "loot region frames require a {LOOT_SOURCE_WIDTH}x{LOOT_SOURCE_HEIGHT} source"
        ));
    }
    if region.width != LOOT_REGION_WIDTH || region.height != LOOT_REGION_HEIGHT {
        return Err(format!(
            "loot capture region must be exactly {LOOT_REGION_WIDTH}x{LOOT_REGION_HEIGHT} pixels"
        ));
    }
    let end_x = region
        .x
        .checked_add(region.width)
        .ok_or_else(|| "loot capture region horizontal bounds overflowed".to_string())?;
    let end_y = region
        .y
        .checked_add(region.height)
        .ok_or_else(|| "loot capture region vertical bounds overflowed".to_string())?;
    if end_x > source_width || end_y > source_height {
        return Err("loot capture region is outside the source bounds".into());
    }
    let mut frame = allocate_frame(FrameHeader {
        kind: FRAME_KIND_REGION,
        batch,
        output_width: region.width,
        output_height: region.height,
        source_width,
        source_height,
        crop_x: region.x,
        crop_y: region.y,
    })?;
    let output_stride = region
        .width
        .checked_mul(4)
        .ok_or_else(|| "region output stride overflowed".to_string())?;

    for y in 0..region.height {
        for x in 0..region.width {
            let source_y = region
                .y
                .checked_add(y)
                .ok_or_else(|| "region source row overflowed".to_string())?;
            let source_x = region
                .x
                .checked_add(x)
                .ok_or_else(|| "region source column overflowed".to_string())?;
            let input = pixel_offset(source_y, source_x, source_stride)?;
            let output = FRAME_HEADER_BYTES
                .checked_add(pixel_offset(y, x, output_stride)?)
                .ok_or_else(|| "region output offset overflowed".to_string())?;
            let pixel = converted_pixel(source, input, format)?;
            frame[output..output + 4].copy_from_slice(&pixel);
        }
    }
    Ok(frame)
}

fn region_for_source(
    region: Option<NormalizedRegion>,
    source_width: u32,
    source_height: u32,
) -> Result<Option<PixelRegion>, String> {
    if source_width != LOOT_SOURCE_WIDTH || source_height != LOOT_SOURCE_HEIGHT {
        return Ok(None);
    }
    region.map(validate_loot_region).transpose()
}

fn allocate_frame(header: FrameHeader) -> Result<Vec<u8>, String> {
    let payload_len = (header.output_width as usize)
        .checked_mul(header.output_height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "capture frame dimensions are too large".to_string())?;
    let frame_len = FRAME_HEADER_BYTES
        .checked_add(payload_len)
        .ok_or_else(|| "capture frame size overflowed".to_string())?;
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(frame_len)
        .map_err(|_| "capture frame allocation failed".to_string())?;
    for value in [
        FRAME_PROTOCOL_VERSION,
        header.kind,
        header.batch.capture_id,
        header.batch.batch_id,
        header.output_width,
        header.output_height,
        header.source_width,
        header.source_height,
        header.crop_x,
        header.crop_y,
    ] {
        frame.extend_from_slice(&value.to_le_bytes());
    }
    frame.resize(frame_len, 0);
    Ok(frame)
}

fn validated_stride(stride: i32, source_width: u32) -> Result<u32, String> {
    let minimum = source_width
        .checked_mul(4)
        .ok_or_else(|| "PipeWire source row size overflowed.".to_string())?;
    if stride < 0 {
        return Err(
            "PipeWire provided a negative source stride; bottom-up frames are unsupported."
                .to_string(),
        );
    }
    let stride = if stride == 0 { minimum } else { stride as u32 };
    if stride < minimum {
        return Err(format!(
            "PipeWire source stride {stride} is smaller than the required {minimum} bytes."
        ));
    }
    Ok(stride)
}

fn pixel_offset(y: u32, x: u32, stride: u32) -> Result<usize, String> {
    let offset = (y as u64)
        .checked_mul(stride as u64)
        .and_then(|row| {
            (x as u64)
                .checked_mul(4)
                .and_then(|column| row.checked_add(column))
        })
        .ok_or_else(|| "capture pixel offset overflowed".to_string())?;
    usize::try_from(offset).map_err(|_| "capture pixel offset exceeds platform limits".to_string())
}

fn converted_pixel(
    source: &[u8],
    offset: usize,
    format: spa::param::video::VideoFormat,
) -> Result<[u8; 4], String> {
    let end = offset
        .checked_add(4)
        .ok_or_else(|| "PipeWire pixel offset overflowed.".to_string())?;
    let pixel = source
        .get(offset..end)
        .ok_or_else(|| "PipeWire frame data is shorter than its negotiated size.".to_string())?;
    match format {
        spa::param::video::VideoFormat::BGRA => Ok([pixel[2], pixel[1], pixel[0], pixel[3]]),
        spa::param::video::VideoFormat::BGRx => Ok([pixel[2], pixel[1], pixel[0], 255]),
        spa::param::video::VideoFormat::RGBA => Ok([pixel[0], pixel[1], pixel[2], pixel[3]]),
        spa::param::video::VideoFormat::RGBx => Ok([pixel[0], pixel[1], pixel[2], 255]),
        _ => Err(format!("Unsupported PipeWire video format: {format:?}")),
    }
}

fn error_frame(error: &str) -> Vec<u8> {
    let mut frame = allocate_frame(FrameHeader {
        kind: FRAME_KIND_ERROR,
        batch: BatchIdentity {
            capture_id: 0,
            batch_id: 0,
        },
        output_width: 0,
        output_height: 0,
        source_width: 0,
        source_height: 0,
        crop_x: 0,
        crop_y: 0,
    })
    .expect("an empty protocol frame must fit in memory");
    frame.extend_from_slice(error.as_bytes());
    frame
}

fn capture_error(error: impl std::fmt::Display) -> String {
    format!("Native display capture failed: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(frame: &[u8]) -> Vec<u32> {
        frame[..FRAME_HEADER_BYTES]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|bytes| u32::from_le_bytes(*bytes))
            .collect()
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
    fn converts_bgra_and_encodes_the_preview_header() {
        let frame = preview_frame(
            &[3, 2, 1, 7, 6, 5, 4, 8],
            2,
            1,
            8,
            spa::param::video::VideoFormat::BGRA,
            17,
            23,
        )
        .unwrap();

        assert_eq!(
            header(&frame),
            [1, FRAME_KIND_PREVIEW, 17, 23, 2, 1, 2, 1, 0, 0]
        );
        assert_eq!(&frame[FRAME_HEADER_BYTES..], &[1, 2, 3, 7, 4, 5, 6, 8]);
    }

    #[test]
    fn bounds_portrait_previews() {
        let source = vec![0; 1080 * 1920 * 4];
        let frame = preview_frame(
            &source,
            1080,
            1920,
            1080 * 4,
            spa::param::video::VideoFormat::BGRx,
            1,
            1,
        )
        .unwrap();

        assert_eq!(&header(&frame)[4..6], &[202, 360]);
        assert_eq!(frame.len(), FRAME_HEADER_BYTES + 202 * 360 * 4);
    }

    #[test]
    fn converts_normalized_bounds_to_deterministic_pixels() {
        assert_eq!(
            super::super::normalized_to_pixel_region(
                NormalizedRegion {
                    x: 0.25,
                    y: 0.2,
                    width: 0.5,
                    height: 0.4,
                },
                8,
                5,
            )
            .unwrap(),
            PixelRegion {
                x: 2,
                y: 1,
                width: 4,
                height: 2,
            }
        );
        assert_eq!(
            super::super::normalized_to_pixel_region(
                NormalizedRegion {
                    x: 0.1,
                    y: 0.1,
                    width: 0.01,
                    height: 0.01,
                },
                2,
                2,
            )
            .unwrap(),
            PixelRegion {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            }
        );
    }

    #[test]
    fn crops_exact_bgra_pixels_and_encodes_the_native_origin() {
        let stride = LOOT_SOURCE_WIDTH * 4;
        let mut source = vec![0; stride as usize * LOOT_REGION_HEIGHT as usize];
        let first = pixel_offset(0, 10, stride).unwrap();
        source[first..first + 8].copy_from_slice(&[30, 20, 10, 40, 60, 50, 40, 70]);
        let last =
            pixel_offset(LOOT_REGION_HEIGHT - 1, 10 + LOOT_REGION_WIDTH - 1, stride).unwrap();
        source[last..last + 4].copy_from_slice(&[99, 88, 77, 110]);

        let frame = crop_region_frame(
            &source,
            LOOT_SOURCE_WIDTH,
            LOOT_SOURCE_HEIGHT,
            stride,
            spa::param::video::VideoFormat::BGRA,
            PixelRegion {
                x: 10,
                y: 0,
                width: LOOT_REGION_WIDTH,
                height: LOOT_REGION_HEIGHT,
            },
            BatchIdentity {
                capture_id: 31,
                batch_id: 47,
            },
        )
        .unwrap();

        assert_eq!(
            header(&frame),
            [
                1,
                FRAME_KIND_REGION,
                31,
                47,
                LOOT_REGION_WIDTH,
                LOOT_REGION_HEIGHT,
                LOOT_SOURCE_WIDTH,
                LOOT_SOURCE_HEIGHT,
                10,
                0,
            ]
        );
        assert_eq!(
            &frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 8],
            &[10, 20, 30, 40, 40, 50, 60, 70]
        );
        assert_eq!(&frame[frame.len() - 4..], &[77, 88, 99, 110]);
    }

    #[test]
    fn rejects_roi_allocation_for_invalid_dimensions() {
        let error = crop_region_frame(
            &[],
            LOOT_SOURCE_WIDTH,
            LOOT_SOURCE_HEIGHT,
            LOOT_SOURCE_WIDTH * 4,
            spa::param::video::VideoFormat::BGRA,
            PixelRegion {
                x: 0,
                y: 0,
                width: LOOT_REGION_WIDTH + 1,
                height: LOOT_REGION_HEIGHT,
            },
            BatchIdentity {
                capture_id: 1,
                batch_id: 1,
            },
        )
        .unwrap_err();

        assert!(error.contains("exactly 362x311"));
    }

    #[test]
    fn source_mismatch_skips_a_configured_region() {
        assert_eq!(
            region_for_source(Some(loot_region(10, 20)), 2560, 1440).unwrap(),
            None
        );
        assert_eq!(
            region_for_source(
                Some(loot_region(10, 20)),
                LOOT_SOURCE_WIDTH,
                LOOT_SOURCE_HEIGHT,
            )
            .unwrap(),
            Some(PixelRegion {
                x: 10,
                y: 20,
                width: LOOT_REGION_WIDTH,
                height: LOOT_REGION_HEIGHT,
            })
        );
    }

    #[test]
    fn validates_signed_and_padded_strides() {
        assert!(validated_stride(-16, 4)
            .unwrap_err()
            .contains("negative source stride"));
        assert!(validated_stride(15, 4)
            .unwrap_err()
            .contains("smaller than the required 16"));
        assert_eq!(validated_stride(20, 4).unwrap(), 20);
        assert_eq!(validated_stride(0, 4).unwrap(), 16);
        assert!(validated_stride(i32::MAX, u32::MAX).is_err());
    }

    #[test]
    fn acknowledgements_are_capture_and_batch_specific_and_idempotent() {
        let mut state = CaptureStateInner::default();
        assert_eq!(state.next_capture_id().unwrap(), 1);
        assert_eq!(state.next_capture_id().unwrap(), 2);

        let control = CaptureControl::new(7, None);
        let batch_id = control.begin_batch(true).unwrap().unwrap();

        control.acknowledge(8, batch_id, FRAME_KIND_PREVIEW);
        control.acknowledge(7, batch_id + 1, FRAME_KIND_PREVIEW);
        control.acknowledge(7, batch_id, FRAME_KIND_ERROR);
        {
            let batches = control.batches.lock().unwrap();
            let pending = batches.pending.as_ref().unwrap();
            assert!(pending.preview_pending);
            assert!(pending.region_pending);
        }

        control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
        control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
        {
            let batches = control.batches.lock().unwrap();
            let pending = batches.pending.as_ref().unwrap();
            assert!(!pending.preview_pending);
            assert!(pending.region_pending);
        }

        control.acknowledge(7, batch_id, FRAME_KIND_REGION);
        assert!(control.batches.lock().unwrap().pending.is_none());

        let next_batch_id = control.begin_batch(false).unwrap().unwrap();
        assert_eq!(next_batch_id, batch_id + 1);
        control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
        assert!(control.batches.lock().unwrap().pending.is_some());
        control.acknowledge(7, next_batch_id, FRAME_KIND_PREVIEW);
        assert!(control.batches.lock().unwrap().pending.is_none());

        let failed_batch_id = control.begin_batch(false).unwrap().unwrap();
        control.clear_batch(failed_batch_id - 1);
        assert!(control.batches.lock().unwrap().pending.is_some());
        control.clear_batch(failed_batch_id);
        assert!(control.batches.lock().unwrap().pending.is_none());
    }

    #[test]
    fn converts_all_negotiated_channel_layouts() {
        assert_eq!(
            converted_pixel(&[3, 2, 1, 4], 0, spa::param::video::VideoFormat::BGRA).unwrap(),
            [1, 2, 3, 4]
        );
        assert_eq!(
            converted_pixel(&[3, 2, 1, 4], 0, spa::param::video::VideoFormat::BGRx).unwrap(),
            [1, 2, 3, 255]
        );
        assert_eq!(
            converted_pixel(&[1, 2, 3, 4], 0, spa::param::video::VideoFormat::RGBA).unwrap(),
            [1, 2, 3, 4]
        );
        assert_eq!(
            converted_pixel(&[1, 2, 3, 4], 0, spa::param::video::VideoFormat::RGBx).unwrap(),
            [1, 2, 3, 255]
        );
    }

    #[test]
    fn encodes_error_protocol_header_and_text() {
        let frame = error_frame("failed");

        assert_eq!(
            header(&frame),
            [1, FRAME_KIND_ERROR, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(&frame[FRAME_HEADER_BYTES..], b"failed");
    }
}
