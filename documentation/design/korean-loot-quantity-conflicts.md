# Korean quantity conflicts

The September recordings expose systematic Korean-font OCR failures at 3440×1440, 80% UI scale. For visible Branch
of Abundance ×10, the three binary 2× line passes repeatedly return `10 / 16 / 10`. Both numbers receive a vote in
every selected frame, so temporal consensus withholds the tied result. The OCR reader's two-matching-threshold
shortcut previously prevented a 4× retry. Additional frames repeat the same error.

For ×190, the crop contains the complete quantity, but binary preprocessing loses small digit shapes. The 2× line
passes mix 1590 and 190, while 4× also introduces 1490 and 130. Preserving grayscale edges in the isolated quantity
crop produces unanimous `190 / 190 / 190` readings.

## Recognition behavior

For Korean normal loot, a two-of-three quantity majority with a different parsed third quantity triggers the existing
three-threshold 4× line pass. It replaces the original readings if all three enlarged passes agree on one positive
safe integer already present in the original readings. This can corroborate an original minority reading: the recorded
Caphras Stone ×11 otherwise produces `11 / 1 / 1`.

If the enlarged line remains inconclusive, shares a possible quantity with the original line, and an automatically
located quantity crop exists, three isolated-digit passes can resolve the conflict. All three must return the same positive safe integer, and that quantity must occur
in both the original and enlarged full-line readings. Only actual enlarged line readings matching the corroborated
quantity are retained. No item text is synthesized, and no missing quantity is invented. Invalid, disagreeing, or
unsupported digit evidence preserves the original line readings. This path takes at most nine OCR passes per frame.

Korean quantity crops now preserve grayscale antialiasing and use bilinear enlargement, reusing the existing pixel
writer in `lootOcrPixels.ts`. Korean full-line preprocessing stays binary. This quantity preprocessing also applies to
Korean's existing weak/unparsed-suffix corroboration, whose acceptance rules remain unchanged. Strong Sword retains
its previous antialiased preprocessing and acceptance rules; gold preprocessing and OCR are unchanged.

The ordinary ×10 recovery still stops after six line passes. Stable Korean readings keep the original fast path.
Temporal item/quantity consensus, including the veto on confidently conflicting frames, remains in force. Quantity
localization, row detection, and arrival tracking are unchanged. Diagnostics retain every raw pass and separately
record the selected final readings; the existing nine-pass metadata limit accommodates this fallback.

## Recorded replay

The supplied runs identify their font as Korean and contain paired normal/rare frames at 16 FPS. Source samples and
logs remain read-only. Reports, probes, and enlarged review crops are under `/tmp/loot-quantities` in the implementation
environment; `large-after.json` and `large-after.jsonl` contain the original two runs, and `182-after.json` /
`182-after.jsonl` contain the corrected third recording.

| Recording | Paired frames | Normal candidates | Recognized before | Recognized after |
| --- | ---: | ---: | ---: | ---: |
| `run-1788955453059-1734491-0004` | 444 | 37 | 35 | 37 |
| `run-1789058186427-49040-0001` | 4,782 | 173 | 125 | 172 |
| `run-1788955377785-1734491-0003` | 408 | 38 | 37 (capture log) | 38 |

The 444-frame recording recovers Caphras Stone ×11 at batch 103686 and Branch of Abundance ×190 at batch 103688. All 47
newly accepted Branch drops in the longer recording show ×10 in their source crops. These two replays gain 660 Branch
and 11 Caphras Stone. The corrected 408-frame run also recovers Ancient Spirit Dust ×2 at batch 102291; all 37
previously accepted item/quantity pairs in its capture log are preserved. Across the original two replays, all previously
accepted item/quantity pairs and candidate IDs/arrival batches are also preserved.
Some events use fewer supplementary observations, so selected-frame metadata can change. None of these recordings produces
a rare candidate. These are candidate replay measurements, not complete session recall or an inventory comparison.

The 444-frame run uses 357 OCR threshold passes versus 354 before. The 4,782-frame run uses 2,136 versus 1,923 (about 11% more),
while selected OCR frames decrease from 620 to 516 because supplementary reads are no longer needed. These counts
measure replay work, not real-time gameplay latency.

The 50 visually reviewed recoveries and one previously recognized ×182 control are in
`scripts/fixtures/loot-korean-quantities-2026-09-10.json`. The fixture checks individual candidate windows rather than treating the entire session as manually annotated. The sole remaining
candidate failure in these runs is insufficient observations at batch 7986 in the longer recording.

## Larger-quantity control

Branch of Abundance ×182 is visible in `run-1788955377785-1734491-0003`, first detected at batch 102544 and selected
for OCR at batches 102546, 102548, and 102550. The source crop at 102546 was visually reviewed. The original capture
log already recognizes ×182 with agreement at all three 2× thresholds in each selected frame. The updated full replay
and production worker preserve that result without additional passes. This provides a real three-digit control for
the ×190 correction; it is not an additional recovered failure.

No source-image ×196 or ×198 example has been located. Synthetic tests exercise the general retry policy for those
quantities but do not establish their real-image accuracy.

## Reproduction

```sh
npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr \
  --annotations scripts/fixtures/loot-korean-quantities-2026-09-10.json \
  --output /tmp/korean-quantities.json --trace /tmp/korean-quantities.jsonl
```

Use fresh report paths outside the source corpus. FFmpeg and the bundled Tesseract language data are required.

## Verification

Frontend checks passed: Biome, 380 tests, and the production build. All 51 labels match the production replays.
Actual Tesseract reads through `createLiveLootTesseractOcr`, using recorded pixels with an in-memory canvas adapter,
confirm ×190, ×11, ×10, ×182, and Ancient Spirit Dust ×2 across their original selected frames. This separately checks
worker parameter restoration and the production preprocessing call path. It is not a native gameplay or browser throughput test.

Tests cover unanimity, retention of unresolved conflicts, rejection of unsafe or unsupported digit quantities, missing
crops, temporal conflict vetoes, diagnostic bounds, and unchanged Strong Sword/gold preprocessing and acceptance.

Full replays of the earlier Korean recording and both earlier Strong Sword recordings retain identical result arrays
compared with the pre-fallback replay, including selected frames and outcomes. Both stored Korean baseline hashes
match, and all 85 prior Strong Sword labels, including reserved validation intervals, remain correct.
