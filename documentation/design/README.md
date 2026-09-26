# Product behavior

This reference describes existing behavior as of September 26, 2026. The previous visual design language is retired
for the app redesign. It is not guidance for future agent work; layout, colors, typography, and component styling are
open to redesign. Historical plans and visual reviews remain available in Git history.

## Sessions and prices

Users select a grind spot and region, optionally fetch market prices, and track time with the timer or manually entered
hours. Spot selection locks once the session has time or entries. Loot and expenses remain editable until finishing.
Favorites and recent spots are stored locally. Ledger filters only affect the displayed rows.

Market, vendor, and expense values remain distinct. Market requests are explicit, prices are editable, and missing
prices are not guessed. If the selected region has no saved prices, the other region's saved snapshot is identified as
a fallback. Entries retain their recorded prices when market snapshots change.

Net silver/hour uses elapsed session time, excluding pauses. Manual hours override tracked time when supplied.
Rates without elapsed time display an unavailable value. Timer ticks and local filters do not mutate saved snapshots.

## Recognition and capture review

Screenshot import accepts cropped English Marni loot tracker images at 80%, 100%, or 120% BDO UI scale. Processing is
local and produces an editable draft with low-confidence suggestions marked for review. Confirmation requires complete
rows and an empty idle session. Screenshots and draft thumbnails are not persisted.

Live capture is explicit and can run before or while the timer is paused. Navigation and minimization preserve
recognition; previews run only when setup is visible. Recognized events enter the ledger. Unresolved captures support
manual correction, OCR suggestions that require confirmation, and dismissal without changing existing ledger entries.
Finishing drains pending OCR and offers a choice to review unresolved drops or finish without them. Review time is
excluded from session duration. Review images are discarded when the session finishes; opted-in learning examples
remain in their separate local database.

Settings → Self-improvement enables learning from successful manual normal-loot corrections. Learned item and quantity
suggestions prefill untouched drafts for confirmation with Add to session; later suggestions never replace manual edits.
Learning and automatic recovery are separate opt-ins, both off by default. Automatic recovery only considers unresolved
OCR and requires validated evidence for both fields. Users can inspect, delete, or reset saved examples. See
[self-improvement](../architecture/quantity-learning.md) for matching rules and limits.

See [live loot architecture](../architecture/live-loot.md) for capture profiles, OCR policy, diagnostics, and limits.

## History and comparisons

History filters completed sessions by recorded region, completion date, and grind spot, with 20 records per page.
Date bounds use local calendar days and include both endpoints. Totals cover all matching sessions, not just the page.
Spot comparisons use the selected region/date range independently of the spot filter. Distinct spot IDs remain separate.

Recorded net is revenue quantity × unit price × sale multiplier minus expenses. Duration-weighted net/hour uses only
positive-duration sessions: their net × 3,600,000 ÷ their total elapsed milliseconds. Zero-duration sessions still count
in recorded net and session count. Negative earnings remain valid. Rates sort descending, unavailable rates last, with
spot ID breaking ties. Prices are recorded valuations, not confirmed sales; EU and NA remain separate.

Reopening returns a finished session to a paused state and cannot replace an active session with progress. It leaves
completed history until finished again, when the new completion timestamp controls date membership. Uploaded or
ambiguous-upload sessions cannot be reopened. Permanent deletion requires confirmation.

## Consumable presets and uploads

Presets store explicit session quantities and prices by region. They never scale silently with duration. Saving a preset
does not apply it; applying replaces tagged consumables while preserving ordinary expenses and loot.

Garmoth upload review shows the stored session and lets users draft consumable expenses. Cancel discards the draft;
confirmation saves expenses and uploads. Saved expenses remain if HTTP fails. Successful uploads can add missing
consumables but cannot replace existing ones. A repeat upload requires confirmation and creates another remote session.
Unknown outcomes block retries. Items outside the destination spot's export table are listed as omitted; local entries
and full session totals are retained.

Global contribution defaults off. Agris and drop-rate options are optional, remain available across failed attempts,
and reset when review is reopened. The detailed persistence and upload contracts live in
[architecture](../architecture/README.md#consumable-presets).
