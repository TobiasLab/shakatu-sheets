# Database

The SQLite database is stored at the Tauri application-data path. On Linux this is currently:

```text
~/.local/share/io.github.shakatusheets/shakatu-sheets.sqlite3
```

On Windows the same identifier resolves through the roaming known folder:

```text
%APPDATA%\io.github.shakatusheets\shakatu-sheets.sqlite3
```

Windows inherits the current user's directory ACLs. For controlled tests only, `SHAKATU_DATA_DIR` can select an absolute
alternate data directory. Normal launches do not set it. Safe window close flushes the ordered session queue and retries
the newest failed snapshot; persistent failure keeps the window open. No migration accompanies Windows support.
If the database cannot be opened or migrated at startup, the window still opens and reports the error instead of
loading a session. Every other database command returns the same reason.

## Migration 1

Migration 1 creates:

- `sessions`: timer state and session metadata.
- `session_entries`: loot and expense rows owned by a session.
- `schema_migrations`: applied migration versions.
- `price_snapshots`: user-triggered regional market-price imports.
- `settings`: local Garmoth configuration, capture calibration, and overlay appearance preferences.

Migration 1 has run on development machines and must not be rewritten. Future schema changes require a new ordered
migration with its own literal version number.

## Migration 2

Migration 2 creates `garmoth_uploads`. Each row records a finished session as `unknown` or `success`; its primary key is
the session ID so a session cannot be uploaded concurrently or retried silently after an ambiguous response.

## Migration 3

Migration 3 adds `sessions_finished_region_time_idx`, a partial index on recorded region, effective completion time
(`COALESCE(finished_at, updated_at) DESC`), and ascending ID for finished sessions. The history page query uses this
ordering; an `EXPLAIN QUERY PLAN` check on a 10,000-row fixture showed that the index removes its temporary sort.
There are no new columns, stored aggregates, or data backfills. Migrations 1 and 2 remain unchanged.

## Migration 4

Migration 4 adds nullable `session_entries.garmoth_consumable_id`. A constraint permits only positive JavaScript-safe
integer IDs on expense rows. Old rows retain NULL; no prices, quantities, or historical totals are backfilled.
The ID is saved and loaded within the existing session transaction and follows session deletion/reopening rules.
No new index is needed because uploads load entries by session through the existing index.

Reusable consumable presets are stored as validated JSON under the `consumable_presets` settings key. Each preset has
an ID, local name, region, and item names/IDs, session quantities, and integer unit prices. Library edits never cascade
to session rows. Preset saving is an explicit operation, separate from the ordered session snapshot save queue.

## Migration 5

Migration 5 creates `session_net_samples`, keyed by session ID and elapsed milliseconds. Each save of an unfinished
session (including the save that finishes it) computes the session's net in whole silver from the saved entries,
using the same after-tax values as history, and inserts a sample at the current elapsed time when net differs from the
latest sample. A running session's elapsed time includes the segment since `started_at`. Samples beyond the saved
elapsed time are removed first, so manually entered hours never leave samples from a discarded span. Rows cascade with
their session. No existing rows are backfilled; sessions recorded before this migration simply have no trend. Loading
a trend returns no samples for a session created before the migration was applied, even if it gained samples after
being reopened or while running across the upgrade, because those samples cover only part of the session.

## Migration 6

Migration 6 adds `garmoth_uploads.was_uploaded`, set when a repeat upload turns a `success` row back into `unknown` and
cleared whenever the row becomes `success` again; a constraint allows it only on `unknown` rows. When the user settles an unconfirmed upload after checking their
Garmoth grind tracker, a repeat returns to `success` whatever the answer, because the earlier upload is on Garmoth; only
a first upload that did not arrive removes the row. Existing rows default to 0, which is correct for every `success`
row and treats an `unknown` repeat from before the migration as a first upload.

## Migration 7

Migration 7 creates `session_loot_events`, keyed by session ID, entry ID, and elapsed milliseconds, so the trend can
name the item behind a jump. Each session save compares the saved entries with the previous save in the same
transaction that records the net sample: a non-expense entry whose quantity rose adds the increase at the current
elapsed time. Drops between two saves therefore share the save's elapsed time, matching the net samples. Increases are
recorded only when the previously saved session was running or paused. Starting the timer saves immediately, so a
Marni import or loot entered before the timer first starts becomes the baseline rather than a drop. A lowered quantity removes the difference
from that entry's newest events first, because corrections usually fix a recent misread. Events past the saved elapsed
time, and events for entries no longer in the session, are deleted on each save. Events store only quantity; loading
joins the entry for its name, current unit price, and sale multiplier, so values match history after a price edit, and
skips entries that are now expenses.
Rows cascade with their session. As with migration 5, sessions created before this migration load no events.

## Persistence

- The latest unfinished session is loaded at startup.
- The desk reads a session's net samples for its session trend (net and silver/h views); the live session supplies the current end point.
  History reads them for the selected finished session, whose saved elapsed time and net supply the end point, and
  shows no trend for sessions without samples. The same command returns the session's loot events, from which the
  trend picks its spike markers.
  History spot summaries also report each spot's latest effective completion time.
- History loads pages of 20 finished sessions and their entries, filtered in SQLite by recorded region (or all
  regions), optional spot, and completion date. Sorting is effective completion time descending, then ID ascending. Older rows without
  `finished_at` use `updated_at` for both sorting and date filtering.
- Date bounds are inclusive start/exclusive end timestamps derived from local calendar dates. Query validation rejects
  invalid ranges and negative offsets; page limits must be 1–100. Offsets beyond the final page are clamped.
- Page records and full-range spot aggregates are read in one transaction. Comparisons use region/date filters across
  all spots; the selected spot additionally narrows the history list and its overview. No aggregate results are stored.
- Recorded net includes all finished sessions. Hourly comparisons exclude both earnings and duration for zero-duration
  sessions, reporting their count separately; positive-duration sessions with no entries still contribute tracked time.
- Stored entry prices and sale multipliers determine historical value. Region is the recorded session region; the
  historical entries do not identify whether a price originated from the other region's fallback or manual input.
- A running session is restored as paused, including elapsed time since its last start.
- Session entries are replaced inside the same transaction as the session update.
- Operations that read before writing (session save, reopen, History consumable correction, Garmoth upload claim, and
  the guarded settings save) start `IMMEDIATE` transactions. A concurrent write then makes them wait for the busy
  timeout instead of failing with a stale read snapshot.
- Normal saves cannot change finished sessions; the explicit reopen command can return one to a paused state.
- The History upload command can save a reviewed consumable draft, replacing only tagged expense rows in one transaction after
  comparing the reviewed session snapshot with the database. It preserves all session timestamps, ordinary loot and
  expenses, and their unit prices. Unknown upload outcomes block correction. A success marker allows adding missing consumables only and remains
  unchanged; existing consumables on uploaded sessions cannot be replaced. The Garmoth mutex covers this correction,
  upload reservation, and HTTP, and serializes them with deletion. Saved expense changes survive failed requests;
  the result returns the saved snapshot for retry and UI refresh. Global and Agris options are transient upload
  metadata; the last drop-buff selection is a JSON array of Garmoth buff IDs under the `garmoth.buffs` setting. This
  workflow needs no additional migration or index.
- The explicit delete command removes only finished sessions. Their entries (including the historical prices kept in
  `session_entries.unit_price`), net samples, loot events, and Garmoth upload marker are deleted through foreign-key cascades;
  unfinished sessions cannot be deleted through this path. Market imports always write `price_snapshots.session_id` as
  NULL, so deletion never removes market prices.
- Money is stored as integer silver values and time as integer milliseconds.
- Market snapshots are never refreshed automatically or expired based on age.
- The latest saved row for each region, item, and enhancement level supplies prices for new entries.
- When the selected region has no saved prices for the active grind-spot profile, the other region's saved prices are
  used locally as a fallback.
- Session entries retain their own unit price and are not changed by later market imports.
- Session entry `source` records whether a row was added manually or through reviewed screenshot recognition.
- Garmoth API keys, fetched character summaries, and the selected character are stored in the existing local `settings`
  table. The API key is never returned to the frontend after it is saved. On Unix, the application-data directory and
  SQLite files are restricted to the current user.
- Overlay opacity uses the `session_overlay_opacity` setting (integer percent, 25–100; default 100). No migration is needed.
  Linux ignores a stored value because its overlay window is opaque.
- The theme uses the `theme` setting (`light` or `dark`; default dark). Grind-spot favorites and the eight most recent
  spots use `grind_spot_preferences`, a JSON object of spot ID arrays. Earlier builds kept both in browser storage; the
  first load without a SQLite value saves the browser value to SQLite and then removes it. No migration is needed.
- The session trend's Net or Silver/h view uses the `trend_view` setting (`net` or `pace`, where `pace` is the Silver/h view; default net), shared by the
  desk and History. No migration is needed.
- Live loot calibration stores only validated normalized rectangle coordinates and source dimensions in `settings`.
  Preview and region pixels remain in memory. Opt-in self-improvement uses the separate database below.
- Connect failures that occur before request transmission release the upload reservation for an explicit retry. Any
  potentially transmitted request without a success response remains `unknown` to prevent duplicate entries. Reserved
  and uploaded sessions cannot be reopened. Deletion is serialized with Garmoth operations so it cannot remove a session
  while its upload request is in flight.
- Screenshots, OCR output, confidence values, and draft thumbnails are never stored in the session SQLite database.

## Self-improvement database

Opt-in normal-loot self-improvement uses `quantity-learning.sqlite3` alongside `shakatu-sheets.sqlite3`, under the same
application-data directory (including `SHAKATU_DATA_DIR` overrides). It has independent ordered migrations, currently
`PRAGMA user_version = 3`. Loading defaults does not create the file; any other operation (settings, save, delete or reset)
creates and migrates it, and loading an existing older file upgrades it. No session migration, setting, foreign key, or session-entry change accompanies this feature. Builds predating
self-improvement ignore the learning file and continue using the session database. Returning to a compatible
learning build restores the saved examples and settings. Migration 2 adds nullable `audit_json` without changing migration 1.
Existing examples retain their images and labels with no invented audit history. Migration 3 adds nullable `item_name`, `item_width`, `item_height` and `item_png` columns. Older examples remain
quantity-only. Auto allow is disabled once on this migration because item recovery expands automatic behavior. Earlier
learning builds supporting versions 1 or 2 cannot open the upgraded learning file.

The separate database stores opt-in and auto-allow settings, a confirmation sequence, and at most 200 examples with
at most 50 per font/UI-scale/source-resolution setup. Each example contains an event UUID, positive safe-integer
quantity, original OCR quantity if available, bounded original OCR text, native dimensions, a small RGBA PNG blob,
capture setup, confirmation time in milliseconds, and a retired `validation` flag that is always written as 0. New corrections additionally save
the confirmed item label and an isolated name PNG when available. Quantity crops are limited to 64×32 pixels, name crops
to 512×32. The sequence orders examples by insertion. Identical paired crops/labels in the same setup do not advance it. The
matcher deduplicates component images independently, so a repeated image adds no support when the other component
changes; the earliest insertion keeps it, regardless of wall-clock time. Conflicting component labels require deletion
first. Earlier builds reserved every third example for checks; this build ignores that stored flag and checks every
example against the others.
Save retries are idempotent. Rust validates dimensions, readable ink and label lengths on save, and encodes the PNGs itself. Loading decodes every PNG
and validates each example again. A stored example that fails (for example a corrupt PNG, malformed audit JSON, or a
check added by a later build) is left out of the library and its ID is returned as unreadable. Settings reports these and
can delete them; they are never deleted silently, and the rest of the library stays usable. Unreadable rows still count
toward the storage limits until they are deleted or pruned.

New examples also store a versioned audit object: session ID and recognition generation when available, original event
ID, unresolved status/reason, and the saved crop's source frame index, ROI dimensions and quantity/item bounds. Native capture
token and batch ID are included when available. Up to five selected OCR frames retain up to three consensus readings and
nine raw passes each, including threshold, scale and region; each text is bounded to 512 characters. These are initial
recognition readings before manual retries. The confirmed item and quantity are the example's labels. No full frame or other
frame images are stored. Identical-pair deduplication keeps the original example and its audit, so this is provenance
for saved examples rather than a log of every correction. Rust validates audit bounds and its link to the saved crop.

Commands run on blocking workers; frontend requests are ordered. Writes and pruning use a transaction. SQLite
foreign keys, busy timeout, WAL mode, and Unix file permissions follow the existing persistence helpers. The learning
file has no session foreign keys: session edits/deletion cannot modify examples, and learning reset/deletion cannot
modify sessions. Reset removes examples and turns learning and auto allow off. Disabling learning retains examples.
A learning error leaves ordinary capture, OCR, and session persistence available. See
[self-improvement](../architecture/quantity-learning.md) for matching and automatic acceptance rules.
