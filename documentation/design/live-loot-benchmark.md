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
appearing in different splits.

Set `baseline` to `true` when a row is already visible in frame 0. It must be tracked until it disappears but must not emit
a new event. Set `truncated` to `true` when the segment ends before a row disappears; its recorded `lastFrame` is the final
available frame rather than the row's actual lifetime.

## Row Tracker

Run the initial row detector and temporal tracker against generated frames with:

```sh
npm run benchmark:loot:track -- /path/to/benchmark-output/manifest.json
```

The benchmark calibrates row geometry and the row threshold exclusively from development segments. Replacement tracking
uses a text-focused signature, minimum average row strength, and maximum fade drop. Contact-sheet enlargement is never
passed to the detector. Use `--development-only` while tuning so held-out segments are not evaluated accidentally.

## Stable-Row OCR

Run dictionary-constrained item and quantity OCR against each event's annotated stable frames with:

```sh
npm run benchmark:loot:ocr -- /path/to/benchmark-output/manifest.json
```

The benchmark creates one local Tesseract worker, processes three adjacent stable frames at three brightness thresholds,
and requires a unique consensus supported by at least two readings. It parses the terminal `x <quantity>` suffix and
fuzzy-matches the preceding text against `itemDictionary`. The development-supported `x |` and `x I` readings are treated
as quantity `1`. Invalid, distant, or tied readings are withheld rather than guessed. Use `--development-only` while
tuning OCR gates.

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

OCR gates were tuned only on development events and frozen before evaluating OCR output from the test sequence.

| Split | Items | Quantities | Complete stable-row OCR |
| --- | ---: | ---: | ---: |
| Development | 24/24 | 24/24 | 24/24 |
| Test | 11/11 | 11/11 | 11/11 |

No OCR reading was wrong or withheld in these sequences. This measures annotated stable-row crops, not end-to-end live
recognition: the OCR benchmark uses labeled event lifetimes to select rows, while the tracker is evaluated separately.
Production must connect tracked event IDs to stable frames without labels and use a native-resolution capture ROI.
