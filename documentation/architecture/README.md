# Architecture

Shakatu Sheets has three current boundaries:

- React renders the interface and holds the active in-memory session.
- `src/domain/session.ts` contains pure session transitions and calculations.
- Rust owns SQLite and exposes `load_active_session` and `save_session` through Tauri.

The frontend sends the complete session snapshot after each meaningful state change. Saves are queued in order. Rust
validates the snapshot and replaces the session entries in one transaction.

There is no service layer or plugin system. New boundaries should only be added when a feature cannot remain clear within
the current structure.
