# Development

Install dependencies and run the desktop application:

Linux builds require the PipeWire development headers (`libpipewire-0.3-dev` on Debian/Ubuntu or `pipewire-devel` on
Fedora) and Clang for the Rust PipeWire bindings' generated FFI.

The offline live-loot video benchmark additionally requires FFmpeg. Benchmark videos and generated frames must not be
committed. Development builds can write five-minute normal and rare ROI samples under the ignored
`dev-samples/live-loot/` directory.

```sh
npm install
npm run tauri dev
```

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
isolation, manual entry, themes, and minimum window width. Screenshots go to `/tmp/shakatu-ui`; set `UI_SMOKE_OUTPUT` to
choose another directory. `UI_SMOKE_URL` overrides the default Vite URL. The browser fixture does not validate the real
PipeWire portal, the installed webview, Garmoth, or the game's FPS.

Set `UI_SMOKE_SOAK_SECONDS=30` when running `npm run test:ui` to exercise sustained synthetic frame delivery. This is
separate from the real-game 30-minute resource/recognition acceptance run.
