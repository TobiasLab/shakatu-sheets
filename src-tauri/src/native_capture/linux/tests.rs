use super::*;

fn header(frame: &[u8]) -> Vec<u32> {
    frame[..FRAME_HEADER_BYTES]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| u32::from_le_bytes(*bytes))
        .collect()
}

fn source_frame(
    pixels: &[u8],
    width: u32,
    height: u32,
    stride: u32,
    format: spa::param::video::VideoFormat,
) -> SourceFrame<'_> {
    SourceFrame {
        pixels,
        width,
        height,
        stride,
        format,
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
        region: super::super::NormalizedRegion {
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
    let (width, height) =
        crate::native_capture::geometry::loot_region_dimensions(ui_scale_percent).unwrap();
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

fn regions_selection(settings: LootCaptureSettings) -> NativeCaptureSelection {
    NativeCaptureSelection::Regions { settings }
}

fn search_selection(x: u32, y: u32) -> NativeCaptureSelection {
    NativeCaptureSelection::Search {
        region: NormalizedRegion {
            x: x as f64 / 3440.0,
            y: y as f64 / 1440.0,
            width: 800.0 / 3440.0,
            height: 600.0 / 1440.0,
        },
        source_width: 3440,
        source_height: 1440,
        ui_scale_percent: 80,
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
        [3, FRAME_KIND_PREVIEW, 17, 23, 2, 1, 2, 1, 0, 0]
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
        crate::native_capture::geometry::normalized_to_pixel_region(
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
        crate::native_capture::geometry::normalized_to_pixel_region(
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
fn crops_an_exact_100_percent_region_and_encodes_the_native_origin() {
    let selection = selection(1920, 1080, 100, 10, 0);
    let region = selection.pixel_region().unwrap();
    let stride = selection.source_width * 4;
    let mut source = vec![0; stride as usize * region.height as usize];
    let first = pixel_offset(0, 10, stride).unwrap();
    source[first..first + 8].copy_from_slice(&[30, 20, 10, 40, 60, 50, 40, 70]);
    let last = pixel_offset(region.height - 1, region.x + region.width - 1, stride).unwrap();
    source[last..last + 4].copy_from_slice(&[99, 88, 77, 110]);

    let frame = crop_region_frame(
        &source_frame(
            &source,
            selection.source_width,
            selection.source_height,
            stride,
            spa::param::video::VideoFormat::BGRA,
        ),
        selection,
        BatchIdentity {
            capture_id: 31,
            batch_id: 47,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [3, FRAME_KIND_REGION, 31, 47, 453, 389, 1920, 1080, 10, 0,]
    );
    assert_eq!(
        &frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 8],
        &[10, 20, 30, 40, 40, 50, 60, 70]
    );
    assert_eq!(&frame[frame.len() - 4..], &[77, 88, 99, 110]);
}

#[test]
fn crops_a_rare_region_and_encodes_its_header() {
    let mut selection = selection(1920, 1080, 80, 10, 20);
    selection.rare_region = Some(NormalizedRegion {
        x: 100.0 / 1920.0,
        y: 200.0 / 1080.0,
        width: 400.0 / 1920.0,
        height: 100.0 / 1080.0,
    });
    let rare_region = selection.rare_pixel_region().unwrap().unwrap();
    let stride = selection.source_width * 4;
    let mut source = vec![0; stride as usize * 300];
    let first = pixel_offset(rare_region.y, rare_region.x, stride).unwrap();
    source[first..first + 4].copy_from_slice(&[30, 20, 10, 40]);

    let frame = crop_pixel_region_frame(
        &source_frame(
            &source,
            selection.source_width,
            selection.source_height,
            stride,
            spa::param::video::VideoFormat::BGRA,
        ),
        rare_region,
        FRAME_KIND_RARE_REGION,
        BatchIdentity {
            capture_id: 31,
            batch_id: 47,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [
            3,
            FRAME_KIND_RARE_REGION,
            31,
            47,
            400,
            100,
            1920,
            1080,
            100,
            200,
        ]
    );
    assert_eq!(
        &frame[FRAME_HEADER_BYTES..FRAME_HEADER_BYTES + 4],
        &[10, 20, 30, 40]
    );
}

#[test]
fn crops_a_search_region_and_encodes_the_kind_four_header() {
    let selection = search_selection(100, 200);
    let region = selection.search_pixel_region().unwrap();
    let stride = 3440 * 4;
    let source = vec![0; stride as usize * 800];

    let frame = crop_pixel_region_frame(
        &source_frame(
            &source,
            3440,
            1440,
            stride,
            spa::param::video::VideoFormat::BGRx,
        ),
        region,
        FRAME_KIND_SEARCH_REGION,
        BatchIdentity {
            capture_id: 41,
            batch_id: 59,
        },
    )
    .unwrap();

    assert_eq!(
        header(&frame),
        [
            3,
            FRAME_KIND_SEARCH_REGION,
            41,
            59,
            800,
            600,
            3440,
            1440,
            100,
            200
        ]
    );
}

#[test]
fn rejects_roi_allocation_for_invalid_dimensions() {
    let selection = selection_with_dimensions(1920, 1080, 100, 0, 0, 452, 389);
    let error = crop_region_frame(
        &source_frame(
            &[],
            selection.source_width,
            selection.source_height,
            selection.source_width * 4,
            spa::param::video::VideoFormat::BGRA,
        ),
        selection,
        BatchIdentity {
            capture_id: 1,
            batch_id: 1,
        },
    )
    .unwrap_err();

    assert!(error.contains("exactly 453x389"));
}

#[test]
fn source_mismatch_skips_a_configured_region() {
    let configured = selection(3440, 1440, 80, 10, 20);
    assert_eq!(
        selection_for_source(Some(regions_selection(configured)), 2560, 1440).unwrap(),
        None
    );
    let configured = selection(2560, 1440, 100, 10, 20);
    assert_eq!(
        selection_for_source(Some(regions_selection(configured)), 2560, 1440).unwrap(),
        Some(regions_selection(configured))
    );
    let configured = search_selection(100, 200);
    assert_eq!(
        selection_for_source(Some(configured), 2560, 1440).unwrap(),
        None
    );
    assert_eq!(
        selection_for_source(Some(configured), 3440, 1440).unwrap(),
        Some(configured)
    );
}

#[cfg(debug_assertions)]
#[test]
fn debug_collector_revalidation_detects_replacement_and_selection_changes() {
    let state = CaptureState::default();
    let settings = selection(1920, 1080, 80, 10, 20);
    let expected_selection = regions_selection(settings);
    let control = Arc::new(CaptureControl::new(4, 9, Some(expected_selection)));
    control.healthy.store(true, Ordering::Release);
    *control.source_dimensions.lock().unwrap() = Some((1920, 1080));
    state.inner.lock().unwrap().capture = Some(control.clone());

    revalidate_debug_roi_capture(&state, &control, expected_selection, Some((1920, 1080))).unwrap();

    state.inner.lock().unwrap().capture = Some(Arc::new(CaptureControl::new(5, 10, None)));
    let (reason, error) =
        revalidate_debug_roi_capture(&state, &control, expected_selection, Some((1920, 1080)))
            .unwrap_err();
    assert_eq!(reason, CAPTURE_REPLACED);
    assert!(error.contains("replaced"));

    state.inner.lock().unwrap().capture = Some(control.clone());
    *control.selection.lock().unwrap() = None;
    let (reason, error) =
        revalidate_debug_roi_capture(&state, &control, expected_selection, Some((1920, 1080)))
            .unwrap_err();
    assert_eq!(reason, SELECTION_CHANGED);
    assert!(error.contains("selection changed"));
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

    let control = CaptureControl::new(7, 11, None);
    let mut settings = selection(3440, 1440, 80, 10, 20);
    settings.rare_region = Some(NormalizedRegion {
        x: 1000.0 / 3440.0,
        y: 1000.0 / 1440.0,
        width: 400.0 / 3440.0,
        height: 100.0 / 1440.0,
    });
    let batch_id = control
        .begin_batch(Some(regions_selection(settings)), true)
        .unwrap()
        .unwrap()
        .0;

    control.acknowledge(8, batch_id, FRAME_KIND_PREVIEW);
    control.acknowledge(7, batch_id + 1, FRAME_KIND_PREVIEW);
    control.acknowledge(7, batch_id, FRAME_KIND_ERROR);
    {
        let batches = control.batches.lock().unwrap();
        let pending = batches.pending.as_ref().unwrap();
        assert!(pending.preview_pending);
        assert!(!pending.search_pending);
        assert!(pending.region_pending);
        assert!(pending.rare_region_pending);
    }

    control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
    control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
    {
        let batches = control.batches.lock().unwrap();
        let pending = batches.pending.as_ref().unwrap();
        assert!(!pending.preview_pending);
        assert!(!pending.search_pending);
        assert!(pending.region_pending);
        assert!(pending.rare_region_pending);
    }

    control.acknowledge(7, batch_id, FRAME_KIND_REGION);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.acknowledge(7, batch_id, FRAME_KIND_RARE_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let next_batch_id = control.begin_batch(None, true).unwrap().unwrap().0;
    assert_eq!(next_batch_id, batch_id + 1);
    control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.acknowledge(7, next_batch_id, FRAME_KIND_PREVIEW);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let normal_batch_id = control
        .begin_batch(
            Some(regions_selection(selection(3440, 1440, 80, 10, 20))),
            true,
        )
        .unwrap()
        .unwrap()
        .0;
    control.acknowledge(7, normal_batch_id, FRAME_KIND_PREVIEW);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.acknowledge(7, normal_batch_id, FRAME_KIND_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let search_batch_id = control
        .begin_batch(Some(search_selection(100, 200)), true)
        .unwrap()
        .unwrap()
        .0;
    control.acknowledge(7, search_batch_id, FRAME_KIND_PREVIEW);
    control.acknowledge(7, search_batch_id, FRAME_KIND_REGION);
    {
        let batches = control.batches.lock().unwrap();
        let pending = batches.pending.as_ref().unwrap();
        assert!(pending.search_pending);
        assert!(!pending.region_pending);
        assert!(!pending.rare_region_pending);
    }
    control.acknowledge(7, search_batch_id, FRAME_KIND_SEARCH_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let failed_batch_id = control.begin_batch(None, true).unwrap().unwrap().0;
    control.clear_batch(failed_batch_id - 1);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.clear_batch(failed_batch_id);
    assert!(control.batches.lock().unwrap().pending.is_none());
}

#[test]
fn hidden_unconfigured_capture_cannot_leave_an_empty_batch_pending() {
    let control = CaptureControl::new(7, 11, None);
    assert!(control.preview_enabled.load(Ordering::Acquire));
    assert!(control.begin_batch(None, false).unwrap().is_none());
    assert!(control.batches.lock().unwrap().pending.is_none());
    // The stream explicitly requests one preview to announce first-frame or changed dimensions.
    let (batch_id, send_preview) = control.begin_batch(None, true).unwrap().unwrap();
    assert!(send_preview);
    control.acknowledge(7, batch_id, FRAME_KIND_PREVIEW);
    assert!(control.begin_batch(None, false).unwrap().is_none());
    assert!(control
        .begin_batch(
            Some(regions_selection(selection(3440, 1440, 80, 10, 20))),
            false
        )
        .unwrap()
        .is_some());
}

#[test]
fn disabled_preview_batches_wait_only_for_selected_crops() {
    let control = CaptureControl::new(7, 11, None);
    control.preview_enabled.store(false, Ordering::Release);
    let preview_enabled = control.preview_enabled.load(Ordering::Acquire);
    let mut settings = selection(3440, 1440, 80, 10, 20);
    settings.rare_region = Some(NormalizedRegion {
        x: 1000.0 / 3440.0,
        y: 1000.0 / 1440.0,
        width: 400.0 / 3440.0,
        height: 100.0 / 1440.0,
    });

    let (region_batch_id, send_preview) = control
        .begin_batch(Some(regions_selection(settings)), preview_enabled)
        .unwrap()
        .unwrap();
    assert!(!send_preview);
    {
        let batches = control.batches.lock().unwrap();
        let pending = batches.pending.as_ref().unwrap();
        assert!(!pending.preview_pending);
        assert!(!pending.search_pending);
        assert!(pending.region_pending);
        assert!(pending.rare_region_pending);
    }
    control.acknowledge(7, region_batch_id, FRAME_KIND_REGION);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.acknowledge(7, region_batch_id, FRAME_KIND_RARE_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let (search_batch_id, send_preview) = control
        .begin_batch(Some(search_selection(100, 200)), preview_enabled)
        .unwrap()
        .unwrap();
    assert!(!send_preview);
    {
        let batches = control.batches.lock().unwrap();
        let pending = batches.pending.as_ref().unwrap();
        assert!(!pending.preview_pending);
        assert!(pending.search_pending);
        assert!(!pending.region_pending);
        assert!(!pending.rare_region_pending);
    }
    control.acknowledge(7, search_batch_id, FRAME_KIND_SEARCH_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());
}

#[test]
fn preview_updates_apply_to_the_next_batch_without_changing_pending_acknowledgements() {
    let control = CaptureControl::new(7, 11, None);
    let selected = Some(regions_selection(selection(3440, 1440, 80, 10, 20)));

    let (enabled_batch_id, send_preview) = control
        .begin_batch(selected, control.preview_enabled.load(Ordering::Acquire))
        .unwrap()
        .unwrap();
    assert!(send_preview);
    control.preview_enabled.store(false, Ordering::Release);
    assert!(control
        .begin_batch(selected, control.preview_enabled.load(Ordering::Acquire))
        .unwrap()
        .is_none());
    control.acknowledge(7, enabled_batch_id, FRAME_KIND_REGION);
    assert!(control.batches.lock().unwrap().pending.is_some());
    control.acknowledge(7, enabled_batch_id, FRAME_KIND_PREVIEW);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let (disabled_batch_id, send_preview) = control
        .begin_batch(selected, control.preview_enabled.load(Ordering::Acquire))
        .unwrap()
        .unwrap();
    assert!(!send_preview);
    control.preview_enabled.store(true, Ordering::Release);
    control.acknowledge(7, disabled_batch_id, FRAME_KIND_REGION);
    assert!(control.batches.lock().unwrap().pending.is_none());

    let (_, send_preview) = control
        .begin_batch(selected, control.preview_enabled.load(Ordering::Acquire))
        .unwrap()
        .unwrap();
    assert!(send_preview);
}

#[test]
fn preview_updates_reject_stale_tokens_and_finished_captures() {
    let state = CaptureState::default();
    let control = Arc::new(CaptureControl::new(1, 7, None));
    state.inner.lock().unwrap().capture = Some(control.clone());

    assert_eq!(
        set_preview_enabled(&state, 6, false),
        Err("Native display capture request is no longer active.".to_string())
    );
    assert!(control.preview_enabled.load(Ordering::Acquire));

    set_preview_enabled(&state, 7, false).unwrap();
    assert!(!control.preview_enabled.load(Ordering::Acquire));
    control.finished.store(true, Ordering::Release);
    assert_eq!(
        set_preview_enabled(&state, 7, true),
        Err("Native display capture is not running.".to_string())
    );
    assert!(!control.preview_enabled.load(Ordering::Acquire));

    let replacement = Arc::new(CaptureControl::new(2, 8, None));
    state.inner.lock().unwrap().capture = Some(replacement.clone());
    assert_eq!(
        set_preview_enabled(&state, 7, false),
        Err("Native display capture request is no longer active.".to_string())
    );
    assert!(replacement.preview_enabled.load(Ordering::Acquire));
}

#[test]
fn finished_capture_rejects_selection_updates() {
    let state = CaptureState::default();
    let control = Arc::new(CaptureControl::new(1, 7, None));
    state.inner.lock().unwrap().capture = Some(control.clone());

    assert_eq!(
        set_selection(&state, 6, None),
        Err("Native display capture request is no longer active.".to_string())
    );
    set_selection(&state, 7, None).unwrap();
    control.finished.store(true, Ordering::Release);

    assert_eq!(
        set_selection(&state, 7, None),
        Err("Native display capture is not running.".to_string())
    );
}

#[test]
fn stale_stop_does_not_cancel_the_current_capture() {
    let state = CaptureState::default();
    let control = Arc::new(CaptureControl::new(1, 7, None));
    {
        let mut inner = state.inner.lock().unwrap();
        inner.latest_capture_token = 7;
        inner.capture = Some(control.clone());
    }

    stop(&state, 6);
    assert!(!control.cancelled.load(Ordering::Acquire));
    assert!(state.inner.lock().unwrap().capture.is_some());

    stop(&state, 7);
    assert!(control.cancelled.load(Ordering::Acquire));
    assert!(state.inner.lock().unwrap().capture.is_none());
}

#[test]
fn stopped_and_superseded_tokens_cannot_start_late() {
    let mut state = CaptureStateInner {
        latest_capture_token: 7,
        ..Default::default()
    };

    assert!(state.install_capture(7, None).is_err());
    assert!(state.install_capture(6, None).is_err());
    let (control, previous) = state.install_capture(8, None).unwrap();

    assert_eq!(control.capture_token, 8);
    assert!(previous.is_none());
    assert_eq!(state.latest_capture_token, 8);
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
        [3, FRAME_KIND_ERROR, 0, 0, 0, 0, 0, 0, 0, 0]
    );
    assert_eq!(&frame[FRAME_HEADER_BYTES..], b"failed");
}

#[test]
fn producer_jitter_does_not_halve_the_sample_rate() {
    let start = Instant::now();
    let mut deadline = None;
    for millis in [0, 124, 251, 374, 500, 626, 749, 875] {
        let now = start + Duration::from_millis(millis);
        assert!(sample_due(deadline, now));
        deadline = Some(next_sample_deadline(deadline, now));
        assert!(!sample_due(deadline, now + Duration::from_millis(30)));
    }
    let late = start + Duration::from_secs(4);
    assert!(sample_due(deadline, late));
    assert_eq!(next_sample_deadline(deadline, late), late + SAMPLE_INTERVAL);
}

fn scalar_crop(source: &SourceFrame<'_>, region: PixelRegion) -> Vec<u8> {
    let mut output = Vec::with_capacity((region.width * region.height * 4) as usize);
    for y in region.y..region.y + region.height {
        for x in region.x..region.x + region.width {
            let offset = pixel_offset(y, x, source.stride).unwrap();
            output
                .extend_from_slice(&converted_pixel(source.pixels, offset, source.format).unwrap());
        }
    }
    output
}

#[test]
fn row_conversion_matches_scalar_pixels_with_padding_and_truncation() {
    use spa::param::video::VideoFormat;
    let pixels: Vec<u8> = (0..120).map(|i| (i * 37) as u8).collect();
    let region = PixelRegion {
        x: 1,
        y: 1,
        width: 3,
        height: 2,
    };
    for format in [
        VideoFormat::RGBA,
        VideoFormat::RGBx,
        VideoFormat::BGRA,
        VideoFormat::BGRx,
    ] {
        let mut source = SourceFrame {
            pixels: &pixels,
            width: 5,
            height: 5,
            stride: 24,
            format,
        };
        let result = crop_pixel_region_frame(
            &source,
            region,
            FRAME_KIND_REGION,
            BatchIdentity {
                capture_id: 1,
                batch_id: 1,
            },
        )
        .unwrap();
        assert_eq!(&result[FRAME_HEADER_BYTES..], scalar_crop(&source, region));
        source.pixels = &pixels[..63];
        assert!(crop_pixel_region_frame(
            &source,
            region,
            FRAME_KIND_REGION,
            BatchIdentity {
                capture_id: 1,
                batch_id: 1
            }
        )
        .is_err());
    }
}

#[test]
#[ignore = "local microbenchmark: run with --release --ignored --nocapture"]
fn benchmark_crop_conversion() {
    use std::hint::black_box;
    let pixels = vec![127; 3440 * 1440 * 4];
    let region = PixelRegion {
        x: 2400,
        y: 900,
        width: 453,
        height: 389,
    };
    let source = SourceFrame {
        pixels: &pixels,
        width: 3440,
        height: 1440,
        stride: 3440 * 4,
        format: spa::param::video::VideoFormat::BGRx,
    };
    let rounds = 1000;
    let start = Instant::now();
    for _ in 0..rounds {
        black_box(scalar_crop(black_box(&source), region));
    }
    let scalar = start.elapsed();
    let start = Instant::now();
    for _ in 0..rounds {
        black_box(
            crop_pixel_region_frame(
                black_box(&source),
                region,
                FRAME_KIND_REGION,
                BatchIdentity {
                    capture_id: 1,
                    batch_id: 1,
                },
            )
            .unwrap(),
        );
    }
    let row = start.elapsed();
    eprintln!(
        "{rounds} crops: scalar={scalar:?}, row={row:?}, speedup={:.2}x",
        scalar.as_secs_f64() / row.as_secs_f64()
    );
}
