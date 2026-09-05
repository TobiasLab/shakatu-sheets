# Paired 80% / 100% OCR Corpus — September 5, 2026

## Corpus And Scope

This investigation starts from `cdaf8e2` on `feat/ocr-scale-log-corpus`. It uses the replacement corpus at
`/home/agent/Projects/shakatu_sheets_pics/automatic_recognition_pics/roi_live_samples/dev-samples/live-loot`.
Earlier corpus annotations refer to different images and were not reused. No inventory totals were supplied for these
runs; replay counts are diagnostic output, not independently verified inventory or whole-session accuracy.

Both manifests record **3440×1440**. The newest recording is 100% UI scale, as expected.

| Recording | 80% | 100% |
| --- | --- | --- |
| Run | `run-1788631566956-9757-0001` | `run-1788636972715-150189-0001` |
| Native batch IDs | 1519–15209 | 2175–10640 |
| Paired batches | 13,691 | 8,466 |
| PNGs, normal plus rare | 27,382 | 16,932 |
| Approximate recorded span | 28m37s | 17m58s |
| Normal crop | 362×311 | 453×389 |
| Rare crop | 400×100 | 500×125 |
| Collector finish reason | `selectionChanged` | `explicitlyStopped` |
| Diagnostic entries | 39 | 29 |

Spans use first/last PNG modification times, not exact gameplay or session timestamps. The collector was configured for
8 FPS and a 30-minute deadline. Both runs have consecutive, unique native IDs, complete normal/rare pairing, matching
accepted/written counts, zero collector drops, and no recorded writer errors. This establishes recorded sample coverage;
it does not establish that collection began with grinding or contains an entire tracker session. Capture was already
running before collection began.

All 68 diagnostic lines parse, and every first/selected frame reference resolves. There are no null file references in
these completed logs. Original absolute collection paths refer to another machine; matching used the supplied run,
native batches, and event order. Multiple rows can share selected batches, so batch tuples alone are insufficient to
identify a logged event. Original images and JSONL files were only read. Generated analysis is under
`/tmp/shakatu-ocr-scale-logs`.

## Baseline

The entire paired corpus was replayed through the unchanged production detector/tracker before OCR experiments. Candidate
metadata preserved the actual selected frames, row centers, and crop bounds. OCR then compared 4× and 2× enlargement for
**every selected job**, using the bundled Tesseract English model and production temporal consensus. Evaluation of the
final retry policy reused those actual per-frame readings through the production helper and consensus functions.

| Pipeline | Frames | Candidates | OCR jobs | Insufficient observations |
| --- | ---: | ---: | ---: | ---: |
| 80% normal | 13,691 | 1,133 | 1,118 | 15 |
| 80% rare | 13,691 | 1 | 1 | 0 |
| 100% normal | 8,466 | 614 | 609 | 5 |
| 100% rare | 8,466 | 0 | 0 | 0 |

This covers 44,314 images and 1,728 OCR jobs. Replay waits for OCR and does not simulate real-time queue pressure.
All 48 logged OCR failures reproduce with the baseline settings. Logs contain withheld/failed/dropped results, so they
cannot expose a confidently wrong accepted quantity or an event the detector never created.

The 80% log contains 12 consensus failures, one unparsed quantity, 11 dictionary rejections, and 15 insufficient tracks.
At 100%, there are 23 consensus failures, one dictionary rejection, and five insufficient tracks. No OCR exception or
queue overflow appears in these logs.

## Implementation And Evidence

Normal OCR now starts at **2× enlargement**. The existing three thresholds (130, 150, 170), native crops, and dictionary
remain unchanged. At 80%, this resolves repeated ×10/×110 conflicts and unreadable ×58. At 100%, it resolves many actual
×6 glyphs previously read as ×8. Reviewed examples include native first batches 2443, 4421, and 13859 at 80%, and 2332,
3082, and 4183 at 100%.

Reducing enlargement alone introduced errors and was rejected as the final policy. In particular, some upper-row ×6
glyphs became repeated single-threshold ×5 readings. Each normal frame therefore retries the three thresholds **once at
4×** if the primary pass has no two matching parsed quantities. The retry replaces that frame's readings if it parses
any quantity; otherwise the primary readings survive. This preserves weak but usable readings such as 80% batch 13884,
while restoring the original readable ×6 at batch 14425 and avoiding the newly introduced ×5 results. This is a generic
preprocessing choice, not a digit substitution or inventory adjustment.

`readLootOcrFrame` shares this policy between live recognition and `benchmark:loot:roi`. Gold rare OCR retains three 4×
passes without retries. Frame selection, the serialized worker, cancellation, ROI collection, queue limits, and capture
behavior remain intact. The retry uses the same canvas and retained source frame; it does not retain additional captures.
It is bounded to six OCR passes per normal frame, or eighteen per three-frame event.

Temporal acceptance still requires a unique leading item/quantity pair from at least two distinct frames. A majority of
threshold readings within any selected frame that consistently names a different pair now vetoes acceptance. For example,
100% batch 3745 shows ×4, while the same selected row in 3746–3747 shows ×6. Counting ×6 by temporal majority would conceal
that the track changed identity. The guard withholds it. Unreadable passes and a single outlying threshold do not impose
that veto; they still participate in the existing temporal support rules.

The underlying tracking limitation is real: around 3745–3746, the fingerprint distance between ×4 and ×6 is only about
0.062, below the 0.1 continuity boundary. The quantity projection includes shared item-name strokes, which dilute the
changed digit. This change adds a conservative acceptance guard; it does not recalibrate fingerprints or claim to repair
those missed stack transitions.

## Final Results

| Normal OCR outcome | 80% | 100% |
| --- | ---: | ---: |
| Baseline accepted jobs | 1,094 | 585 |
| Final accepted jobs | 1,106 | 595 |
| Logged failures recovered with reviewed quantities | 13 | 19 |
| Previously accepted ×8 corrected to reviewed ×6 | 0 | 11 |
| Previously accepted mixed-row results now withheld | 1 | 9 |

The recovered 80% quantities are nine ×10 events, ×58, ×50, ×6, and ×4. All nineteen recovered 100% quantities are ×6.
The ten newly withheld results contain selected frames from different quantities: 80% first batch 13881; 100% first
batches 3115, 3734, 3750, 4485, 5143, 5687, 6125, 7039, and 7167. These are detection/tracking ambiguities, not proof that
each underlying drop was false. Withholding can reduce recall; it prevents assigning an uncertain quantity to that event.

Replay item totals follow. These are **not inventory truth** and were not used as optimization targets.

| Item | 80% before → after | 100% before → after |
| --- | ---: | ---: |
| Branch of Abundance | 8,641 → 8,840 | 3,156 → 3,198 |
| Black Stone | 48 → 48 | 33 → 33 |
| Ancient Spirit Dust | 81 → 81 | 33 → 33 |
| Caphras Stone | 21 → 21 | 0 → 0 |
| WON Origin Shard | 4 → 4 | 2 → 2 |
| Corrupt Oil of Immortality | 2 → 2 | 1 → 1 |
| Nev's Fragment | 1 → 1 | 0 → 0 |
| Twilight of the End - Earring, rare pipeline | 1 → 1 | 0 → 0 |

The single rare candidate was visually verified as Twilight of the End - Earring ×1. No rare positive was detected in the
100% run; that is insufficient evidence to measure rare recall. No dust, stone, Caphras, shard, oil, or fragment replay
quantity changed.

The final shared policy was also rerun with actual Tesseract on **160 normal jobs**: the focused logged failures and
uniformly spaced controls, supplemented with every changed previously accepted result. All 160 matched the staged final
evaluation. The image-free annotation file `scripts/fixtures/loot-roi-scales-2026-09-05.json` contains 26 reviewed normal
recoveries and one rare event; all 27 match the final replay. The remaining recovered cases share first batches with other
rows and are not represented as single-event annotations. These are narrow reviewed cases, not exhaustive run labels.

## Cost And Remaining Uncertainty

At 80%, 64 of 3,354 selected normal frames retry (1.9%); at 100%, 539 of 1,827 retry (29.5%). The larger fraction at 100%
reflects weak or ambiguous upper-row glyphs. Across both runs, normal OCR performs 17,352 threshold passes versus 15,543
before. Most passes use smaller images; the maximum per-image allocation remains the existing 16 MiB bound.

In the final 160-job verification subset, mean offline OCR job time was approximately 179 → 146 ms for 80% (72 jobs), and
197 → 215 ms for 100% (88 jobs); medians were 178 → 143 ms and 201 → 207 ms respectively. These separate runs and selected
cases are not a controlled gameplay performance benchmark. In particular, the retries can cost more CPU at 100%.
There is still one serialized worker and a hard retry bound; no additional parallel OCR or capture work was introduced.
Native Windows gameplay, game FPS, and real-time queue pressure were not measured.

Known limitations remain:

- Empty Picture Frame ×1 is visibly present and often read exactly, but is absent from the selected Aphrodon dictionary.
  All twelve dictionary rejections concern this item. It was not assigned invented pricing or item metadata.
- Two reviewed 100% ×6 events, first batches 7028 and 7032, still produce the baseline ×8 after the conservative retry.
  This establishes remaining accepted quantity errors; the corpus does not support a whole-run precision claim.
- Twenty insufficient tracks remain. Representative images include scenery before a notification (80% batch 1947),
  a stats panel covering rows (100% batch 4057), and bright scenery over existing loot (100% batch 4293). They are not all
  missed new drops. Fast real row changes also occur around 80% batches 13880–13883 and 100% 9805; further tracking work
  needs event-level annotations rather than treating every diagnostic line as one missing drop.
- Baseline suppression, detection omissions, and duplicate candidates cannot be fully assessed from failure logs alone.
  This change does not alter detection counts or repair missing session coverage.
- The genuine new recordings validate normal 3440×1440 crops at both scales. There is no new 2560×1440 recording or
  positive 100% rare banner. Windows capture code was unchanged; Linux testing is not Windows gameplay validation.

## Local Verification And Reproduction

Local checks: Biome, 254 frontend tests, TypeScript/Vite production build, Rust formatting, 80 Rust tests (one optional
microbenchmark ignored), and Rust Clippy. Retry tests cover preserving weak primary readings, hard pass limits, unchanged
gold behavior, conflicting quantities, live retry canvas dimensions/filtering, and cancellation during the retry. No GitHub CI was added.

Reproduce the complete ROI replay with the original corpus available:

```sh
npm run benchmark:loot:roi -- \
  /home/agent/Projects/shakatu_sheets_pics/automatic_recognition_pics/roi_live_samples/dev-samples/live-loot \
  --ocr --annotations scripts/fixtures/loot-roi-scales-2026-09-05.json \
  --output /tmp/shakatu-scale-ocr-replay.json
```

Analysis artifacts include `inventory.json`, `baseline-detection.json`, `baseline-jobs.jsonl`, `full-comparison.jsonl`,
`final-analyzed.json`, and `final-verification.jsonl` under `/tmp/shakatu-ocr-scale-logs`. The baseline detector covered both
complete runs; OCR comparisons covered every selected job. The command above is the standalone reproduction path, not a
claim that the staged analysis measured live scheduling.
