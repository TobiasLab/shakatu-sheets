# Self-improvement for loot items and quantities

## Scope and compatibility

Normal-loot corrections in Needs attention teach item names and whole quantities independently. Teaching Black Stone × 6
can help recognize Black Stone × 9: the name matcher excludes the quantity marker and digits. Whole-number matching does
not generalize a confirmed `16` into all numbers containing `6`. Rare banners, accepted-capture teaching, neural model
training and cross-device sharing are outside this implementation.

Settings and examples live in a separate `quantity-learning.sqlite3`. Self-improvement adds no session migrations. Learning migration 3 adds nullable item labels/images to existing examples. Older examples remain quantity-only;
item identities are never inferred from old OCR guesses. This migration turns Auto allow off once because automatic item
recovery expands its scope. Users may enable it again in Settings. Builds predating self-improvement ignore the learning
file; earlier learning builds supporting schema versions 1 or 2 cannot open the upgraded file.

## Corrections and inspection

Open **Settings → Self-improvement** and enable **Learn from my corrections**. The app-level controller shares settings,
examples and the failed-save queue with Needs attention. Both settings default to off. The correction editor shows the
quantity image and, when available, the isolated item-name image. Check that both images contain the complete text,
select the correct item and quantity, and add the drop. Only a successful manual insertion teaches the reader. The editor states that the drop will be saved for learning only when
the library has loaded and the capture has a known setup. Dismissals,
failed insertions, rare banners, accepted OCR, and learned automatic recoveries never become training examples.

Segmentation reuses the existing row projection and isolated `x` marker. The name crop ends before that marker; quantity
pixels never enter the name matcher. A missing, clipped or blank quantity crop skips the example. If the quantity crop is
usable but the item name cannot be isolated or is blank, the confirmed item label is saved but only the quantity image
teaches recognition. The manual drop still adds normally. There is no accepted-capture gallery or ledger-total learning.

Available learned item and quantity suggestions prefill an untouched correction draft. A match on the saved crop comes
first, because it uses the current library, including examples saved or deleted after the capture. It uses one crop and
no eligibility checks, which is acceptable only because a person confirms it. The suggestion made at capture time fills
fields that match lacks: a learned match from another selected frame (all frames' learned matches had to agree) or a clear
OCR majority. Conflicting OCR only prevents automatic use; it does not remove that suggestion. Users check the editable fields
against the capture and click **Add to session** once to confirm. Prefilling does not insert a drop or teach the reader.
The first suggested draft stays stable across example saves and capture switches, and a field is tagged Suggested while it still holds the learned value. Matching runs
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
shows a separate, dismissible notice that newer corrections were added to the session but not kept for learning. Unsaved examples are lost on app close.

## Matching and automatic recovery

Item and quantity matchers have separate labels, templates and checks for each font/UI-scale/source-resolution setup. They preserve grayscale text edges, suppress colored/dark background pixels, trim padding, and compare cosine
distance over ±1 native pixel alignment. Dimension differences over two pixels, distance above 0.12, or a competing label
within 0.06 of the best distance cause abstention. These are engineering defaults, not calibrated accuracy probabilities.
Only labels represented by saved image examples can be suggested.

Every saved example is a template from the first correction. Within each component, a byte-identical image counts once,
kept by its earliest insertion in database order: pairing the same number with a new item, or the same item with a new
number, cannot add support or check itself. Conflicting labels for an identical component image are rejected on save.

Eligibility for automatic use is checked leave-one-out: each example is predicted by the other examples of its setup. A
label becomes eligible with at least four examples, all predicted correctly, plus at least one correctly predicted example
of a different label. An example predicted as another label blocks only the labels involved (its own and the predicted
one): a real crop of one label then lies within matching distance of the other's templates. Settings marks such examples.
Deleting a mislabeled one clears the block; for a correct one, more examples of its label resolve it. Each new image also needs two matching templates.
Settings shows examples, correct and wrong predictions, correct predictions of other labels, and eligibility per
label/setup. Deleting examples recomputes the evidence.

This replaced a fixed split in which every third example was only used for checks. On the recorded replay (every drop
treated as confirmed), that split kept the dominant item of a grind spot from becoming eligible: its checks needed a
correctly checked example of another item, and the rare items rarely landed in the reserved third. Leave-one-out checks
every example, so a label needs fewer corrections and still meets a stricter per-check requirement: four correct checks,
each predicted from at least three other examples. Similar captures can share errors; these checks do not establish
independent real-game accuracy. The stored `validation` flag of migration 1 is no longer read or set. Older builds see no
reserved examples in a newer library, so they suggest but never recover automatically.

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

## Validation limits

The library is prepared on load and mutation, and matching runs synchronously for unresolved events. Every learning command
returns the whole library as JSON. With crop sizes seen in recorded 3440 × 1440 captures, a full 200-example library is about
10 MB of JSON and takes roughly 160 ms to prepare in Node, mostly for the leave-one-out checks (`scripts/benchmark-loot-learning.mjs`). The largest crops the
storage limits allow (64 × 32 quantities, 453 × 32 names) raise this to about 44 MB and 2.4 s, which would pause the UI
after each change; real captures do not reach that size. Stored examples that can no longer be read are listed in Settings
and can be deleted there. No additional OCR passes are added. The ROI replay's `--learning` option
([self-improvement replay](../development/live-loot-benchmark.md#self-improvement-replay)) measures the matcher on
recorded crops as if every drop were confirmed; it does not predict how often real unresolved drops are recovered.
Synthetic tests and benchmarks do not establish end-to-end capture latency or real gameplay accuracy; Windows hardware acceptance also remains unmeasured.
See [development verification](../development/README.md#performance-and-ui-verification) for learning smoke and benchmark
commands, and [database storage](../database/README.md#self-improvement-database) for migrations and persistence limits.
