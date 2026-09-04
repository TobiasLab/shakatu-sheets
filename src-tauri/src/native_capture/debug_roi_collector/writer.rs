use super::*;

pub(super) fn run_worker(run: Arc<Run>, receiver: Receiver<SamplePair>) {
    let mut failure = false;
    loop {
        let lifecycle = run.phase.load(Ordering::Acquire);
        if lifecycle == PHASE_STARTING {
            if Instant::now() >= run.deadline {
                run.request_finish(FINISH_DEADLINE);
            } else {
                thread::sleep(Duration::from_millis(10));
            }
            continue;
        }
        if lifecycle != PHASE_RUNNING {
            break;
        }
        let now = Instant::now();
        if now >= run.deadline {
            run.request_finish(FINISH_DEADLINE);
            break;
        }
        let wait = (run.deadline - now).min(Duration::from_millis(50));
        match receiver.recv_timeout(wait) {
            Ok(pair) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
                if let Err(error) = write_pair(&run, &pair) {
                    record_write_failure(&run, error);
                    failure = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                run.request_finish(FINISH_CAPTURE_ENDED);
                break;
            }
        }
    }

    while !failure && run.queued.load(Ordering::Acquire) != 0 {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(pair) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
                if let Err(error) = write_pair(&run, &pair) {
                    record_write_failure(&run, error);
                    failure = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                record_write_failure(
                    &run,
                    "Debug ROI encoder queue disconnected while draining.".to_string(),
                );
                failure = true;
            }
        }
    }
    if failure {
        discard_queued_pairs(&run, &receiver);
    }
    let terminal_phase = if failure {
        DebugRoiSampleCollectionPhase::Failed
    } else {
        let reason = run
            .requested_finish_reason()
            .and_then(finish_reason)
            .unwrap_or("captureEnded")
            .to_string();
        if let Ok(mut outcome) = run.outcome.lock() {
            outcome.finish_reason = Some(reason);
        }
        DebugRoiSampleCollectionPhase::Finished
    };
    if let Err(error) = write_manifest_for_phase(&run, terminal_phase) {
        fail_run(
            &run,
            format!("Failed to finalize debug ROI manifest: {error}"),
        );
        let _ = write_manifest(&run);
    } else {
        run.phase.store(
            match terminal_phase {
                DebugRoiSampleCollectionPhase::Finished => PHASE_FINISHED,
                DebugRoiSampleCollectionPhase::Failed => PHASE_FAILED,
                _ => unreachable!("worker terminal phase must be finished or failed"),
            },
            Ordering::Release,
        );
    }
}

pub(super) fn record_write_failure(run: &Run, error: String) {
    run.request_finish(FINISH_WRITE_FAILED);
    if let Ok(mut outcome) = run.outcome.lock() {
        outcome.finish_reason = Some("writeFailed".to_string());
        outcome.errors.push(error);
    }
}

pub(super) fn discard_queued_pairs(run: &Run, receiver: &Receiver<SamplePair>) {
    while run.queued.load(Ordering::Acquire) != 0 {
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(_) => {
                run.queued.fetch_sub(1, Ordering::AcqRel);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                run.queued.store(0, Ordering::Release);
            }
        }
    }
}

pub(super) fn write_pair(run: &Run, pair: &SamplePair) -> Result<(), String> {
    let sequence = run.written.load(Ordering::Acquire) + 1;
    let minute = (sequence - 1) / FRAMES_PER_MINUTE + 1;
    let normal_dir = run.path.join("normal").join(format!("minute-{minute:02}"));
    let rare_dir = run.path.join("rare").join(format!("minute-{minute:02}"));
    fs::create_dir_all(&normal_dir)
        .and_then(|_| fs::create_dir_all(&rare_dir))
        .map_err(|error| format!("Failed to create debug ROI minute directories: {error}"))?;

    let file_name = format!("frame-{:010}.png", pair.batch_id);
    let normal_path = normal_dir.join(&file_name);
    let rare_path = rare_dir.join(&file_name);
    let normal_temp = normal_dir.join(format!(".{file_name}.tmp"));
    let rare_temp = rare_dir.join(format!(".{file_name}.tmp"));
    let result = (|| {
        write_png(
            &normal_temp,
            run.normal_pixels.width,
            run.normal_pixels.height,
            &pair.normal_rgba,
        )?;
        write_png(
            &rare_temp,
            run.rare_pixels.width,
            run.rare_pixels.height,
            &pair.rare_rgba,
        )?;
        fs::rename(&normal_temp, &normal_path)
            .map_err(|error| format!("Failed to commit normal debug ROI PNG: {error}"))?;
        if let Err(error) = fs::rename(&rare_temp, &rare_path) {
            let _ = fs::remove_file(&normal_path);
            return Err(format!("Failed to commit rare debug ROI PNG: {error}"));
        }
        let bytes = fs::metadata(&normal_path)
            .and_then(|normal| fs::metadata(&rare_path).map(|rare| normal.len() + rare.len()))
            .map_err(|error| format!("Failed to measure debug ROI PNG pair: {error}"))?;
        run.written.fetch_add(1, Ordering::Relaxed);
        run.bytes_written.fetch_add(bytes, Ordering::Relaxed);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(normal_temp);
        let _ = fs::remove_file(rare_temp);
        let _ = fs::remove_file(normal_path);
        let _ = fs::remove_file(rare_path);
    }
    result
}

pub(super) fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Debug ROI PNG dimensions overflowed.".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "Debug ROI PNG payload has {} bytes; expected {expected}.",
            rgba.len()
        ));
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| format!("Failed to create debug ROI PNG: {error}"))?;
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fastest);
    let mut writer = encoder
        .write_header()
        .map_err(|error| format!("Failed to write debug ROI PNG header: {error}"))?;
    writer
        .write_image_data(rgba)
        .map_err(|error| format!("Failed to encode debug ROI PNG: {error}"))?;
    writer
        .finish()
        .map_err(|error| format!("Failed to finish debug ROI PNG: {error}"))
}

pub(super) fn write_manifest(run: &Run) -> Result<(), String> {
    write_manifest_for_phase(run, phase(run.phase.load(Ordering::Acquire)))
}

pub(super) fn write_manifest_for_phase(
    run: &Run,
    manifest_phase: DebugRoiSampleCollectionPhase,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&run.manifest(manifest_phase))
        .map_err(|error| format!("Failed to serialize debug ROI manifest: {error}"))?;
    atomic_write(&run.path.join("manifest.json"), &bytes)
}

pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    let result = (|| {
        let mut file = File::create(&temp)
            .map_err(|error| format!("Failed to create temporary manifest: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to write temporary manifest: {error}"))?;
        fs::rename(&temp, path)
            .map_err(|error| format!("Failed to commit debug ROI manifest: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
