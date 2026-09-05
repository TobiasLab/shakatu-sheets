# Live Loot UI Scale Support

Normal and rare recognition are enabled at 2560×1440 and 3440×1440 with either 80% or 100% BDO UI scale. Optional
**Adjust automatically** is available for both areas at both scales, including on 1920×1080 capture sources. Recognition
at 1920×1080 remains unavailable. Manual placement remains the default, and changing scale clears confirmation and
requires placement again. The selected scale must match BDO's setting; it is separate from Windows display scaling.

## Geometry And Limits

| Geometry | 80% | 100% |
| --- | --- | --- |
| Native normal crop | 362×311 | 453×389 |
| Normal bottom row center / spacing | 204 / 39 px | 255 / 49 px |
| Normal row score threshold | 196 | 306 |
| Normal glyph half-band / trailing text gap | 6 / 8 px | 8 / 10 px |
| Normal OCR vertical padding | 12 px | 15 px |
| Native rare crop | 400×100 | 500×125 |
| Native search area | 800×600 | 800×600 |

The 100% settings derive from the 80% measurements with a 1.25 spatial factor, rounding to source pixels; area-based
thresholds use its square. The normal profile's optional `pixelScale` field controls glyph neighbors, vertical bands,
text-gap fingerprints, and OCR padding. Omitted values preserve existing 80% behavior. The profile artifact reader accepts
only 1 or 1.25 when supplied. Rare shell, border, and OCR bounds have a separate native 100% geometry.

No frame resampling is introduced. OCR reads original native crop pixels. Both localizers use scale-specific geometry,
and normal localization replays exact native crops from its bounded search history. The native search command carries
the selected UI scale and validates either 80 or 100 while retaining the 800×600 search limit. Frame retention, candidate
history, temporal confirmation, OCR passes, queue limits, and capture cadence are unchanged. Larger native crops increase
per-frame work and storage in proportion to their dimensions; there is no extra full-screen pixel readback.

## Verification And Remaining Evidence

All six manifests in the supplied live corpus record 3440×1440 at 80% UI scale. They do not validate 100% detection.
The new 100% profile is **enabled but provisional**, rather than a measured calibration. Actual 100% gameplay recordings
are still needed to assess font rasterization, row alignment, fading, moving scenery, quantities, and rare banners.
The same applies to native Windows gameplay; cross-target compilation and browser fixtures cannot establish it.

Local checks passed: 244 frontend tests, the production build, Biome, Rust formatting, 80 Rust tests (one optional
microbenchmark ignored), Rust Clippy, and Windows cross-target Clippy for code and test targets. New tests exercise
native five-row detection, OCR bounds and event delivery with controlled OCR readings, normal/rare automatic placement,
crop-edge bounds, rare confirmation, empty frames, bounded history, profile serialization, and both native search scales.
ROI CLI tests decode paired 100% crops for both 1440p widths and verify reviewed missing events cause failure.

Browser smoke fixtures passed all four 1440p width/scale combinations, exercising both backend capability paths:
2560×1440/100% and 3440×1440/80% with Windows capabilities; the other two with Linux capabilities. They check scale changes,
manual defaults, automatic normal placement and relocation, rare search/cancel/confirmation, source-pixel crop sizes,
preview suppression, and capture lifecycle. Reproduce with `UI_SMOKE_SOURCE=2560x1440 UI_SMOKE_SCALE=100
UI_SMOKE_BACKEND=windows npm run test:ui` while Vite and a Chromium debugging session are running.

A direct comparison against main `99f6f6d` on 186 unchanged real 80% frames found identical detected rows, scores,
fingerprint projections, and tracked events. These are six 31-frame windows around native batches 5935, 9147, 18091,
19203, 37980, and 43351. The full hour OCR replay was not repeated for this scale change. An alternating warm detector
microbenchmark on those frames measured median 0.334 ms/frame before and 0.356 ms/frame after (five rounds, 744 frames
per measurement). This measures detector cost only, not gameplay FPS, OCR latency, or 100% performance.

Generated comparisons and browser outputs are under `/tmp/shakatu-scale-*`; source samples are unchanged.
