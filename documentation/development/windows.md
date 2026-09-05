# Windows support

Windows 11 x64 with SDR and BDO in borderless mode is the primary target. Select either a monitor or the borderless
BDO window in the Windows source picker. Windows 10 is an unverified compatibility target. Bordered windows, exclusive
fullscreen, HDR, ARM64, and capture of protected content are outside the release target.

The implementation is ready for native validation, **not verified Windows release support**. This Linux workspace can
build the complete Windows executable and check shared behavior, but cannot run D3D11, WebView2, the picker, or BDO.
The six requested resolution/scale combinations are acceptance targets; only 3440×1440 at 80% currently has a normal
recognition profile. Its rare detector remains provisional. The other five combinations must not be advertised as
supported detection until calibrated and scored. Manual session tracking and screenshot import remain available.

## Verification in this workspace

| Check | Result |
| --- | --- |
| Biome, TypeScript/production frontend build | Passed |
| Frontend and benchmark unit tests | 194 passed, including real FFmpeg decoding |
| Linux Rust tests | 75 passed, one opt-in timing benchmark ignored |
| Linux Rust formatting and debug/release Clippy, warnings denied | Passed |
| Final Linux AppImage | Built successfully |
| Browser UI fixtures, Linux and Windows capabilities | Passed; each acknowledged 240 synthetic frames in 30 seconds. Windows compact layout checked at 640/700px. |
| Full Windows debug code and test targets | Cross-target Clippy passed with all targets/features and warnings denied on 2026-09-05, including debug ROI collection. Windows tests were compiled, not executed. |
| Full Windows executable | Cross-compiled successfully on Ubuntu on 2026-09-05 with cargo-xwin 0.23.1 and LLVM 18. Verified as a 29 MiB x86-64 Windows GUI executable; linker warnings concern missing Microsoft CRT debug-symbol files (LNK4099). |
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
still needs a successful monitor/window capture retry on Windows. The application does not require elevation or inject into the game.

`windows/capture.rs` uses a free-threaded WGC frame pool with two frames and a single bounded notification slot. It
requests a 125 ms minimum update interval when that interface exists; older systems use the shared 8 FPS consumer gate.
The worker keeps the latest frame and checks the one-outstanding-batch budget before texture conversion. Actual cadence
and hybrid-GPU cost require hardware measurement.

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

Debug builds retain the opt-in five-minute paired ROI collector at the repository's ignored `dev-samples/live-loot` path.
Its token/revision checks, bounded writer, stop reasons, native PNGs, and manifests also apply on Windows. The manifest
file handle is closed before rename. Release builds omit the collector commands. Samples are never automatically uploaded.

Replay uses enumerated PNG files piped into FFmpeg, avoiding Windows builds' missing glob support:

```powershell
npm run benchmark:loot:roi -- 'C:\path with spaces\dev-samples\live-loot' --ocr
npm run benchmark:loot:roi -- 'C:\path with spaces\dev-samples\live-loot' --validation --ocr
```

Set `SHAKATU_CAPTURE_DIAGNOSTICS=1` only when measuring. Windows writes aggregate counters under
`%LOCALAPPDATA%\io.github.shakatusheets\logs\capture.log`, rotating at 1 MiB with one previous file. Counters contain no
pixels or window names. Packing time includes GPU copy/readback wait and CPU packing; it is not an isolated GPU timing.
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
| Gameplay impact | Repeat game-only, app idle, capture setup, recognition visible/hidden/minimized comparisons. At most 5% degradation in average FPS **and** 1% lows; bounded queue/memory and native cadence near 8 FPS under changing content. Confirm ROI-only IPC/readback with preview off. |
| Samples | Record a complete five-minute paired run, explicit early stop, source resize/replacement, unwritable path, and queue-pressure stop. Manifests/PNG batch IDs match, stopping drains admitted pairs, and Windows replay agrees with Linux. No collector API in release. |
| Data/installer | Clean standard user, Unicode/spaces in profile path, runtime present/absent, offline runtime-present install; upgrade with data, close immediately after ledger edit, forced termination/reopen, SQLite error/retry, and uninstall/reinstall data retention. Check signed public artifacts. |

Uncalibrated profiles remain unavailable until this evidence exists. Add a distinct normal artifact and rare geometry per
validated combination in `src/recognition/liveLootProfiles.ts`; do not automatically enable the current 3440×1440/80%
localizer on a newly registered profile. This repository has no available labeled Windows corpus to perform that work.

References: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
[Windows installers](https://v2.tauri.app/distribute/windows-installer/),
[code signing](https://v2.tauri.app/distribute/sign/windows/),
[WebDriver](https://v2.tauri.app/develop/tests/webdriver/),
[WGC minimum interval](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval),
[AWS-LC Windows assembly requirements](https://github.com/aws/aws-lc-rs/blob/main/aws-lc-rs/README.md).
