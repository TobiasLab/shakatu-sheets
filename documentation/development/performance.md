# Capture performance verification

Offline OCR replay and browser fixtures do not measure gameplay cost. Use this protocol for native release acceptance;
see the [Windows validation checklist](windows.md#validation-checklist) for platform-specific checks.

## Game-impact protocol

Use a release build and the same game location, route, graphics settings, monitor resolution, and FPS limit. Record GPU,
CPU, driver, compositor, UI scale, application build, and the selected capture source. Let the scene settle, then make
three repeated 60-second runs of each condition; compare frame-time captures, not only an instantaneous FPS counter.

| Condition | Purpose |
| --- | --- |
| Game only | Reference average FPS, 1% lows, frame-time distribution |
| App idle / timer only | Separate window and presentation cost |
| Capture setup, recognition inactive | Separate source capture/preview cost; use an unconfirmed manual placement |
| Full recognition, setup open | Combined pipeline cost |
| Full recognition, setup closed | Normal-use cost without previews |
| Full recognition, minimized | Background tracking cost |

Record app CPU and resident memory, available GPU utilization, sampled rate, IPC volume, analysis/OCR duration, queue
peaks, and dropped notifications. Native profiling is opt-in through `SHAKATU_CAPTURE_DIAGNOSTICS=1`; it prints aggregate
source/sample rates, IPC MB/s, packing/sending times, and backpressure skips every five seconds. Frontend analysis and
OCR timings publish while Advanced diagnostics is visible. Run the normal-use comparisons with diagnostics closed and
native profiling disabled as well. No screenshot or gameplay pixels are logged by these diagnostics.

Target: at most 5% loss in both average FPS and 1% lows versus the game-only reference, without a recognition regression.
Follow with a 30-minute grind containing normal stacks and rare banners; inspect queue growth, memory after stopping,
missed/duplicate loot, and source/placement changes. If the negotiated stream cannot provide the intended native
resolution/cadence on a particular portal/compositor, investigate its negotiation before treating this target as met.

Native Windows gameplay, hybrid-GPU readback, minimized WebView2 throughput, and BDO frame times require hardware
validation. Cross-compilation and synthetic browser fixtures do not establish those results.

## Focused measurements

Run the isolated Rust crop-conversion benchmark with:

```sh
cd src-tauri
cargo test --release benchmark_crop_conversion -- --ignored --nocapture
```

From the repository root, measure silver formatting and exercise overlay lifecycle behavior with:

```sh
npm exec vite-node -- scripts/benchmark-session-format.mjs
node scripts/smoke-session-overlay.mjs
```

The overlay smoke requires Chromium listening on port 9222 and starts its own temporary Vite server.
These checks measure isolated conversion/formatting work and synthetic UI behavior, not whole-app CPU, memory, or FPS.
See [development verification](README.md#performance-and-ui-verification) for the full browser smoke setup.
