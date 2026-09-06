use super::writer::{discard_queued_pairs, record_write_failure};
use super::*;
use std::fs;
use std::sync::Barrier;

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "shakatu-roi-{name}-{}-{}",
            std::process::id(),
            unix_ms(SystemTime::now()).unwrap()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn settings() -> LootCaptureSettings {
    LootCaptureSettings {
        region: NormalizedRegion {
            x: 10.0 / 1920.0,
            y: 20.0 / 1080.0,
            width: 362.0 / 1920.0,
            height: 311.0 / 1080.0,
        },
        rare_region: Some(NormalizedRegion {
            x: 500.0 / 1920.0,
            y: 600.0 / 1080.0,
            width: 400.0 / 1920.0,
            height: 100.0 / 1080.0,
        }),
        rare_region_confirmed: true,
        source_width: 1920,
        source_height: 1080,
        ui_scale_percent: 80,
    }
}

fn wait_for(
    collector: &DebugRoiSampleCollector,
    predicate: impl Fn(&DebugRoiSampleCollectionStatus) -> bool,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = collector.status();
        if predicate(&status) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for collector: {status:?}"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn writes_valid_paired_pngs_and_final_manifest() {
    let temp = TempDir::new("paired");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let selection = NativeCaptureSelection::Regions { settings };
    collector
        .start_in(&temp.0, 4, 9, selection, settings, Duration::from_secs(30))
        .unwrap();
    let normal = vec![17; 362 * 311 * 4];
    let rare = vec![23; 400 * 100 * 4];
    collector.enqueue_pair(SampledRoiPair {
        capture_id: 4,
        selection,
        source_width: 1920,
        source_height: 1080,
        batch_id: 37,
        normal_frame: &normal,
        rare_frame: &rare,
        payload_offset: 0,
    });
    wait_for(&collector, |status| status.written_batch_count == 1);
    collector.stop(9).unwrap();
    wait_for(&collector, |status| {
        status.phase == DebugRoiSampleCollectionPhase::Finished
    });

    let run_path = PathBuf::from(collector.status().path.unwrap());
    let normal_path = run_path.join("normal/minute-01/frame-0000000037.png");
    let rare_path = run_path.join("rare/minute-01/frame-0000000037.png");
    for (path, dimensions) in [(normal_path, (362, 311)), (rare_path, (400, 100))] {
        let bytes = fs::read(path).unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            dimensions.0
        );
        assert_eq!(
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
            dimensions.1
        );
    }
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(run_path.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["targetFps"], 16);
    assert_eq!(manifest["phase"], "finished");
    assert_eq!(manifest["writtenBatchCount"], 1);
    assert_eq!(manifest["finishReason"], "explicitlyStopped");
    assert_eq!(manifest["normalCrop"]["pixels"]["width"], 362);
    assert_eq!(manifest["rareCrop"]["pixels"]["width"], 400);
}

#[test]
fn explicit_stop_writes_an_already_accepted_pair() {
    let temp = TempDir::new("drain");
    let settings = settings();
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    enqueue_to_run(
        &run,
        SamplePair {
            batch_id: 41,
            normal_rgba: vec![17; 362 * 311 * 4],
            rare_rgba: vec![23; 400 * 100 * 4],
        },
    );
    run.request_finish(FINISH_EXPLICIT);

    run_worker(run.clone(), receiver);

    let status = run.snapshot();
    assert_eq!(status.phase, DebugRoiSampleCollectionPhase::Finished);
    assert_eq!(status.accepted_batch_count, 1);
    assert_eq!(status.written_batch_count, 1);
    assert_eq!(status.dropped_batch_count, 0);
    assert!(temp
        .0
        .join("normal/minute-01/frame-0000000041.png")
        .is_file());
    assert!(temp.0.join("rare/minute-01/frame-0000000041.png").is_file());
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(temp.0.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["targetFps"], 16);
    assert_eq!(manifest["acceptedBatchCount"], 1);
    assert_eq!(manifest["writtenBatchCount"], 1);
    assert_eq!(manifest["finishReason"], "explicitlyStopped");
}

#[test]
fn bounded_queue_drops_whole_pairs() {
    let temp = TempDir::new("bounded");
    let settings = settings();
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = test_run(&temp.0, sender, settings);
    enqueue_to_run(
        &run,
        SamplePair {
            batch_id: 1,
            normal_rgba: vec![1],
            rare_rgba: vec![2],
        },
    );
    enqueue_to_run(
        &run,
        SamplePair {
            batch_id: 2,
            normal_rgba: vec![3],
            rare_rgba: vec![4],
        },
    );

    assert_eq!(run.accepted.load(Ordering::Acquire), 1);
    assert_eq!(run.dropped.load(Ordering::Acquire), 1);
    let pair = receiver.try_recv().unwrap();
    assert_eq!(pair.batch_id, 1);
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn stop_is_capture_token_scoped_and_idempotent() {
    let temp = TempDir::new("stop");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let (sender, _receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    collector.active.store(Some(run.clone()));

    assert_eq!(
        collector.stop(8).unwrap().phase,
        DebugRoiSampleCollectionPhase::Running
    );
    assert_eq!(run.requested_finish_reason(), None);
    assert_eq!(
        collector.stop(9).unwrap().phase,
        DebugRoiSampleCollectionPhase::Finalizing
    );
    assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
    collector.finish_capture(4, FINISH_CAPTURE_REPLACED);
    assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
    collector.finish_capture(3, FINISH_CAPTURE_ENDED);
    assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
}

#[test]
fn writer_failure_closes_admission_before_queue_cleanup() {
    let temp = TempDir::new("writer-failure");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let selection = NativeCaptureSelection::Regions { settings };
    let (sender, _receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    collector.active.store(Some(run.clone()));

    record_write_failure(&run, "PNG encoding failed".to_string());
    collector.enqueue_pair(SampledRoiPair {
        capture_id: 4,
        selection,
        source_width: 1920,
        source_height: 1080,
        batch_id: 42,
        normal_frame: &[],
        rare_frame: &[],
        payload_offset: 0,
    });

    let status = collector.status();
    assert_eq!(status.phase, DebugRoiSampleCollectionPhase::Finalizing);
    assert_eq!(status.finish_reason.as_deref(), Some("writeFailed"));
    assert_eq!(status.error.as_deref(), Some("PNG encoding failed"));
    assert_eq!(status.accepted_batch_count, 0);
    assert_eq!(status.dropped_batch_count, 0);
    assert_eq!(run.queued.load(Ordering::Acquire), 0);
}

#[test]
fn failure_cleanup_waits_for_an_in_flight_accepted_pair() {
    let temp = TempDir::new("failure-in-flight");
    let settings = settings();
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    assert!(reserve_queue_slot(&run));
    record_write_failure(&run, "PNG encoding failed".to_string());

    let producer_run = run.clone();
    let producer = thread::spawn(move || {
        thread::sleep(Duration::from_millis(20));
        send_reserved_pair(
            &producer_run,
            SamplePair {
                batch_id: 43,
                normal_rgba: vec![1],
                rare_rgba: vec![2],
            },
        );
    });
    discard_queued_pairs(&run, &receiver);
    producer.join().unwrap();

    assert_eq!(run.accepted.load(Ordering::Acquire), 1);
    assert_eq!(run.written.load(Ordering::Acquire), 0);
    assert_eq!(run.dropped.load(Ordering::Acquire), 0);
    assert_eq!(run.queued.load(Ordering::Acquire), 0);
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn startup_reservation_rejects_overlap_and_clears_on_drop() {
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let binding = CollectionBinding {
        capture_id: 4,
        capture_token: 9,
        selection: NativeCaptureSelection::Regions { settings },
        settings,
    };
    let first = collector.reserve_start(binding).unwrap();

    assert!(collector.reserve_start(binding).is_err());
    assert!(collector.startup.load_full().is_some());
    drop(first);

    assert!(collector.startup.load_full().is_none());
    drop(collector.reserve_start(binding).unwrap());
}

#[test]
fn installed_run_keeps_startup_reserved_until_revalidation_completes() {
    let temp = TempDir::new("pending-start");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let pending = collector
        .start_pending_in_at(
            &temp.0,
            CollectionBinding {
                capture_id: 4,
                capture_token: 9,
                selection: NativeCaptureSelection::Regions { settings },
                settings,
            },
            Duration::from_secs(30),
            CollectionStart {
                monotonic: Instant::now(),
                unix_ms: unix_ms(SystemTime::now()).unwrap(),
            },
        )
        .unwrap();

    assert!(collector
        .reserve_start(CollectionBinding {
            capture_id: 4,
            capture_token: 9,
            selection: NativeCaptureSelection::Regions { settings },
            settings,
        })
        .is_err());
    assert!(collector.active.load_full().is_some());
    let status = pending.abort(FINISH_CAPTURE_REPLACED);
    assert!(matches!(
        status.phase,
        DebugRoiSampleCollectionPhase::Finalizing | DebugRoiSampleCollectionPhase::Finished
    ));
    assert!(collector.startup.load_full().is_none());
    wait_for(&collector, |status| {
        status.phase == DebugRoiSampleCollectionPhase::Finished
    });
}

#[test]
fn preinstall_lifecycle_event_aborts_the_installed_run() {
    let temp = TempDir::new("preinstall-abort");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let binding = CollectionBinding {
        capture_id: 4,
        capture_token: 9,
        selection: NativeCaptureSelection::Regions { settings },
        settings,
    };
    let mut reservation = collector.reserve_start(binding).unwrap();
    collector.finish_capture(4, FINISH_SELECTION_CHANGED);
    let (sender, _receiver) = mpsc::sync_channel(1);
    let mut starting_run = test_run(&temp.0, sender, settings);
    starting_run.phase = AtomicU8::new(PHASE_STARTING);
    let run = Arc::new(starting_run);

    reservation.install(run.clone()).unwrap();
    collector.enqueue_pair(SampledRoiPair {
        capture_id: 4,
        selection: binding.selection,
        source_width: 1920,
        source_height: 1080,
        batch_id: 47,
        normal_frame: &[1],
        rare_frame: &[2],
        payload_offset: 0,
    });

    assert_eq!(
        reservation.binding.abort_reason.load(Ordering::Acquire),
        FINISH_SELECTION_CHANGED
    );
    assert_eq!(
        run.requested_finish_reason(),
        Some(FINISH_SELECTION_CHANGED)
    );
    assert_eq!(
        phase(run.phase.load(Ordering::Acquire)),
        DebugRoiSampleCollectionPhase::Finalizing
    );
    assert_eq!(run.accepted.load(Ordering::Acquire), 0);
    assert_eq!(run.queued.load(Ordering::Acquire), 0);
    reservation.release();
}

#[test]
fn explicit_stop_is_recorded_during_startup() {
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let reservation = collector
        .reserve_start(CollectionBinding {
            capture_id: 4,
            capture_token: 9,
            selection: NativeCaptureSelection::Regions { settings },
            settings,
        })
        .unwrap();

    assert_eq!(
        collector.stop(9).unwrap(),
        DebugRoiSampleCollectionStatus::idle()
    );
    assert_eq!(
        reservation.binding.abort_reason.load(Ordering::Acquire),
        FINISH_EXPLICIT
    );
}

#[test]
fn setup_time_consumes_the_collection_deadline() {
    let temp = TempDir::new("deadline");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let started_at_unix_ms = unix_ms(SystemTime::now()).unwrap().saturating_sub(2_000);
    let status = collector
        .start_in_at(
            &temp.0,
            CollectionBinding {
                capture_id: 4,
                capture_token: 9,
                selection: NativeCaptureSelection::Regions { settings },
                settings,
            },
            Duration::from_secs(1),
            CollectionStart {
                monotonic: Instant::now().checked_sub(Duration::from_secs(2)).unwrap(),
                unix_ms: started_at_unix_ms,
            },
        )
        .unwrap();

    assert_eq!(status.started_at_unix_ms, Some(started_at_unix_ms));
    assert_eq!(status.deadline_at_unix_ms, Some(started_at_unix_ms + 1_000));
    wait_for(&collector, |status| {
        status.phase == DebugRoiSampleCollectionPhase::Finished
    });
    assert_eq!(
        collector.status().finish_reason.as_deref(),
        Some("deadlineReached")
    );
}

#[test]
fn sample_uses_the_lock_free_active_run_snapshot() {
    let temp = TempDir::new("active-snapshot");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let selection = NativeCaptureSelection::Regions { settings };
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    collector.active.store(Some(run.clone()));
    collector.enqueue_pair(SampledRoiPair {
        capture_id: 4,
        selection,
        source_width: 1920,
        source_height: 1080,
        batch_id: 44,
        normal_frame: &[1],
        rare_frame: &[2],
        payload_offset: 0,
    });

    assert_eq!(run.accepted.load(Ordering::Acquire), 1);
    assert_eq!(run.dropped.load(Ordering::Acquire), 0);
    assert_eq!(receiver.try_recv().unwrap().batch_id, 44);
}

#[test]
fn finish_transition_cannot_be_overwritten_by_startup_activation() {
    let temp = TempDir::new("finish-admission");
    let collector = DebugRoiSampleCollector::default();
    let settings = settings();
    let selection = NativeCaptureSelection::Regions { settings };
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    run.phase.store(PHASE_STARTING, Ordering::Release);
    let barrier = Arc::new(Barrier::new(3));
    thread::scope(|scope| {
        let activation_run = run.clone();
        let activation_barrier = barrier.clone();
        scope.spawn(move || {
            activation_barrier.wait();
            activation_run.activate();
        });
        let finish_run = run.clone();
        let finish_barrier = barrier.clone();
        scope.spawn(move || {
            finish_barrier.wait();
            finish_run.request_finish(FINISH_EXPLICIT);
        });
        barrier.wait();
    });
    collector.active.store(Some(run.clone()));

    collector.enqueue_pair(SampledRoiPair {
        capture_id: 4,
        selection,
        source_width: 1920,
        source_height: 1080,
        batch_id: 45,
        normal_frame: &[1],
        rare_frame: &[2],
        payload_offset: 0,
    });

    assert_eq!(run.requested_finish_reason(), Some(FINISH_EXPLICIT));
    assert_eq!(run.accepted.load(Ordering::Acquire), 0);
    assert_eq!(run.queued.load(Ordering::Acquire), 0);
    assert!(matches!(
        receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn producer_reserved_before_finish_is_accepted_and_drained() {
    let temp = TempDir::new("finish-reservation");
    let settings = settings();
    let (sender, receiver) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings));
    assert!(run.admission_open());
    assert!(reserve_queue_slot(&run));
    assert!(run.admission_open());
    run.request_finish(FINISH_EXPLICIT);

    send_reserved_pair(
        &run,
        SamplePair {
            batch_id: 46,
            normal_rgba: vec![17; 362 * 311 * 4],
            rare_rgba: vec![23; 400 * 100 * 4],
        },
    );
    run_worker(run.clone(), receiver);

    let status = run.snapshot();
    assert_eq!(status.accepted_batch_count, 1);
    assert_eq!(status.written_batch_count, 1);
    assert_eq!(status.dropped_batch_count, 0);
    assert_eq!(status.finish_reason.as_deref(), Some("explicitlyStopped"));
}

#[test]
fn elapsed_deadline_wins_over_later_lifecycle_stop() {
    let temp = TempDir::new("deadline-reason");
    let settings = settings();
    let (sender, _receiver) = mpsc::sync_channel(1);
    let mut run = test_run(&temp.0, sender, settings);
    run.deadline = Instant::now()
        .checked_sub(Duration::from_millis(1))
        .unwrap();

    run.request_finish(FINISH_CAPTURE_ENDED);

    assert_eq!(run.requested_finish_reason(), Some(FINISH_DEADLINE));
    assert_eq!(
        run.snapshot().finish_reason.as_deref(),
        Some("deadlineReached")
    );
}

#[test]
fn status_serialization_is_camel_case() {
    let value = serde_json::to_value(DebugRoiSampleCollectionStatus {
        phase: DebugRoiSampleCollectionPhase::Running,
        path: Some("sample".to_string()),
        accepted_batch_count: 2,
        dropped_batch_count: 3,
        written_batch_count: 1,
        bytes_written: 99,
        error: None,
        finish_reason: None,
        started_at_unix_ms: Some(10),
        deadline_at_unix_ms: Some(20),
    })
    .unwrap();

    assert_eq!(value["phase"], "running");
    assert_eq!(value["acceptedBatchCount"], 2);
    assert_eq!(value["bytesWritten"], 99);
    assert_eq!(value["startedAtUnixMs"], 10);
    assert!(value.get("accepted_batch_count").is_none());
}

fn test_run(path: &Path, sender: SyncSender<SamplePair>, settings: LootCaptureSettings) -> Run {
    Run {
        id: 1,
        capture_id: 4,
        capture_token: 9,
        selection: NativeCaptureSelection::Regions { settings },
        settings,
        normal_pixels: settings.pixel_region().unwrap(),
        rare_pixels: settings.rare_pixel_region().unwrap().unwrap(),
        path: path.to_path_buf(),
        sender,
        queue_capacity: 1,
        deadline: Instant::now() + Duration::from_secs(30),
        started_at_unix_ms: 1,
        deadline_at_unix_ms: 301_000,
        duration_seconds: 300,
        phase: AtomicU8::new(PHASE_RUNNING),
        accepted: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
        queued: AtomicU64::new(0),
        written: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
        diagnostic_writer: Mutex::new(()),
        outcome: Mutex::new(RunOutcome {
            finish_reason: None,
            errors: Vec::new(),
        }),
    }
}

fn diagnostic_json(path: &Path) -> serde_json::Value {
    serde_json::json!({
        "captureToken": 9, "collectionPath": path.to_string_lossy(), "source": "rare",
        "generation": 2, "eventId": "rare-1", "status": "withheld", "reason": "consensus-withheld",
        "firstFrame": {"frame": 0, "batchId": 7, "readings": []},
        "selectedFrames": [{"frame": 1, "batchId": 8, "readings": ["Loot x1", "Loot x7"]}],
        "count": 1, "error": null
    })
}

#[test]
fn ocr_diagnostics_require_a_matching_collection_and_resolve_saved_frames() {
    let temp = TempDir::new("ocr-gating");
    let collector = DebugRoiSampleCollector::default();
    let issue = || serde_json::from_value(diagnostic_json(&temp.0)).unwrap();
    assert!(!collector.log_ocr_issue(issue()).unwrap());
    assert!(!temp.0.join("ocr-issues.jsonl").exists());
    let (sender, _) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings()));
    collector.active.store(Some(run.clone()));
    for (key, value) in [
        ("captureToken", serde_json::json!(10)),
        ("collectionPath", serde_json::json!("/unrelated")),
    ] {
        let mut invalid = diagnostic_json(&temp.0);
        invalid[key] = value;
        assert!(!collector
            .log_ocr_issue(serde_json::from_value(invalid).unwrap())
            .unwrap());
    }
    assert!(!temp.0.join("ocr-issues.jsonl").exists());
    fs::create_dir_all(temp.0.join("rare/minute-02")).unwrap();
    fs::write(
        temp.0.join("rare/minute-02/frame-0000000008.png"),
        b"sample",
    )
    .unwrap();
    run.written.store(FRAMES_PER_MINUTE + 1, Ordering::Release);
    assert!(collector.log_ocr_issue(issue()).unwrap());
    // Completion does not discard late OCR results from saved frames in the same run.
    run.phase.store(PHASE_FINISHED, Ordering::Release);
    assert!(collector.log_ocr_issue(issue()).unwrap());
    let log = fs::read_to_string(temp.0.join("ocr-issues.jsonl")).unwrap();
    assert_eq!(log.lines().count(), 2);
    let record: serde_json::Value = serde_json::from_str(log.lines().next().unwrap()).unwrap();
    assert_eq!(record["version"], 2);
    assert_eq!(
        record["selectedFrames"][0]["file"],
        "rare/minute-02/frame-0000000008.png"
    );
    assert!(record["firstFrame"]["file"].is_null());
    assert_eq!(record["selectedFrames"][0]["readings"][1], "Loot x7");
    fs::remove_file(temp.0.join("rare/minute-02/frame-0000000008.png")).unwrap();
    assert!(!collector.log_ocr_issue(issue()).unwrap());
}

#[test]
fn ocr_diagnostics_validate_payloads_and_surface_write_limits_and_errors() {
    let temp = TempDir::new("ocr-validation");
    let collector = DebugRoiSampleCollector::default();
    let (sender, _) = mpsc::sync_channel(1);
    collector
        .active
        .store(Some(Arc::new(test_run(&temp.0, sender, settings()))));
    for (key, value) in [
        ("reason", serde_json::json!("unknown")),
        ("count", serde_json::json!(0)),
        ("error", serde_json::json!("x".repeat(4097))),
    ] {
        let mut invalid = diagnostic_json(&temp.0);
        invalid[key] = value;
        assert!(collector
            .log_ocr_issue(serde_json::from_value(invalid).unwrap())
            .is_err());
    }
    let mut invalid = diagnostic_json(&temp.0);
    invalid["source"] = serde_json::json!("../outside");
    assert!(serde_json::from_value::<OcrIssue>(invalid).is_err());
    let path = temp.0.join("ocr-issues.jsonl");
    fs::create_dir(&path).unwrap();
    assert!(collector
        .log_ocr_issue(serde_json::from_value(diagnostic_json(&temp.0)).unwrap())
        .unwrap_err()
        .contains("open"));
    fs::remove_dir(&path).unwrap();
    File::create(&path)
        .unwrap()
        .set_len(64 * 1024 * 1024)
        .unwrap();
    assert!(collector
        .log_ocr_issue(serde_json::from_value(diagnostic_json(&temp.0)).unwrap())
        .unwrap_err()
        .contains("64 MiB"));
    assert_eq!(fs::metadata(path).unwrap().len(), 64 * 1024 * 1024);
}

#[test]
fn concurrent_ocr_diagnostics_append_complete_json_lines() {
    let temp = TempDir::new("ocr-concurrent");
    let collector = Arc::new(DebugRoiSampleCollector::default());
    let (sender, _) = mpsc::sync_channel(1);
    collector
        .active
        .store(Some(Arc::new(test_run(&temp.0, sender, settings()))));
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let collector = collector.clone();
            let issue = serde_json::from_value(diagnostic_json(&temp.0)).unwrap();
            thread::spawn(move || collector.log_ocr_issue(issue).unwrap())
        })
        .collect();
    for worker in workers {
        assert!(worker.join().unwrap());
    }
    let log = fs::read_to_string(temp.0.join("ocr-issues.jsonl")).unwrap();
    assert_eq!(log.lines().count(), 16);
    for line in log.lines() {
        serde_json::from_str::<serde_json::Value>(line).unwrap();
    }
}

#[test]
fn ocr_diagnostics_preserve_results_while_finalizing_pending_pngs() {
    let temp = TempDir::new("ocr-finalizing");
    let collector = DebugRoiSampleCollector::default();
    let (sender, _) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings()));
    run.queued.store(1, Ordering::Release);
    run.request_finish(FINISH_EXPLICIT);
    collector.active.store(Some(run.clone()));
    let issue = || serde_json::from_value(diagnostic_json(&temp.0)).unwrap();
    assert!(collector.log_ocr_issue(issue()).unwrap());
    let log = fs::read_to_string(temp.0.join("ocr-issues.jsonl")).unwrap();
    let record: serde_json::Value = serde_json::from_str(log.trim()).unwrap();
    assert_eq!(record["selectedFrames"][0]["batchId"], 8);
    assert!(record["selectedFrames"][0]["file"].is_null());
    run.phase.store(PHASE_FINISHED, Ordering::Release);
    assert!(!collector.log_ocr_issue(issue()).unwrap());
}

#[test]
fn accepted_ocr_diagnostics_validate_quantities_and_pass_metadata() {
    let temp = TempDir::new("ocr-accepted");
    let collector = DebugRoiSampleCollector::default();
    let mut value = diagnostic_json(&temp.0);
    value["status"] = serde_json::json!("recognized");
    value["reason"] = serde_json::Value::Null;
    value["itemName"] = serde_json::json!("Branch of Abundance");
    value["quantity"] = serde_json::json!(6);
    value["selectedFrames"][0]["centerY"] = serde_json::json!(255);
    value["selectedFrames"][0]["bounds"] =
        serde_json::json!({"left": 100, "right": 320, "top": 240, "bottom": 270});
    value["selectedFrames"][0]["passes"] =
        serde_json::json!([{"threshold":150,"scale":4,"region":"quantity","text":"6"}]);
    assert!(!collector
        .log_ocr_issue(serde_json::from_value(value.clone()).unwrap())
        .unwrap());
    let (sender, _) = mpsc::sync_channel(1);
    let run = Arc::new(test_run(&temp.0, sender, settings()));
    collector.active.store(Some(run.clone()));
    value["source"] = serde_json::json!("normal");
    assert!(collector
        .log_ocr_issue(serde_json::from_value(value.clone()).unwrap())
        .unwrap());
    let written: serde_json::Value = serde_json::from_str(
        fs::read_to_string(temp.0.join("ocr-issues.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    assert_eq!(written["status"], "recognized");
    assert_eq!(written["quantity"], 6);
    assert_eq!(
        written["selectedFrames"][0]["passes"][0]["region"],
        "quantity"
    );
    let mut outside = value.clone();
    outside["selectedFrames"][0]["bounds"]["right"] =
        serde_json::json!(run.normal_pixels.width + 1);
    assert!(collector
        .log_ocr_issue(serde_json::from_value(outside).unwrap())
        .unwrap_err()
        .contains("exceed the collected ROI"));
    for invalid_quantity in [0_u64, 9_007_199_254_740_992] {
        let mut invalid = value.clone();
        invalid["quantity"] = serde_json::json!(invalid_quantity);
        assert!(collector
            .log_ocr_issue(serde_json::from_value(invalid).unwrap())
            .is_err());
    }
    let mut invalid = value.clone();
    invalid["selectedFrames"][0]["bounds"]["right"] = serde_json::json!(99);
    assert!(collector
        .log_ocr_issue(serde_json::from_value(invalid).unwrap())
        .is_err());
    value["selectedFrames"][0]["passes"][0]["scale"] = serde_json::json!(100);
    assert!(collector
        .log_ocr_issue(serde_json::from_value(value).unwrap())
        .is_err());
}
