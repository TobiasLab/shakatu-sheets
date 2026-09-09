use super::*;
use crate::native_capture::{control::CaptureStateInner, windows::frame::Gpu};
use windows::{
    core::{factory, w, Interface},
    Win32::{
        Foundation::{E_ACCESSDENIED, E_POINTER, HWND, RPC_E_WRONG_THREAD},
        Graphics::Direct3D11::ID3D11Texture2D,
        System::WinRT::{
            Direct3D11::IDirect3DDxgiInterfaceAccess,
            Graphics::Capture::IGraphicsCaptureItemInterop, RoInitialize, RoUninitialize,
            RO_INIT_SINGLETHREADED,
        },
        UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, TranslateMessage,
            CW_USEDEFAULT, MSG, PM_REMOVE, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        },
    },
};

#[test]
fn windows_10_optional_interfaces_do_not_block_capture() {
    assert!(optional_setting(Ok(())).unwrap());
    assert!(!optional_setting(Err(windows::core::Error::from_hresult(E_NOINTERFACE))).unwrap());
    for code in [E_ACCESSDENIED, E_POINTER, RPC_E_WRONG_THREAD] {
        assert_eq!(
            optional_setting(Err(windows::core::Error::from_hresult(code)))
                .unwrap_err()
                .code(),
            code
        );
    }
}

#[test]
fn rejected_update_interval_uses_consumer_throttling() {
    assert!(update_interval_supported(Ok(())));
    for code in [E_NOINTERFACE, E_ACCESSDENIED, E_POINTER, RPC_E_WRONG_THREAD] {
        assert!(!update_interval_supported(Err(
            windows::core::Error::from_hresult(code)
        )));
    }
}

struct TestWindow(HWND);
impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}
struct Sta;
impl Drop for Sta {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

// Uses only a window created by this test. No screenshots are saved. This
// validates actual WGC/COM/D3D behavior that a Linux cross-compile cannot test.
#[test]
#[ignore = "requires an interactive Windows desktop and D3D11"]
fn native_ui_session_delivers_frames_to_mta_worker() {
    // Use a fresh thread so another Rust test cannot determine its apartment.
    std::thread::spawn(|| {
        unsafe {
            RoInitialize(RO_INIT_SINGLETHREADED).unwrap();
        }
        let _sta = Sta;
        let window = TestWindow(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("Shakatu capture test"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                640,
                480,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        });
        let factory = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().unwrap();
        let mut state = CaptureStateInner::default();
        let (cleanup, cleanups) = mpsc::channel();
        let (cancelled, _) = state.install_capture(1, None).unwrap();
        cancelled.cancelled.store(true, Ordering::Release);
        let item = unsafe { factory.CreateForWindow(window.0).unwrap() };
        assert!(start(
            item,
            |_| panic!("cancelled startup registered cleanup"),
            &cancelled
        )
        .is_err());
        SESSIONS.with(|sessions| assert!(sessions.borrow().is_empty()));

        // Exercise normal worker completion, abandoned startup, and app shutdown
        // with a late guard. The channel substitutes only for Tauri's UI queue.
        for token in 2..=4 {
            let item = unsafe { factory.CreateForWindow(window.0).unwrap() };
            let (control, _) = state.install_capture(token, None).unwrap();
            let cleanup = cleanup.clone();
            let prepared = start(item, move |id| cleanup.send(id).unwrap(), &control).unwrap();
            SESSIONS.with(|sessions| assert!(sessions.borrow().contains_key(&control.capture_id)));
            if token == 3 {
                control.cancelled.store(true, Ordering::Release);
                std::thread::spawn(move || drop(prepared)).join().unwrap();
                close(
                    cleanups
                        .recv_timeout(std::time::Duration::from_secs(1))
                        .unwrap(),
                );
                SESSIONS.with(|sessions| assert!(sessions.borrow().is_empty()));
                continue;
            }
            let (sender, receiver) = mpsc::sync_channel(1);
            let worker = std::thread::spawn(move || {
                let PreparedCapture {
                    device,
                    source,
                    session,
                } = prepared;
                let result = read_preview(device, source);
                let _ = sender.send(result);
                session
            });
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            let result = loop {
                let mut message = MSG::default();
                unsafe {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                    Ok(result) => break result,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        panic!("capture worker disconnected")
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => assert!(
                        std::time::Instant::now() < deadline,
                        "capture worker timed out"
                    ),
                }
            };
            let guard = worker.join().unwrap();
            result.unwrap();
            if token == 4 {
                shutdown();
                SESSIONS.with(|sessions| assert!(sessions.borrow().is_empty()));
            }
            std::thread::spawn(move || drop(guard)).join().unwrap();
            let capture_id = cleanups
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
            assert_eq!(capture_id, control.capture_id);
            close(capture_id);
            SESSIONS.with(|sessions| assert!(sessions.borrow().is_empty()));
            assert!(cleanups.try_recv().is_err());
        }
    })
    .join()
    .unwrap();
}

fn read_preview(
    device: AgileReference<IDirect3DDevice>,
    source: FrameSource,
) -> Result<(), String> {
    let _apartment = super::super::Apartment::enter()?;
    let device = device.resolve().map_err(|e| e.to_string())?;
    let mut gpu = Gpu::from_winrt(device)?;
    let pool = source.pool.resolve().map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let _ = source
            .receiver
            .recv_timeout(std::time::Duration::from_millis(20));
        if let Some(frame) =
            super::super::nullable_result(pool.TryGetNextFrame()).map_err(|e| e.to_string())?
        {
            let result = (|| {
                let size = frame.ContentSize().map_err(|e| e.to_string())?;
                let surface = frame.Surface().map_err(|e| e.to_string())?;
                let access: IDirect3DDxgiInterfaceAccess =
                    surface.cast().map_err(|e| e.to_string())?;
                let texture: ID3D11Texture2D =
                    unsafe { access.GetInterface() }.map_err(|e| e.to_string())?;
                let preview = gpu.preview(
                    &texture,
                    size.Width as u32,
                    size.Height as u32,
                    crate::native_capture::protocol::BatchIdentity {
                        capture_id: 1,
                        batch_id: 1,
                    },
                )?;
                assert!(preview.len() > crate::native_capture::protocol::FRAME_HEADER_BYTES);
                Ok(())
            })();
            let _ = frame.Close();
            return result;
        }
        if std::time::Instant::now() >= deadline {
            return Err("No captured frame within 10 seconds".into());
        }
    }
}
