# Self-improvement for loot quantities

## Implemented design

1. Keep the existing session database and migrations unchanged. Store opt-in settings and explicitly confirmed quantity
   examples in a sibling `quantity-learning.sqlite3`, with its own ordered schema versions. Test that learning operations
   leave a populated version-4 session database usable by the unchanged persistence code.
2. Preserve native quantity crops and capture-time font, UI scale, and source dimensions. Only explicit corrections in
   Needs attention teach the reader. Do not retain accepted OCR captures or add a recent-capture teaching view.
3. Compare whole quantity images against a bounded in-memory library for the same display setup. Keep antialiased
   edges, reject blank/invalid crops and ambiguous matches, and never use automatic readings as confirmed labels.
4. Default to suggestions requiring confirmation. A separately enabled auto-allow mode may recover unresolved normal
   quantities only: require clear item evidence, agreement across at least three frames, no conflicting parsed quantities,
   and success on reserved validation examples. Never override accepted OCR or train from automatic acceptance.
5. Provide example inspection, individual deletion and reset, ordered background persistence, useful failure messages,
   and explicit disclosure that opt-in learning retains small crops locally. Capture/OCR must continue if learning fails.
6. Test crop geometry, setup isolation, conflicting examples, automatic acceptance boundaries, bounded storage,
   persistence errors and main-branch compatibility. Run frontend checks/build/tests and Rust formatting/tests/Clippy.

## First-version boundaries

Normal loot quantities only. Whole-quantity matching does not generalize a confirmed `16` into all numbers containing
`6`. Rare banners, model training, cross-device sharing, and changes to capture/tracking are outside this version.
Numerical matching thresholds are conservative engineering defaults, not a measured real-game accuracy guarantee.
Real gameplay validation is required before claiming improved accuracy or recommending automatic recovery.

## Using the feature

Open **Settings → Self-improvement** and enable **Learn from my corrections**. Self-improvement has its own Settings
section and navigation link. Its controller lives at the app level so Settings and Needs attention share the same
state, saved examples, and failed-save queue. Changing views does not create a second reader or discard pending saves.
Learning and auto allow both default to off. For a normal-loot capture, the correction form shows the exact quantity crop
that will be saved. Enter the item and whole quantity, check that the crop contains the full number, then add the drop.
Only a successful manual insertion teaches the reader. Dismissals, failed insertions, rare banners, automatically
accepted OCR, and learned automatic recoveries never save an example. A missing, clipped, or blank quantity crop is
skipped; the manual drop still adds normally. No accepted-capture gallery or ledger-total learning is included.

Matching examples suggest a quantity with a **Use learned quantity** button. This only fills the quantity field;
the user still selects/checks the item and submits the correction. Corrections made before opting in are not recovered
retroactively. Only whole quantities already represented by suitable examples can be suggested.

Expand **Saved examples** in Settings to inspect crop images, quantities, font/scale/resolution, confirmation time,
and recognition details. Details distinguish your confirmed number from the accepted OCR quantity, which is absent for
unresolved captures. New examples preserve the source frame index, ROI dimensions and quantity bounds, session/event/run
identifiers, native capture token/batch when available, and the unresolved reason. Up to five selected frames retain their
consensus readings and raw OCR passes (threshold, scale, region and text), before any manual retry. Text is capped at
512 characters per reading/pass, with up to three readings and nine passes per frame. OCR failures preserve completed
evidence; insufficient-observation captures have no OCR history. Only the quantity crop image is saved, not full frames.
Older examples remain usable and explicitly show that detailed history is unavailable. Identical-image deduplication
keeps the original example and its provenance rather than logging another correction. Delete an individual mislabeled
example, or reset all examples and turn both settings off.
Disabling learning keeps the library for later. Session deletion and branch switching do not erase it. Learning writes
run independently from session writes: failure does not undo or re-add the corrected drop. Up to 50 pending/failed examples
are retained in memory for retry or discard; a full queue explicitly reports that a new correction could not be learned.
Unsaved examples are lost on app close. Save retries never insert a second loot entry.

## Matching and automatic recovery

The matcher preserves grayscale text edges, suppresses colored/dark background pixels, trims padding, and compares shapes
with cosine distance over ±1 native pixel alignment in each direction. It rejects dimension differences over two pixels,
distance above 0.12, or a competing quantity within 0.06 distance of the best match. These values are engineering defaults,
not calibrated probabilities. Examples must have the same font, UI scale and original source resolution. Libraries are
prepared on load or mutation completion and reused in memory; recognition performs no database requests.

Every third unique saved image is reserved for validation and never used as a matching template. An automatic candidate
needs two supporting matching examples. Its setup must also have at least three reserved examples of that quantity,
all correctly suggested, and at least one correctly suggested reserved example of another quantity. Any incorrectly
suggested reserved example blocks automatic recovery for the setup. Deleting or replacing examples recomputes eligibility.
This is a small local validation gate, not an independent gameplay accuracy estimate: examples may come from the same
session, and users can repeatedly inspect validation outcomes.

With **Auto allow** enabled, the normal coordinator consults the prepared library only after
the existing OCR and supplementary-frame policy fails to reach consensus. Automatic recovery requires all selected
quantity crops (at least three) to agree and be eligible. In every frame, a majority of passes must read the same exact
dictionary item before an explicit `x` marker. Any parsed numeric disagreement or recognized competing item blocks
recovery, even in a minority pass. Existing accepted OCR is never overridden. Insufficient-observation events and OCR
failures can receive manual suggestions in review but cannot be automatically recovered. Rare processing is unchanged.

Automatic recovery uses the existing event ID and insertion/retry path and is labeled as a learned quantity in recognition
announcements. The library is disabled while a settings/example operation is pending, then atomically replaced between
recognition callbacks. Corrections can therefore help later unresolved events in the same session without restarting OCR.

## Verification

Unit tests cover setup isolation, six/nine separation, whole-quantity limits, blanks and invalid crops, conflicting labels,
reserved-example exclusion and eligibility, frame/item/numeric vetoes, successful manual corrections only, unchanged accepted
OCR, multi-pass integration, and ordered IPC failures. Rust tests exercise PNG round trips, input validation, idempotency,
limits and reset, audit round trips and validation, version-1 learning migration, future-version rejection, and
byte-for-byte preservation of a populated version-4 session database.
The latter is then reopened and updated by the unchanged main-branch migration and session functions.

With Chromium listening on port 9222, run `node scripts/smoke-loot-learning.mjs` for the real components/hook using a
synthetic persistence adapter. It checks opt-in, failed/successful corrections, suggestions without insertion, save failure
and retry after another save, auto toggle, deletion, reset, and narrow layout. The existing review smoke also passes.
These browser checks use no user database or gameplay images.

Run `npx vite-node --script scripts/benchmark-loot-learning.mjs` for synthetic matching overhead. A Linux/Node run with
200 saved examples, 50 in the active setup, and five 48×20 crops per unresolved event measured 1.90 ms median and 2.09 ms
95th percentile matching time; initial library preparation took 33.8 ms. This is not end-to-end capture latency or a
dropped-frame measurement. Library preparation happens after explicit learning operations, not per frame. Real gameplay
and Windows hardware acceptance remain unmeasured.
