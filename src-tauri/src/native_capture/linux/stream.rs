use super::*;
use std::ops::ControlFlow;

pub(super) fn run_pipewire(
    node_id: u32,
    fd: std::os::fd::OwnedFd,
    frames: Channel<InvokeResponseBody>,
    control: Arc<CaptureControl>,
    #[cfg(debug_assertions)] debug_collector: Arc<DebugRoiSampleCollector>,
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
    let last_source_frame = Rc::new(Cell::new(None));
    let last_source_frame_in_process = last_source_frame.clone();
    let stream_error = Rc::new(RefCell::new(None));
    let stream_error_in_callback = stream_error.clone();
    let stream_error_in_process = stream_error.clone();
    let loop_for_error = mainloop.clone();
    let _listener = stream
        .add_local_listener_with_user_data(StreamData {
            format: Default::default(),
            next_sample: None,
            published_source_dimensions: None,
            diagnostics: CaptureDiagnostics::from_env(),
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
            let Ok((media_type, media_subtype)) = spa::param::format_utils::parse_format(parameter)
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
            match process_frame(
                stream,
                data,
                &control_for_frames,
                &frames,
                &last_source_frame_in_process,
                #[cfg(debug_assertions)]
                &debug_collector,
            ) {
                Ok(ControlFlow::Continue(())) => {}
                Ok(ControlFlow::Break(())) => loop_for_frames.quit(),
                Err(error) => {
                    *stream_error_in_process.borrow_mut() = Some(error);
                    loop_for_frames.quit();
                }
            }
        })
        .register()
        .map_err(capture_error)?;

    let loop_for_timer = mainloop.clone();
    let stream_error_in_timer = stream_error.clone();
    let connection_started = Instant::now();
    let _stop_timer = mainloop.loop_().add_timer(move |_| {
        if control.cancelled.load(Ordering::Acquire) {
            loop_for_timer.quit();
        } else if last_source_frame.get().is_some() {
            // After the first frame a pause is not an error: compositors only send frames when the screen changes, and
            // the frontend shows the source as waiting.
            match control.pending_batch_age() {
                Ok(Some(age)) if age >= FRAME_ACK_TIMEOUT => {
                    *stream_error_in_timer.borrow_mut() = Some(
                        "The frontend did not acknowledge a native display frame batch within 10 seconds."
                            .to_string(),
                    );
                    loop_for_timer.quit();
                }
                Ok(_) => {}
                Err(error) => {
                    *stream_error_in_timer.borrow_mut() = Some(error);
                    loop_for_timer.quit();
                }
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

/// Samples one PipeWire buffer. `Break` stops capture without an error; `Err` stops it with one.
fn process_frame(
    stream: &pw::stream::Stream,
    data: &mut StreamData,
    control: &CaptureControl,
    frames: &Channel<InvokeResponseBody>,
    last_source_frame: &Cell<Option<Instant>>,
    #[cfg(debug_assertions)] debug_collector: &DebugRoiSampleCollector,
) -> Result<ControlFlow<()>, String> {
    if control.cancelled.load(Ordering::Acquire) {
        return Ok(ControlFlow::Break(()));
    }
    let Some(mut buffer) = stream.dequeue_buffer() else {
        return Ok(ControlFlow::Continue(()));
    };
    if let Some(metrics) = data.diagnostics.as_mut() {
        metrics.source_frame();
    }
    let now = Instant::now();
    if !sample_due(data.next_sample, now) {
        return Ok(ControlFlow::Continue(()));
    }
    let Some(plane) = buffer.datas_mut().first_mut() else {
        return Ok(ControlFlow::Continue(()));
    };
    let size = data.format.size();
    if size.width == 0 || size.height == 0 {
        return Ok(ControlFlow::Continue(()));
    }
    let stride = validated_stride(plane.chunk().stride(), size.width)?;
    let offset = plane.chunk().offset() as usize;
    let available = plane.chunk().size() as usize;
    // Compositors send an empty or corrupted buffer when they could not record a frame, for example during a display
    // mode change. Skipping it keeps capture running; it does not count as a source frame.
    if available == 0
        || plane
            .chunk()
            .flags()
            .contains(spa::buffer::ChunkFlags::CORRUPTED)
    {
        return Ok(ControlFlow::Continue(()));
    }
    let memory_type = plane.type_();
    let Some(source) = plane.data() else {
        return Ok(ControlFlow::Continue(()));
    };
    let end = offset
        .checked_add(available)
        .ok_or("PipeWire frame offset and size overflowed.")?
        .min(source.len());
    let pixels = source
        .get(offset..end)
        .ok_or("PipeWire frame offset is outside mapped memory.")?;
    if !frame_is_complete(pixels.len(), size.width, size.height, stride) {
        return Ok(ControlFlow::Continue(()));
    }
    let configured_selection = *control
        .selection
        .lock()
        .map_err(|_| "Capture selection state is unavailable.")?;
    // A single metadata preview bootstraps selection and reports source changes even while hidden.
    let preview_enabled = control.preview_enabled.load(Ordering::Acquire)
        || data.published_source_dimensions != Some((size.width, size.height));
    let selection = selection_for_source(configured_selection, size.width, size.height)?;
    #[cfg(debug_assertions)]
    if matches!(
        configured_selection,
        Some(NativeCaptureSelection::Regions { .. })
    ) && selection.is_none()
    {
        debug_collector.finish_capture(control.capture_id, SOURCE_MISMATCH);
    }
    if last_source_frame.get().is_none() {
        eprintln!(
            "Native display capture received first frame: memory={memory_type:?}, bytes={}, stride={stride}",
            pixels.len()
        );
    }
    let source_frame_time = Instant::now();
    last_source_frame.set(Some(source_frame_time));
    #[cfg(debug_assertions)]
    if let Ok(mut source_dimensions) = control.source_dimensions.lock() {
        *source_dimensions = Some((size.width, size.height));
        control.healthy.store(true, Ordering::Release);
    }
    if selection.is_none() && !preview_enabled {
        return Ok(ControlFlow::Continue(()));
    }
    let Some((batch_id, send_preview)) = control.begin_batch(selection, preview_enabled)? else {
        if let Some(metrics) = data.diagnostics.as_mut() {
            metrics.blocked();
        }
        return Ok(ControlFlow::Continue(()));
    };
    let packing_started = data.diagnostics.as_ref().map(|_| Instant::now());
    let preview = if send_preview {
        match preview_frame(
            pixels,
            size.width,
            size.height,
            stride,
            data.format.format(),
            control.capture_id,
            batch_id,
        ) {
            Ok(frame) => Some(frame),
            Err(error) => {
                control.clear_batch(batch_id);
                return Err(error);
            }
        }
    } else {
        None
    };
    let batch = BatchIdentity {
        capture_id: control.capture_id,
        batch_id,
    };
    let source_frame = SourceFrame {
        pixels,
        width: size.width,
        height: size.height,
        stride,
        format: data.format.format(),
    };
    let selected_frames = match selection {
        Some(selection @ NativeCaptureSelection::Search { .. }) => selection
            .search_pixel_region()
            .and_then(|region| {
                crop_pixel_region_frame(&source_frame, region, FRAME_KIND_SEARCH_REGION, batch)
            })
            .map(|search| (Some(search), None, None)),
        Some(NativeCaptureSelection::Regions { settings }) => (|| {
            let region = crop_region_frame(&source_frame, settings, batch)?;
            let rare_region = settings
                .rare_pixel_region()?
                .map(|rare_region| {
                    crop_pixel_region_frame(
                        &source_frame,
                        rare_region,
                        FRAME_KIND_RARE_REGION,
                        batch,
                    )
                })
                .transpose()?;
            Ok((None, Some(region), rare_region))
        })(),
        None => Ok((None, None, None)),
    };
    let (search_frame, region_frame, rare_region_frame) = match selected_frames {
        Ok(frames) => frames,
        Err(error) => {
            control.clear_batch(batch_id);
            return Err(error);
        }
    };
    #[cfg(debug_assertions)]
    match (selection, region_frame.as_ref(), rare_region_frame.as_ref()) {
        (
            Some(selection @ NativeCaptureSelection::Regions { .. }),
            Some(region_frame),
            Some(rare_region_frame),
        ) => debug_collector.enqueue_pair(SampledRoiPair {
            capture_id: control.capture_id,
            selection,
            source_width: size.width,
            source_height: size.height,
            batch_id,
            normal_frame: region_frame,
            rare_frame: rare_region_frame,
            payload_offset: FRAME_HEADER_BYTES,
        }),
        (Some(NativeCaptureSelection::Regions { .. }), _, _) => {
            debug_collector.finish_capture(control.capture_id, SOURCE_MISMATCH)
        }
        _ => {}
    }
    let packing_duration = packing_started
        .map(|start| start.elapsed())
        .unwrap_or_default();
    let sending_started = data.diagnostics.as_ref().map(|_| Instant::now());
    let bytes = if data.diagnostics.is_some() {
        [&preview, &search_frame, &region_frame, &rare_region_frame]
            .iter()
            .filter_map(|frame| frame.as_ref())
            .map(|frame| frame.len())
            .sum()
    } else {
        0
    };
    for frame in [preview, search_frame, region_frame, rare_region_frame]
        .into_iter()
        .flatten()
    {
        if frames.send(InvokeResponseBody::Raw(frame)).is_err() {
            control.clear_batch(batch_id);
            return Ok(ControlFlow::Break(()));
        }
    }
    if let Some(metrics) = data.diagnostics.as_mut() {
        metrics.sample(
            bytes,
            packing_duration,
            sending_started
                .map(|start| start.elapsed())
                .unwrap_or_default(),
        );
    }
    data.published_source_dimensions = Some((size.width, size.height));
    data.next_sample = Some(next_sample_deadline(data.next_sample, source_frame_time));
    Ok(ControlFlow::Continue(()))
}

fn video_format_parameter() -> Vec<u8> {
    // Let the ScreenCast producer retain its native size; a preferred size may rescale the stream.
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
            pw::spa::param::format::FormatProperties::VideoFramerate,
            Choice,
            Range,
            Fraction,
            pw::spa::utils::Fraction {
                num: SAMPLE_FPS,
                denom: 1
            },
            pw::spa::utils::Fraction { num: 0, denom: 1 },
            pw::spa::utils::Fraction {
                num: SAMPLE_FPS,
                denom: 1
            }
        ),
        // framerate=0/1 denotes a variable-rate source; bound that path too.
        pw::spa::pod::property!(
            pw::spa::param::format::FormatProperties::VideoMaxFramerate,
            Fraction,
            pw::spa::utils::Fraction {
                num: SAMPLE_FPS,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variable_rate_sources_have_an_explicit_sixteen_fps_maximum() {
        let bytes = video_format_parameter();
        let (_, value) =
            spa::pod::deserialize::PodDeserializer::deserialize_from::<spa::pod::Value>(&bytes)
                .unwrap();
        let spa::pod::Value::Object(object) = value else {
            panic!("expected format object")
        };
        let maximum = object
            .properties
            .iter()
            .find(|property| {
                property.key == spa::param::format::FormatProperties::VideoMaxFramerate.as_raw()
            })
            .unwrap();
        assert_eq!(
            maximum.value,
            spa::pod::Value::Fraction(spa::utils::Fraction {
                num: SAMPLE_FPS,
                denom: 1
            })
        );
        assert!(!object.properties.iter().any(
            |property| property.key == spa::param::format::FormatProperties::VideoSize.as_raw()
        ));
    }
}
