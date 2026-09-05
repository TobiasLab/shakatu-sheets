# Hour Corpus Investigation — 2026-09-05

The new samples expose three separate recognition problems: fixed normal OCR bounds truncate long names, scenery after
quantities can make incorrect readings win consensus, and brightness changes can reject real stack shifts or count an
appearance twice. The changes address those behaviors without item-specific quantity limits or aggregate corrections.
They do not establish complete hour accuracy.

## Corpus And Coverage

Source: `shakatu_sheets_pics/automatic_recognition_pics/roi_live_samples/dev-samples/live-loot`, read only throughout.
Analysis, temporary image previews, raw readings, and full reports are in `/tmp/shakatu-ocr-hour/`, outside the source.

The directory contains **96,112 PNGs**, six manifests, and **no `ocr-issues.jsonl` files**. Every normal PNG has a matching
rare PNG; batch IDs are unique and consecutive within each run. All manifests report zero dropped pairs and no errors.
All runs use 3440×1440 at 80% UI scale, normal crops of 362×311, and rare crops of 400×100.

| Run | Paired batches | Inclusive batch range | Role |
| --- | ---: | --- | --- |
| `run-1788546792943-431670-0001` | 2,270 | 8,233–10,502 | Older corpus |
| `run-1788547757579-492174-0001` | 2,271 | 603–2,873 | Older corpus |
| `run-1788603947977-1942988-0001` | 143 | 1,928–2,070 | Older corpus |
| `run-1788603961654-1942988-0002` | 443 | 2,114–2,556 | Older corpus |
| `run-1788615779035-2188209-0001` | 25,802 | 1,459–27,260 | New hour, first run |
| `run-1788617579855-2188209-0002` | 17,127 | 27,267–44,393 | New hour, second run |

Only the last two runs contribute to the hour comparison: **42,929 pairs / 85,858 PNGs**. Their crop origins are normal
`(2433, 991)` and rare `(2065, 845)`. Six native batches between runs are absent. The first manifest ends at its 30-minute
deadline; the second says `explicitlyStopped`. Preserved PNG modification times span approximately **13:42:59–14:41:49
UTC**, or **58 minutes 50 seconds**. There are images for every intervening second within each run. Modification times
are encoder/write timestamps with one-second precision, not exact capture timestamps. Session start/end times and live
accepted-result history are unavailable. These samples therefore **do not establish coverage of the full tracked hour**.

The first 30-minute run contains 25,802 pairs, versus at most about 14,400 at the advertised 8 FPS. Many seconds have
14–16 PNGs per source. The second run averages about 9.9 pairs/second using its modification-time span. `minute-XX`
folders group every 480 pairs; their names are not reliable wall-clock minutes in these runs. Linux previously bypassed
its local sampling deadline when PipeWire advertised a rate of at most 8 FPS. It now always applies the existing deadline,
including its 3 ms jitter allowance, before mapping/copying frames. The producer rate request remains in place.
A synthetic 16 FPS sequence now admits 480 samples over 60 seconds and does not emit catch-up bursts after a pause.
This fixes the permissive code path; the original capture build and producer negotiation cannot be reconstructed from
these manifests alone. Saved samples were replayed in their recorded order, not resampled to simulate the new gate.

## Evidence And Changes

### Violet: Normal Crop Truncation

Violet Primordial Luster - Sovereign ×1 appears in the **normal** stack beginning at batch **37,980**, with clear selected
frames 37,981–37,983. The detector created a candidate and the dictionary already contained the item. The old normal OCR
crop ended at x=290, cutting off the quantity and part of “Sovereign.” Representative raw text was
`Violet Primordial Luster = Sover:`. This is an OCR-bound failure, not a dictionary omission or an undetected rare banner.

Normal OCR now uses the existing glyph projections to bound the text. It takes the earliest trailing whitespace boundary
across the three selected observations, retains the full eight-pixel gap to protect trailing glyphs, and allows the crop
to reach the detector's x≈348 text envelope. Long names retain their suffix, while short names exclude more scenery.
The left edge and vertical padding remain the same, with bounds clamped to the source image. Explicit rare/custom bounds
are preserved. No extra OCR passes, screenshot buffers, or item-specific geometry were added.

The same three Violet frames now produce the correct item and ×1 consensus. Both new rare streams still produce zero
banner candidates. Independent color/edge scans and reviewed candidate frames showed scenery; the positive Violet
example was located through an independent normal-icon scan. This is not a new calibration of rare-banner detection.

### Branch: Quantity Errors And Duplicate Tracking

Seven visually reviewed Branch ×10 notifications were accepted as **×110** at batches **9,147, 17,473, 18,051, 18,058,
18,576, 18,603, and 43,351**. The high-threshold variant often reads ×110 while lower thresholds read ×10 followed by
scenery artifacts. The final implementation correctly accepts ×10 in three cases and withholds the other four. A reviewed
false ×16 at 43,337 is also withheld. Genuine large amounts such as ×58 and ×184 remain valid; there is no quantity cap.

Terminal dash artifacts are accepted alongside existing punctuation. This matters for 9,147: after cropping, two frames
contain valid ×10, while the third has `x10 -`. Previously, ×110 won three frames to two. Preserving the dash-terminated
×10 evidence yields a tie and withholds the event. Trailing words, decimal/separated quantities, and conflicting amounts
remain rejected or withheld. Consensus still requires distinct frames; threshold variants do not count as extra frames.

A confirmed, discriminative stack shift can now survive brightness loss from a fading top row. A strongly changed short
row can be confirmed at the detector threshold instead of needing twice that threshold. The existing identity distances
and lookahead confirmation remain required. This restores the Dust identity in the burst at 18,091–18,093 and creates a
candidate for Black Stone ×3 at 19,203.

The audit also found a duplicate when a stack brightened immediately after a confirmed birth. The tracker now suppresses
that subsequent birth only when row count and every row identity remain stable. Count growth and distinct consecutive
replacements remain countable. Twenty-four suppressed baseline candidates were visually checked against preceding frames:
no new notification appeared on those frames. Their preceding real drops remain recognized. A separate case at
34,076–34,077 now keeps the real ×7 appearance at 34,076 and avoids counting its brightness rebound. Completely identical
replacements at a full stack remain intrinsically difficult when sampled frames supply no independent motion evidence.

### Dust And Black Stone: Remaining Limits

Dust changes include removal of quantity-tail scenery and corrected row assignments through fading-stack shifts.
Net replay Dust increases from 151 to 160. Reviewed failures include ×1 at 5,935, 17,471, 34,052, and 41,917; ×2 at
11,707 and 18,091; and a Dust ×1 row previously read as Branch at 30,457. The final total exceeds the user's inventory
amount by one. Other duplicates, quantities, and session-boundary effects remain unreviewed; this is not a claim that
all Dust is now correct.

Black Stone ×3 at **19,203** was detected with score 346 but failed the old replacement requirement of 392. It now reaches
OCR, where each selected frame contains `Black Stone x 3` and a competing `Black Slone x 2`. It remains withheld. This
explains a concrete three-stone loss but does not establish the cause of the fourth missing stone. The remaining stone
and session differences must not be repaired with inferred quantities.

## Measured Results

Baseline is main `67502a3`; after is the implementation on `feat/ocr-hour-corpus`. Both use the same two new runs, the full
Aphrodon Temple dictionary, production detection/tracking, bundled English Tesseract, and all three thresholds. Offline
replay waits for OCR, so it does not reproduce live queue pressure, cancellation, or ledger-insertion failures.

| Item | User's inventory | User's tracker | Baseline replay | Final replay |
| --- | ---: | ---: | ---: | ---: |
| Branch of Abundance | 19,598 | 20,026 | 19,853 | 19,188 |
| Ancient Spirit Dust | 159 | 152 | 151 | 160 |
| Black Stone | 84 | 80 | 80 | 80 |
| Caphras Stone | 21 | 21 | 20 | 20 |
| WON Origin Shard | 3 | 3 | 3 | 3 |
| Nev's Fragment | 3 | 3 | 3 | 3 |
| Violet Primordial Luster - Sovereign | 1 | 0 | 0 | 1 |

**These aggregate totals are diagnostics, not accuracy scores.** Baseline replay already differs from the live tracker.
Caphras remains 20 in both replays versus 21 in inventory and the live tracker; the missing one is unexplained.
The final Branch total is farther below inventory after removing observed overcounts; unresolved misses and coverage
remain. No implementation constants or corrections were chosen to make these columns agree.

| Measurement | Baseline | Final |
| --- | ---: | ---: |
| Normal candidates | 2,404 | 2,396 |
| Normal OCR jobs | 2,335 | 2,331 |
| Recognized normal results | 2,287 | 2,300 |
| Correct events in 24 reviewed positive windows | 1 / 26 | 26 / 26 |
| Extra candidates in 24 reviewed stationary windows | 24 | 0 |
| Reviewed false ×110 readings still accepted | 7 | 0 |
| Older reviewed rare earring events | Previously 3 / 3 | 3 / 3 |

The positive windows were selected from failures and changes during this investigation. They are development regressions,
not an unbiased holdout or exhaustive event labels. The three older earring examples were visually rechecked in the
current directory before applying their old labels. All 5,127 older pairs were replayed; other old normal events remain
unreviewed overall. The separate historical 35-event video benchmark was not rerun in this investigation.

The final pass reused 2,292 exact OCR inputs from the full preceding pass and ran OCR for 39 changed inputs. Cache keys
include run, source, selected batch IDs, row centers, and complete bounds; detection and tracking ran across every frame
again. A fresh uncached replay is available with the command below.

A small detector-plus-bounded-tracker microbenchmark measured median **0.264 ms/frame before and 0.263 ms/frame after**:
160 real frames, warmup, five alternating measurements per implementation, 800 frame evaluations per measurement in one
Node process. This indicates no material change in that test; it is not a game-FPS, whole-app CPU, or live OCR latency
measurement. Existing frame retention, normal/rare queue limits, shared OCR serialization, and collector buffers remain
bounded. New live cadence and gameplay smoothness need native measurement.

## Reproduction And Verification

Text-only labels: `scripts/fixtures/loot-roi-hour-2026-09-05.json`. Per-run `normalCases` score reviewed windows while the
remaining frames retain diagnostic-only status. Neither annotation files nor generated output need to be inside the corpus.

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --annotations scripts/fixtures/loot-roi-hour-2026-09-05.json --ocr --output /tmp/hour-replay.json
```

Local verification passed: Biome, 231 frontend tests and the production build, Rust formatting, 80 Rust tests (one
opt-in test ignored), Rust Clippy, and Windows cross-target Clippy for all code and test targets. Windows binaries were
not executed. No native Windows capture, WebView2, Windows or Linux gameplay, release package, or installed-app
validation was performed for this change. No GitHub CI was added.
