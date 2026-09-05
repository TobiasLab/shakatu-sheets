# Development

Use Node from `.node-version` and Rust from `rust-toolchain.toml`. For native Windows prerequisites, installer commands,
and outstanding validation, see [Windows support](windows.md). Install locked dependencies and run the desktop application:

Linux builds require the PipeWire development headers (`libpipewire-0.3-dev` on Debian/Ubuntu or `pipewire-devel` on
Fedora) and Clang for the Rust PipeWire bindings' generated FFI.

The offline live-loot video benchmark additionally requires FFmpeg. Benchmark videos and generated frames must not be
committed. Development builds can write 30-minute normal and rare ROI samples under the ignored
`dev-samples/live-loot/` directory. Each run also records recognized, withheld, failed, and dropped OCR events in
`ocr-issues.jsonl`. Version 2 records include native frame IDs, exact row/crop bounds, final item quantities, and individual
preprocessing passes when available; see the [capture documentation](../design/live-loot-recognition.md).

```sh
npm ci
npm run tauri dev
```

Development builds and verification run locally. No GitHub Actions workflow is configured.
For an optimized executable without creating an installer, run this from the repository root:

```sh
npm run tauri -- build --no-bundle -- --locked
```

The executable is `src-tauri/target/release/shakatu-sheets.exe` on Windows and
`src-tauri/target/release/shakatu-sheets` on Linux. Use `npm run tauri dev` when collecting debug ROI samples.

To produce a Windows `.exe` on Linux, use the [cross-compilation setup and command](windows.md#cross-compiling-an-executable-on-linux).

Run normal verification:

```sh
npm run check
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Build an AppImage on Arch-derived Linux distributions with:

```sh
npm run bundle:linux -- --bundles appimage
```

The application disables WebKitGTK's DMA-BUF renderer on Linux Wayland to avoid NVIDIA protocol errors. Live monitor
capture uses the XDG ScreenCast portal and PipeWire directly on Linux. Windows is not affected.


## Performance and UI verification

See [the performance report and game-impact protocol](../design/performance.md). Enable native aggregate capture
measurements by launching the release app with `SHAKATU_CAPTURE_DIAGNOSTICS=1`. Native metrics are emitted at most once
every five seconds. For frontend analysis/OCR timing, open capture setup and expand Advanced diagnostics. Close the
panel for normal resource measurements. The debug ROI collector remains opt-in and absent from release builds.

A browser smoke test uses synthetic Tauri responses and does not access the user's database or accounts:

```sh
npm run dev
# In a separate terminal; use your installed Chromium executable.
chromium --headless --remote-debugging-port=9222 --user-data-dir=/tmp/shakatu-ui-browser about:blank
# In another terminal (Node 22+ for the built-in WebSocket client):
node scripts/smoke-loot-ui.mjs
```

The test opens and closes its own tab, verifies navigation/minimization/preview and finish behavior, timer persistence
isolation, manual entry, themes, and minimum window width. Screenshots go to the OS temporary directory under `shakatu-ui`; set `UI_SMOKE_OUTPUT` to
choose another directory. `UI_SMOKE_URL` overrides the default Vite URL. The browser fixture does not validate the real
PipeWire portal, Windows capture, the installed webview, Garmoth, or the game's FPS.

Set `UI_SMOKE_BACKEND=linux` or `windows` and `UI_SMOKE_SOURCE=1920x1080` or `2560x1440` to also verify synthetic
manual startup, explicit normal relocation, rare search/cancellation/confirmation, and the transition to exact ROI capture
at 80% BDO UI scale. Set `UI_SMOKE_SCALE=100` to exercise 100% native search requests, normal/rare crop sizes, and
automatic placement. These are synthetic browser fixtures, not native gameplay validation.

Set `UI_SMOKE_SOAK_SECONDS=30` when running `npm run test:ui` to exercise sustained synthetic frame delivery. This is
separate from the real-game 30-minute resource/recognition acceptance run.


For detection changes, replay developer ROI samples with `npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr`. Add `--validation` for the reserved split. For the refreshed September 5 corpus, pass
`--annotations scripts/fixtures/loot-roi-2026-09-05.json` so the sample directory can remain untouched. See the [ROI replay documentation](../design/live-loot-benchmark.md#roi-sample-replay)
for scoring limits and optional JSON reports. Captured PNGs stay outside tracked source.

Use `UI_SMOKE_BACKEND=windows` for the synthetic Windows capability path and 640/700px compact layout checks (in
PowerShell set `$env:UI_SMOKE_BACKEND = 'windows'`). This remains a browser fixture, not native Windows validation.
