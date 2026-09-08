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

## Persistence

- The latest unfinished session is loaded at startup.
- The history view loads the 20 most recently finished sessions and their entries.
- A running session is restored as paused, including elapsed time since its last start.
- Session entries are replaced inside the same transaction as the session update.
- Normal saves cannot change finished sessions; the explicit reopen command can return one to a paused state.
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
