# Windows support

Windows 11 x64 is supported and has been tested by users. Windows 10 version 1809 or later is expected to work but has
not been tested yet. Capture targets SDR displays with BDO in borderless mode: select either a monitor or the borderless
BDO window in the Windows source picker. Bordered windows, exclusive fullscreen, HDR, ARM64, and capture of protected
content are not supported. Windows builds are not code-signed yet.

Recognition is enabled at 3440×1440, 2560×1440, and 1920×1080 with 80% and 100% BDO UI scale. The 80% calibration comes
from 3440×1440 recordings, and the 100% geometry is derived from it. There is no labeled Windows gameplay corpus, and
rare detection remains provisional. See [capture profiles and validation limits](../architecture/live-loot.md).

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

Cross-compiling needs LLVM/Clang/LLD, CMake, Ninja, NASM, cargo-xwin 0.23.1, and the Windows MSVC Rust target. On
Ubuntu, install them with:

```sh
sudo apt-get update
sudo apt-get install -y clang llvm lld cmake ninja-build nasm
cargo install cargo-xwin --version 0.23.1 --locked
rustup target add x86_64-pc-windows-msvc
```

From the repository root, build the optimized Windows executable:

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
create an installer or sign the executable. Windows needs Evergreen WebView2 to run the app; Windows capture, OCR, and
gameplay behavior must still be tested on Windows.

## Capture and coordinates

`native_capture/windows/mod.rs` opens the system `GraphicsCapturePicker` on the Tauri UI thread, initializes it with the
owning HWND, and cancels pending selection when the capture token changes. `GraphicsCaptureSession::IsSupported` feeds
the frontend capability command. No user-agent sniffing or Windows WebView `getDisplayMedia` path is used.
The OS picker supplies consent and retains its normal capture indicator; policy denial and API failures produce an
error with a restart action. Monitor selection and window selection use the same picker and capture pipeline. The
application does not require elevation or inject into the game.

`windows-core` 0.61 converts a successful null WinRT interface into `Error::empty()` with HRESULT `S_OK`
(`0x00000000`). The frame pool legitimately returns null when it has no next frame, so the backend treats that result as
an empty pool and keeps waiting, and a null picker result means cancellation. Real failure HRESULTs, including
`E_POINTER`, still propagate.

WinRT capture objects must be used from the apartment that created them; using them from a worker fails with
`RPC_E_WRONG_THREAD` (`0x8001010E`). Capture revision `wgc-ui-2` therefore splits the work by thread:

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
- Windows draws a yellow border around a captured monitor or window. Where `IsBorderRequired` exists (build 20348
  and newer, which includes Windows 11), each capture start awaits `GraphicsCaptureAccess::RequestAccessAsync(Borderless)`
  on the async command thread before opening the picker, and session setup sets `IsBorderRequired(false)`, as OBS
  does. The border is cosmetic, so a denied request or rejected setting is logged and capture continues with the
  border. Windows 10 always shows it.
- Errors name the individual failing operation and include `[wgc-ui-2]`. Startup logs record the actual Windows
  build, capture revision, thread IDs, session setup/cleanup, and first-frame arrival. Logs contain no pixels or
  source/window names. When investigating a failure, read the complete error or the capture log described below.

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
manual testing. It saves no screenshots. It uses the window interop API (introduced in version 1903) to avoid manual
picker interaction; picker consent and monitor selection still require manual checks. The ordinary Windows tests cover
nullable results, pending/cancelled selection, preserved failure HRESULTs, absent optional interfaces, and rejected
update-interval fallback. These tests run only on Windows; Linux can compile them with cargo-xwin.

`windows/frame.rs` copies normal and rare regions from the same source texture into reusable ROI-sized staging textures.
Only those exact native pixels are mapped to the CPU; padded BGRA rows become tightly packed RGBA. A compute shader
reduces visible previews on the GPU to at most 640×360 before readback. Closing setup or minimizing disables repeated
preview work; one bootstrap preview announces a source or changed dimensions. The full source is never read back to CPU.
The version-3 binary protocol, token checks, acknowledgments, bounded OCR queues, and shared English OCR parser are retained.

### Positioning the loot guides

Setup shows draggable green text guides for normal and rare loot. Grabbing inside a guide preserves the pointer offset;
clicking elsewhere centers the selected guide there. Arrow buttons move by one source pixel. The guide matches the actual
native capture area, so it can reach every source edge.
Normal crops are 272×180 at 80% and 341×226 at 100%; rare crops are 340×72 and 425×90.
Text, quantity, and rare banner coordinates are translated to preserve the original recognition pixels.
Saved larger crops are migrated on load, preserving their text placement. Historical ROI recordings retain their original
geometry for replay. Confirm both areas after positioning.

### Importing normal loot placement

Capture setup offers **Import normal loot position**. Select the account-level
`Documents/Black Desert/UserCache/<account>/gamevariable.xml`, with a capture source selected and previews enabled.
The file is read only on request; its contents and path are not saved or uploaded. Confirming the placement saves
only the existing capture-region settings. The same import is available on Linux for a copied settings file.

The Rust parser reads the active `UIData` entry with `Index="159"`, identified by a controlled normal-notification
movement in reference settings snapshots. It ignores saved presets and uses `RelativePosX`/`RelativePosY` as the
saved panel anchor, with the current capture dimensions and calibrated crop size. Both coordinates receive the
text-alignment correction below. Anchored `PosX`/`PosY` are not screen
coordinates; the observed move switched from `RightBottom` to `LeftBottom`. Saved display dimensions are not
used because they differed from the gameplay layout in the reference files. This assumes the captured source covers
the game viewport; a monitor capture with a smaller game window may need manual adjustment.

Only the normal placement moves. Rare placement is preserved, recognition is reset, and the user checks the preview
before confirming. The XML-to-text correction moves the crop right 25 and down 21 source pixels at 80% UI scale. This is
based on a 3440×1440 reference placement: XML produced `(3023, 1073)` and automatic placement produced `(3048, 1094)`,
both 272×180. The corrected import matches that automatic placement at `(3048, 1094)`. The correction scales with BDO UI
scale, not resolution or monitor DPI: right 31 and down 26 pixels at 100% (rounded after multiplying by 1.25).
That 100% correction is extrapolated; other resolutions, moved panels, and actual text alignment still need in-game
validation. The regression test uses the reference `Index="159"` entry
(`RelativePosX="0.9183720946"`, `RelativePosY="0.8078845143"`, `PendingType="RightBottom"`).

Character files without coordinates, hidden or unsaved panels, duplicate active entries, invalid coordinates, unsupported
UI scales, and files over 2 MiB are rejected. The XML scale must match the selected capture scale. Selecting another
source or resizing during the read discards the result.

Coordinates refer to physical pixels within the selected capture item. Windows display scaling and BDO's UI scale are
independent. No desktop origin, monitor DPI multiplier, or virtual-desktop normalization is applied to detector crops.
New Windows sources require fresh region confirmation, even if their dimensions match saved hints. A source resize
recreates the frame pool and GPU resources, stops sample collection, and resets recognition/placement. Switching game UI
scale selects a separate detector geometry; it never scales pixel data into another profile.

The app window is fitted to the current monitor work area at startup and DPI changes, with a 640×420 logical minimum
where space permits. Mixed DPI, negative monitor origins, taskbars, and monitor removal are part of the validation
checklist below.

Stop, Finish, session replacement, source closure, device/API failure, and app exit cancel the capture token. First-frame
and missing-ACK timeouts are 10 seconds. Desktop access failure or a long system interruption ends capture and asks for
restart. A static/minimized game source may produce no frames: the visible UI reports waiting, and the next frame after
a gap over two seconds resets temporal recognition so old observations cannot bridge the gap. No global WebView2 GPU
or background-throttling flags are set.

## Persistence, samples, and diagnostics

Normal data uses `%APPDATA%\io.github.shakatusheets\shakatu-sheets.sqlite3`, resolved through Windows known folders,
with inherited current-user ACLs. A controlled test may set the absolute `SHAKATU_DATA_DIR` environment variable to
isolate SQLite/settings; never point a smoke run at an existing user database. Installed smoke also sets
`WEBVIEW2_USER_DATA_FOLDER` to its temporary directory. Changing `APPDATA` alone does not redirect Windows known-folder
APIs. Window close stops capture and flushes ordered session saves, retrying the newest failed snapshot; a persistent
save failure keeps the window open with an error. Forced process termination cannot flush JS work.

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
frame counters. Records contain no pixels or window names. Packing time includes GPU copy/readback wait and CPU packing;
it is not an isolated GPU timing. See [the game-impact protocol](performance.md) for measurements with diagnostics
disabled too.

## Local builds and packaging

`tauri.windows.conf.json` creates a per-user NSIS installer and downloads the Evergreen WebView2 bootstrapper if needed.
Existing WebView2 permits offline app use; a fresh machine without the runtime needs a connection during installation.
For an optimized executable without an installer, run `npm run tauri -- build --no-bundle -- --locked` from the
repository root. The result is `src-tauri/target/release/shakatu-sheets.exe`. Use `npm run tauri dev` for debug builds
and ROI sample collection.

`npm run bundle:windows -- -- --locked` builds an unsigned NSIS installer under `src-tauri/target/release/bundle/nsis`.
Local builds do not require a signing certificate.

For an installed local smoke run, install `tauri-driver` 2.0.5, run `scripts/install-edge-driver.ps1`, set
`DESKTOP_SMOKE_BINARY` to the installed executable, and run `npm run test:desktop`. It uses a new temporary database,
checks startup, bundled OCR asset retrieval, a real SQLite ledger save/reload, navigation, and compact layout. Asset
retrieval does not establish OCR worker/WASM execution; the offline import and live recognition checks below cover that.

To sign a build, provide a code-signing certificate with an accessible private key in the current-user certificate
store, set `SHAKATU_CERTIFICATE_THUMBPRINT`, and run `scripts/bundle-windows-release.ps1` on Windows. It builds locally
with SHA-256 and an RFC3161 timestamp, then verifies executable and installer signatures. It does not publish. No signing
certificate has been set up for the project yet.

## Validation checklist

Use this checklist when validating Windows capture changes on real hardware. Record OS build, GPU/driver, CPU, monitor
topology, display DPI, game mode/resolution/UI scale, app revision, and WebView2 version for every run. Use a release
build for performance and a debug build only for sample acquisition.

| Area | What to check |
| --- | --- |
| Native sources | Monitor and borderless BDO window each yield correct SDR colors/native dimensions; cancel/deny, stop during picker, rapid source replacement, repeated start/stop, closed game, and app exit release capture without stale insertions. |
| Geometry | At 100/125/150/200% Windows scaling, previews and crops identify the same physical pixels. Move between mixed-DPI monitors, including a negative origin; resize/reselect, disconnect the selected monitor, and confirm placement resets. Compact settings/review controls remain reachable. |
| Background lifecycle | Thirty-minute BDO run with setup open/closed, History/Settings navigation, app covered/minimized, game minimized/restored, lock/unlock, and suspend/resume. No ACK stall, duplicate insertion, stale OCR, leaked session, or growing queue; errors permit explicit restart. |
| OCR offline | Disconnect networking after installation. Marni import runs the bundled worker/WASM/model and produces its reviewed result; live normal/rare recognition uses identical pixels, dictionaries, thresholds, and quantities on Linux and Windows. |
| Accuracy | For **1920×1080, 2560×1440, 3440×1440 × 80%, 100%**, collect labeled native normal/rare runs with positive and negative scenes, moving backgrounds, overlapping/identical drops, repeated identical banners, and placement changes. Tune only development data; freeze gates before a separate positive held-out run. All reviewed events must match item/quantity with no misses, inventions, or duplicates. Preserve existing Linux regression results. |
| Gameplay impact | Repeat game-only, app idle, capture setup, recognition visible/hidden/minimized comparisons. At most 5% degradation in average FPS **and** 1% lows; bounded queue/memory and native cadence near 16 FPS under changing content. Confirm ROI-only IPC/readback with preview off. |
| Samples | Record a complete 30-minute paired run, explicit early stop, source resize/replacement, unwritable path, and queue-pressure stop. Manifests/PNG batch IDs match, stopping drains admitted pairs, and Windows replay agrees with Linux. No collector API in release. |
| Data/installer | Clean standard user, Unicode/spaces in profile path, runtime present/absent, offline runtime-present install; upgrade with data, close immediately after ledger edit, forced termination/reopen, SQLite error/retry, and uninstall/reinstall data retention. |

All three resolutions share normal and rare OCR settings at each UI scale because BDO draws loot at the same native
pixel size for a given UI scale. Add distinct settings in `src/recognition/liveLootProfiles.ts` only when that geometry
changes. Reused settings do not establish measured gameplay accuracy: 1920×1080 has no gameplay recordings yet.

Manual placement is the default. **Adjust automatically** searches the selected normal or rare area using the same
800×600 native capture on both platforms at all three resolutions with 80% or 100% BDO UI scale. Normal search returns
a 272×180 or 341×226 crop; rare search returns a 340×72 or 425×90 crop for user confirmation. Rare search and the 100%
geometry need real-game acceptance with positive banners and negative scenes.

References: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
[Windows installers](https://v2.tauri.app/distribute/windows-installer/),
[code signing](https://v2.tauri.app/distribute/sign/windows/),
[WebDriver](https://v2.tauri.app/develop/tests/webdriver/),
[WGC minimum interval](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.minupdateinterval),
[AWS-LC Windows assembly requirements](https://github.com/aws/aws-lc-rs/blob/main/aws-lc-rs/README.md).
