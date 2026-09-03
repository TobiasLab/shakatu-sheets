# Live Loot Recognition Plan

## Status

Linux capture feasibility is established. The first native-resolution offline pipeline tracks events, selects OCR frames,
and recognizes items and quantities exactly on its held-out sequence without label-selected crops. For the validated
3440x1440 80% profile, live capture now searches an `800x600` native-resolution area and automatically locks the exact
`362x311` normal-stack crop after three stable observations. Manual placement remains available. A provisional detector
also recognizes appearances of the fixed gold rare-banner shell in the separately positioned `400x100` crop, delays OCR
until its text is readable, and presents dictionary-constrained results in the review feed. Recognized rare results are
added to the ledger automatically, although the detector has only one calibration event and no held-out sequence.
A browser-safe production module now analyzes packed RGBA crops, tracks notification identities, selects stable OCR frames,
and resolves dictionary-constrained replay readings. Its incremental coordinator bounds retained frames and OCR work,
confirms births with one-frame lookahead, reports backpressure explicitly, and suppresses stale results after cancellation.
The offline benchmark uses the same production detector, tracker, and parsers. Passing held-out E2E runs can atomically
export a strict V1 detector profile containing only validated capture dimensions, UI scale, 8 FPS cadence, and OCR-safe
row geometry. The validated 3440x1440, 80%-UI profile is bundled for live capture. Normal jobs begin after automatic
alignment or manual confirmation, while rare jobs require separate rare-area confirmation. A browser-side adapter
serializes both paths through one local Tesseract worker and sends recognized, withheld, failed, and overflow results to a
bounded review feed. The normal path retains up to eight outstanding OCR jobs, including the active job, so one five-row
appearance burst does not immediately lose events; the lower-volume rare path retains two. Live diagnostics expose current
and peak outstanding job counts plus last and average execution time for the shared OCR worker. Recognized events from both
paths are added to the ledger
immediately; insertion failures remain visible and receive three automatic retries with short backoff before remaining
manually retryable. Live validation and calibrated recognition benchmarks for the additional profiles remain required.

## Goal

Recognize BDO's in-game loot notifications while a session is running and add each new loot event to a reviewable feed.
The feature should remain local, explicit, and external to the game process. It must not inject into BDO, read process
memory, upload frames, or create video recordings.

BDO does not expose a usable local loot log. This feature must not read or modify game files, inspect game memory, hook the
game process, or inspect BDO network traffic. User-authorized operating-system screen capture is the only permitted input.

## Initial Scope

- English BDO client.
- 80% and 100% UI scale capture profiles; only 80% currently has a labeled recognition benchmark.
- Capture sources at `3440x1440`, `2560x1440`, and `1920x1080`, with independently calibrated recognition benchmarks
  required before release.
- Linux Wayland first, followed by Windows using the same browser capture interface where possible.
- Automatically localized normal loot-stack placement for the validated profile, with manual fallback.
- Independently positioned and confirmed rare-banner placement selected by the user, with provisional recognition at 80%
  UI scale.
- User-triggered start, stop, and live-preview pause controls with a persistent capture indicator.
- Borderless-windowed mode as the recommended game display mode.
- The user selects the monitor containing BDO from the operating-system source picker.
- Known grind-spot item names as the recognition dictionary.
- Local processing and persistence of recognized events only.

## Capture

Capture uses a live operating-system screen-sharing stream rather than repeatedly saving screenshots. The app samples
approximately 8 frames per second, creates a bounded full-source preview when previews are enabled, and copies either the
automatic search area or the configured notification rectangles at native resolution into memory.

Windows and browser development use `navigator.mediaDevices.getDisplayMedia` inside the Tauri WebView. The call must come
directly from a user action and requests video without audio. The operating system presents its own source picker and the
user selects the monitor containing BDO. Browser hints cannot restrict the picker reliably or choose a monitor for the
user.

WebKitGTK 2.52 can close the portal session after source selection and then fail `Start` with `Invalid session`. Its
implementation ignores the `SelectSources` response and requests an embedded cursor without checking whether the portal
advertises that mode. Linux therefore performs the same user-authorized XDG ScreenCast portal flow natively, requests one
monitor with a hidden cursor, and consumes the returned PipeWire stream. Sampled RGBA preview frames cross Tauri's local
binary IPC channel and are not persisted. On Linux, the selected normal and rare rectangles are cropped directly from the
same mapped native PipeWire frame before separate typed region frames cross the same versioned channel. During automatic
placement, PipeWire emits the search crop instead of the exact normal and rare crops. Browser capture performs the same
mode-specific crops from the native hidden video frame with canvas while retaining the downscaled preview. Protocol V3
identifies preview, normal, rare, and search frames separately. Frame batches are acknowledged independently to bound
local IPC work until the frontend has consumed every emitted preview and crop in the batch. Pausing live previews stops
the Linux backend from creating or sending full-source preview frames while a valid crop selection is active; native ROI
frames, OCR, diagnostics, and debug sample collection continue. The browser fallback keeps processing ROI frames through
offscreen canvases while visible canvases remain frozen. Native capture forces a preview frame when no selection matches
the source so dimension changes can still be detected and recovered. Selection, preview, and stop commands carry a capture
token so delayed commands from a previous request cannot modify or terminate a newer capture.

Debug Linux builds expose a separate `Save ROI samples for 5 minutes` action after both capture areas are confirmed. It
writes synchronized normal and rare PNG crops at the existing 8 FPS sampling cadence under the repository's ignored
`dev-samples/live-loot/` directory. A bounded background encoder drops and reports pairs when storage cannot keep pace,
rather than delaying capture or recognition. The backend enforces the five-minute deadline and finalizes the run when
capture ends, the source or selection changes, or the user stops collection early. Each run includes source, UI-scale,
crop, timing, count, byte-size, and completion metadata in `manifest.json`; it never includes a full-screen frame.

Platform capture remains behind the same start/stop interface:

- Windows Graphics Capture for a selected monitor.
- `xdg-desktop-portal` ScreenCast with PipeWire on Wayland (implemented for the feasibility slice).
- The portal path on Linux where available instead of compositor-specific capture code.

Wayland intentionally requires an operating-system permission dialog. Browser display-capture permission cannot be
persisted, so the user should expect to select a source for every new capture session. A future native portal path may use
a restore token, but the application must never attempt to bypass capture consent.

The user selects the BDO UI scale and positions two fixed rectangles on the preview. The normal stack uses `362x311` at
80% and a proportional `453x389` at 100%. The rare banner uses `400x100` at 80% and a provisional proportional `500x125`
at 100%. Each rectangle can be selected, dragged, reset, and nudged by one source pixel independently. On the validated
3440x1440 80% profile, an inner guide marks the approximately `x=78..350`, `y=36..216` portion of the normal envelope used
by row detection and OCR. Its green horizontal lines must pass through the center of each visible item name. A second
inner guide marks the measured rare-banner text extent at approximately `x=52..388`, `y=20..92` within the 80% rare
envelope, with a green line at `y=57` that must pass through the center of the rare item name. Both guides scale
proportionally at 100% and appear on the full-source placement preview and their respective native-resolution crop
previews. The larger envelopes remain unchanged so the normal guide's benchmarked detector geometry stays valid and the
rare guide can retain placement tolerance.

Supported sources are `3440x1440`, `2560x1440`, and `1920x1080`. Persist only validated normalized coordinates for both
rectangles, an explicit rare-area confirmation flag, source dimensions, and UI scale, never preview or captured pixels.
Legacy settings default the confirmation flag to false even if they contain an automatically saved rare rectangle, so the
user must explicitly confirm that placement before rare recognition starts. A dimension mismatch disables cropping and
requires a supported profile or recalibration. The 100% dimensions still require representative recordings to validate
recognition geometry. The normal rectangle and a separately confirmed rare rectangle feed independent event analyzers and
serialized jobs through the same local OCR worker. Automatic normal localization never implicitly confirms the rare
placement. Only 3440x1440 at 80% currently has bundled normal and provisional rare detector geometry. Recognized results
from both paths are added automatically and remain visible in the bounded review feed.

### Automatic Normal-Stack Localization

Automatic placement is enabled only for the bundled `3440x1440`, 80%-UI profile. Capture begins with an `800x600` search
area centered around the saved normal region, or the default region when no saved placement exists. The user can drag this
larger area to recenter the search without switching to manual pixel placement.

The localizer evaluates every second sampled frame, scores the five calibrated row centers, and requires at least two
visible rows. It locks only after three of the latest four candidates agree within 12 source pixels. Retained search history
is bounded to 12 frames. On lock, the localizer converts the median candidate to the exact normalized `362x311` region and
switches native capture from search mode to exact normal and rare crops. It persists the normal result and preserves a
previously confirmed rare position; otherwise the user must align and confirm the rare area before rare frames feed
recognition. The first retained search frame establishes the event baseline, and later notifications in the retained
history are replayed. While the single Tesseract worker starts, capture retains rolling windows of at most 32 frames per
crop.

If localization cannot establish confidence, capture remains in search mode rather than guessing. The user can choose
manual placement at any time. Other resolutions and 100% UI scale continue to use manual placement until separately
calibrated localization benchmarks exist.

## Recognition Pipeline

1. Crop each sampled frame to the configured notification region.
2. Detect notification rows and track their vertical movement between frames. Rows already visible when capture starts
   establish the baseline and are not counted.
3. Wait until a new row's entrance animation settles before attempting OCR.
4. Align and combine several frames to suppress changing scenery, particles, and combat effects.
5. Resize the row to a canonical text height so later processing is independent of capture resolution.
6. Enhance local contrast and detect the notification's bright glyphs with dark outlines.
7. Match the item icon against the active grind spot's known item assets.
8. OCR an enhanced text row and fuzzy-match it against the icon-narrowed item candidates.
9. Parse the rightmost `x <number>` quantity with a digits-only OCR pass.
10. Combine readings from several stable frames and attach confidence and diagnostic scores.

The translucent notification background has already been composited with the game scene, so its original alpha channel
cannot be recovered. Preprocessing must use local contrast and multiple frames rather than one global brightness
threshold.

### Provisional Rare-Banner Recognition

At 3440x1440 and 80% UI scale, the rare analyzer measures the fixed gold shell independently of the normal row detector.
It requires four consecutive shell observations, emits one synthetic row for the duration of the appearance, and waits 12
detected frames before selecting three OCR frames from `x=40..392`, `y=20..92`. A minimum active lifetime keeps the
synthetic row available after the gold entrance shell fades and before the text disappears unless a separately confirmed
replacement appears. Frames used to confirm a replacement remain tracking-only and cannot be selected as OCR evidence for
the old event. Two absent frames end a sufficiently old appearance; a new confirmed shell after a longer early gap starts
a separate appearance. A later identical banner therefore receives a new `rare-*` event ID. A banner whose confirmation
begins in the first captured frame is treated as a baseline and suppressed until it disappears.

The active grind spot's item names remain the only OCR candidates, and the existing terminal quantity parser reads the
displayed `x <number>` suffix. Normal and rare coordinators serialize requests through one Tesseract worker. The current
gold-color, timing, and crop gates were measured from one event and are deliberately marked provisional; 100% UI scale and
other source resolutions do not start recognition because they have no bundled calibrated profile.

## Event Tracking

Recognition must run once per notification event, not once per frame. A visible row may persist across many frames, while
two identical rows may represent separate legitimate drops.

Track rows by position, motion, appearance time, text, and icon similarity. Assign each newly appearing row an event ID,
retain that ID while it moves through the stack, and count it once. Text-only deduplication is insufficient because two
consecutive drops can have the same item and quantity.

The first prototype shows every result in a recent-event feed and identifies whether it came from the normal stack or rare
banner. Recognized matches from either source are immediately added to the ledger. Users can remove or edit an inserted
entry through the ledger before finishing the session. If insertion fails, the app retries it after one, two, and four
seconds while the same session remains running. An exhausted result remains actionable while retained in the bounded feed,
with the latest validation error and a manual retry control. Withheld and failed recognition results remain visible without
inventing an item or quantity and require manual entry. Before release, broader benchmark data must establish whether
automatic insertion needs stricter confidence gating.

## Privacy And Safety

- Capture begins only after an explicit user action and operating-system consent.
- The interface always shows when capture is active and provides an immediate stop control.
- Capture stops when the session pauses or finishes, the user leaves the live view, the source ends, or the component is
  destroyed.
- Full frames, cropped rows, and OCR images remain in memory and are discarded after processing unless the explicit
  debug-only ROI sample action is active.
- No screenshots or videos are persisted or uploaded by default.
- Debug ROI sample collection requires a separate explicit action, identifies the two exported regions, shows its output
  path and progress, and stops after at most five minutes.
- Use operating-system capture APIs only; do not inject code, inspect game memory, or interfere with anti-cheat systems.
- Review BDO's current terms before shipping the feature.

## Rollout

1. On Linux Wayland, prove that the portal stream supplies at least five sampled frames per second for ten minutes while
   BDO is focused, then confirm immediate stream release on stop.
2. Confirm the same capture lifecycle on Windows WebView2.
3. Validate rectangle selection and native-resolution in-memory preview for all supported resolution and UI-scale profiles
   during live BDO sessions.
4. Build an external benchmark from labeled screenshots and a 5-10 FPS frame burst across bright, dark, crowded, and
   effect-heavy scenes.
5. Implement row detection and temporal event tracking, including consecutive identical drops.
6. Add icon-first classification, constrained OCR, and the active grind spot's known-item dictionary.
7. Add the editable recent-event feed and session integration.
8. Measure event accuracy, missed events, duplicate events, frame cadence, CPU use, and memory use on held-out samples.
9. Evaluate prototype automatic insertion against broader held-out data and add measured confidence gating if required.
10. Add 100% UI-scale and 16:9 benchmark sets and confirm normalization preserves acceptable results.
11. Freeze the rare-banner detector against multiple development events, then evaluate event identity and OCR on an
    untouched held-out sequence and add measured confidence gating if automatic insertion is not sufficiently accurate.

The current 3440x1440, 80%-UI-scale end-to-end baseline has 24/24 development and 11/11 test item-and-quantity matches.
Tracked identities select their own first three consecutive detected OCR frames after a one-frame delay, with labels used
only for development calibration and final scoring. This small benchmark does not yet measure live native-resolution ROI
delivery, other layouts, or release accuracy.

## Success Criteria

- At least 99% of automatically accepted events have the correct item and quantity.
- Uncertain events are withheld for review rather than silently guessed.
- A notification visible across multiple frames is counted once.
- Consecutive identical notifications are counted as separate events.
- Stopping capture releases the operating-system stream immediately.
- Capture continues to supply at least five sampled frames per second while BDO is focused.
- Normal use writes no captured pixels to disk and performs no recognition network requests.

Coverage is separate from accuracy: the system may leave difficult events for review to protect the accepted-event error
rate. Full-session accuracy also depends on avoiding missed frames and duplicate events, not only OCR quality.

## Remaining Questions

- Does `getDisplayMedia` work reliably in the current Tauri WebView on every target platform?
- How long do notifications remain visible at each UI scale and notification-stack setting?
- Can the notification region move independently through BDO's UI editor?
- Which item-name and quantity combinations are most likely to overlap combat text?
- What capture and recognition behavior is permitted by BDO's current terms?
