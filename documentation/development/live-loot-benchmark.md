# Live Loot Benchmark

The live-loot benchmark uses short, labeled sequences from user-provided recordings. Videos and extracted pixels stay
outside tracked source. Git contains only generalized sampling and recognition code; the development collector writes to
the ignored `dev-samples/live-loot/` directory.

## Requirements

Install FFmpeg so `ffmpeg` and `ffprobe` are available. The sampler verifies the input metadata, samples only selected
time ranges, crops the notification region at the encoded resolution, and writes deterministic PNG sequences.

Run it with:

```sh
npm run benchmark:loot:sample -- /path/to/manifest.json
```

Pass `--output /path/to/output` to override the default `benchmark-output` directory beside the manifest.

## Source Manifest

Coordinates are normalized against the encoded video, not a specific monitor size. Physical display dimensions and BDO
UI scale remain separate metadata so an ultrawide recording is never stretched into a 16:9 test case.

```json
{
    "version": 1,
    "source": "grind-session.mp4",
    "display": { "width": 3440, "height": 1440 },
    "recording": { "width": 3440, "height": 1440 },
    "uiScalePercent": 80,
    "sampleFps": 8,
    "maxRows": 5,
    "itemDictionary": ["Ancient Spirit Dust", "Black Stone", "Branch of Abundance"],
    "roi": { "x": 0.7075, "y": 0.6875, "width": 0.105, "height": 0.2153 },
    "segments": [
        {
            "id": "consecutive-identical-drops",
            "startSeconds": 22,
            "endSeconds": 31,
            "split": "development",
            "events": []
        }
    ]
}
```

Each resolution and UI layout needs its own calibrated normalized ROI. A future 16:9 recording should use the same
manifest format with its actual display dimensions, encoded dimensions, UI scale, and independently selected ROI.
`itemDictionary` is the recognition candidate set known independently of event labels, such as the active grind spot's
configured drops. It is optional for sampling and tracking but required for OCR. When provided, every labeled event item
must appear in it.

## Generated Data

The sampler creates one directory per segment and a generated `manifest.json` containing the probed codec, duration,
frame rate, pixel crop, and frame count. Each segment also includes numbered contact sheets that enlarge the native crop
for annotation review. Recognition continues to use the unscaled PNG frames. At 8 FPS, frame index `n` represents
approximately `startSeconds + n / 8` seconds in the source.

Annotate each event after sampling:

```json
{
    "id": "branch-of-abundance-001",
    "item": "Branch of Abundance",
    "quantity": 2,
    "firstFrame": 10,
    "stableFrame": 14,
    "lastFrame": 45
}
```

Event IDs describe appearances, not item names. Two consecutive identical drops must have different event IDs. Keep
development, validation, and test segments separated by time range to prevent nearly identical neighboring frames from
appearing in different splits. List events by `firstFrame`; when multiple events begin on the same sampled frame, list
them in their displayed top-to-bottom order. The tracker and OCR commands validate generated annotations before decoding.

Set `baseline` to `true` when a row is already visible in frame 0. It must be tracked until it disappears but must not emit
a new event. Set `truncated` to `true` when the segment ends before a row disappears; its recorded `lastFrame` is the final
available frame rather than the row's actual lifetime.

## Row Tracker

Run the initial row detector and temporal tracker against generated frames with:

```sh
npm run benchmark:loot:track -- /path/to/benchmark-output/manifest.json
```

The benchmark calibrates row geometry and the row threshold exclusively from annotated development segments. Replacement
tracking uses text-focused signatures for the bottom row and the full stack, a brightness-reset signal, minimum average
row strength, and maximum fade drop. Contact-sheet enlargement is never passed to the detector. Use `--development-only`
while tuning so held-out segments are not decoded or evaluated accidentally.

## Stable-Row OCR

Run dictionary-constrained item and quantity OCR against each event's annotated stable frames with:

```sh
npm run benchmark:loot:ocr -- /path/to/benchmark-output/manifest.json
```

The benchmark creates one local Tesseract worker, processes three adjacent stable frames at three brightness thresholds,
and requires a unique consensus supported by at least two distinct frames. It parses the terminal `x <quantity>` suffix and
fuzzy-matches the preceding text against `itemDictionary`. The development-supported `x |` and `x I` readings are treated
as quantity `1`. Invalid, distant, or tied readings are withheld rather than guessed. Use `--development-only` while
tuning OCR gates. A wrong or withheld held-out item or quantity makes the command exit unsuccessfully.

## End-To-End Recognition

Run tracker-selected item and quantity recognition with:

```sh
npm run benchmark:loot:e2e -- /path/to/benchmark-output/manifest.json
```

Export a versioned production detector profile from a passing benchmark with:

```sh
npm run benchmark:loot:e2e -- /path/to/benchmark-output/manifest.json --profile-output /path/to/live-loot-profile.json
```

Development annotations calibrate only row geometry and the occupancy threshold. Inference then operates on decoded
frames, the frozen calibration, and `itemDictionary`: an ordered stack tracker assigns event IDs, treats frame-zero rows
as baselines, preserves retained identities when rows shift upward, and confirms detected births against the following
frame before appending them at the bottom. Each event uses the first three consecutive detected row observations after its
entrance frame, with adjacent fingerprints required to remain visually consistent. OCR accepts only an item-and-quantity pair supported by at least two distinct frames, so independently
conflicting item and quantity readings cannot be combined. Labels are joined only after inference for chronological
scoring. The tracker and end-to-end commands decode packed RGBA frames and call the browser-safe analyzer, tracker, and OCR
parsers in `src/recognition/` (`liveLoot.ts`, `lootRowTracker.ts`, `lootReadings.ts`), but with the tracker's
defaults: projection identity distance, a two-frame empty limit, single-frame steps, and three-frame OCR selection
without supplementary frames. Live capture configures
these through `LiveLootCoordinator` instead (row identity distance, a four-frame limit and two-frame steps at 16 FPS, and
supplementary frames). Use the [ROI sample replay](#roi-sample-replay), which runs the coordinator, to measure the
production configuration. Use `--development-only` while tuning.
Profile export is disabled in development-only mode and occurs only after Tesseract terminates, every validation/test
segment has exact event detection and item-and-quantity recognition with no missed or invented tracks, and at least one
non-baseline event exists across those held-out splits. A test split alone satisfies the held-out requirement. The V1
artifact contains only source dimensions, UI scale, 8 FPS sampling metadata, and OCR-safe detector geometry; it excludes
recording paths, labels, dictionaries, ROI positions, and benchmark metrics.

## ROI Sample Replay

Replay the developer collector’s paired PNG runs with the actual `LiveLootCoordinator`, bundled detection profile,
production OCR preprocessing, local Tesseract worker, and production consensus parser:

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr --output /tmp/loot-development.json
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --validation --ocr --output /tmp/loot-validation.json
```

The directory must contain run directories with `manifest.json`, `normal/minute-*`, and `rare/minute-*`. Supply version-1
annotations through `annotations.json` in the sample directory or an explicit `--annotations` path. The replay validates
the capture version, source resolution, UI scale, sample rate, contiguous matching normal/rare batch IDs, and crop
dimensions against that resolution/scale registry entry. Files are enumerated and piped as an
ordered PNG stream into FFmpeg, including on Windows without glob support. It streams frames
through a bounded decoder and waits for pending OCR before advancing, so these are accuracy measurements, not a live
throughput benchmark. Omit `--ocr` for detection and selected-window diagnostics. Output files must not already exist.

Only explicitly reviewed event lists are scored. Empty event arrays on unreviewed normal runs are **not** negative labels.
The small manually inspected development intervals in `scripts/fixtures/loot-roi-cases.json` add coverage for scenery,
simultaneous identical drops, three consecutive drops, camera movement, and arrivals overlapping expiry. Those labels
contain batch IDs and expected items, not captured pixels. They are development regression cases, not an independent
accuracy estimate. Original PNGs and generated reports remain outside tracked source.

### Self-improvement replay

Add `--learning /path/to/learning.json` (with `--ocr`) to replay self-improvement over the normal-loot events of each run:

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr --learning /tmp/loot-learning.json
```

It only observes. The coordinator gets no learning callback, so recognition results match a run without the option. OCR
passes are recorded, as in the app, so saved capture evidence can include them. Events are processed in order. Each
event is first matched against the library built from the earlier events, both as the Needs attention prefill (one crop)
and as automatic recovery (every OCR frame and reading, with Auto allow on). Then a recognized event teaches its OCR label
through the same crops and storage rules the app uses. This treats every drop as confirmed, so it measures the matcher on
real crops and how quickly labels become eligible. Real users only confirm unresolved drops, so it gives no expected
recovery rate. The report scores prefills and automatic recoveries against the OCR labels. It also lists unresolved
events with the suggestion they would receive, and fails the command on any wrong automatic recovery.

## Regression fixtures

Use `--annotations scripts/fixtures/<fixture>.json` to select reviewed labels without modifying a source corpus.
The corresponding original recordings are required; the fixture files contain no pixels. These recordings are the
maintainer's and are not published, so contributors without them should benchmark recordings of their own.

| Fixture | Coverage |
| --- | --- |
| `loot-roi-2026-09-05.json` | Refreshed ROI corpus |
| `loot-roi-hour-2026-09-05.json` | Hour-corpus investigation |
| `loot-roi-scales-2026-09-05.json` | Paired 80% and 100% scales |
| `loot-roi-improvements-2026-09-05.json` | Quantity and tracking regressions |
| `loot-arrivals-2026-09-06.json` | Repeated and overlapping arrivals |
| `loot-strong-sword-2026-09-08.json` | Strong Sword font and tinted text |
| `loot-korean-quantities-2026-09-10.json` | Korean quantity conflicts and multidigit controls |
| `loot-korean-six-nine-2026-09-25.json` | Korean gray-edge preservation and quantity controls |

For example:

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-korean-six-nine-2026-09-25.json \
  --output /tmp/korean-six-nine.json --trace /tmp/korean-six-nine.jsonl
```

Add `--validation` for reserved annotations where available. `--trace` records selected frames, row bounds, readings,
and available pass metadata. Use fresh output paths outside the source corpus.

For offline sampling sensitivity, use `--sample-step 2 --sample-offset 0`, then repeat with offset 1. Reports retain
native batch IDs and distinguish recorded from replayed frames. Exact-batch fixtures can fail when sampling delays or
misses an arrival; this experiment does not change live capture settings.

Run the separate digit-identity comparison with:

```sh
npm run benchmark:loot:identity -- /path/to/dev-samples/live-loot --output /tmp/identity.json
```

Reviewed windows and development regressions do not establish full-session recall. Events never detected can be absent
from logs, and recognized-event totals are not independent inventory truth. Keep held-out recordings separate from
tuning data. See [recognition limits](../architecture/live-loot.md#validation-limits) and the
[game-impact protocol](performance.md) for validation beyond offline replay.
