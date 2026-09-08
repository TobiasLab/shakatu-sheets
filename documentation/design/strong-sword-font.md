# In-game font recognition

Settings → Capture provides **Korean Font** and **Strong Sword**. Korean is the default for existing installations.
The SQLite `loot_font` setting stores `korean` or `strong-sword`; no schema migration is needed. Rust validates writes
as an enum. Invalid stored values produce an actionable settings error rather than starting with an unintended font.
The preference loads before capture can start. Saves are ordered and included in the app's save-before-close handling.

Each capture snapshots the selected font at startup. Changing the preference does not restart a worker, clear tracking,
or alter an active capture. The saved selection applies when capture next starts. The game itself requires a restart
when changing its font.

## Detection behavior

Korean uses the existing row geometry, pixel thresholds, fingerprints, quantity localization, binary OCR preprocessing,
retry policy, and consensus rules. The new optional detection/OCR font arguments default to Korean. There are no model
changes or per-item quantity corrections.

Strong Sword uses a four-native-pixel word gap at 80% scale when separating the quantity marker, compared with the
existing Korean five-pixel threshold. This is scaled with UI size. Row detection and automatic placement otherwise retain
the existing geometry and rules. Native recording logs showed quantity bounds in only 56 of 1,488 selected Strong Sword
frames, compared with 276 of 290 selected Korean frames; these are diagnostic coverage counts, not accuracy measurements.

For normal Strong Sword OCR, preprocessing preserves grayscale antialiasing and uses bilinear 4× enlargement instead of
thresholding to binary pixels before nearest-neighbor enlargement. The three existing pass thresholds select contrast floors
of 60, 80, and 100, with the white-text level capped at 235 and the existing color rejection retained. This addresses visible
6s being read as 4s or ampersands. It also avoids repeating the same 4× line pass as a retry. The existing conservative
quantity-corroboration rule still requires a number already read from the full line; standalone digits cannot invent a result
or override a conflict. Normal Strong Sword requires at most six OCR passes per selected frame. Gold/rare OCR remains on
the original preprocessing and pass policy for both fonts.

100% UI scale remains available using the existing scaled geometry and quantity-gap scaling. The real recordings below
cover 80%; synthetic tests cover 100%, but real-game Strong Sword accuracy at 100% is not established by these samples.

Active font metadata is saved in future ROI manifests and OCR issue records. Old records without a font remain readable
as Korean. Replay annotations can explicitly identify a legacy Strong Sword recording without modifying source samples.

## September 8 validation

Source images remained read-only under
`/home/agent/Projects/shakatu_sheets_pics/automatic_recognition_pics/roi_live_samples/dev-samples/live-loot`.

| Recording | Font | UI scale | Paired batches | Recorded rate |
| --- | --- | --- | --- | --- |
| `run-1788691911921-1530901-0001` | Korean | 80% | 2,137 | 8 FPS |
| `run-1788894195425-217625-0001` | Strong Sword | 80% | 10,848 | 16 FPS |

The baseline recognition path is the Korean configuration from main `149bc5b`. Reports, raw traces, and review contact sheets are under `/tmp/strong-sword` in
the implementation environment. They are not repository assets. Korean replay results match exactly, including selected
frames, outcomes, quantities, and review captures: 100 normal candidates (94 recognized) and no rare candidates. A separate
comparison against the untouched source snapshot also matched every one of the 2,137 normal frame analyses and 372 sampled
preprocessed OCR images byte for byte.

The full Strong Sword replay retained 436 normal candidates and increased recognized candidates from 365 to 433. Its one
rare candidate remained recognized. These counts alone do not prove accuracy or complete recall. Two remaining normal
candidates are items outside the current grind-spot dictionary (Intricately Patterned Mystical Shard and Laila’s Petal),
and one has insufficient observations. The implementation does not weaken acceptance to admit them. The replay dictionary
includes Empty Picture Frame, which the app already supports.

Review annotations are in `scripts/fixtures/loot-strong-sword-2026-09-08.json`. They cover consecutive candidate sequences,
with item names and quantities read from recorded image crops, rather than copied from OCR output. Development covers
batches 8800–9500. Reserved validation covers 16000–16700 and 18700–19000, outside the preprocessing experiments.

| Reviewed sequence | Expected events | Baseline correct | Baseline wrong accepted | Baseline withheld | Strong Sword correct |
| --- | --- | --- | --- | --- | --- |
| Development | 31 | 15 | 10 | 6 | 31 |
| Validation | 41 | 22 | 18 | 1 | 41 |

The new results have no wrong accepted quantities, missing annotated events, or extra candidates within these reviewed
intervals. Coverage includes repeated identical quantities, 4/6 distinctions, several item names, and ×180. This is not a
fully annotated grind or an inventory comparison; a notification missed by both detector runs could remain outside these
candidate-based labels. Wider real-game validation, particularly 100% scale and rare drops, remains useful.

## Reproduction

Use the read-only sample root as the first argument:

```sh
npm run benchmark:loot:roi -- /path/to/live-loot --annotations scripts/fixtures/loot-strong-sword-2026-09-08.json --ocr --output /tmp/font-development.json
npm run benchmark:loot:roi -- /path/to/live-loot --annotations scripts/fixtures/loot-strong-sword-2026-09-08.json --validation --ocr --output /tmp/font-validation.json
```

The fixture also stores SHA-256 baselines of the complete Korean result arrays, including selected frames and review
captures. At the original sampling rate with `--ocr`, the replay fails if either Korean digest changes. Runs without OCR or with
subsampling skip the full-OCR digest comparison. Reviewed intervals still fail for missing/extra candidates, and for
incorrect recognition when OCR is enabled. To compare against older
code, use the same recording and annotations on an isolated checkout of that revision; the older CLI ignores font metadata
and uses its original behavior. Compare the Korean `results` arrays exactly, not just aggregate counts. Keep every report
outside the source sample tree and use fresh output filenames.

Frontend lint, 342 tests, and the production build passed. Native formatting, 83 tests (one existing ignored test), and
Clippy passed. Browser smoke checks passed for Linux at 80% and the Windows capability path at 100%, including font-save
failure/retry, settings navigation, capture restart, and preserving the active capture's font. These browser checks mock
native capture; they do not exercise the real Windows desktop capture service.

An additional real-image browser OCR check read the inspected Strong Sword ×6 correctly in all three passes. The Korean
worker's readings before and after using a separate Strong Sword worker were identical, confirming that worker selection
and browser preprocessing do not share mutable font state.
