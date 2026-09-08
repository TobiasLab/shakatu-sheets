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
  unmount. Suppress clock/diagnostic UI timers while hidden, including when setup is closed; retain timestamp-based elapsed time.
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
| Frontend unit tests | 186 passed after detection improvements and review fixes |
| Rust unit tests | 73 passed; timing benchmark ignored by default and run separately |
| Browser interaction checks | Timer transitions, no timer-triggered saves, navigation and minimized preview suppression, continued frame acknowledgments, late-frame rejection after Finish, hidden diagnostics, screenshot-state isolation between sessions, manual entry, themes, minimum width |
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
runtime behavior have **not** been verified in this workspace. The full Windows executable was cross-compiled on Linux on 2026-09-05 using cargo-xwin and LLVM.
That verifies compilation and linking, not Windows runtime behavior or game performance. Keep Windows and Linux live-capture smoke tests as release acceptance work. No worker migration or further OCR algorithm changes
were made without representative evidence of a main-thread bottleneck and replay validation.

## Windows capture implementation

WGC uses two frame-pool buffers, a bounded wake queue, and the same one-outstanding-batch control. D3D11 staging textures
match the exact ROI dimensions; repeated preview work is disabled outside visible setup, and visible previews are reduced
on the GPU before readback. Requesting a 125 ms producer interval is best effort, with an 8 FPS consumer fallback.
GPU/device selection and cross-adapter copies on hybrid systems require actual measurements. Windows aggregate logs
rotate in the app log directory; packing time includes GPU wait/readback, while IPC, analysis, and OCR have separate
measurements. No minimized-WebView2 throughput or BDO frame-time result is claimed. The
[Windows release protocol](../development/windows.md#release-gates) includes both.

## Focused review — 2026-09-08

Branch: `feat/performance-cleanup`, based on `9072db2`. The goal is modest reductions in gameplay overhead and
straightforward maintenance, with no reported performance problem to justify a broad rewrite. Capture, frame delivery,
OCR scheduling, recognition, retries, profiles, replay tools, and their regression tests remain unchanged.

### Review findings

| Area | Finding and decision |
| --- | --- |
| Number formatting | Each silver display constructed an `Intl.NumberFormat`. Reuse two formatters with the same locale, rounding, and compact settings. Implemented and measured below. |
| Session summary | Each clock tick recalculated entry values. Separate entry totals from hourly rates; cache totals by entries while deriving the rate from elapsed time. Existing calculation tests still exercise the shared implementation. |
| Overlay items | Each clock tick re-aggregated and formatted every icon. Extract a memoized drop-list component, keeping clock updates independent of the list. |
| Hidden overlay | Main sent full snapshots after every session/theme change even when hidden. Publish only while shown; visibility lifecycle events trigger native visibility checks and a fresh snapshot on reopening. No polling. Both the close button and native close path notify listeners; presentation ticks explicitly pause when hidden. |
| Other UI and dialogs | Ledger filtering is proportional to recorded entry groups, not every recognition event. Dialogs and settings use local state and explicit actions. No evidence warrants virtualization, global state machinery, or broad component rewrites. |
| History | Loads at most 20 sessions, but reloads after saving and performs per-session queries. Potential follow-up if large histories or live-history use become slow; query/invalidation changes are deferred. |
| Persistence | Saves open/configure a connection, read the existing session, and replace its entries in a transaction. This is a real source of repeated work, but write coalescing or incremental persistence would add ordering and durability complexity. Preserve the queue, transaction, and close-flush guarantees; no database timing or improvement claim. |
| Market and Garmoth | Requests are explicit or tied to configuration changes, rather than recurring gameplay polling. Existing validation, timeouts, and upload serialization are useful. Defer connection/client caching absent measurements showing a problem. |
| Startup and assets | The hidden overlay is created at startup and shares the main entry bundle. On-demand creation or separate entrypoints could reduce startup/module costs, but introduce loading/lifecycle changes. Deferred; no measured whole-app memory benefit. Item images already use local compressed assets. |
| Capture and OCR | Existing bounded queues, preview suppression, and visibility-aware diagnostics are already documented above. Entire pipeline frozen for this pass. Shared capture visibility hooks are also untouched. |
| Timestamp formatting | Keep per-call date formatter construction so runtime system time-zone changes retain existing behavior. No additional cache invalidation mechanism. |
| Cleanup | Split stable entry calculations from time-dependent rates and isolate item rendering. No speculative service layers, dependency changes, or module reorganization. |

### Measurements

Linux x86_64 workspace, Node 22.23.2. Formatting compares the previous function with production `formatSilver`:
median of five samples, each performing 100 passes over a rate plus the synthetic item values, both full and compact.
Outputs are checked for equality before timing.

| Entries | Formatting calls per sample | Previous | Reused formatters |
| --- | --- | --- | --- |
| 0 | 200 | 1.99 ms | 0.076 ms |
| 30 | 6,200 | 64.26 ms | 1.78 ms |
| 300 | 60,200 | 628.96 ms | 16.76 ms |

Run `npm exec vite-node -- scripts/benchmark-session-format.mjs`. These are isolated formatting measurements,
not app CPU percentages, native-webview timings, or game FPS gains.

A headless Chromium harness mounts the real overlay and publisher hook with synthetic sessions and mocked Tauri
window/event APIs. React Strict Mode is enabled. Two timer ticks produced:

| Entries | Previous silver-format calls | Optimized silver-format calls |
| --- | --- | --- |
| 0 | 4 | 4 |
| 30 | 244 | 4 |
| 300 | 2,404 | 4 |

Each hidden session update previously emitted one full state snapshot; it now emits zero once the hide event has
been processed. Timer ticks emit zero snapshots in both versions. This measures eliminated presentation work and
message counts, not IPC throughput or native memory. An already in-flight message can finish while a hide event is
being processed. Native visibility queries occur on lifecycle events, never once per timer tick or hidden update.

Run the focused smoke check with Chromium already listening on port 9222:

```sh
node scripts/smoke-session-overlay.mjs
```

The script starts and closes its own temporary Vite server; it does not edit application files. It checks 0/30/300
items, hidden message suppression, stopped hidden timers, reopen catch-up, theme changes, item removal, pause,
finish/reset display, and the event used by native close. Keep this as one focused integration scenario rather than
many tests coupled to individual hooks. For baseline comparison, point `SESSION_PERF_ROOT` at an untouched copy of
`9072db2` with dependencies available and set `BASELINE=1`; run comparisons sequentially to keep the measured tab visible.

### Test review and validation

Removed six low-value frontend tests:

- Three catalog tests copied names, prices, drop counts, identifiers, and an entire item object from production data.
  Remove the duplicate catalog fixture file. Retain drop-key uniqueness in the existing frontend/backend mapping
  consistency test, which compares independently consumed representations rather than a third hand-maintained catalog.
- One API-wrapper test only checked that `deleteFinishedSession` forwards its ID to `invoke`. Delete the test and
  its unused import; capture protocol tests in the same file are unchanged. Rust deletion and persistence tests remain.
- One empty-overlay aggregation test repeated expense exclusion covered by the mixed-loot aggregation test, plus an
  empty-array case already exercised by the overlay lifecycle smoke. Retain the mixed-price/source aggregation test.
- The newly added formatter test constructed the same `Intl.NumberFormat` options as the implementation. Remove it;
  the reproducible benchmark already checks equivalence with the previous formatter before measuring performance.

Session calculations, state transitions, persistence ordering/failure recovery, export behavior, and all capture/OCR
regressions remain covered. No unrelated scenarios were merged merely to reduce the test count.

The full frontend suite has 337 passing tests; Rust has 81 passing tests and one existing ignored
microbenchmark. Biome, TypeScript/production build, Rust formatting, and Clippy passed. The focused browser lifecycle
smoke passed with mocked native events, including failed-show reporting and retry. The existing full-app UI smoke
also passed (timer transitions, navigation, capture lifecycle, preview suppression, dialogs, ledger editing, history,
themes, and compact layouts). It was run from a temporary copy with mock handlers added for overlay visibility/window
queries; the tracked capture smoke script was not modified. Native dragging, compositor behavior, Windows runtime, game frame times,
and whole-application CPU/memory remain unmeasured. The existing real-game acceptance protocol above still applies.
