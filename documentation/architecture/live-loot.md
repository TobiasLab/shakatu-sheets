# Live loot recognition

This is the current capture and recognition reference, not an implementation plan. Product flows are described in
[product behavior](../design/README.md); replay commands are in the [benchmark guide](../development/live-loot-benchmark.md).

## Capture and profiles

Linux uses the user-authorized XDG ScreenCast portal and PipeWire. Windows uses Windows Graphics Capture with the system
picker and GPU-cropped ROI readback. Browser development uses `getDisplayMedia`. Capture samples at up to 16 FPS;
backpressure, frame retention, and OCR queues are bounded. Source-token checks reject stale control commands.

Protocol V4 transports bounded previews and native-resolution normal, rare, or search crops over binary IPC. Each batch
travels as one message holding its frames back to back and is acknowledged once, after consumption. Hiding setup
suppresses repeated previews while recognition continues; a new source or changed dimensions still produces a metadata
preview. Navigation and minimization do not stop recognition.

Native sources send no frames while the screen is static or the game is minimized. After the first frame this is not an
error: the UI reports the source as waiting. On Windows, whose window source pauses only while minimized, the first frame
after a gap of over two seconds restarts recognition so rows still on screen count as already seen. Linux captures the
whole monitor and receives frames only when it changes, so the first frame after a pause may show a new drop and
recognition continues. Linux ends capture when the portal removes the stream (sharing stopped from the desktop or the
monitor disconnected), skips empty or corrupted PipeWire buffers, and closes each capture's own portal connection when
it ends, which ends the screen-share session and its indicator.

Recognition and automatic placement support 1920×1080, 2560×1440, and 3440×1440 at 80% or 100% BDO UI scale. BDO draws
loot at the same native pixel size for a given UI scale, so all three sources share the recognition settings calibrated
at 3440×1440. 1920×1080 is supported but not yet verified on gameplay recordings. Placement is manual by default, with
optional automatic adjustment for each area. Changing scale requires placement confirmation again. BDO UI scale is
separate from OS scaling.

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

New drops appear at full brightness, and a row stays bright for about one second before it fades. Fading text can
change a row's projection enough to look like a replacement, so a birth that keeps the row count needs a brightened
bottom row or the old bottom row moved up; otherwise a dimming bottom row or a stack about to shrink is treated as a
fade. Conversely, a short detector gap normally keeps a row's identity, but a bottom row that was fading before the gap
and returns brighter is a new identical drop. A refreshed bottom row without a detector gap is not yet counted.

Identical drops scroll the stack without changing any text, so brightness also decides scrolls. When an older row
reappearing above rows that stayed in place matches the text better than a scroll, it is rejected if any of those rows
got brighter, because rows only fade. When the row count stays flat, a fading row just above a fresh bottom row that
turns fully bright and stays so means the old bottom row moved up, which is one arrival. A full stack of identical
bright rows that scrolls remains invisible.

Normal OCR reads three stable observations spaced 125 ms apart after the entrance delay. Up to two supplementary frames
are read only for unresolved results. Consensus considers all readings and retains the veto on confidently conflicting
item/quantity pairs. There is no standalone single-frame or two-frame acceptance. Normal and rare jobs share one local
Tesseract worker, with at most eight outstanding normal jobs and two rare jobs, including active work.

Rows that end before spaced evidence exists stay withheld for review. Reading them from adjacent 16 FPS frames recovered
real drops when the whole stack faded quickly, but on Korean gameplay it also counted already-recognized rows twice: the
tracker can give a row a new identity while the stack fades, and that short remainder was then read. Revisit the
fallback only after the tracker stops splitting fading rows.

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
Its calibration is provisional. The rare crop must fit the longest name, so each gold pass ends at the first blank gap
as wide as the text line is tall; otherwise bright scenery after the quantity reads as junk that fails the quantity
parser. Unresolved banners read up to two supplementary frames, as normal loot does. Detection needs the banner within
about 3 px vertically of the calibrated position, and larger offsets either clip the text or miss the banner, so the
placement preview matters more than for the loot stack.

Normal and rare recognized events enter the ledger; failed insertion retries after one, two, and four seconds, then
remains manually retryable while retained in the bounded feed. Review OCR suggests a correction that must be confirmed.
Dismissal cancels insertion retries without deleting ledger loot. Finishing drains OCR and stops capture before
resolving the user's choice about remaining captures.

Opt-in [self-improvement](quantity-learning.md) can suggest learned item names and quantities after normal OCR fails.
Separately enabled automatic recovery requires multi-frame agreement, eligible learned matches, and no conflicting
OCR evidence. Accepted OCR is never overridden, and automatic recoveries never train the reader.

## Brightness ledger

Normal loot at 16 FPS has a second arrival count, the brightness ledger, that reads no text. A new row appears
fully opaque at the bottom and pushes every row up a slot, and rows fade in the order they arrived. Between two frames
the ledger tries each number of arrivals and keeps those that put every row in the right slot with a brightness it
could have: a fully shown row stays so or starts to fade, a fading row fades on or out of sight at a plausible rate,
and rows that start fading in the same frame read alike, because only rows that arrived together do that.

Row opacity compares each column's brightest unsaturated pixel with that column's own background, so how bright the
scenery behind a row is does not change its reading. Scenery with contrast of its own can still raise a slot, so a new
row must also be one the row detector found, while a row the detector loses for a frame is still there. A slot whose
background is nearly as bright as the text cannot be measured. No lifetime is assumed: rows usually last 16 frames at 16 FPS, but about 20 in busy bursts.

The tracker's count of new rows in a frame stays within what the ledger proves. Where brightness shows more arrivals
than the tracker counted, the extra bottom rows become new drops, such as identical drops that scrolled the list. Where
it shows fewer, the tracker counts only that many, so a fading row is not counted again or captured as a fragment. The
tracker settles each frame one frame later, after the ledger has seen it, so this adds no delay. Where the ledger cannot
see an arrival it proves nothing and the tracker's count stands: where several numbers of arrivals fit a frame equally
well, such as while every slot holds a fully shown row, and across frames it cannot measure. Corrections are on for the
Korean font, which the ledger was checked on.

Builds that can record ROI samples also log where the counts still differ. A difference that lasts 12 frames becomes a
`missed-drop` (brightness shows an arrival the tracker did not count) or a `phantom-drop` (the tracker counted a drop
without one), dated by the frame it appeared in. A difference in the last second before capture ends is not reported.

Text luminance is fixed per font (228 Korean, 218 Strong Sword) from 3440×1440 recordings at 80% UI scale; Strong
Sword and 100% scale are unverified. On four Korean recordings (3.3 hours, 8,922 counted drops) the ledger found 27
drops the tracker missed, mostly identical drops that scrolled the list, and 24 rows the tracker counted without an
arrival, which the app showed as "Capture too brief" or silently counted twice. All were confirmed in the frames, and
it found nothing else. With corrections, all 27 are counted with the right item and quantity and all 24 are gone. A
real drop that was first captured as a fragment and then counted again is now read once, at its arrival. 16 of the 28
entries left to check are gone, and three drops the tracker had misread next to these are read correctly. No other
result changes. On the hour with a known in-game total, recognized Branch of Abundance plus the one entry left to check
matches the game's 20,106 exactly.

## Diagnostics and pixel lifetime

Pixels remain transient unless the user enables self-improvement or debug ROI collection. Learning saves only small
text crops from successful manual corrections, with confirmed labels and bounded audit metadata, in its separate local
database. Full frames are never saved by learning. Debug Linux and Windows builds can save paired normal/rare PNGs under
ignored `dev-samples/live-loot/`. The switch is under Settings → Capture → Developer and is saved in the SQLite
`settings` table, so it stays on across restarts. Once enabled, collection records while the session timer runs, so a
run covers the same stretch as the tracked loot; each pause ends the run and resuming starts a new one. While capture
runs, a strip in the capture card shows the recording state, elapsed time, size, and dropped pairs, and copies the run
folder path. There is no time limit, and a
run takes roughly 10 GB per hour at 3440×1440. A source/selection change or capture end also ends the run; a new one
starts once capture and both confirmed areas are applied again while the timer runs. A run that ends for another reason,
such as a write failure, is not restarted until the timer is paused and resumed. A bounded encoder reports dropped pairs without
blocking capture.
Release builds do not expose this collector. Capture never reads game memory, hooks the game, or uploads frames.

Each run has a `manifest.json` and version-2 `ocr-issues.jsonl` records for recognized, withheld, failed, and dropped
results. Records include final readings, selected frame/row/crop metadata, font, and raw OCR passes. A recognized result
is not proof of ledger insertion. Native `batchId` maps to the PNG filename; recognition `frame` is a separate index.
Null file references can mean pending or dropped image writes. Metadata is bounded, diagnostic writes have at most
32 frontend requests outstanding, and logs are capped at 64 MiB per run.

[Brightness ledger](#brightness-ledger) disagreements are logged as `audit` records with reason `missed-drop` or
`phantom-drop`, the frame where the difference appeared, and the number of rows in `count`. They are leads to check in
the frames, not results. Other records cannot reveal arrivals never detected.

## Validation limits

Reviewed recordings provide regression coverage, not complete session recall or inventory truth. Rapid replacements
can be missed between samples; an unchanged full stack cannot prove how many identical arrivals occurred. Confident
OCR mistakes remain possible despite consensus. Keep independent held-out recordings separate from development cases.

Evidence includes 3440×1440 normal loot at both scales and Strong Sword recordings at 80%. Native 1920×1080 and
2560×1440 gameplay, 100% rare-banner calibration, Strong Sword gameplay at 100%, and native Windows gameplay need
further validation.
Synthetic geometry tests, cross-compilation, and offline replay do not establish live throughput or gameplay impact.
Use the [performance protocol](../development/performance.md) for those measurements.
