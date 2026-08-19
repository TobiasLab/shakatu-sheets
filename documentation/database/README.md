# Database

The SQLite database is stored at the Tauri application-data path. On Linux this is currently:

```text
~/.local/share/io.github.shakatusheets/shakatu-sheets.sqlite3
```

## Migration 1

Migration 1 creates:

- `sessions`: timer state and session metadata.
- `session_entries`: loot and expense rows owned by a session.
- `schema_migrations`: applied migration versions.
- `price_snapshots`: user-triggered regional market-price imports.
- `settings`: reserved for persisted settings; currently unused.

Migration 1 has run on development machines and must not be rewritten. Future schema changes require a new ordered
migration with its own literal version number.

## Persistence

- The latest unfinished session is loaded at startup.
- The history view loads the 20 most recently finished sessions and their entries.
- A running session is restored as paused, including elapsed time since its last start.
- Session entries are replaced inside the same transaction as the session update.
- Finished sessions are immutable.
- Money is stored as integer silver values and time as integer milliseconds.
- Market snapshots are never refreshed automatically or expired based on age.
- The latest saved row for each region, item, and enhancement level supplies prices for new entries.
- When the selected region has no saved profile prices, the other region's saved prices are used locally as a fallback.
- Session entries retain their own unit price and are not changed by later market imports.
