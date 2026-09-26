# Live loot recognition

This is the current capture and recognition reference, not an implementation plan. Product flows are described in
[product behavior](../design/README.md); replay commands are in the [benchmark guide](../development/live-loot-benchmark.md).

## Capture and profiles

Linux uses the user-authorized XDG ScreenCast portal and PipeWire. Windows uses Windows Graphics Capture with the system
picker and GPU-cropped ROI readback. Browser development uses `getDisplayMedia`. Capture samples at up to 16 FPS;
backpressure, frame retention, and OCR queues are bounded. Source-token checks reject stale control commands.

Protocol V3 transports bounded previews and native-resolution normal, rare, or search crops over binary IPC. Batches
are acknowledged after consumption. Hiding setup suppresses repeated previews while recognition continues; a new source
or changed dimensions still produces a metadata preview. Navigation and minimization do not stop recognition.

Recognition supports 2560×1440 and 3440×1440 at 80% or 100% BDO UI scale. Placement is manual by default, with optional
automatic adjustment for each area. Automatic placement also supports 1920×1080, but that resolution has no calibrated
recognition profile. Changing scale requires placement confirmation again. BDO UI scale is separate from OS scaling.

| Native capture geometry | 80% | 100% |
| --- | --- | --- |
| Normal crop | 272×180 | 341×226 |
| Rare crop | 340×72 | 425×90 |
| Search area | 800×600 | 800×600 |

Saved placements migrate from the earlier larger capture envelopes; replay accepts historical crops. OCR reads native
pixels, without frame resampling. SQLite retains normalized placement, source dimensions, UI scale, and font preference.
See [Windows capture](../development/windows.md#capture-and-coordinates) for placement and source lifecycle details.

## Tracking and OCR

The active spot's known item names constrain OCR. Rows present when capture begins establish a baseline and are not
counted as arrivals. Event IDs track appearances, including repeated identical drops; text-only deduplication would lose
legitimate loot. Faint glyph movement and confirmed stack displacement provide arrival evidence as older rows fade.
Digit shapes refine ambiguous row assignments but do not independently establish a new drop.

Normal OCR reads three stable observations spaced 125 ms apart after the entrance delay. Up to two supplementary frames
are read only for unresolved results. Consensus considers all readings and retains the veto on confidently conflicting
item/quantity pairs. There is no standalone single-frame or two-frame acceptance. Normal and rare jobs share one local
Tesseract worker, with at most eight outstanding normal jobs and two rare jobs, including active work.

The `loot_font` setting accepts `korean` (default) or `strong-sword`. Each capture freezes the font at startup, including
later review retries; changes apply to the next capture. Old sample records without font metadata default to Korean.

White-text preprocessing preserves grayscale antialiasing and uses bilinear enlargement. Korean starts with three 2×
line passes. Unresolved or conflicting quantities can trigger three 4× line passes. Unanimous enlarged readings can
resolve a conflict only with a positive safe integer already present in the original readings. If needed, unanimous
localized-digit readings must corroborate a quantity in both original and enlarged lines. Other weak-suffix repairs
corroborate existing line evidence; they do not invent missing quantities. The limit is nine passes per frame.

Strong Sword starts at 4×, retains tinted glyph edges in its OCR crop, and uses font-specific quantity-gap geometry.
When all line quantities are unreadable but retain a textual `x` marker, three unanimous localized-digit passes can
recover a quantity. Existing parsed quantities are not replaced, and temporal consensus still applies. The limit is
six passes per frame. Gold rare text retains its separate preprocessing for both fonts.

Rare recognition uses the gold shell and entrance border, waits for readable text, and suppresses startup baselines.
Its calibration is provisional. Normal and rare recognized events enter the ledger; failed insertion retries after
one, two, and four seconds, then remains manually retryable while retained in the bounded feed. Review OCR suggests a
correction that must be confirmed. Dismissal cancels insertion retries without deleting ledger loot. Finishing drains
OCR and stops capture before resolving the user's choice about remaining captures.

Opt-in [self-improvement](quantity-learning.md) can suggest learned item names and quantities after normal OCR fails.
Separately enabled automatic recovery requires multi-frame agreement, eligible learned matches, and no conflicting
OCR evidence. Accepted OCR is never overridden, and automatic recoveries never train the reader.

## Diagnostics and pixel lifetime

Pixels remain transient unless the user enables self-improvement or explicitly starts debug ROI collection. Learning
saves only small text crops from successful manual corrections, with confirmed labels and bounded audit metadata, in
its separate local database. Full frames are never saved by learning. Debug Linux and Windows builds can
save paired normal/rare PNGs for up to 30 minutes under ignored `dev-samples/live-loot/`. Collection ends on stop,
source/selection change, capture end, or the deadline. A bounded encoder reports dropped pairs without blocking capture.
Release builds do not expose this collector. Capture never reads game memory, hooks the game, or uploads frames.

Each run has a `manifest.json` and version-2 `ocr-issues.jsonl` records for recognized, withheld, failed, and dropped
results. Records include final readings, selected frame/row/crop metadata, font, and raw OCR passes. A recognized result
is not proof of ledger insertion. Native `batchId` maps to the PNG filename; recognition `frame` is a separate index.
Null file references can mean pending or dropped image writes. Metadata is bounded, diagnostic writes have at most
32 frontend requests outstanding, and logs are capped at 64 MiB per run. Logs cannot reveal arrivals never detected.

## Validation limits

Reviewed recordings provide regression coverage, not complete session recall or inventory truth. Rapid replacements
can be missed between samples; an unchanged full stack cannot prove how many identical arrivals occurred. Confident
OCR mistakes remain possible despite consensus. Keep independent held-out recordings separate from development cases.

Evidence includes 3440×1440 normal loot at both scales and Strong Sword recordings at 80%. Native 2560×1440 gameplay,
100% rare-banner calibration, Strong Sword gameplay at 100%, and native Windows gameplay need further validation.
Synthetic geometry tests, cross-compilation, and offline replay do not establish live throughput or gameplay impact.
Use the [performance protocol](../development/performance.md) for those measurements.
