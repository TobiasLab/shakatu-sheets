# Architecture

Shakatu Sheets has three current boundaries:

- React renders the interface and holds the active in-memory session.
- `src/domain/session.ts` contains pure session transitions and calculations.
- Rust owns SQLite and external HTTP requests exposed through explicit Tauri commands.

The frontend sends the complete session snapshot after each meaningful state change. Saves are queued in order. Rust
validates the snapshot and replaces the session entries in one transaction.

Manual screenshot recognition stays in the frontend. Tesseract.js loads its bundled English model, worker, and WASM core
from `public/ocr`, while canvas preprocessing and profile icon comparison produce a transient review draft. The draft
belongs to one session and resets when that session changes. Confirming a valid draft applies one guarded session
transition; normal snapshot persistence then stores the imported entries. No screenshot bytes or OCR draft data cross
the Tauri command boundary.

The history view requests the 20 newest finished sessions from SQLite, filters them by the selected grind-spot profile,
and calculates display totals with the same pure frontend function as the live view. Normal saves cannot change finished
sessions. Reopening is a separate backend command that atomically returns one finished session to a paused state without
replacing an active session that contains progress. Deletion is also a separate backend command, requires the row to still
be finished, and relies on SQLite foreign-key cascades for session-owned records.

Saved market prices are read from SQLite when the selected region or grind-spot profile changes. The frontend only
invokes the Arsha network request after the user presses the fetch or refresh button. Successful complete responses are
written as a new set of price snapshots; failed responses do not change saved data.

Garmoth credentials remain in SQLite and are used only by Rust requests. The frontend receives configured state and
validated character summaries, never the saved key. Character builds are fetched explicitly using the IDs required by
Garmoth's approved endpoint. Finished-session upload previews map profile drop names to Garmoth keys and reject
unmatched revenue rows rather than silently omitting them. Backend Garmoth operations are serialized so navigation or
multiple windows cannot race key replacement, character selection, uploads, and finished-session deletion.

Uploads are explicit and single-shot. Rust reserves a session as `unknown` before sending the create request and changes
it to `success` only after a successful response. A connect failure known to occur before transmission releases the
reservation; any potentially transmitted request without a success response remains `unknown` because Garmoth does not
document error semantics or an idempotency contract. The app blocks ambiguous retries and directs the user to check their
Garmoth grind tracker. Reserved and uploaded sessions cannot be reopened.

Rust remains feature-oriented: `persistence` groups SQLite infrastructure with session, market-price, settings, and
Garmoth-upload storage; `garmoth` separates account settings from uploads; and `native_capture` keeps its cross-platform
command boundary separate from validated geometry and the Linux implementation. Linux capture is split into
lifecycle/backpressure (`linux/mod.rs`), portal-stream processing (`linux/stream.rs`), pixel conversion and binary
encoding (`linux/frame.rs`), and opt-in aggregate diagnostics. Debug ROI collection separates lifecycle/admission
from its writer and tests. `lib.rs` is the composition root and explicitly registers every
command.

Live loot capture uses a versioned local binary channel for a bounded preview and an optional native-resolution region
frame. Linux crops that region from the mapped PipeWire buffer before IPC; browser capture crops its native hidden video
frame. Pixels remain transient. SQLite stores only the validated normalized rectangle and the source dimensions used to
position it.

There is no service layer or plugin system. New boundaries should only be added when a feature cannot remain clear within
the current structure.


The grind desk stays mounted when History or Settings is selected. Its `useLiveLootCapture` hook owns capture,
recognition, and pending insertion retries; the component renders setup and review controls. Finishing a session or
explicitly stopping capture tears the pipeline down. Navigation and minimization do not stop recognition. Preview
requests are serialized and follow setup visibility, page visibility, and window minimization. One metadata preview
still announces a new capture source or changed dimensions; an unconfigured hidden stream does not send repeated
previews or create an empty acknowledgment batch.

Timer state lives only in the clock and earnings components, ticks once per second while visible, and derives elapsed
time from timestamps. It never dispatches a session mutation. Session persistence remains ordered and transaction-backed.

PipeWire is requested at a maximum of 8 FPS, at native source dimensions. Known bounded producer rates bypass downstream sampling so arrival jitter cannot drop valid frames. For producers
without a usable rate limit, a deadline-based consumer gate tolerates 3 ms of jitter and limits processing to 8 FPS. Crops validate contiguous rows before
conversion, retain source stride handling and exact channel/alpha conversion, and preserve the version 3 binary header.
Recognition profiles, event tracking, OCR consensus, bounded queues, and command payloads are unchanged. OCR canvases
are resized only when dimensions change and still cleared and released after each job. There are no schema migrations.
