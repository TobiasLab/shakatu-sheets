use super::*;
use crate::native_capture::{LootCaptureSettings, NormalizedRegion};

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
        font: Default::default(),
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
fn producer_jitter_does_not_halve_the_sample_rate() {
    let start = Instant::now();
    let mut deadline = None;
    for micros in [
        0, 62_000, 126_000, 187_000, 250_000, 313_500, 374_000, 437_500,
    ] {
        let now = start + Duration::from_micros(micros);
        assert!(sample_due(deadline, now));
        deadline = Some(next_sample_deadline(deadline, now));
        assert!(!sample_due(deadline, now + Duration::from_millis(30)));
    }
    let late = start + Duration::from_secs(4);
    assert!(sample_due(deadline, late));
    assert_eq!(next_sample_deadline(deadline, late), late + SAMPLE_INTERVAL);
}

#[test]
fn overspeed_source_is_bounded_without_catch_up_bursts() {
    let start = Instant::now();
    let mut deadline = None;
    let mut samples = Vec::new();
    // A producer can advertise sixteen FPS while delivering thirty-two.
    for tick in 0..960 {
        let now = start + Duration::from_micros(tick * 31_250);
        if sample_due(deadline, now) {
            samples.push(now);
            deadline = Some(next_sample_deadline(deadline, now));
        }
    }
    assert_eq!(samples.len(), 480);
    assert!(samples
        .windows(2)
        .all(|pair| pair[1] - pair[0] == SAMPLE_INTERVAL));
    let resumed = start + Duration::from_secs(90);
    assert!(sample_due(deadline, resumed));
    deadline = Some(next_sample_deadline(deadline, resumed));
    assert!(!sample_due(deadline, resumed + Duration::from_millis(30)));
}
