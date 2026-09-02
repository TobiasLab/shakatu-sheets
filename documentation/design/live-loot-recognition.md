# Live Loot Recognition Plan

## Status

Linux capture feasibility is established. The first native-resolution offline pipeline tracks events, selects OCR frames,
and recognizes items and quantities exactly on its held-out sequence without label-selected crops. The live capture UI
now positions and previews a native-resolution in-memory crop for three source resolutions at 80% or 100% UI scale.
A browser-safe production module now analyzes packed RGBA crops, tracks notification identities, selects stable OCR frames,
and resolves dictionary-constrained replay readings. Its incremental coordinator bounds retained frames and OCR work,
confirms births with one-frame lookahead, reports backpressure explicitly, and suppresses stale results after cancellation.
The offline benchmark uses the same production detector, tracker, and parsers. Passing held-out E2E runs can atomically
export a strict V1 detector profile containing only validated capture dimensions, UI scale, 8 FPS cadence, and OCR-safe
row geometry. The validated 3440x1440, 80%-UI profile is bundled for live capture. After the user confirms the crop, a
browser-side adapter reuses one local Tesseract worker and sends recognized, withheld, failed, and overflow results to a
bounded review feed. Recognized events require explicit acceptance before entering the ledger. Live validation and
calibrated recognition benchmarks for the additional profiles remain required.

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
- A fixed loot-notification location selected by the user.
- User-triggered start and stop controls with a persistent capture indicator.
- Borderless-windowed mode as the recommended game display mode.
- The user selects the monitor containing BDO from the operating-system source picker.
- Known grind-spot item names as the recognition dictionary.
- Local processing and persistence of recognized events only.

## Capture

Capture uses a live operating-system screen-sharing stream rather than repeatedly saving screenshots. The app samples
approximately 5-10 frames per second, creates a bounded full-source preview, and copies the configured notification
rectangle at native resolution into memory.

Windows and browser development use `navigator.mediaDevices.getDisplayMedia` inside the Tauri WebView. The call must come
directly from a user action and requests video without audio. The operating system presents its own source picker and the
user selects the monitor containing BDO. Browser hints cannot restrict the picker reliably or choose a monitor for the
user.

WebKitGTK 2.52 can close the portal session after source selection and then fail `Start` with `Invalid session`. Its
implementation ignores the `SelectSources` response and requests an embedded cursor without checking whether the portal
advertises that mode. Linux therefore performs the same user-authorized XDG ScreenCast portal flow natively, requests one
monitor with a hidden cursor, and consumes the returned PipeWire stream. Sampled RGBA preview frames cross Tauri's local
binary IPC channel and are not persisted. On Linux, the selected notification rectangle is cropped directly from the
mapped native PipeWire frame before a separate region frame crosses the same versioned channel. Browser capture crops the
native hidden video frame with canvas while retaining the downscaled preview.

Platform capture remains behind the same start/stop interface:

- Windows Graphics Capture for a selected monitor.
- `xdg-desktop-portal` ScreenCast with PipeWire on Wayland (implemented for the feasibility slice).
- The portal path on Linux where available instead of compositor-specific capture code.

Wayland intentionally requires an operating-system permission dialog. Browser display-capture permission cannot be
persisted, so the user should expect to select a source for every new capture session. A future native portal path may use
a restore token, but the application must never attempt to bypass capture consent.

The user selects the BDO UI scale and positions a fixed notification rectangle on the preview. The 80% profile uses a
`362x311` rectangle and the 100% profile currently uses a proportional `453x389` rectangle. Supported sources are
`3440x1440`, `2560x1440`, and `1920x1080`. Persist only validated normalized rectangle coordinates, source dimensions, and
UI scale, never preview or captured pixels. A dimension mismatch disables the crop and requires a supported profile or
recalibration. The 100% dimensions still require representative recordings to validate recognition geometry.

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

## Event Tracking

Recognition must run once per notification event, not once per frame. A visible row may persist across many frames, while
two identical rows may represent separate legitimate drops.

Track rows by position, motion, appearance time, text, and icon similarity. Assign each newly appearing row an event ID,
retain that ID while it moves through the stack, and count it once. Text-only deduplication is insufficient because two
consecutive drops can have the same item and quantity.

The first prototype shows every result in a recent-event feed and requires explicit acceptance before adding a valid match
to the ledger. Users can remove or edit an accepted entry through the ledger before finishing the session. Recognition
failures remain visible without inventing an item or quantity. After broader benchmark data establishes useful confidence
thresholds, high-confidence events may be added automatically while uncertain events continue to wait for review.

## Privacy And Safety

- Capture begins only after an explicit user action and operating-system consent.
- The interface always shows when capture is active and provides an immediate stop control.
- Capture stops when the session pauses or finishes, the user leaves the live view, the source ends, or the component is
  destroyed.
- Full frames, cropped rows, and OCR images remain in memory and are discarded after processing.
- No screenshots or videos are persisted or uploaded by default.
- Optional diagnostic sample export must require a separate explicit action and show exactly what will be exported.
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
9. Replace prototype auto-acceptance with measured confidence gating before release.
10. Add 100% UI-scale and 16:9 benchmark sets and confirm normalization preserves acceptable results.

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
