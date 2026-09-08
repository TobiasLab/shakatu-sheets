# OCR Accuracy Improvements

This work builds on main `0291ac1` (PR #25). It includes automatic quantity localization, conservative row assignment,
bounded OCR retries, accepted-event diagnostics, a dictionary correction, and expanded replay fixtures.

## Recorded Coverage

The replacement corpus remains read-only. Both runs use 3440×1440 source images:

| UI scale | Run | Paired batches | Native batch range | Recorded file-time span |
| --- | --- | ---: | --- | --- |
| 80% | `run-1788631566956-9757-0001` | 13,691 | 1519–15209 | approximately 28m 37s |
| 100% | `run-1788636972715-150189-0001` | 8,466 | 2175–10640 | approximately 17m 58s |

All 44,314 PNGs are paired normal/rare samples. The manifests report no dropped sample batches or write errors. The 68
original issue records resolve to existing frames. These are two partial sessions, not a verified hour or an inventory
comparison. Recording began after capture, so initial visible rows are baseline observations. Earlier corpus annotations
are not applicable. Generated reports and contact sheets are under `/tmp/shakatu-digit-tracking`.

## Runtime Behavior

`lootQuantity.ts` finds the trailing digit word after a small isolated marker using the current row's glyph spacing.
It has no item-specific coordinates or quantity corrections. It preserves multiple digits, rejects clipped/empty suffixes,
and stores at most about 1.3 KiB of binary mask data per detected row. Its two-dimensional comparison permits one native
pixel of vertical alignment; strokes outside the overlap remain in the distance denominator.

The digit comparison refines ambiguous **row assignments**, including the existing recovery check after one empty frame.
The projection-based birth rules remain unchanged. Near-identical whole-row matches (distance ≤0.01) retain priority. Digit evidence is ignored when item-name ink
changes by more than 10%, since fading can erase quantity strokes. A mask match does not identify a drop event: repeated
identical drops still need independent stack/birth evidence.

Normal OCR retains a six-observation search window after the existing appearance delay, backed by seven rolling ROI
frames. It keeps the first usable three consecutive observations, then ranks supplementary frames by their proportion of
strict glyph pixels to detected row pixels. Up to two supplementary observations can be used. A later different run cannot
replace the original three observations, and supplementary frames cannot narrow their shared text crop.

The worker reads the original three frames first. Only an unresolved result uses the supplementary frames, and consensus
then evaluates **all** readings together. The existing veto on confident conflicting item/quantity readings remains in
force. Short tracks are flushed at expiry, before their pixels leave the rolling buffer, or at finish. Existing job/result
queue limits and cancellation remain bounded. At 8 FPS the larger selection window can add up to 375 ms before OCR starts;
it does not add Tesseract calls to the usual successful three-frame path. Rare OCR keeps its existing window and gold pass.

For the default Korean font, full-line OCR still uses three thresholds at 2× enlargement and, when needed, a single 4× retry. For an unresolved quantity,
a localized digits-only 4× single-word pass can corroborate a quantity already present in a full-line reading. It only repairs
unparsed suffixes with a visible textual `x` marker; it never invents a quantity or replaces a conflicting parsed number.
There is no extra quantity pass when no repair is possible. The shared worker restores its line segmentation and unrestricted
character set before subsequent normal or rare text. Limits are nine threshold passes per frame and five frames per event;
this worst case is reserved for unresolved events. [Strong Sword](strong-sword-font.md) has separate enlargement and
unanimous digit-recovery rules; Korean behavior remains unchanged.

## Dictionary And Diagnostics

Empty Picture Frame is now an Aphrodon vendor drop: item/export key `767249_0`, vendor value 15,348 silver, and icon
`new_icon/03_etc/03_quest_item/00066292.webp`. These were verified against the current
[Garmoth global metadata](https://api.garmoth.com/api/external/grind-tracker), rather than inferred from aggregate loot totals.
The publisher describes it as an indicator drop from
[Allan Serbin's Landscape](https://blackdesert.pearlabyss.com/Console/th-TH/Game/Wiki?_masterWikiNo=577).
It is absent from Garmoth's static Aphrodon drop list; the local export mapping uses its verified global key. No session was
uploaded as part of this work, so provider acceptance of that supplemental drop remains untested.

`ocr-issues.jsonl` now writes version 2 event records, including successful OCR consensus. `recognized` describes the OCR
result, not proof that a session mutation or upload succeeded. Records include the final item/quantity, native batch IDs,
row centers, full-line and quantity bounds, text color, and individual threshold/enlargement/region/raw-text passes. Final
readings are separate from raw passes, so a corroborated suffix remains auditable. Partial OCR failures keep completed-pass
metadata. Multiple rows sharing a batch remain distinguishable by event ID and row bounds.

Logging stays limited to active debug ROI collection: 16,384 sample references, 128 recent OCR metadata entries, the existing
32 pending writes, and the existing 64 MiB file cap. Rust validates recognized quantities, bounds, pass limits, and coordinates
against the selected normal/rare ROI. Older payloads without the new optional fields remain accepted. The file name and
pending-PNG null-file behavior remain compatible; original source logs are never rewritten.

## Evaluation

The expanded identity fixture contains 24 visually reviewed pairs covering Branch of Abundance, Black Stone, Caphras Stone,
Ancient Spirit Dust, and Nev's Fragment at both UI scales. It includes a real ×5, multidigit quantities, movement, combat effects,
and consecutive identical drops. Automatic digit-assisted comparison classifies 23/24 pairs correctly at the existing 0.1
continuity boundary, versus 18/24 for the original fingerprint. The one unresolved pair is the ×4/×6 change in combat effects
around 100% batches 9816–9817, where localization falls back to the original projection.

The original manually cropped experiment remains a separate 14-pair comparison: unaligned masks score 9/14 and vertical
alignment scores 14/14. Manual crop bounds are never used by the app. None of these pair scores establishes event accuracy.

The whole-run replay uses actual recorded pixels and the production policy. Identical run/source/batch/row/crop readings are
reused from prior actual Tesseract work; changed crops are read afresh. The complete-interval fixture includes both recovered
events and known unresolved cases. Its nonzero exit status is an accuracy finding, not a failing build or an assertion that
all candidate events should be accepted. Previously reviewed quantity cases remain separate from whole-session truth.

Measured final replay versus main:

| Pipeline | Candidates before → after | OCR events before → after | Recognized before → after |
| --- | ---: | ---: | ---: |
| 80% normal | 1133 → 1133 | 1118 → 1120 | 1106 → 1119 |
| 100% normal | 614 → 614 | 609 → 609 | 595 → 597 |
| 80% rare | 1 → 1 | 1 → 1 | 1 → 1 |
| 100% rare | 0 → 0 | 0 → 0 | 0 → 0 |

Every previously accepted item/quantity pair is preserved. The 15 added events are eleven Empty Picture Frames at 80%,
one at 100%, two short 80% Branch drops (×7 at batch 11436 and ×10 at 13217), and the 100% Branch ×6 at 5143 whose row
moves while older rows fade. The three Branch recoveries were checked against contiguous source frames.

Branch replay sums change 8840→8857 at 80% and 3198→3204 at 100%. Black Stone stays 48/33, Ancient Spirit Dust 81/33,
and Caphras Stone 21/0 (80%/100%). WON shards, oil, Nev's Fragment, and the one rare earring are unchanged. These sums
are replay diagnostics, not independent inventory truth. Supplementary frames are read for 13 of 1729 normal OCR events
(about 0.75%); successful primary reads do not pay for those extra frames.

Fresh execution through `createLiveLootTesseractOcr` matched the final replay on 114 events: 71 normal at 80%, 42 normal
at 100%, and the rare earring. This subset includes changed results, reviewed quantities, known failures, and uniform
controls. Its mean OCR durations were 145 ms and 235 ms for the two normal scales; they are not a controlled gameplay
throughput comparison. The 26 previously reviewed normal quantity cases and the rare case still match their labels.
New complete intervals deliberately expose the remaining two six/eight errors and missing rapid births.

An alternating detector microbenchmark on the same decoded frames measured 0.385→0.396 ms/frame at 80% and
0.642→0.654 ms/frame at 100% (60 warmup iterations, six alternating 500-frame passes per variant; 15 and 12 distinct frames).
This measures analysis cost, not native gameplay FPS or end-to-end capture latency.

## Remaining Limits

The two known confidently wrong ×6→×8 readings at 100% batches 7028 and 7032 remain unresolved. Standalone digits-only OCR
was not reliably corrective: line/character modes often returned nothing and word mode sometimes read a visible six as three.
Those readings therefore cannot overwrite stable full-line results. The current recordings contain no independently reviewed
true ×8 control; future recordings must provide one before a general six/eight discriminator is claimed.

Rapid replacements around batch 3746 and the ×4 following the recovered ×6 near 5145 still expose birth-detection limits.
Strict pixel birth gates and hard per-event pixel anchors caused additional misses in full replay and were rejected.
The conservative implementation keeps uncertain cases explicit instead of forcing aggregate counts.

This corpus is development data, not an independent holdout. There is one reviewed rare earring event at 80%, no recorded
100% rare positive, and no native 2560×1440 recording. Synthetic geometry tests and Windows cross-compilation do not establish
native Windows gameplay accuracy. New recordings with accepted-event logs are needed for independent validation.

## Reproduction

```sh
npm run benchmark:loot:identity -- /path/to/dev-samples/live-loot --output /tmp/identity.json
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-roi-improvements-2026-09-05.json \
  --output /tmp/replay.json --trace /tmp/readings.jsonl
```

The trace records event IDs, selected row coordinates, readings, and available pass metadata. Counts distinguish OCR events
from reader calls, including the bounded secondary call. Output must be outside the source corpus and must not already exist.
FFmpeg is required. Source images, original logs, generated reports, and the unrelated pre-existing lockfile change are not
part of the intended commit.

## Local Verification

The implementation is covered by frontend tests for quantity geometry, fading, worker mode restoration, bounded retries,
conflicting original readings, short-track expiry, cancellation, and accepted/failed diagnostic provenance. Rust tests
cover accepted records, invalid quantities, pass metadata, and ROI bounds. Review added coverage for cancellation during
supplementary OCR and diagnostic separation across both OCR stages and rows sharing a batch. It also fixed detection-only
replay traces and protected identity reports against accidental overwrite. A 15-batch copied sample produced the expected
five event traces across ten reader calls without OCR; the 24-pair identity replay retained the measured 23/24 result.

Local checks passed: Biome, 279 frontend tests, production build, Rust formatting, 81 Rust tests (one ignored), strict Rust
Clippy, and Windows cross-target Clippy. No native Windows gameplay session was run.
