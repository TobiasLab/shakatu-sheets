#[cfg(target_os = "linux")]
mod linux {
    use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
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

    const FRAME_HEADER_BYTES: usize = 16;
    const MAX_PREVIEW_WIDTH: u32 = 640;
    const SAMPLE_INTERVAL: Duration = Duration::from_millis(125);
    const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);

    #[derive(Default)]
    pub struct NativeCaptureState(Mutex<Option<Arc<AtomicBool>>>);

    struct StreamData {
        format: spa::param::video::VideoInfoRaw,
        last_sample: Option<Instant>,
    }

    pub async fn start(
        state: tauri::State<'_, NativeCaptureState>,
        frames: Channel<InvokeResponseBody>,
    ) -> Result<(), String> {
        stop(&state);
        let cancelled = Arc::new(AtomicBool::new(false));
        *state
            .0
            .lock()
            .map_err(|_| "Capture state is unavailable.")? = Some(cancelled.clone());

        let portal = Screencast::new().await.map_err(capture_error)?;
        let session = portal
            .create_session(Default::default())
            .await
            .map_err(capture_error)?;
        portal
            .select_sources(
                &session,
                SelectSourcesOptions::default()
                    .set_cursor_mode(CursorMode::Hidden)
                    .set_sources(Some(SourceType::Monitor.into()))
                    .set_multiple(false),
            )
            .await
            .map_err(capture_error)?
            .response()
            .map_err(capture_error)?;
        if cancelled.load(Ordering::Acquire) {
            return Err("Screen sharing was cancelled.".to_string());
        }

        let response = portal
            .start(&session, None, Default::default())
            .await
            .map_err(capture_error)?
            .response()
            .map_err(capture_error)?;
        if cancelled.load(Ordering::Acquire) {
            return Err("Screen sharing was cancelled.".to_string());
        }
        let stream = response
            .streams()
            .first()
            .ok_or_else(|| "The screen capture portal returned no monitor stream.".to_string())?;
        let node_id = stream.pipe_wire_node_id();
        let fd = portal
            .open_pipe_wire_remote(&session, Default::default())
            .await
            .map_err(capture_error)?;

        let errors = frames.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) = run_pipewire(node_id, fd, frames, cancelled) {
                eprintln!("Native display capture stopped: {error}");
                let mut message = vec![0; FRAME_HEADER_BYTES];
                message.extend_from_slice(error.as_bytes());
                let _ = errors.send(InvokeResponseBody::Raw(message));
            }
            drop(session);
        });
        Ok(())
    }

    pub fn stop(state: &tauri::State<'_, NativeCaptureState>) {
        if let Ok(mut capture) = state.0.lock() {
            if let Some(cancelled) = capture.take() {
                cancelled.store(true, Ordering::Release);
            }
        }
    }

    fn run_pipewire(
        node_id: u32,
        fd: std::os::fd::OwnedFd,
        frames: Channel<InvokeResponseBody>,
        cancelled: Arc<AtomicBool>,
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
        let cancelled_for_frames = cancelled.clone();
        let received_frame = Rc::new(Cell::new(false));
        let received_frame_in_process = received_frame.clone();
        let stream_error = Rc::new(RefCell::new(None));
        let stream_error_in_callback = stream_error.clone();
        let loop_for_error = mainloop.clone();
        let _listener = stream
            .add_local_listener_with_user_data(StreamData {
                format: Default::default(),
                last_sample: None,
            })
            .state_changed(move |_, _, _, state| {
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
                {
                    let _ = data.format.parse(parameter);
                }
            })
            .process(move |stream, data| {
                if cancelled_for_frames.load(Ordering::Acquire) {
                    loop_for_frames.quit();
                    return;
                }
                if data
                    .last_sample
                    .is_some_and(|last| last.elapsed() < SAMPLE_INTERVAL)
                {
                    return;
                }
                let Some(mut buffer) = stream.dequeue_buffer() else {
                    return;
                };
                let Some(plane) = buffer.datas_mut().first_mut() else {
                    return;
                };
                let size = data.format.size();
                if size.width == 0 || size.height == 0 {
                    return;
                }
                let stride = match plane.chunk().stride().unsigned_abs() {
                    0 => size.width * 4,
                    stride => stride,
                };
                let offset = plane.chunk().offset() as usize;
                let available = plane.chunk().size() as usize;
                let Some(source) = plane.data() else { return };
                let end = offset.saturating_add(available).min(source.len());
                let Some(pixels) = source.get(offset..end) else {
                    return;
                };
                let Some(frame) = preview_frame(
                    pixels,
                    size.width,
                    size.height,
                    stride,
                    data.format.format(),
                ) else {
                    return;
                };
                if frames.send(InvokeResponseBody::Raw(frame)).is_err() {
                    loop_for_frames.quit();
                    return;
                }
                received_frame_in_process.set(true);
                data.last_sample = Some(Instant::now());
            })
            .register()
            .map_err(capture_error)?;

        let loop_for_timer = mainloop.clone();
        let stream_error_in_timer = stream_error.clone();
        let connection_started = Instant::now();
        let _stop_timer = mainloop.loop_().add_timer(move |_| {
            if cancelled.load(Ordering::Acquire) {
                loop_for_timer.quit();
            } else if !received_frame.get() && connection_started.elapsed() >= FIRST_FRAME_TIMEOUT {
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
        let mut parameters = [spa::pod::Pod::from_bytes(&format).ok_or_else(|| {
            "Native display capture produced an invalid format request.".to_string()
        })?];
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
                pw::spa::param::video::VideoFormat::BGRA,
                pw::spa::param::video::VideoFormat::BGRA,
                pw::spa::param::video::VideoFormat::BGRx,
                pw::spa::param::video::VideoFormat::RGBA,
                pw::spa::param::video::VideoFormat::RGBx
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
    ) -> Option<Vec<u8>> {
        let output_width = source_width.min(MAX_PREVIEW_WIDTH);
        let output_height =
            ((source_height as u64 * output_width as u64) / source_width as u64).max(1) as u32;
        let mut frame = vec![0; FRAME_HEADER_BYTES + (output_width * output_height * 4) as usize];
        for (index, value) in [output_width, output_height, source_width, source_height]
            .into_iter()
            .enumerate()
        {
            frame[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
        }

        let swap_red_blue = matches!(
            format,
            spa::param::video::VideoFormat::BGRA | spa::param::video::VideoFormat::BGRx
        );
        if !swap_red_blue
            && !matches!(
                format,
                spa::param::video::VideoFormat::RGBA | spa::param::video::VideoFormat::RGBx
            )
        {
            return None;
        }
        for y in 0..output_height {
            let source_y = y as u64 * source_height as u64 / output_height as u64;
            for x in 0..output_width {
                let source_x = x as u64 * source_width as u64 / output_width as u64;
                let input = (source_y * source_stride as u64 + source_x * 4) as usize;
                let output = FRAME_HEADER_BYTES + ((y * output_width + x) * 4) as usize;
                let pixel = source.get(input..input + 4)?;
                if swap_red_blue {
                    frame[output..output + 4].copy_from_slice(&[pixel[2], pixel[1], pixel[0], 255]);
                } else {
                    frame[output..output + 4].copy_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
                }
            }
        }
        Some(frame)
    }

    fn capture_error(error: impl std::fmt::Display) -> String {
        format!("Native display capture failed: {error}")
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn converts_bgra_and_preserves_source_dimensions() {
            let frame = preview_frame(
                &[3, 2, 1, 0, 6, 5, 4, 0],
                2,
                1,
                8,
                spa::param::video::VideoFormat::BGRA,
            )
            .unwrap();

            assert_eq!(
                &frame[0..16],
                &[2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0]
            );
            assert_eq!(&frame[16..], &[1, 2, 3, 255, 4, 5, 6, 255]);
        }
    }
}

#[cfg(target_os = "linux")]
pub use linux::NativeCaptureState;

#[cfg(not(target_os = "linux"))]
#[derive(Default)]
pub struct NativeCaptureState;

#[tauri::command]
pub async fn start_native_display_capture(
    state: tauri::State<'_, NativeCaptureState>,
    frames: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return linux::start(state, frames).await;

    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, frames);
        Err("Native display capture is only available on Linux.".to_string())
    }
}

#[tauri::command]
pub fn stop_native_display_capture(state: tauri::State<'_, NativeCaptureState>) {
    #[cfg(target_os = "linux")]
    linux::stop(&state);

    #[cfg(not(target_os = "linux"))]
    let _ = state;
}
