# Korean 6/9 recognition

The September 25 recording (`run-1790368760136-2464682-0001`) uses the Korean font at 3440×1440,
80% UI scale, with compact normal/rare crops and 27,317 paired frames at 16 FPS.
Its small quantity glyphs expose a preprocessing error: converting the text to black and white before enlargement
loses the gray edge pixels that distinguish digits. A visible ×9 can produce unanimous ×8 readings across thresholds
and frames. Conflicting ×6/×8 readings also withhold genuine ×6 drops. Retrying only conflicting quantities cannot
fix a confidently wrong result.

## Change

All white OCR crops now use the existing antialiased pixel writer and bilinear enlargement, including Korean full
lines. Korean still starts with three 2× passes; Strong Sword still starts at 4×. The quantity retry policy,
item dictionary matching, temporal consensus, row tracking, and gold OCR are unchanged. No digit or item substitutions
are added. The preprocessing function no longer needs font/region arguments because both white fonts and crop types
use the same pixel transformation. Its explicit binary option preserves the offline identity benchmark's mask comparison.

## Reviewed samples

`scripts/fixtures/loot-korean-six-nine-2026-09-25.json` contains 86 visually checked event labels:

- The first 40 logged events, including ×9 misread as ×8, withheld ×6/×9, and other item controls.
- All 26 previously recognized quantities above nine, including ×18, ×78, ×87, ×90, ×273, and ×297.
- The last 20 events, reserved from the initial preprocessing probe, including another ×90.

All 86 labels match the complete updated replay. Running their original selected frames through
`createLiveLootTesseractOcr` with real local Tesseract and an in-memory canvas adapter also matches all 86 labels.
Source screenshots and logs remain read-only and are not committed. These labels cover selected event windows,
not independently annotated session recall or inventory totals.

The complete baseline and updated replays produce the same 1,375 normal candidate identities and arrival batches:

| Measurement | Before | After |
| --- | ---: | ---: |
| Recognized normal candidates | 1,108 | 1,371 |
| Correct reviewed labels | 54 / 86 | 86 / 86 |
| Normal frames submitted to OCR | 4,660 | 4,128 |
| Normal OCR threshold passes | 21,723 | 12,402 |

The updated replay changes 191 accepted ×8 readings to ×9 and recovers 261 withheld ×9 drops, one ×6, and one ×90.
All other previously accepted item/quantity pairs are preserved. The rare result is identical. The pass reduction is
about 43%; it measures replay OCR work, not live gameplay latency.

Three normal candidates remain withheld because their selected frames contain different drops: births at batches
5965, 5967, and 16485. Visual inspection of batches 5969/5971 and 16489/16491 confirms that the digits change as
rows move, matching the new OCR readings. The temporal conflict veto correctly preserves those unresolved cases.
Batch 16041 lacks sufficient observations. This change does not alter those tracking decisions.

## Regression checks

All 51 earlier Korean quantity labels pass, including ×10, ×11, ×182, and ×190. The older Korean control recording
still matches its stored normal and rare result hashes. All 85 Strong Sword development and reserved validation labels
also pass. Biome, all 475 tests, and the production build pass; the updated compact-crop tests also pass.
The production worker checks use the same preprocessing as the replay, but do not measure live capture throughput.

## Reproduction

With FFmpeg installed and the bundled Tesseract assets available:

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-korean-six-nine-2026-09-25.json \
  --output /tmp/korean-six-nine.json --trace /tmp/korean-six-nine.jsonl

npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-korean-quantities-2026-09-10.json \
  --output /tmp/korean-quantities.json

npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-strong-sword-2026-09-08.json \
  --output /tmp/strong-sword.json

npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr --validation \
  --annotations scripts/fixtures/loot-strong-sword-2026-09-08.json \
  --output /tmp/strong-sword-validation.json
```

Use fresh output paths outside the corpus. Unit tests cover gray edge preservation at both enlargements, white-text
color filtering, binary gold pixels, crop geometry, and the existing conservative retry and consensus rules.
