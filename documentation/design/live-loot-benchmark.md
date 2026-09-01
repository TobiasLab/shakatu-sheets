# Live Loot Benchmark

The live-loot benchmark uses short, labeled sequences from user-provided recordings. Videos and extracted pixels stay
outside the repository. Git contains only generalized sampling and recognition code.

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

Development annotations calibrate only row geometry and the occupancy threshold. Inference then operates on decoded
frames, the frozen calibration, and `itemDictionary`: an ordered stack tracker assigns event IDs, treats frame-zero rows
as baselines, preserves retained identities when rows shift upward, and confirms detected births against the following
frame before appending them at the bottom. Each event uses the first three consecutive detected row observations after its
entrance frame. OCR accepts only an item-and-quantity pair supported by at least two distinct frames, so independently
conflicting item and quantity readings cannot be combined. Labels are joined only after inference for chronological
scoring. The tracker and end-to-end commands decode packed RGBA frames and call the browser-safe production analyzer,
tracker, and OCR parsers in `src/recognition/liveLoot.ts`; the benchmark is therefore a replay adapter around the production
core rather than a separate implementation. Use `--development-only` while tuning.

## Native-Resolution Baseline

The 3440x1440, 80%-UI-scale benchmark contains two development sequences and one test sequence. The original validation
sequence was promoted to development after its failures were inspected. The replacement gates were then frozen before
the `118-128` second test sequence was labeled or evaluated.

| Split | Event matches | Row-count frames |
| --- | ---: | ---: |
| Development | 24/24 | 146/176 |
| Test | 11/11 | 67/80 |

No event was missed, duplicated, or invented. Row-count accuracy is lower because nearly transparent rows near the end of
their fade are often omitted; this did not change event identity in the measured sequences. More recordings and an
independently calibrated 16:9 layout are still required before treating these numbers as release accuracy.
Multiple births hidden by expirations are inferred only when at least one retained row visually anchors the stack
transition. A simultaneous full-stack replacement has no such anchor and is conservatively undercounted rather than
inventing events from fade noise; that case needs explicit benchmark coverage before release.
One completely empty detector frame preserves the prior stack when its rows visually recover. Ambiguous partial
under-detection may shorten an affected track and withhold recognition, while a persistent identical count increase is
treated as a new drop because pixels alone cannot distinguish it from a previously missed identical baseline row.

OCR gates were tuned only on development events and frozen before evaluating OCR output from the test sequence.

| Split | Items | Quantities | Complete stable-row OCR |
| --- | ---: | ---: | ---: |
| Development | 24/24 | 24/24 | 24/24 |
| Test | 11/11 | 11/11 | 11/11 |

No OCR reading was wrong or withheld in these sequences. The stable-row OCR command remains an oracle component test that
uses labeled event lifetimes. The end-to-end gates were subsequently frozen on development before their first test run.

| Split | Detected events | Complete end-to-end recognition |
| --- | ---: | ---: |
| Development | 24/24 | 24/24 |
| Test | 11/11 | 11/11 |

The end-to-end command selected every row and OCR frame without event labels, with no missed, invented, wrong, or withheld
test events. Production still needs a native-resolution capture ROI and must be evaluated on more recordings, UI scales,
and aspect ratios before these small-set results can be treated as release accuracy.
