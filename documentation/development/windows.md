# Windows support

Windows 10 (version 1809 or later) and Windows 11 x64 with SDR and BDO in borderless mode are intended capture targets.
Select either a monitor or the borderless BDO window in the Windows source picker. The affected Windows 10 user
confirmed capture works with revision `wgc-ui-2`; broader native validation remains required on both OS versions.
Bordered windows, exclusive
fullscreen, HDR, ARM64, and capture of protected content are outside the release target.

The implementation is ready for native validation, **not verified Windows release support**. This Linux workspace can
build the complete Windows executable and check shared behavior, but cannot run D3D11, WebView2, the picker, or BDO.
The six requested resolution/scale combinations remain native acceptance targets. Recognition is enabled at
3440×1440 and 2560×1440 with 80% and 100% BDO UI scale; 1920×1080 remains preview-only. The 80% calibration comes from
3440×1440, and the 100% geometry is derived from it pending genuine 100% gameplay validation. Rare detection remains
provisional. See [UI-scale support and evidence](../design/live-loot-ui-scale.md).

## Verification in this workspace

| Check | Result |
| --- | --- |
| Biome, TypeScript/production frontend build | Passed |
| Frontend and benchmark unit tests | 357 passed, including real FFmpeg decoding on 2026-09-09 |
| Linux Rust tests | 83 passed, one opt-in timing benchmark ignored on 2026-09-09 |
| Linux Rust formatting and debug/release Clippy, warnings denied | Passed |
| Final Linux AppImage | Built successfully |
| Browser UI fixtures, Linux and Windows capabilities | Passed; each acknowledged 240 synthetic frames in 30 seconds. Windows compact layout checked at 640/700px. |
| Full Windows debug/release code and test targets | Cross-target Clippy passed with all targets/features and warnings denied on 2026-09-09, including debug ROI collection and the native capture regression fixture. Windows tests were compiled, not executed. |
| Full Windows executable | Cross-compiled successfully on Ubuntu on 2026-09-09 with cargo-xwin 0.23.1 and LLVM 18. Verified as a 29 MiB x86-64 Windows GUI executable; linker warnings concern missing Microsoft CRT debug-symbol files (LNK4099). |
| NSIS, installed WebView2, BDO and signing | Not run; Windows runtime validation and signing remain pending. |

## Native development

Use the pinned Node version in `.node-version` and Rust version in `rust-toolchain.toml`. Install Visual Studio 2022
Build Tools with **Desktop development with C++**, MSVC x64 tools, a Windows SDK, and CMake. Use the Rust
`x86_64-pc-windows-msvc` host toolchain. Install Evergreen WebView2 and Git. FFmpeg is needed for ROI replay and the two
real-decoder tests (those tests report skipped if FFmpeg is absent).

The locked Rustls dependency uses AWS-LC C/assembly code. Install NASM, or explicitly use the dependency's packaged
prebuilt x64 assembly objects for your local build:

```powershell
$env:AWS_LC_SYS_PREBUILT_NASM = '1'
npm ci
npm run tauri dev
```

Run the [normal verification commands](README.md), including release Clippy:

```powershell
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --release --all-targets --all-features -- -D warnings
npm run bundle:windows -- -- --locked
```

No PipeWire, portal, WebKitGTK, system SQLite, or system OpenSSL installation is required on Windows. The Windows-only
`windows` 0.61.3 bindings and `windows-future` 0.2.1 are pinned to match the existing Tauri dependency family. The native
API supplies capture; English Tesseract worker/WASM/model assets remain bundled and local.

## Cross-compiling an executable on Linux

This Ubuntu 24.04 development machine has LLVM/Clang/LLD 18, CMake, Ninja, NASM, cargo-xwin 0.23.1, and the Windows
MSVC Rust target installed. To reproduce the setup on Ubuntu, run:

```sh
sudo apt-get update
sudo apt-get install -y clang llvm lld cmake ninja-build nasm
cargo install cargo-xwin --version 0.23.1 --locked
rustup target add x86_64-pc-windows-msvc
```

From the repository root, build the optimized Windows executable locally:

```sh
XWIN_ARCH=x86_64 npm run tauri -- build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle -- --locked
```

Check the full Windows debug code and test targets without running Windows binaries:

```sh
XWIN_ARCH=x86_64 cargo xwin clippy --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --locked --all-targets --all-features -- -D warnings
```

cargo-xwin downloads Microsoft's Windows SDK and CRT headers/libraries into its user cache on the first build. Its
[installation documentation](https://github.com/rust-cross/cargo-xwin) links the Microsoft SDK license terms.
The resulting executable is `src-tauri/target/x86_64-pc-windows-msvc/release/shakatu-sheets.exe`. This command does not
create an installer, sign the executable, or run GitHub Actions. Windows needs Evergreen WebView2 to run the app;
Windows capture, OCR, and gameplay behavior must still be tested on Windows. The Linux native build command is unchanged.

## Capture and coordinates

`native_capture/windows/mod.rs` opens the system `GraphicsCapturePicker` on the Tauri UI thread, initializes it with the
owning HWND, and cancels pending selection when the capture token changes. `GraphicsCaptureSession::IsSupported` feeds
the frontend capability command. No user-agent sniffing or Windows WebView `getDisplayMedia` path is used.
The OS picker supplies consent and retains its normal capture indicator; policy denial and API failures produce an
error with a restart action. Monitor selection and window selection use the same picker and capture pipeline.

The first user capture test exposed a startup failure after source selection: `windows-core` 0.61 converts a successful
null WinRT interface into `Error::empty()` with HRESULT `S_OK` (`0x00000000`). The frame pool legitimately returns null
when it has no next frame, including when draining the pool after receiving one frame. The backend now treats that
nullable result as an empty pool and continues waiting; a null picker result means cancellation. Real failure HRESULTs,
including `E_POINTER`, still propagate. Regression tests cover both nullable interfaces and real failures; they have
been cross-compiled, not executed on Windows. Error messages now name the failing capture step. The rebuilt executable
has since passed the user-reported Windows 10 retry described below. The application does not require elevation or inject into the game.

A Windows 10 user reported `RPC_E_WRONG_THREAD` (`0x8001010E`) for both monitor and window selection. The initial
candidate marshaled the selected item to a worker, but the user reported the failure persisted. That candidate has
been superseded by capture revision `wgc-ui-2`:

- Picker status, cancellation, and `GetResults` run on the Tauri UI thread. The selected item stays there.
- `windows/session.rs` creates the device, frame pool, and session, configures the session, registers callbacks, and
  calls `StartCapture` on that same UI thread. Thread-local session ownership prevents moving lifecycle objects to
  the worker. Stop queues cleanup on the UI thread; application exit explicitly clears sessions before UI teardown.
- Only the free-threaded pool and D3D device cross to the worker, through `AgileReference`. The worker initializes
  COM, resolves them, and obtains its GPU context there. Pixel processing, pool draining, and resizing remain in the
  background. No D3D immediate-context operations run concurrently on the UI thread.
- Missing cursor control (`E_NOINTERFACE`) keeps the OS cursor behavior; other cursor-setting failures propagate.
  The minimum update interval is best effort: absent interfaces or rejected settings use the shared 16 FPS consumer
  gate, with unexpected rejections logged. Other capture setup failures still propagate. The free-threaded pool
  requires Windows 10 version 1809 or newer; capability probing reports this requirement explicitly.
- Errors name the individual failing operation and include `[wgc-ui-2]`. Startup logs record the actual Windows
  build, capture revision, thread IDs, session setup/cleanup, and first-frame arrival. Logs contain no pixels or
  source/window names.

On 2026-09-09, the user confirmed that revision `wgc-ui-2` restored capture on the affected Windows 10 machine.
This is a user-reported runtime success; the exact Windows build and originally failing operation were not supplied.
It does not establish completion of the full native acceptance matrix. Remaining validation covers monitor and
window selection separately, cancelling/reopening the picker, stop/restart, replacing a pending source, source closure,
and app exit. For any further failures, inspect the complete error or capture log. See the log location below.

The design follows [Microsoft's cross-apartment interface guidance](https://learn.microsoft.com/en-us/windows/win32/com/accessing-interfaces-across-apartments),
the [free-threaded pool contract](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded),
and the [capture snapshot sample](https://github.com/robmikh/Win32CaptureSample/blob/master/Win32CaptureSample/CaptureSnapshot.cpp),
which returns to the originating apartment for session shutdown. Cursor control was added in Windows 10 version 2004;
see the [session API version history](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession).

`windows/capture.rs` uses a free-threaded WGC frame pool with two frames and a single bounded notification slot. It
requests a 62.5 ms minimum update interval; absent or rejected settings use the shared 16 FPS consumer gate.
The worker keeps the latest frame and checks the one-outstanding-batch budget before texture conversion. Actual cadence
and hybrid-GPU cost require hardware measurement.

For an interactive native regression test on Windows 10 version 1903+ or Windows 11, run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked native_ui_session_delivers_frames_to_mta_worker -- --ignored --nocapture
```

This creates its own visible test window, starts a session on an STA thread, marshals the device and frame pool to
an MTA worker, and reads a GPU preview. It exercises the production session registry and guard for normal cleanup,
cancellation before setup, abandoned startup after setup, and app shutdown followed by late guard cleanup. A channel
stands in for Tauri’s UI dispatch queue; actual event-loop teardown and cancellation during `StartCapture` still require
manual testing. It saves no screenshots. It uses the window interop API (introduced in version 1903) to avoid manual picker interaction; picker consent and monitor
selection still require the manual checks above. The ordinary Windows tests cover nullable results, pending/cancelled
selection, preserved failure HRESULTs, absent optional interfaces, and rejected update-interval fallback. These tests
can be compiled here but cannot execute in this Linux workspace.

`windows/frame.rs` copies normal and rare regions from the same source texture into reusable ROI-sized staging textures.
Only those exact native pixels are mapped to the CPU; padded BGRA rows become tightly packed RGBA. A compute shader
reduces visible previews on the GPU to at most 640×360 before readback. Closing setup or minimizing disables repeated
preview work; one bootstrap preview announces a source or changed dimensions. The full source is never read back to CPU.
The version-3 binary protocol, token checks, acknowledgments, bounded OCR queues, and shared English OCR parser are retained.

Coordinates refer to physical pixels within the selected capture item. Windows display scaling and BDO's UI scale are
independent. No desktop origin, monitor DPI multiplier, or virtual-desktop normalization is applied to detector crops.
New Windows sources require fresh region confirmation, even if their dimensions match saved hints. A source resize
recreates the frame pool and GPU resources, stops sample collection, and resets recognition/placement. Switching game UI
scale selects a separate detector geometry; it never scales pixel data into another profile.

The app window is fitted to the current monitor work area at startup and DPI changes, with a 640×420 logical minimum
where space permits. Verify this under mixed DPI, negative monitor origins, taskbars, and monitor removal.

Stop, Finish, session replacement, source closure, device/API failure, and app exit cancel the capture token. First-frame
and missing-ACK timeouts are 10 seconds. Desktop access failure or a long system interruption ends capture and asks for
restart. A static/minimized game source may produce no frames: the visible UI reports waiting, and the next frame after
a gap over two seconds resets temporal recognition so old observations cannot bridge the gap. No global WebView2 GPU
or background-throttling flags are set. Minimized sustained OCR and Windows lock/resume behavior are native release gates.

## Persistence, samples, and diagnostics

Normal data uses `%APPDATA%\io.github.shakatusheets\shakatu-sheets.sqlite3`, resolved through Windows known folders,
with inherited current-user ACLs. Schema and identifier are unchanged. A controlled test may set the absolute
`SHAKATU_DATA_DIR` environment variable to isolate SQLite/settings; never point a smoke run at an existing user database.
Installed smoke also sets `WEBVIEW2_USER_DATA_FOLDER` to its temporary directory. Changing `APPDATA` alone does not redirect
Windows known-folder APIs. Window close stops capture and flushes ordered session saves, retrying the newest failed
snapshot; a persistent save failure keeps the window open with an error. Forced process termination cannot flush JS work.

Debug builds retain the opt-in 30-minute paired ROI collector at the repository's ignored `dev-samples/live-loot` path.
Its token/revision checks, bounded writer, stop reasons, native PNGs, and manifests also apply on Windows. The manifest
file handle is closed before rename. Release builds omit the collector commands. Samples are never automatically uploaded.

Replay uses enumerated PNG files piped into FFmpeg, avoiding Windows builds' missing glob support:

```powershell
npm run benchmark:loot:roi -- 'C:\path with spaces\dev-samples\live-loot' --ocr
npm run benchmark:loot:roi -- 'C:\path with spaces\dev-samples\live-loot' --validation --ocr
```

Windows writes capture startup/error records to `%LOCALAPPDATA%\io.github.shakatusheets\logs\capture.log`, rotating at
1 MiB with one previous file. Set `SHAKATU_CAPTURE_DIAGNOSTICS=1` only when measuring to additionally record aggregate
frame counters. Records contain no pixels or window names. Packing time includes GPU copy/readback wait and CPU packing; it is not an isolated GPU timing.
See [the game-impact protocol](../design/performance.md) for measurements with diagnostics disabled too.

## Local builds and optional packaging

`tauri.windows.conf.json` creates a per-user NSIS installer and downloads the Evergreen WebView2 bootstrapper if needed.
Existing WebView2 permits offline app use; a fresh machine without the runtime needs a connection during installation.
Development builds and checks run locally; no GitHub Actions workflow is configured. For an optimized executable
without an installer, run `npm run tauri -- build --no-bundle -- --locked` from the repository root. The result is
`src-tauri/target/release/shakatu-sheets.exe`. Use `npm run tauri dev` for debug builds and ROI sample collection.

Installer creation is optional during development: `npm run bundle:windows -- -- --locked` builds an unsigned NSIS
installer under `src-tauri/target/release/bundle/nsis`. Local development builds do not require a signing certificate.
Run the frontend and Rust checks above on each target OS; validate BDO capture, DPI transitions, minimized OCR, and
gameplay impact on the actual Windows machine using the protocol below.

For an installed local smoke run, install `tauri-driver` 2.0.5, run `scripts/install-edge-driver.ps1`, set
`DESKTOP_SMOKE_BINARY` to the installed executable, and run `npm run test:desktop`. It uses a new temporary database,
checks startup, bundled OCR asset retrieval, a real SQLite ledger save/reload, navigation, and compact layout. Asset retrieval does not establish OCR
worker/WASM execution; the offline import and live recognition tests below are still mandatory.

For a public release, provide a code-signing certificate with an accessible private key in the current-user certificate
store and set `SHAKATU_CERTIFICATE_THUMBPRINT`. Run `scripts/bundle-windows-release.ps1` on Windows. It builds locally with
SHA-256 and an RFC3161 timestamp, then verifies executable and installer signatures. It does not publish. Signing setup,
native Windows execution/testing, clean-user install, upgrades, uninstall/data retention, and SmartScreen behavior are unverified here.

## Release gates

Record OS build, GPU/driver, CPU, monitor topology, display DPI, game mode/resolution/UI scale, app revision, and WebView2
version for every hardware run. Use a release build for performance and a debug build only for sample acquisition.

| Area | Required acceptance evidence |
| --- | --- |
| Native sources | Monitor and borderless BDO window each yield correct SDR colors/native dimensions; cancel/deny, stop during picker, rapid source replacement, repeated start/stop, closed game, and app exit release capture without stale insertions. |
| Geometry | At 100/125/150/200% Windows scaling, previews and crops identify the same physical pixels. Move between mixed-DPI monitors, including a negative origin; resize/reselect, disconnect the selected monitor, and confirm placement resets. Compact settings/review controls remain reachable. |
| Background lifecycle | Thirty-minute BDO run with setup open/closed, History/Settings navigation, app covered/minimized, game minimized/restored, lock/unlock, and suspend/resume. No ACK stall, duplicate insertion, stale OCR, leaked session, or growing queue; errors permit explicit restart. |
| OCR offline | Disconnect networking after installation. Marni import runs the bundled worker/WASM/model and produces its reviewed result; live normal/rare recognition uses identical pixels, dictionaries, thresholds, and quantities on Linux and Windows. |
| Accuracy | For **1920×1080, 2560×1440, 3440×1440 × 80%, 100%**, collect labeled native normal/rare runs with positive and negative scenes, moving backgrounds, overlapping/identical drops, repeated identical banners, and placement changes. Tune only development data; freeze gates before a separate positive held-out run. All reviewed release events must match item/quantity with no misses, inventions, or duplicates. Preserve existing Linux regression results. |
| Gameplay impact | Repeat game-only, app idle, capture setup, recognition visible/hidden/minimized comparisons. At most 5% degradation in average FPS **and** 1% lows; bounded queue/memory and native cadence near 16 FPS under changing content. Confirm ROI-only IPC/readback with preview off. |
| Samples | Record a complete 30-minute paired run, explicit early stop, source resize/replacement, unwritable path, and queue-pressure stop. Manifests/PNG batch IDs match, stopping drains admitted pairs, and Windows replay agrees with Linux. No collector API in release. |
| Data/installer | Clean standard user, Unicode/spaces in profile path, runtime present/absent, offline runtime-present install; upgrade with data, close immediately after ledger edit, forced termination/reopen, SQLite error/retry, and uninstall/reinstall data retention. Check signed public artifacts. |

The 3440×1440 and 2560×1440 profiles share normal and rare OCR settings at each UI scale because their native ROI pixel
geometry is the same. Add distinct settings in `src/recognition/liveLootProfiles.ts` only when that geometry changes.
OCR at 1920×1080 remains unavailable pending calibration. Reusing settings does not establish measured gameplay accuracy;
this repository has no labeled Windows corpus for the hardware acceptance checks above.

Manual placement is the default. **Adjust automatically** searches the selected normal or rare area using the same
800×600 native capture on both platforms at all three resolutions with 80% or 100% BDO UI scale. Normal search returns
a 362×311 or 453×389 crop; rare search returns a 400×100 or 500×125 crop for user confirmation. Rare search and the new
100% geometry need real-game acceptance with positive banners and negative scenes.

References: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
[Windows installers](https://v2.tauri.app/distribute/windows-installer/),
[code signing](https://v2.tauri.app/distribute/sign/windows/),
[WebDriver](https://v2.tauri.app/develop/tests/webdriver/),
[WGC minimum interval](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval),
[AWS-LC Windows assembly requirements](https://github.com/aws/aws-lc-rs/blob/main/aws-lc-rs/README.md).
