# Live Loot Recognition Plan

Normal arrival tracking also uses faint glyph movement to distinguish repeated drops while older rows fade.
See [repeated loot arrivals](repeated-loot-arrivals.md) for the current arrival rules, measured results, and sampling limits.

The current OCR policy and measured 80%/100% corpus results are documented in
[OCR accuracy improvements](live-loot-digit-tracking.md). Normal recognition uses three initial frames and up to two
supplementary frames only for unresolved results. Debug collection logs recognized events as well as failures, with exact
row bounds and per-pass metadata in version 2 `ocr-issues.jsonl` records.

## Status

Linux capture feasibility is established. The first native-resolution offline pipeline tracks events, selects OCR frames,
and recognizes items and quantities exactly on its held-out sequence without label-selected crops. At 80% and 100% UI scale
on 3440x1440, 2560x1440, and 1920x1080 sources, optional automatic adjustment searches an `800x600` native area.
Normal adjustment locks a `362x311` (80%) or `453x389` (100%) crop after stable observations; rare adjustment places a
`400x100` or `500x125` crop for confirmation.
Manual placement is the default for both areas. A provisional detector
also recognizes appearances of the fixed gold rare-banner shell and its horizontal border in the separately positioned `400x100` crop, delays OCR
until its text is readable, and presents dictionary-constrained results in the review feed. Recognized rare results are
added to the ledger automatically, with limited validation: the original detector calibration used one event, and
follow-up ROI replay covers three earring events, including one reserved from parser tuning. See the benchmark results
for scope.
A browser-safe production module now analyzes packed RGBA crops, tracks notification identities, selects stable OCR frames,
and resolves dictionary-constrained replay readings. Its incremental coordinator bounds retained frames and OCR work,
confirms births with one-frame lookahead, reports backpressure explicitly, and suppresses stale results after cancellation.
The offline benchmark uses the same production detector, tracker, and parsers. Passing held-out E2E runs can atomically
export a strict V1 detector profile containing only validated capture dimensions, UI scale, 8 FPS cadence, and OCR-safe
row geometry. The validated 3440x1440, 80%-UI profile is bundled for live capture and shared with 2560x1440 at 80%:
both use the same native ROI pixel geometry. Both 1440p widths also enable a native 100% variant derived from the
80% measurements; its gameplay accuracy is not yet measured. See [UI-scale support](live-loot-ui-scale.md). Normal jobs begin after automatic
alignment or manual confirmation, while rare jobs require separate rare-area confirmation. A browser-side adapter
serializes both paths through one local Tesseract worker and sends recognized, withheld, failed, and overflow results to a
bounded review feed. The normal path retains up to eight outstanding OCR jobs, including the active job, so one five-row
appearance burst does not immediately lose events; the lower-volume rare path retains two. Live diagnostics expose current
and peak outstanding job counts plus last and average execution time for the shared OCR worker. Recognized events from both
paths are added to the ledger
immediately; insertion failures remain visible and receive three automatic retries with short backoff before remaining
manually retryable. Live validation and calibrated recognition benchmarks for the additional profiles remain required.

## Goal

Recognize BDO's in-game loot notifications while a session is active and add each new loot event to a reviewable feed.
The feature should remain local, explicit, and external to the game process. It must not inject into BDO, read process
memory, upload frames, or create video recordings.

BDO does not expose a usable local loot log. This feature must not read or modify game files, inspect game memory, hook the
game process, or inspect BDO network traffic. User-authorized operating-system screen capture is the only permitted input.

## Initial Scope

- English BDO client.
- 80% and 100% UI scale capture profiles; only 80% currently has a labeled recognition benchmark.
- Capture sources at `3440x1440`, `2560x1440`, and `1920x1080`, with real-game recognition validation required
  before release. The two 1440p aspect ratios share OCR settings at each UI scale; 1080p remains uncalibrated.
- Native Linux portal/PipeWire and Windows 11 x64 WGC; Windows hardware acceptance remains pending.
- Automatically localized normal loot-stack placement at 80% and 100% UI scale on all three source resolutions, with manual fallback.
- Independently positioned and confirmed rare-banner placement selected by the user, with provisional recognition at both UI scales on the two 1440p sources.
- User-triggered start, stop, and live-preview pause controls with a persistent capture indicator.
- Borderless-windowed mode as the recommended game display mode.
- The user selects the monitor containing BDO from the operating-system source picker.
- Known grind-spot item names as the recognition dictionary.
- Local processing and persistence of recognized events only.

## Capture

Capture uses a live operating-system screen-sharing stream rather than repeatedly saving screenshots. The app samples
approximately 16 frames per second, creates a bounded full-source preview when previews are enabled, and copies either the
automatic search area or the configured notification rectangles at native resolution into memory.

Windows uses native Windows Graphics Capture with the system picker, an owning HWND, and free-threaded D3D11 frame
acquisition. It copies exact ROIs on the GPU before CPU readback and reduces visible previews on the GPU. Native runtime
capabilities select this backend. Browser development alone uses `navigator.mediaDevices.getDisplayMedia` from a user
action. Both paths select a source explicitly; Windows supports a selected monitor or borderless game window. See
[Windows implementation and release gates](../development/windows.md) for lifecycle, DPI, packaging, and hardware limits.

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
native backends from creating or sending repeated preview frames while a valid crop selection is active; native ROI
frames, OCR, diagnostics, and debug sample collection continue. The browser fallback keeps processing ROI frames through
offscreen canvases while visible canvases remain frozen. Native capture forces one preview frame on source/dimension change so placement can be recovered; hidden unconfigured
sources do not repeatedly send previews. Selection, preview, and stop commands carry a capture
token so delayed commands from a previous request cannot modify or terminate a newer capture.

Linux applies the local 16 FPS sampling deadline even when PipeWire advertises a bounded producer rate. This prevents
an unexpectedly fast producer from bypassing the capture/recognition work limit; the existing jitter allowance remains.

Debug Linux and Windows builds expose a separate `Save ROI samples for 30 minutes` action after both capture areas are confirmed. It
writes synchronized normal and rare PNG crops at the 16 FPS sampling cadence under the repository's ignored
`dev-samples/live-loot/` directory. A bounded background encoder drops and reports pairs when storage cannot keep pace,
rather than delaying capture or recognition. The backend enforces the 30-minute deadline and finalizes the run when
capture ends, the source or selection changes, or the user stops collection early. Each run includes source, UI-scale,
crop, timing, count, byte-size, and completion metadata in `manifest.json`; it never includes a full-screen frame.

While the collector is running, normal and rare recognition record recognized and withheld results, OCR errors,
frame-analysis/startup errors, and dropped-result summaries in the run's `ocr-issues.jsonl`. Ordinary frames without a
loot candidate are not logged. Version 2 records contain a logging timestamp, source, recognition generation/event ID,
status/reason, final item/quantity, first and selected frames, row centers, crop bounds, text color, and individual raw
OCR passes with their threshold, enlargement, and region. Final readings remain separate from raw passes. Partial OCR
failures keep completed-pass metadata. Dropped summaries include a count and last frame rather than an entry for each
dropped event. Older payloads without the new optional metadata remain accepted.

`batchId` identifies the native capture batch used in `normal|rare/minute-XX/frame-NNNNNNNNNN.png`; `frame` is the
zero-based index within that source's recognition generation, not the PNG number. Startup failures have no recognition
index. The backend resolves existing PNGs into relative `file` paths. A null batch ID means the frame was outside that
collection or its metadata was evicted; a null file means the image was not saved yet or was dropped. Search for its batch
ID after collection finishes if it was still queued. Results arriving while PNGs are draining are retained even if
their images are not written yet. After finalization, in-flight OCR can still append if its referenced images exist in
the same run. Events spanning collections are associated with their latest selected sample run. Results from a superseded run are discarded rather than written to a new run.

Diagnostic writes use a separate background task and per-run lock, with at most 32 frontend writes outstanding and a
64 MiB log limit per run. Overflow and write failures appear in the sample collector's error area and do not stop
capture or OCR. Only bounded frame metadata and truncated text/error strings are retained; diagnostics do not copy pixel
buffers. The existing `/dev-samples/` Git ignore covers both images and logs. These diagnostics cannot identify loot
that never produced a detection candidate, and cancelled recognition jobs are not treated as OCR failures.

Platform capture remains behind the same start/stop interface:

- Windows Graphics Capture for a selected monitor or borderless game window (implemented, awaiting hardware validation).
- `xdg-desktop-portal` ScreenCast with PipeWire on Wayland.
- The portal path on Linux where available instead of compositor-specific capture code.

Wayland intentionally requires an operating-system permission dialog. Browser display-capture permission cannot be
persisted, so the user should expect to select a source for every new capture session. A future native portal path may use
a restore token, but the application must never attempt to bypass capture consent.

The user selects the BDO UI scale and positions two fixed rectangles on the preview. The normal stack uses `362x311` at
80% and a proportional `453x389` at 100%. The rare banner uses `400x100` at 80% and a provisional proportional `500x125`
at 100%. Each rectangle can be selected, dragged, reset, and nudged by one source pixel independently. On the validated
1440p 80% profile, an inner guide marks the approximately `x=78..350`, `y=36..216` portion of the normal envelope used
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
requires a supported profile or recalibration. The two 1440p widths share normal and provisional rare geometry at each UI
scale. The 100% variant scales pixel measurements, including stroke bands and OCR padding, while retaining original
capture pixels. Its settings remain provisional pending genuine 100% gameplay calibration.
The normal rectangle and a separately confirmed rare rectangle feed independent event analyzers and
serialized jobs through the same local OCR worker. Automatic normal localization never implicitly confirms the rare
placement. 3440x1440 and 2560x1440 share the normal and provisional rare detector geometry at each UI scale. Recognized results
from both paths are added automatically and remain visible in the bounded review feed.

### Optional Automatic Placement

Capture opens in manual placement, including after source or UI-scale changes. Select **Loot stack** or **Rare loot**
and click **Adjust automatically** to start search. This is available at 80% and 100% UI scale for `3440x1440`, `2560x1440`, and
`1920x1080` on Linux and Windows. The selected area uses an `800x600` search centered around its current region. Drag this
larger area to recenter the search without switching to manual pixel placement. **Adjust manually** cancels search.

Rare search uses the selected scale's gold-shell and horizontal-border geometry to score candidates inside the bounded area.
It rejects weak shell contrast and competing locations, and requires three consecutive observations all within three source
pixels of each other before placing a 400x100 (80%) or 500x125 (100%) crop. Missing signals, cancellation, and source changes reset stability. The user confirms
the areas before rare OCR starts; search frames are not replayed into rare recognition. Gold scenery and synthetic
banners are covered by tests, but real rare-banner placement accuracy remains unmeasured.

Normal search retains the existing algorithm below.

At the live 16 FPS rate, the localizer evaluates every fourth sampled frame, scores the five calibrated row centers, and requires at least two
visible rows. It locks only after three of the latest four candidates agree within 12 source pixels at 80% or 15 at 100%. Retained search history
is bounded to 24 frames. On lock, the localizer converts the median candidate to the exact normalized `362x311` (80%) or `453x389` (100%) region and
switches native capture from search mode to exact normal and rare crops. It persists the normal result and preserves a
previously confirmed rare position; otherwise the user must align and confirm the rare area before rare frames feed
recognition. The first retained search frame establishes the event baseline, and later notifications in the retained
history are replayed. While the single Tesseract worker starts, capture retains rolling windows of at most 64 frames per
crop.

If localization cannot establish confidence, capture remains in search mode rather than guessing. The user can choose
manual placement at any time. Both UI scales support automatic placement. Search normalization uses actual source
dimensions and resets retained observations when those dimensions change. The 800x600 search and scale-specific output stay at
native resolution; the existing 80% glyph geometry and lock thresholds are unchanged. Synthetic tests exercise translated
signals and source edges at all three resolutions, and browser fixtures verify native search-to-regions selection for
both backends. Gameplay accuracy at the added resolutions remains unmeasured. Auto-placement is independent of the OCR
profile registry: 2560x1440 shares the existing 3440x1440 normal and rare settings at each UI scale, while 1920x1080 still
reports no calibrated OCR profile and does not insert recognized loot. Changing only the aspect ratio does not
change the crop-local OCR geometry. The original labeled calibration remains from 3440x1440; reuse does not claim a
separate measured result at 2560x1440.

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
At 16 FPS it requires eight consecutive observations of both a warm shell and a long horizontal entrance border. Gold scenery alone
is insufficient. It emits one synthetic row for the appearance and waits 24 detected frames before selecting three OCR
frames from the text-only bounds `x=112..392`, `y=49..65`. Gold OCR jobs retain warmer lettering than normal jobs; the
normal white-text filter otherwise erases much of this banner’s text. A minimum active lifetime keeps the
synthetic row available after the gold entrance shell fades and before the text disappears unless a separately confirmed
replacement appears. Frames used to confirm a replacement remain tracking-only and cannot be selected as OCR evidence for
the old event. Four absent frames end a sufficiently old appearance; a new confirmed shell after a longer early gap starts
a separate appearance. A later identical banner therefore receives a new `rare-*` event ID. A banner whose confirmation
begins in the first captured frame is treated as a baseline and suppressed until it disappears.

The active grind spot's item names remain the only OCR candidates, and the existing terminal quantity parser reads the
displayed `x <number>` suffix. Normal and rare coordinators serialize requests through one Tesseract worker. The current
gold-color, border, timing, and crop gates were measured from one positive 80% live-sample event and remain provisional.
The 100% variant scales geometry without changing temporal gates. 1920x1080 does not start recognition because it has
no bundled recognition profile.

### Live-Sample Detection Gates

Normal rows retain the existing calibrated edge-score scale, with an additional text-presence check: the leading text
must contain enough bright neutral strokes concentrated around the baseline, compared with its upper and lower margins.
This rejects grass and combat textures without raising the threshold for short or compressed item names. Row fingerprints
use the central glyph band and exclude scenery after a trailing whitespace gap. The gap itself remains part of the
comparison so an appended quantity digit still changes identity. Fingerprints are computed only for detected rows, and
quantity projections reuse the full projection. Normal OCR uses the earliest trailing whitespace boundary across its
three original projections, including the full gap, and can extend to the detector's full text envelope for long names.
Explicit rare OCR bounds remain separate. The following preprocessing and retry rules describe the default Korean
font; [Strong Sword](strong-sword-font.md) uses separate preprocessing and an additional unanimous digit fallback. Normal text is enlarged 2× for Tesseract, while gold rare text retains 4×
enlargement. The native source crops and the three luminance thresholds (130, 150, 170) are unchanged. A normal frame
without two matching parsed quantities retries those thresholds once at 4×; a retry with no parsed quantity preserves
the original readings. A localized digits-only pass can corroborate an unresolved quantity already present in the full-line
readings; it cannot invent a quantity or replace a conflicting parsed number. Gold frames do not retry. Both live OCR and
the ROI replay use `readLootOcrFrame` for this policy.
The smaller normal images reduce the observed ×10/×110 and ×6/×8 conflicts in the
[paired scale corpus](live-loot-scales-2026-09-05.md), while the bounded retry preserves less readable glyphs.

A temporary fingerprint change that returns to the previous identity is not a replacement unless the stack shifts. A
strongly different, shorter new item may be confirmed at the detector threshold while older rows lose brightness.
Discriminative, confirmed stack shifts also survive that loss. A stationary stack brightening immediately after a
confirmed birth does not create another event; count growth and distinct consecutive replacements remain countable.
Baseline suppression and distinct event IDs for repeated identical drops remain in place.

OCR starts with three observations spaced 125 ms apart after the entrance delay. Both adjacent captured frames and
frames 125 ms apart must have consistent fingerprints. Normal tracking retains a bounded window spanning six observations
at 8 FPS or eleven at 16 FPS and may select two clearer supplementary frames. It reads
the original three first and uses supplementary frames only for unresolved results, preserving all original readings and
requiring a strict majority across the combined frame set. A confident conflicting item/quantity pair in any frame vetoes
acceptance. A later different run cannot replace the first usable three observations. Short tracks are flushed before
retained evidence expires, at track expiry, or at finish.

Digit shapes refine ambiguous row assignments and recovery after short empty gaps (up to three samples at 16 FPS). Near-identical
whole-row matches retain priority, and the projection-based birth rules remain unchanged. Unreadable passes are not conflicting pairs. Trailing OCR punctuation remains allowed, including terminal
dash artifacts, while decimals, separators inside quantities, and trailing words remain rejected. There is no standalone
two-frame or single-frame acceptance. See the [measured policy](live-loot-digit-tracking.md) for limits and remaining failures.

## Event Tracking

Recognition must run once per notification event, not once per frame. A visible row may persist across many frames, while
two identical rows may represent separate legitimate drops.

Track rows by position, motion, appearance time, text, and icon similarity. Assign each newly appearing row an event ID,
retain that ID while it moves through the stack, and count it once. Text-only deduplication is insufficient because two
consecutive drops can have the same item and quantity.

Recognized matches from either source are immediately added to the ledger. Users can remove or edit an inserted
entry through the ledger before finishing the session. If insertion fails, the app retries it after one, two, and four
seconds while the same session remains active. An exhausted result remains actionable while retained in the bounded feed,
with the latest validation error and a manual retry control. The review feed shows unresolved results; users can correct
the item and quantity, retry OCR on the retained crop, or dismiss an individual entry. Dismissal cancels pending insertion
retries and leaves ledger loot unchanged. OCR retries use the font frozen when that capture started, including after the
user changes the font setting. A retry suggests a correction for the user to confirm; it does not add loot automatically.
Dismissing during a retry discards its result and lets the single-crop read settle before disposing its worker, avoiding
Tesseract's termination race during asynchronous image preparation.

Finishing pauses the timer, drains pending OCR, and stops capture before checking unresolved entries. If any remain, a
dialog lets the user return to review, keep the session open, or explicitly finish without adding those drops. Captures
remain available while reviewing the paused session and are discarded when it finishes. With no unresolved entries,
finishing proceeds immediately after OCR drains. Review time is excluded from session duration. Canceling while OCR is
being drained stops capture and keeps the session open; canceled preparation cannot finish a subsequent session.

Before release, broader benchmark data must establish whether automatic insertion needs stricter confidence gating.

## Privacy And Safety

- Capture begins only after an explicit user action and operating-system consent.
- The interface always shows when capture is active and provides an immediate stop control.
- Capture and local recognition can start before the timer and continue while it is paused. They stop when the session
  finishes, the user leaves the live view, the source ends, or the component is destroyed.
- Full frames, cropped rows, and OCR images remain in memory and are discarded after processing unless the explicit
  debug-only ROI sample action is active.
- No screenshots or videos are persisted or uploaded by default.
- Debug ROI sample collection requires a separate explicit action, identifies the two exported regions, shows its output
  path and progress, and stops after at most 30 minutes.
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

The original 3440x1440, 80%-UI-scale video benchmark recorded 24/24 development and 11/11 test item-and-quantity matches.
The newer [hour-corpus investigation](live-loot-hour-2026-09-05.md) documents current changes and their measured limits;
that separate historical video benchmark was not rerun for these changes.
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

Font-specific capture selection and the Strong Sword evaluation are documented in [In-game font recognition](strong-sword-font.md).
