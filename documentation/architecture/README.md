# Architecture

Shakatu Sheets has three current boundaries:

- React renders the interface and holds the active in-memory session.
- `src/domain/session.ts` contains pure session transitions and calculations.
- Rust owns SQLite and external HTTP requests exposed through explicit Tauri commands.

The frontend sends the complete session snapshot after each meaningful state change. Saves are queued in order. Rust
validates the snapshot and replaces the session entries in one transaction.

Saved market prices are read from SQLite when the selected region changes. The frontend only invokes the Arsha network
request after the user presses the fetch or refresh button. Successful complete responses are written as a new set of
price snapshots; failed responses do not change saved data.

There is no service layer or plugin system. New boundaries should only be added when a feature cannot remain clear within
the current structure.
