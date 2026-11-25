# Product behavior

This reference describes existing behavior. The visual rules every UI change follows are in the
[design language](design-language.md).

## Interface

Dark is the default theme and light is the alternative; a saved preference for the retired moss theme falls back to
dark.

- **Shell.** A 44px top bar holds the Grind desk, History, and Settings tabs, capture status, and save state. Away from
  the desk, it also shows the running session's spot, time, and silver per hour; clicking it returns to the desk. While
  captures await review, a warning pill shows their count everywhere and opens the Needs attention queue; the session
  overlay shows the same count in its header. The top bar replaces the system title bar: dragging it moves the window,
  double-clicking it toggles maximize, and minimize, maximize, and close buttons sit at its right end.
- **Grind desk.** The grind spot is the heading, with variant prefixes such as `[Dehkia 2]` shown as tags. One readout
  row shows net silver/hour, session net, a session trend, and session time beside the timer controls. A paused
  timer shows a Paused badge and muted time. A Net / Silver/h switch heads the trend and is remembered across the desk
  and History. Net plots persisted net samples against elapsed time with a hairline chord for the average pace.
  Silver/h plots the session average up to each moment (net so far over time so far), so its end always matches the
  desk's and overlay's silver/hour, with a flat hairline at the current average. The first 15 minutes, or half of a
  shorter session, do not set its scale: one early drop would otherwise flatten the rest of the line, so the line runs
  along the edge there while the readout keeps the exact value. The average and the last 30 minutes' rate hold net at
  its latest sample, because samples are stored only when net changes, so a drop after a quiet stretch counts when it
  was recorded. Both views show the last 30 minutes' rate once available and a readout that follows the pointer or
  the arrow keys.
  Spike markers stand above the plot for the spot's rare drops: item icon and a stem to the step it caused. Every drop
  whose single item is worth at least 100M after tax gets a marker. A marker closer than 8% of the session's duration
  to the one before it would overlap it, so it stands one level (8 px) higher and is drawn over it, up to three levels,
  so later drops are on top; drops from the same save are ordered by name, and same-name entries share one marker. The
  plot reserves the room for the highest level whenever it has a marker, so stacking never moves it. These values are
  the `SPIKE_*` constants in `src/domain/trend.ts`. When the pointer is over an icon, or the readout reaches a marker,
  that marker is drawn over its neighbours with its compact value just below the icon, and the readout snaps to the
  drop and names the item and time, shortening a long name so the time stays visible. Other markers show no value. The
  plot's accessible label lists the marked drops with their values.
- **Capture.** Loot capture is a one-line status strip. Setup expands it into a connected stepper, the live preview with
  both crop previews beneath, and a narrow control column (area switch, UI scale, position pad, layout import,
  confirmation, diagnostics). Needs attention sits flush inside the strip.
- **Drops.** Drops default to an inventory of item tiles (quantity, value after market tax, name, quantity/hour)
  aggregated by item; a tile flashes briefly when its quantity rises or a new item appears. The Ledger view is the
  editable table; its quantity and price inputs look like plain grouped numbers until focused.
- **Dialogs.** Add loot or expense switches between a dense loot catalog with a price column and an expense form, and
  previews the entry's value before adding. Browse all spots is one dense list with variants grouped beside their base
  spot, arrow-key navigation, and the player's recorded silver/hour, session count, and last session per spot in the
  current region, optionally sorted by that rate.
- **History.** Filters sit in an always-visible bar: region switch (All, EU, NA), grind spot, completion date range,
  7/30-day shortcuts, and Clear filters. Totals use the desk's readout style. Grind-spot comparisons are an open table with a bar
  proportional to each spot's rate. The session list sits beside a single receipt panel for the selected session. The
  receipt shows the session trend beside its figures, with the same switch and readout as the desk; sessions
  created before net samples were recorded (migration 5) show no trend rather than a straight line.
- **Settings.** A sticky section index sits beside open sections. Each section has a label column and a form column.
  Items holds the ignored items and the items added at every grind spot (name and unit price).

## Sessions and prices

Users select a grind spot and region, optionally fetch market prices, and track time with the timer or manually entered
hours. Spot selection locks once the session has time or entries. Loot and expenses remain editable until finishing.
Favorites and recent spots are saved in SQLite settings; if they cannot be loaded, the spot browser shows the error with
Retry and keeps them unchanged until they load. Ledger filters only affect the displayed rows.

Market, vendor, and expense values remain distinct. Market requests are explicit, prices are editable, and missing
prices are not guessed. If the selected region has no saved prices, the other region's saved snapshot is identified as
a fallback. Entries retain their recorded prices when market snapshots change.

Net silver/hour uses elapsed session time, excluding pauses. Manual hours override tracked time when supplied.
Rates without elapsed time display an unavailable value. Timer ticks and local filters do not mutate saved snapshots.

## Recognition and capture review

Screenshot import accepts cropped English Marni loot tracker images at 80%, 100%, or 120% BDO UI scale. Processing is
local and produces an editable draft with low-confidence suggestions marked for review. Confirmation requires complete
rows, an empty idle session, and a saved price for every imported item; missing prices name the items instead of
importing them at zero. Enhanced items have no market price, so their rows are set to Ignore item and added manually. Screenshots and draft thumbnails are not persisted.

Live capture is explicit and can run before or while the timer is paused. Navigation and minimization preserve
recognition; previews run only when setup is visible. Recognized events enter the ledger. Unresolved captures support
manual correction, OCR suggestions that require confirmation, and dismissal without changing existing ledger entries.
Finishing drains pending OCR and offers a choice to review unresolved drops or finish without them. Review time is
excluded from session duration. Review images are discarded when dismissed, when the session finishes, or when the app
closes; opted-in learning examples remain in their separate local database.

See [live loot architecture](../architecture/live-loot.md) for capture profiles, OCR policy, diagnostics, and limits.

## Self-learning

Settings → Self-improvement provides **Learn from my corrections** and **Auto allow**, both off by default. With learning
enabled, successful manual corrections in Needs attention teach normal-loot item names and whole quantities separately.
Learning Black Stone ×6 can help recognize Black Stone ×9, but learning a quantity of 16 does not teach every number
containing 6. Rare banners, dismissals, failed insertions, and automatic results do not teach the reader.

Learned suggestions prefill untouched item and quantity fields and tag them Suggested. Users check the capture and
confirm with **Add to session**; prefilling alone never inserts loot. Drafts survive switching between captures, and
later suggestions never replace manual edits. Suggested items must belong to the current session's item dictionary.

**Auto allow** separately enables recovery after ordinary OCR remains unresolved. It requires eligible learned examples,
agreement across at least three frames, and no conflicting item or quantity evidence. Accepted OCR is never overridden;
uncertain captures remain available for manual review. Eligibility checks do not guarantee real-game accuracy.

**Saved examples** lets users inspect confirmed labels, small text images, and recognition details, and delete
individual examples. **Reset self-improvement** clears the library and turns both settings off. Disabling learning
retains saved examples. Examples stay on the user's device in a separate database and survive session deletion; full
capture frames are not saved by learning. A failed example save does not undo the added loot and can be retried or
discarded from the capture strip or Settings. A successful save is announced to screen readers without leaving a message
in the strip.

See [self-improvement architecture](../architecture/quantity-learning.md) for matching rules, storage, and validation limits.

## History and comparisons

History filters completed sessions by recorded region, completion date, and grind spot, with 20 records per page.
Date bounds use local calendar days and include both endpoints. Totals cover all matching sessions, not just the page.
Spot comparisons use the selected region/date range independently of the spot filter. Distinct spot IDs remain separate.

Recorded net is revenue quantity × unit price × sale multiplier minus expenses. Duration-weighted net/hour uses only
positive-duration sessions: their net × 3,600,000 ÷ their total elapsed milliseconds. Zero-duration sessions still count
in recorded net and session count. Negative earnings remain valid. Rates sort descending, unavailable rates last, with
spot ID breaking ties. Prices are recorded valuations, not confirmed sales; EU and NA remain separate.

A Sessions / Analytics switch beside the History title swaps the session list and receipt for analytics over the same
filters; the overview and comparisons stay above both. Analytics split net/hour into base (everything except rare
drops, after consumables) and rare drops, so the two add up to the overview's net/hour, and show rare drops' share of
loot value and consumables per hour (loot minus net over the timed sessions, rounded to whole silver, in the expense color with a true minus,
with their share of loot beneath). With one spot and one region selected and at least one looted item that has an
imported market price, a further readout shows net per hour at today's prices: loot recorded at a market price valued
at its item's latest import after tax, everything else (including loot recorded at a vendor price) at its recorded
value, consumables at their recorded cost, with its change
against the recorded rate beneath; the item table gains a Today / hour column on the same basis. Market prices,
after the item table, lists the spot's market items with at least one import in that region, highest latest price
first: a price line per item on a time axis all rows share (each row scaled to its own prices, its latest import
marked), the latest price, the change since the first import, the number of imports, and when it was last
imported. Rare items are those whose average after-tax unit value across the filtered sessions with tracked time is at
least 100M, the trend's spike threshold. A dot chart plots each timed session's net/hour at its completion time against a hairline at
the pooled average, with the same pointer and arrow-key readout as the trend. Recorded net over time follows: the
filtered sessions' net added up in completion order (zero-duration sessions included, as in the overview's recorded
net) as one line over a 10% wash, its latest point marked, with the same readout naming each session's running total,
spot and completion time. Net / hour per session then shows,
per spot (every spot when none is selected), the spread of its timed sessions' net per hour: a box plot on a scale
shared by all rows, from the lowest to the highest session (lowest–highest whisker, middle half as a box, median as a
tick), with the median, middle half, lowest–highest and session count beside it. Quartiles interpolate between the
sorted rates (QUARTILE.INC); spots with the higher median come first, and fewer than five timed sessions get a "Few
sessions" tag. A Total / Base switch in its title leaves rare drops out of each session's rate; the choice survives
reloads and filter changes for the visit. Analytics write negative values with a true minus. Items per hour, Market prices, Rare drops and Rare drop log are disclosures (native `<details>`)
under their headings, open by default; History remembers which are closed across reloads and filter changes while it
stays open. Day by day comes next: a month calendar for each month from the first to the last
session in local time (the last 12 months at most, noted under the legend when earlier months are left out), every day
showing its date and shaded in five steps of gold (with a matching Less–More legend) by tracked time or, with its
Time / Net switch, by net. Fixed steps let each carry a day-number colour that keeps 4.5:1 contrast in both themes.
Sessions store no start once paused, so each is placed from its completion minus its tracked time up to its completion,
earning steadily, and split at local midnight; sessions without tracked time, with typed-in hours (see the database
documentation) or over 24 hours count whole on the day they were completed. The caption names the busiest (or best)
day; the pointer or arrow keys (a day left or right, a week up or down) show a day's tracked time, net and net per
hour, the first arrow press starting at that day. The switch survives reloads like Total / Base. With a spot
selected, Net / hour through a session follows: one bar per
quarter hour into a session (at most 40 px wide, standing on the zero line) for the net per hour earned in that
quarter hour, averaged over the sessions that lasted through it, against a hairline at the average of every measured
quarter hour. Bars backed by fewer than three sessions are faded; hours are labelled under the plot; the pointer or
arrow keys show a quarter hour's rate, span and session count. A rare drop lands in the quarter hour it dropped in, so
single bars can spike. Anything entered before the timer started is the starting point, not part of the first quarter
hour. Sessions whose hours were typed in are left out (see the database documentation). With a spot selected, an item table
shows each item's quantity per hour pooled over all timed sessions (including those without the item), the lowest and
highest per-session rate (0 when some session had none), how many timed sessions it dropped in, its silver per hour,
and its share of loot value. Below it, Rare drops places every rare drop along the spot's tracked time: sessions in
completion order, each drop at its recorded time into its session, or at the session's end when none was recorded
(loot entered before the timer started, or sessions from before migration 7). Per rare item a row shows a tick for each
drop along the tracked time, the drop count (a "Few drops" tag below five), the average gap (tracked time ÷ drops),
the tracked time since the last drop ("≥" when that drop has no time), and the chance of a gap at least that long
at the item's own rate, e^(−since ÷ average gap) ("≤" beside a "≥", since a longer gap is less likely). The rare drop log lists every rare drop, newest first, with its
session's completion time, its time into the session, and the tracked time since the item's previous drop ("≈" when
either drop has no time). When no sessions match, Analytics show History's empty state with Clear filters; when
sessions match but none has tracked time, one line says so. Analytics load only while the
Analytics view is shown (their code loads with the first read rather than at startup), separately from the session page: switching views keeps the page, and a failed read shows its
own error and retry while the overview and comparisons stay.

Reopening returns a finished session to a paused state and cannot replace an active session with progress. It leaves
completed history until finished again, when the new completion timestamp controls date membership. Uploaded or
ambiguous-upload sessions cannot be reopened; their receipt shows a lock note in place of the Reopen button. Permanent
deletion requires confirmation.

## Consumable presets and uploads

Presets store explicit session quantities and prices by region. They never scale silently with duration. Saving a preset
does not apply it; applying replaces tagged consumables while preserving ordinary expenses and loot.

Garmoth upload review shows the stored session and lets users draft consumable expenses. Cancel discards the draft;
confirmation saves expenses and uploads. Saved expenses remain if HTTP fails. Successful uploads can add missing
consumables but cannot replace existing ones. A repeat upload requires confirmation and creates another remote session.
Unknown outcomes block retries. Items outside the destination spot's export table are listed as omitted; local entries
and full session totals are retained.

The review puts the preset list and drop buffs first and keeps the read-only ledger in a closed disclosure, so a short
preset list and the buffs fit a 1440×900 window without scrolling; the upload options sit in the footer. Drop buffs
follow Garmoth's form: a loot scroll level (None, Lv. 1, Lv. 2), one menu for each other tiered buff, and a grid of the
remaining grind buffs. The review shows the resulting drop amount and drop rate, with capped buffs limited to 300% and
uncapped buffs added on top, and preselects the buffs submitted with the previous upload. Global contribution defaults
off. The Agris option is optional, remains available across failed attempts, and resets when review is reopened. The
detailed persistence and upload contracts live in [architecture](../architecture/README.md#consumable-presets).