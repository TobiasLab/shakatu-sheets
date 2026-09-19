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

## Persistence

- The latest unfinished session is loaded at startup.
- History loads pages of 20 finished sessions and their entries, filtered in SQLite by recorded region, optional spot,
  and completion date. Sorting is effective completion time descending, then ID ascending. Older rows without
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
- Normal saves cannot change finished sessions; the explicit reopen command can return one to a paused state.
- The explicit History consumable-correction command replaces only tagged expense rows in one transaction after
  comparing the reviewed session snapshot with the database. It preserves all session timestamps, ordinary loot and
  expenses, and their price snapshots. Any upload marker blocks correction; the Garmoth mutex serializes this command
  with uploads and deletion. This narrow correction needs no additional migration or index.
- The explicit delete command removes only finished sessions. Their entries, session-linked price snapshots, and Garmoth
  upload marker are deleted through foreign-key cascades; unfinished sessions cannot be deleted through this path.
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
- Live loot calibration stores only validated normalized rectangle coordinates and source dimensions in `settings`.
  Preview and region pixels remain in memory and are never written to the database.
- Connect failures that occur before request transmission release the upload reservation for an explicit retry. Any
  potentially transmitted request without a success response remains `unknown` to prevent duplicate entries. Reserved
  and uploaded sessions cannot be reopened. Deletion is serialized with Garmoth operations so it cannot remove a session
  while its upload request is in flight.
- Screenshots, OCR output, confidence values, and draft thumbnails are never stored in SQLite.
