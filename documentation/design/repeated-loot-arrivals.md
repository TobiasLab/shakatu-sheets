# Repeated Loot Arrivals

This work starts from main `a5a5b4f`, after PR #26 was rebase-merged, on `feat/repeated-loot-arrivals`.
It addresses new loot rows being missed when they look like existing rows and older entries fade during an arrival.

## Recording And Evidence

The replacement corpus is `run-1788693914800-1530901-0003`: 3440×1440, 80% UI scale, 362×311 normal ROI and
400×100 rare ROI. Its manifest records a completed 1,800-second collection (`deadlineReached`), 14,348 accepted/written
paired batches, no dropped batches, and no write errors. Normal and rare IDs both run consecutively from 16974 to 31321:
28,696 PNGs total. All file references in 1,135 version 2 diagnostic records resolve. Recognition uses one generation.

This establishes coverage of the collection window, not independent inventory totals or exact gameplay session boundaries.
The target is 8 FPS; 14,348 samples over 1,800 seconds is approximately 7.97 FPS. Native batch continuity does not establish
that every in-game animation frame was sampled. The earlier 80%/100% corpus was replaced and is not reused as image evidence.
Original images and logs remain read-only. Generated analysis is outside the corpus under `/tmp/shakatu-arrivals`.

The baseline replay exactly reproduces the recorded normal/rare candidate and recognition counts using the current main
policy. Exact source/batch/row/crop readings can be reused from the logs because OCR preprocessing and consensus are unchanged.
New selections are read using actual Tesseract on the source pixels. Intermediate experiments and contact sheets are not
runtime fixtures or committed captures.

Examples checked against consecutive source images:

- At 27833, another Branch ×4 enters a list of identical rows while the oldest row fades. The prior confirmation rejects
  it because the following frame has fewer detected rows and identical text cannot establish a unique alignment.
- At 27402 and 30221, two new bottom rows arrive together as old rows fade. The prior projection alignment rejects them.
- At 26476 and 29307, a new Branch ×6 replaces another ×6. Its fading predecessor remains visible above the fresh bottom
  row, although the normal detector reports only one row. The previous implementation misses that arrival.
- At 31079, the baseline event incorrectly inherits a later ×6. Separating the arrival at 31080 keeps the original ×4.
- At 19673–19689 and 29188–29203, five identical ×10/×6 arrivals are already counted correctly. Their stationary and fading
  tails are negative controls: no additional events should be invented.

## Implementation

`lootArrival.ts` adds appearance evidence to normal row analysis. It measures a short item-name region at each of the five
known row positions, including faint text above the normal detection threshold's surviving stack. A local-contrast projection
preserves glyph shape while brightness falls; a percentile of column brightness estimates visibility. These signatures are
separate from the existing OCR eligibility and quantity fingerprints. Faint evidence alone cannot supply a recognized quantity.

The arrival check requires an old row's shape at a displaced, fading position and fresh bottom rows that persist into the
next sample. It accounts for already-faint old rows, permits those rows to disappear, and keeps still-bright old rows accounted
for. It chooses the smallest supported displacement when identical rows permit several explanations. A refreshed bottom row
with a fading predecessor above it can establish one replacement even when the detected count stays flat. Global brightening,
unrelated scenery, and a transient bottom flash do not suffice.

The original projection birth rules remain in place. Appearance evidence can add arrivals that those rules miss, and each
confirmed arrival receives its own existing tracker event ID. When only the top entries fade, the surviving bottom tracks keep
their identities rather than being reassigned by small differences between identical text fingerprints. This also prevents
usable short tracks from being discarded before OCR. There are no item-name checks, quantity corrections, or aggregate targets
in this logic. Rare analysis has no normal appearance evidence and retains its existing behavior.

A first experiment overestimated movement when the oldest row was already too faint for normal detection. A broader variant
could discard a still-bright Dust row to explain a larger shift. Both were rejected; exact-batch labels and synthetic tests
cover those cases (17635, 21973, and 25125). Higher recognized counts alone were not used as acceptance evidence.

## Measured Results

The reviewed fixture `scripts/fixtures/loot-arrivals-2026-09-06.json` contains 61 cases and 71 distinct labeled arrivals,
including repeated bursts, mixed items, concurrent arrivals, corrected assignment, and stationary/fading controls. The baseline
recognizes 15/71 correctly; the final replay recognizes 71/71, with no extra events in those reviewed intervals. These cases
were selected for development and failure investigation, not as an independent estimate of whole-session accuracy.

| Normal pipeline | Before | After |
| --- | ---: | ---: |
| Candidates | 1133 | 1179 |
| Events sent to OCR | 1121 | 1176 |
| Recognized events | 1119 | 1174 |
| Insufficient observations | 12 | 3 |
| Other withheld events | 2 | 2 |

There are 55 additional recognized events: 54 Branch drops and one Dust ×2. The separately corrected Branch event changes
×6 to the visually verified ×4. Every other previously recognized item/quantity at its original arrival batch is preserved.
Both rare events remain recognized with their original quantities.

| Item | Logged/baseline sum | Final replay sum |
| --- | ---: | ---: |
| Branch of Abundance | 6525 | 6873 |
| Ancient Spirit Dust | 65 | 67 |
| Black Stone | 33 | 33 |
| Caphras Stone | 7 | 7 |
| Fusion Shard | 1 | 1 |

Empty Picture Frame (9), WON Origin Shard (6), both recorded primordial lusters (1 each), Twilight earring (1), and Embers of
Ynix - Armor (1) are unchanged. These sums describe recorded OCR results; there is no independent inventory count for this run.

## Sampling And Gameplay Cost

The ROI replay now accepts `--sample-step 2 --sample-offset 0|1` to omit alternating frames while retaining original native
batch IDs in reports/traces. This is an offline sampling experiment, not a native capture-rate setting. Using the two phases,
only 58/71 and 55/71 reviewed arrivals produce candidates, even allowing a one-original-frame delay when matching births.
The existing 8 FPS samples support all 71 reviewed arrivals. This argues against reducing the observation rate; it does not
prove that increasing the native rate would help. No higher-rate gameplay recording is available yet. The subsequent 16 FPS trial is described below.

An alternating detector benchmark on 28 decoded empty, active, and fading 80% frames measured 0.372→0.508 ms/frame: 100 warmup
iterations, six alternating rounds of 500 analyses per implementation. The extra approximately 0.136 ms/frame is analysis CPU
time, not a measurement of game FPS or end-to-end capture latency. Recognizing additional real events adds OCR jobs, but the
per-event OCR policy and queue caps are unchanged; only two normal events require the existing supplementary read.

Appearance signatures are computed only when normal rows are detected. Their typed buffers total at most 1,280 bytes per
analyzed frame at the supported scales, with temporary peak arrays released immediately. They follow the tracker's existing
bounded previous/pending-frame lifecycle. The arrival algorithm itself does not enlarge ROI histories or OCR job queues
and introduces no worker, dependency, or database migration. The paired ROI collection feature and Windows/Linux capture paths remain.

## Remaining Limits And Validation

If five opaque identical rows are replaced between samples with no captured movement or visibility change, the images do not
establish how many arrivals occurred. The tracker does not invent five events from an unchanged screen. Tests explicitly cover
that ambiguous case. The current corpus establishes recoverable fading/arrival cases, not a guarantee for every possible
full-list overwrite. The 16 FPS trial needs a new recording and measured gameplay cost to establish its benefit.

Five normal candidates remain withheld: 18071 (conflicting consensus), 21622/25437/27814 (insufficient observations), and 26200
(item not recognized). This change does not relax OCR consensus to accept them. Entirely unseen arrivals can still be absent
from event logs. Independent future recordings remain necessary, especially at 100% scale; the replaced 100% images are no
longer available. Synthetic tests cover both scale geometries and bounded buffers, not native 100% gameplay accuracy.

## Reproduction

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-arrivals-2026-09-06.json \
  --output /tmp/arrivals.json --trace /tmp/arrivals.jsonl

npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot \
  --annotations scripts/fixtures/loot-arrivals-2026-09-06.json \
  --sample-step 2 --sample-offset 0 --output /tmp/arrivals-half-rate.json
```

Use fresh output paths outside the corpus. Repeat the sampling experiment with offset 1. Its exact-batch fixture comparisons
are expected to fail when births are delayed or missing; the sampling results above separately allow a one-frame delay.
Normal full-rate replay should pass this fixture. No original log, screenshot, or generated report belongs in the commit.

## Local Checks

Passed: Biome, 295 frontend tests across 24 files, the production TypeScript/Vite build, Rust formatting, 81 Rust tests
(one ignored microbenchmark), strict native Clippy, and strict Windows cross-target Clippy. Final whole-run replay passes
all 61 reviewed cases and preserves the two rare results byte-for-byte in its result records. Native Windows gameplay
was not run. Source samples/logs and the unrelated pre-existing lockfile change are preserved.

## 16 FPS Capture Trial

After the 8 FPS measurements above, live capture was increased to 16 FPS (62.5 ms per sample) on Linux, Windows, and the
browser fallback. Native sampling and debug manifest rates share one Rust constant; Windows requests the same minimum
update interval and PipeWire requests the same maximum rate. Backpressure and paired PNG queue limits remain unchanged.
The collector still stops after 30 minutes, now targeting 28,800 pairs, and its metadata history is bounded to 32,768 entries
per recognition pipeline. PNG disk work and ROI transport can approximately double; gameplay cost has not been measured.

Normal tracking sees every sample and retains one-sample birth lookahead. The normal entrance delay remains 125 ms.
OCR examines a consecutive stable run, then spaces candidate reads 125 ms apart: three primary reads and at most two extra
reads from the same 625 ms observation span. Intermediate samples must also pass the score and identity checks. The rolling
normal ROI buffer is capped at 12 frames; the rare buffer at eight. Short empty gaps clear tracked rows after four samples
instead of two, preserving the 250 ms threshold. Rare shell confirmation, active lifetime, reappearance gaps, replacement
separation, and the 1.5-second OCR entrance delay are scaled to preserve their prior durations.

Automatic placement keeps its previous evaluation cadence: normal search evaluates every fourth sample and retains up to
24 frames; rare search evaluates every second sample. OCR startup histories retain at most 64 frames per crop (four seconds).
These remain bounded buffers. The normal and rare outstanding OCR job limits remain eight and two respectively.

Historical calibrated profile artifacts remain explicitly 8 FPS. ROI replay accepts either 8 or 16 FPS manifests and uses
the recorded rate for temporal settings. Downsampling a 16 FPS recording with `--sample-step 2` uses the 8 FPS settings;
the earlier 8-to-4 FPS experiment remains a frame-dropping sensitivity check with unchanged 8 FPS timing settings.

The measured totals and 71 reviewed arrivals above are from the real 8 FPS corpus, not a validation of 16 FPS accuracy.
New synthetic regressions cover OCR spacing/read limits, short empty gaps, rare replacement isolation and delayed OCR,
localization cadence, and replay acceptance at both rates. Native Windows gameplay and a real 16 FPS grind still need testing.

Local checks for the 16 FPS trial passed: 307 frontend tests, 81 Rust tests (one ignored), production frontend build,
Biome, Rust formatting, strict native Clippy, and strict Windows MSVC cross-target Clippy. Cross-target checks do not
validate Windows capture during gameplay.
