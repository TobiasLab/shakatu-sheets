# Self-improvement for loot items and quantities

## Scope and compatibility

Normal-loot corrections in Needs attention teach item names and whole quantities independently. Teaching Black Stone × 6
can help recognize Black Stone × 9: the name matcher excludes the quantity marker and digits. Whole-number matching does
not generalize a confirmed `16` into all numbers containing `6`. Rare banners, accepted-capture teaching, neural model
training and cross-device sharing are outside this implementation.

Settings and examples live in a separate `quantity-learning.sqlite3`. Session storage and its version-4 migrations are
unchanged. Learning migration 3 adds nullable item labels/images to existing examples. Older examples remain quantity-only;
item identities are never inferred from old OCR guesses. This migration turns Auto allow off once because automatic item
recovery expands its scope. Users may enable it again in Settings. Main ignores the learning file; older feature builds
supporting learning schema versions 1 or 2 cannot open the upgraded file.

## Corrections and inspection

Open **Settings → Self-improvement** and enable **Learn from my corrections**. The app-level controller shares settings,
examples and the failed-save queue with Needs attention. Both settings default to off. The correction editor shows the
quantity image and, when available, the isolated item-name image. Check that both images contain the complete text,
select the correct item and quantity, and add the drop. Only a successful manual insertion teaches the reader. Dismissals,
failed insertions, rare banners, accepted OCR, and learned automatic recoveries never become training examples.

Segmentation reuses the existing row projection and isolated `x` marker. The name crop ends before that marker; quantity
pixels never enter the name matcher. A missing, clipped or blank quantity crop skips the example. If the quantity crop is
usable but the item name cannot be isolated or is blank, the confirmed item label is saved but only the quantity image
teaches recognition. The manual drop still adds normally. There is no accepted-capture gallery or ledger-total learning.

Available learned item and quantity suggestions prefill an untouched correction draft. Users check the editable fields
against the capture and click **Add to session** once to confirm. Prefilling does not insert a drop or teach the reader.
The first suggested draft and its suggestion note stay stable across example saves and capture switches. Matching runs
only until a draft is populated; later suggestions never overwrite a manual edit. Suggestions only use item labels present in the current session's item dictionary. Corrections made before
opt-in are not recovered retroactively.

**Saved examples** displays confirmed item/quantity labels, images, setup, time, and recognition details. Each new example
preserves its source frame, ROI dimensions, quantity/item bounds, session/event/run IDs, native token/batch when available,
and the original unresolved reason. Up to five selected frames retain initial consensus readings and raw OCR passes
(threshold, scale, region and text), before manual retries. Text is capped at 512 characters per reading/pass, with at most
three readings and nine passes per frame. OCR failures preserve completed passes; insufficient-observation captures have
no OCR history. Only the source frame's small text crops are saved, never full frames. Older missing history is shown as
unavailable. Identical paired examples retain their original provenance instead of creating a correction log.

Delete mislabeled examples individually, or reset all examples and turn both settings off. Disabling learning retains the
library. Session deletion and branch switching do not erase it. Learning writes run independently from session writes:
failure does not undo or re-add a drop. Up to 50 pending/failed saves are retained in memory for retry/discard; a full queue
reports that the new correction could not be learned. Unsaved examples are lost on app close.

## Matching and automatic recovery

Item and quantity matchers have separate labels, templates and validation results for each font/UI-scale/source-resolution
setup. They preserve grayscale text edges, suppress colored/dark background pixels, trim padding, and compare cosine
distance over ±1 native pixel alignment. Dimension differences over two pixels, distance above 0.12, or a competing label
within 0.06 of the best distance cause abstention. These are engineering defaults, not calibrated accuracy probabilities.
Only labels represented by saved image examples can be suggested.

Every third unique paired example is reserved for validation. Within each component, byte-identical images retain only
their earliest retained role in database insertion order (independent of clock changes): pairing the same number with a new item, or the same item with a new number, cannot add support or
leak the repeated component into validation. Conflicting labels for an identical component image are rejected on save.

For a learned label to become eligible for automatic use, its setup needs at least two templates, at least three reserved
examples of that label all recognized correctly, and at least one correctly recognized reserved example of a different
label. Any wrong reserved prediction blocks that component's automatic eligibility for the setup. Each new image also
needs two matching templates. Settings exposes template counts, correct/total reserved predictions, alternative-label
successes, wrong predictions and eligibility per label/setup. Similar captures can share errors; these checks do not
establish independent real-game accuracy. Deleting examples recomputes the evidence.

The coordinator consults learning only after ordinary OCR and supplementary-frame consensus fail. Automatic recovery needs
at least three frames, agreement for both item and quantity, and no conflicting parsed number or exact dictionary item in
any consensus reading or raw OCR pass, including minority readings and earlier passes discarded by OCR refinement. A learned field must be eligible and agree in every selected frame.
When no learned match exists for a field, a strict per-frame majority of OCR readings may establish that field: exact
normalized dictionary item names before an explicit `x`, or parsed positive quantities. At least one field must have a
learned match. This permits learned item recovery with a clear OCR number, learned numbers with a clear OCR item, or both
learned fields together. Missing/ambiguous evidence and excluded dictionary items cannot be automatically recorded.
Accepted OCR is never overridden. OCR failures and insufficient-observation captures remain manual review only.

Automatic recovery uses the existing event insertion/retry path and is labeled self-improvement in announcements. The
prepared library is disabled during settings/example operations, then replaced between recognition callbacks. Capture
performs no learning database requests and item learning adds no OCR passes.

## Verification and limits

Tests cover item recognition across quantities, dictionary/setup isolation, item and numeric conflicts, both-field recovery,
OCR fallback, ambiguous/missing crops, identical-component validation leakage, clock rollback, raw-pass conflict vetoes, successful corrections only, unchanged
accepted OCR and audit provenance. Rust tests cover bounded PNG round trips, rejected labels/images/bounds, conflict and
retry behavior, migrations from learning versions 1 and 2, one-time Auto allow reset, and byte-for-byte preservation of a
populated session database followed by reopening/updating through unchanged persistence code.

With Chromium listening on port 9222, `node scripts/smoke-loot-learning.mjs` exercises real components with synthetic
persistence, including item and number suggestions without insertion, audit display, failed-save retry, controls and reset.
No user database or gameplay images are used. Run the standard frontend and Rust checks for cross-stack changes.

`npx vite-node --script scripts/benchmark-loot-learning.mjs` measures both matchers. A Linux/Node run with 200 examples,
50 in the active setup, five 48×20 quantity images and five 300×20 name images measured 13.40 ms median and 13.70 ms p95 per
unresolved event; initial library preparation took 261 ms. Preparation happens on load/mutation, not per capture frame.
This synchronous work can briefly pause the UI on large-library updates. These are synthetic CPU measurements, not
end-to-end capture latency, dropped-frame measurements or gameplay accuracy. Real gameplay and Windows hardware
acceptance remain unmeasured.
