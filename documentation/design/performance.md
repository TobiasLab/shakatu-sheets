# Capture performance and grind desk verification

Implementation branch: `feat/gpt6astra_test`. Measurements below were taken on 2026-09-04 in the Linux x86_64 development
workspace. They measure particular components, not the game's FPS or the user's hardware.

## Changes

- Request at most 8 FPS from PipeWire for fixed and variable-rate video, without asking it to resize the source.
  Consume every frame from a negotiated bounded-rate producer; use a deadline-based gate when the published rate is
  missing or exceeds the limit. This avoids losing alternate samples to delivery jitter.
- Convert cropped rows in contiguous slices rather than repeatedly checking bounds and matching pixel formats for each
  pixel. RGBA rows copy directly; BGR/RGBx conversion preserves channel and alpha semantics and source padding.
- Disable preview conversion, transport, and painting outside visible setup. One metadata preview still reports the
  initial source or changed dimensions. A hidden stream with no selection cannot create an empty pending batch.
- Keep the capture controller alive across page changes. Stop and release it on Finish, explicit Stop, or application
  unmount. Suppress clock/diagnostic UI timers while hidden; retain timestamp-based elapsed time.
- Resize OCR canvases only when dimensions change. Preserve the existing single serialized worker, tracking profiles,
  three-frame consensus, bounded queues, retries, and recognition failure reporting.
- Separate Rust capture commands, geometry, lifecycle, PipeWire processing, encoding, diagnostics, and debug writing.
  Persistence and Garmoth already have cohesive feature modules and ordinary testable functions; their storage and
  integration semantics were retained. No database migration, new production dependency, or command protocol change.

## Measured results

| Check | Result |
| --- | --- |
| Release crop microbenchmark, 1,000 BGRx crops of 453×389 from a 3440×1440 buffer | Scalar reference: 777.82 ms; row conversion: 99.50 ms; **7.82× faster** |
| Earlier run of the same benchmark | 789.60 ms / 87.99 ms; **8.97× faster** |
| Existing recorded end-to-end recognition benchmark | Development: 24/24; held-out test: 11/11; no missed, invented, wrong, or withheld events |
| Frontend unit tests | 172 passed |
| Rust unit tests | 73 passed; timing benchmark ignored by default and run separately |
| Browser interaction checks | Timer transitions, no timer-triggered saves, navigation and minimized preview suppression, continued frame acknowledgments, late-frame rejection after Finish, manual entry, themes, minimum width |
| Static checks | Biome, TypeScript/production build, Rust formatting, Clippy with warnings denied |
| Linux packaging | AppImage builds successfully |

The scalar reference uses the former per-pixel offset/conversion approach. This is an isolated conversion comparison;
it does not include compositor cost, OCR, the webview, or game rendering. Reproduce it with:

```sh
cd src-tauri
cargo test --release benchmark_crop_conversion -- --ignored --nocapture
```

Recognition replay uses the existing local labeled native-resolution recording and the production tracker/OCR parsers.
The held-out set is small and does not establish accuracy across new layouts, rare-banner scenes, or live scheduling.
No detector/consensus tuning was performed against held-out labels.

Browser tests use synthetic Tauri responses and blank transient frames. `UI_SMOKE_SOAK_SECONDS=30 npm run test:ui`
adds sustained delivery, not a real-game memory or OCR-load test. Before/after UI screenshots are generated outside Git;
see the development guide for reproduction. There is no claim of a measured whole-application CPU/memory reduction.

## Real-game acceptance run still required

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

Actual BDO FPS, native desktop capture under the user's compositor, long-running gameplay resource use, and Windows
runtime behavior have **not** been verified in this workspace. Only the Linux Rust target is installed. Keep Windows
and Linux live-capture smoke tests as release acceptance work. No worker migration or further OCR algorithm changes
were made without representative evidence of a main-thread bottleneck and replay validation.
