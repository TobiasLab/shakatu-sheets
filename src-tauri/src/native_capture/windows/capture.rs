use super::{capture_error, frame::Gpu, nullable_result, Apartment};
#[cfg(debug_assertions)]
use crate::native_capture::debug_roi_collector::{
    DebugRoiSampleCollector, SampledRoiPair, SOURCE_MISMATCH,
};
use crate::native_capture::{control::*, protocol::*, NativeCaptureSelection};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant, SystemTime};
use tauri::ipc::{Channel, InvokeResponseBody};
use windows::{
    core::{IInspectable, Interface},
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{Capture::*, DirectX::DirectXPixelFormat},
    Win32::{
        Graphics::Direct3D11::{ID3D11Texture2D, D3D11_TEXTURE2D_DESC},
        System::{
            StationsAndDesktops::{
                CloseDesktop, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
            },
            WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess,
        },
    },
};

struct Resources {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrival: Option<i64>,
    closed: Option<i64>,
}
impl Drop for Resources {
    fn drop(&mut self) {
        if let Some(token) = self.arrival {
            let _ = self.pool.RemoveFrameArrived(token);
        }
        if let Some(token) = self.closed {
            let _ = self.item.RemoveClosed(token);
        }
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}
struct Frame(Direct3D11CaptureFrame);
impl Drop for Frame {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

pub(super) fn run(
    item: GraphicsCaptureItem,
    frames: &Channel<InvokeResponseBody>,
    control: &Arc<CaptureControl>,
    #[cfg(debug_assertions)] collector: &DebugRoiSampleCollector,
) -> Result<(), String> {
    let _apartment = Apartment::enter()?;
    let mut gpu = Gpu::new()?;
    let mut size = item
        .Size()
        .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err("The selected capture source is empty.".into());
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &gpu.winrt,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )
    .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
    let session = match pool.CreateCaptureSession(&item) {
        Ok(session) => session,
        Err(error) => {
            let _ = pool.Close();
            return Err(capture_error("acquiring capture frames", error));
        }
    };
    let mut resources = Resources {
        item,
        pool,
        session,
        arrival: None,
        closed: None,
    };
    resources
        .session
        .SetIsCursorCaptureEnabled(false)
        .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
    // Interface probing permits older Windows versions without making them release targets.
    let producer_limited = resources
        .session
        .SetMinUpdateInterval(TimeSpan {
            Duration: 1_250_000,
        })
        .is_ok();
    let (wake, receiver) = mpsc::sync_channel(1);
    resources.arrival = Some(
        resources
            .pool
            .FrameArrived(
                &TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |_, _| {
                    let _ = wake.try_send(());
                    Ok(())
                }),
            )
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?,
    );
    let closed = Arc::new(AtomicBool::new(false));
    let closed_callback = closed.clone();
    resources.closed = Some(
        resources
            .item
            .Closed(
                &TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                    closed_callback.store(true, Ordering::Release);
                    Ok(())
                }),
            )
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?,
    );
    if control.cancelled.load(Ordering::Acquire) {
        return Ok(());
    }
    resources
        .session
        .StartCapture()
        .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
    let started = Instant::now();
    let mut last_clock = SystemTime::now();
    let mut last_desktop_check = Instant::now();
    let mut received = false;
    let mut published = None;
    let mut next_sample = None;
    let mut diagnostics = crate::native_capture::diagnostics::CaptureDiagnostics::from_env();
    loop {
        if control.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        if closed.load(Ordering::Acquire) {
            return Err("The selected capture source closed. Select a source to restart.".into());
        }
        let wall = SystemTime::now();
        if wall
            .duration_since(last_clock)
            .is_ok_and(|gap| gap > Duration::from_secs(5))
        {
            return Err(
                "Capture stopped after a system interruption. Select a source to restart.".into(),
            );
        }
        last_clock = wall;
        if last_desktop_check.elapsed() >= Duration::from_secs(1) {
            last_desktop_check = Instant::now();
            let desktop =
                unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) }
                    .map_err(|_| {
                    "The desktop is locked or unavailable. Unlock it and restart capture."
                        .to_string()
                })?;
            unsafe {
                let _ = CloseDesktop(desktop);
            }
        }
        if control
            .pending_batch_age()?
            .is_some_and(|age| age >= FRAME_ACK_TIMEOUT)
        {
            return Err("The frontend did not acknowledge a capture batch within 10 seconds. Restart capture.".into());
        }
        if !received && started.elapsed() >= FIRST_FRAME_TIMEOUT {
            return Err("The selected source did not produce a frame within 10 seconds. Try a monitor with BDO in borderless mode.".into());
        }
        let _ = receiver.recv_timeout(Duration::from_millis(50));
        // Keep only the latest of the two pool frames. Notifications contain no pixels.
        let mut latest = None;
        for _ in 0..2 {
            match nullable_result(resources.pool.TryGetNextFrame()) {
                Ok(Some(frame)) => {
                    latest = Some(Frame(frame));
                    if let Some(metrics) = diagnostics.as_mut() {
                        metrics.source_frame();
                    }
                }
                Ok(None) => break,
                Err(error) => return Err(capture_error("acquiring capture frames", error)),
            }
        }
        let Some(frame) = latest else { continue };
        received = true;
        let content = frame
            .0
            .ContentSize()
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
        if content.Width <= 0 || content.Height <= 0 {
            continue;
        }
        if content != size {
            drop(frame);
            gpu.reset();
            resources
                .pool
                .Recreate(
                    &gpu.winrt,
                    DirectXPixelFormat::B8G8R8A8UIntNormalized,
                    2,
                    content,
                )
                .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
            size = content;
            published = None;
            next_sample = None;
            #[cfg(debug_assertions)]
            {
                control.healthy.store(false, Ordering::Release);
                collector.finish_capture(control.capture_id, SOURCE_MISMATCH);
            }
            continue;
        }
        let now = Instant::now();
        if !producer_limited && !sample_due(next_sample, now) {
            continue;
        }
        let (width, height) = (content.Width as u32, content.Height as u32);
        let configured = *control
            .selection
            .lock()
            .map_err(|_| "Capture selection is unavailable.")?;
        let selection = selection_for_source(configured, width, height)?;
        #[cfg(debug_assertions)]
        {
            *control
                .source_dimensions
                .lock()
                .map_err(|_| "Capture dimensions are unavailable.")? = Some((width, height));
            control.healthy.store(true, Ordering::Release);
            if configured.is_some() && selection.is_none() {
                collector.finish_capture(control.capture_id, SOURCE_MISMATCH);
            }
        }
        let preview =
            control.preview_enabled.load(Ordering::Acquire) || published != Some((width, height));
        let Some((batch_id, send_preview)) = control.begin_batch(selection, preview)? else {
            if let Some(metrics) = diagnostics.as_mut() {
                metrics.blocked();
            }
            continue;
        };
        let batch = BatchIdentity {
            capture_id: control.capture_id,
            batch_id,
        };
        let packing = Instant::now();
        let surface = frame
            .0
            .Surface()
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }
            .map_err(|e| capture_error("configuring or reading the capture stream", e))?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            texture.GetDesc(&mut desc);
        }
        if (desc.Width, desc.Height) != (width, height) {
            return Err("Capture texture dimensions do not match the source.".into());
        }
        let preview = if send_preview {
            Some(gpu.preview(&texture, width, height, batch)?)
        } else {
            None
        };
        let mut normal = None;
        let mut rare = None;
        let mut search = None;
        let header = |kind, region: crate::native_capture::geometry::PixelRegion| FrameHeader {
            kind,
            batch,
            output_width: region.width,
            output_height: region.height,
            source_width: width,
            source_height: height,
            crop_x: region.x,
            crop_y: region.y,
        };
        match selection {
            Some(selection @ NativeCaptureSelection::Search { .. }) => {
                let region = selection.search_pixel_region()?;
                search = Some(gpu.crop(
                    &texture,
                    region,
                    header(FRAME_KIND_SEARCH_REGION, region),
                    0,
                )?);
            }
            Some(NativeCaptureSelection::Regions { settings }) => {
                let region = settings.pixel_region()?;
                normal = Some(gpu.crop(&texture, region, header(FRAME_KIND_REGION, region), 0)?);
                if let Some(region) = settings.rare_pixel_region()? {
                    rare = Some(gpu.crop(
                        &texture,
                        region,
                        header(FRAME_KIND_RARE_REGION, region),
                        1,
                    )?);
                }
            }
            None => {}
        }
        drop(texture);
        drop(access);
        drop(surface);
        drop(frame);
        #[cfg(debug_assertions)]
        if let (Some(selection), Some(normal), Some(rare)) =
            (selection, normal.as_ref(), rare.as_ref())
        {
            collector.enqueue_pair(SampledRoiPair {
                capture_id: control.capture_id,
                selection,
                source_width: width,
                source_height: height,
                batch_id,
                normal_frame: normal,
                rare_frame: rare,
                payload_offset: FRAME_HEADER_BYTES,
            });
        }
        let packing_duration = packing.elapsed();
        let bytes = [&preview, &normal, &rare, &search]
            .into_iter()
            .flatten()
            .map(Vec::len)
            .sum();
        let sending = Instant::now();
        if control.cancelled.load(Ordering::Acquire) {
            return Ok(());
        }
        for frame in [preview, normal, rare, search].into_iter().flatten() {
            frames
                .send(InvokeResponseBody::Raw(frame))
                .map_err(|_| "The capture window disconnected.")?;
        }
        if let Some(metrics) = diagnostics.as_mut() {
            metrics.sample(bytes, packing_duration, sending.elapsed());
        }
        published = Some((width, height));
        next_sample = Some(next_sample_deadline(next_sample, now));
    }
}
