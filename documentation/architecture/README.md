# Architecture

Shakatu Sheets has three current boundaries:

- React renders the interface and holds the active in-memory session.
- `src/domain/session.ts` contains pure session transitions and calculations.
- Rust owns SQLite and external HTTP requests exposed through explicit Tauri commands.

The frontend sends the complete session snapshot after each meaningful state change. Saves are queued in order. Rust
validates the snapshot and replaces the session entries in one transaction.

Manual screenshot recognition stays in the frontend. Tesseract.js loads its bundled English model, worker, and WASM core
from `public/ocr`, while canvas preprocessing and profile icon comparison produce a transient review draft. Confirming a
valid draft applies one guarded session transition; normal snapshot persistence then stores the imported entries. No
screenshot bytes or OCR draft data cross the Tauri command boundary.

The history view requests the 20 newest finished sessions from SQLite, filters them by the selected grind-spot profile,
and calculates display totals with the same pure frontend function as the live view. Normal saves cannot change finished
sessions. Reopening is a separate backend command that atomically returns one finished session to a paused state without
replacing an active session that contains progress.

Saved market prices are read from SQLite when the selected region or grind-spot profile changes. The frontend only
invokes the Arsha network request after the user presses the fetch or refresh button. Successful complete responses are
written as a new set of price snapshots; failed responses do not change saved data.

Garmoth credentials remain in SQLite and are used only by Rust requests. The frontend receives configured state and
validated character summaries, never the saved key. Character builds are fetched explicitly using the IDs required by
Garmoth's approved endpoint. Finished-session upload previews map profile drop names to Garmoth keys and reject
unmatched revenue rows rather than silently omitting them.

Uploads are explicit and single-shot. Rust reserves a session as `unknown` before sending the create request and changes
it to `success` only after a successful response. Any non-success response or network failure remains `unknown` because
Garmoth does not document error semantics or an idempotency contract; the app blocks retries and directs the user to
check their Garmoth grind tracker. Reserved and uploaded sessions cannot be reopened.

There is no service layer or plugin system. New boundaries should only be added when a feature cannot remain clear within
the current structure.
