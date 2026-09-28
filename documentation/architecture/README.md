# Architecture

Shakatu Sheets has three current boundaries:

- React renders the interface and holds the active in-memory session.
- `src/domain/session.ts` contains pure session transitions and calculations.
- Rust owns SQLite, filesystem access, native capture, and external HTTP requests exposed through explicit Tauri commands.

The frontend sends the complete session snapshot after each meaningful state change. Saves are queued in order. Rust
validates the snapshot and replaces the session entries in one transaction.

Manual screenshot recognition stays in the frontend. Tesseract.js loads its bundled English model, worker, and WASM core
from `public/ocr`, while canvas preprocessing and profile icon comparison produce a transient review draft. The draft
belongs to one session and resets when that session changes. Confirming a valid draft applies one guarded session
transition; normal snapshot persistence then stores the imported entries. No screenshot bytes or OCR draft data cross
the Tauri command boundary.

The history view requests pages of 20 finished sessions, with region, grind-spot, and completion-date filters applied in
SQLite before pagination. A single read transaction returns the page and aggregates across all completed sessions in the
selected region/date range. Entry values are aggregated per session before spot grouping so counts and duration are not
multiplied by the number of entries. SQL mirrors the existing entry valuation calculation; pure TypeScript history
functions derive duration-weighted rates and ranking from the compact aggregate facts. Individual session details still
use the same pure frontend calculation as the live view. Normal saves cannot change finished
sessions. Reopening is a separate backend command that atomically returns one finished session to a paused state without
replacing an active session that contains progress. The frontend flushes the save queue first, so that check sees
loot still waiting for the autosave. Deletion is also a separate backend command, requires the row to still
be finished, and relies on SQLite foreign-key cascades for session-owned records.

Saved market prices are read from SQLite when the selected region or grind-spot profile changes. The frontend only
invokes the Arsha network request after the user presses the fetch or refresh button. Successful complete responses are
written as a new set of price snapshots; failed responses do not change saved data.

Garmoth credentials remain in SQLite and are used only by Rust requests. The frontend receives configured state and
validated character summaries, never the saved key. Character builds are fetched explicitly using the IDs required by
Garmoth's approved endpoint. Finished-session upload previews map profile drop names to Garmoth keys and list rows
outside the destination spot's export table as omitted. Local entries and full session totals are retained. Backend
Garmoth operations are serialized so navigation or multiple windows cannot race key replacement, character selection,
uploads, and finished-session deletion.

Uploads are explicit and single-shot. Rust reserves a session as `unknown` before sending the create request and changes
it to `success` only after a successful response. A connect failure known to occur before transmission releases the
reservation; a 10-second connect timeout keeps stalled DNS, TCP, and TLS setup in that category; any potentially transmitted request without a success response remains `unknown` because Garmoth does not
document error semantics or an idempotency contract. The app blocks ambiguous retries and directs the user to check their
Garmoth grind tracker. Reserved and uploaded sessions cannot be reopened.

Rust remains feature-oriented: `persistence` groups SQLite infrastructure with session, market-price, settings, and
Garmoth-upload storage; `garmoth` separates account settings from uploads. `native_capture/control.rs` owns shared
capture-token lifecycle, selection validation, sampling, and acknowledgment backpressure. `protocol.rs` owns binary
encoding, and `diagnostics.rs` owns opt-in aggregate metrics. Linux retains the portal lifecycle (`linux/mod.rs`),
PipeWire processing (`linux/stream.rs`), and mapped-buffer conversion (`linux/frame.rs`). Windows separates picker/COM
setup (`windows/mod.rs`), WGC session/frame-pool lifecycle (`windows/capture.rs`), and D3D11 ROI/preview work
(`windows/frame.rs`). Debug ROI collection separates admission from its writer and tests. `lib.rs` explicitly registers
commands and shuts down native capture at app exit.

Live loot capture uses a versioned binary channel for a bounded preview and native-resolution normal/rare or search
regions. Linux crops the mapped PipeWire buffer; Windows reads back only GPU-cropped regions and GPU-reduced previews;
browser capture crops its hidden video frame. Pixels remain transient except for explicit debug ROI collection and
opt-in [self-improvement examples](quantity-learning.md). SQLite stores normalized rectangles, UI scale,
and source dimensions. The capability command chooses the native backend and reports unavailable capture without
user-agent detection. Windows source replacement requires fresh confirmation of saved placement hints.

There is no service layer or plugin system. New boundaries should only be added when a feature cannot remain clear within
the current structure.


The grind desk stays mounted when History or Settings is selected. Its `useLiveLootCapture` hook owns capture,
recognition, and pending insertion retries; the component renders setup and review controls. `SessionTools` owns native
entry/import dialogs and keeps their contents mounted when closed. Ledger search, filters, draft edits, and submission feedback
are transient presentation state. History totals cover every matching completed session, independently of the visible page. Finishing a session or
explicitly stopping capture or replacing the session tears the pipeline down. Navigation and minimization do not stop recognition. Preview
requests are serialized and follow setup visibility, page visibility, and window minimization. One metadata preview
still announces a new capture source or changed dimensions; an unconfigured hidden stream does not send repeated
previews or create an empty acknowledgment batch.

The earnings/timer overview owns one clock subscription, ticks once per second while visible, and derives elapsed
time from timestamps. Its clock receives the same elapsed value as its earnings metrics. It never dispatches a session mutation. Session persistence remains ordered and transaction-backed. Window close blocks new UI input, stops capture, flushes
the save queue, and retries its latest failed snapshot before destroying the window. A persistent failure keeps the app
open with an actionable error.

Capture profiles, bounded OCR consensus, repeated-arrival tracking, font-specific preprocessing, and debug collection
are described in [live loot recognition](live-loot.md). See that reference for current geometry and validation limits.

## Session overlay

The desktop live-session toolbar opens a separate, resizable, always-on-top `session-overlay` window.
On supported native Wayland desktops (including KDE Plasma and Hyprland), setup initializes the hidden GTK window
as a layer-shell `Overlay` surface before realization. This selects the compositor's overlay layer above fullscreen
surfaces, without reserving screen space or requesting keyboard focus when opened. Keyboard focus is on demand
when supported by the protocol. X11/XWayland and unsupported Wayland compositors retain the standard utility window;
that fallback cannot guarantee visibility over fullscreen games.
Layer surfaces use top/left margins rather than desktop window positions. Dragging the header or bottom-right resize
handle applies the gesture on release, avoiding surface-local pointer feedback while moving. Arrow keys on either
handle move/resize in 16-pixel steps (64 with Shift); Escape cancels an active drag. A display button cycles outputs.
Placement is clamped to the current output, and the usual show/hide, snapshots, timer requests and opacity stay shared.
Drag its header to move it; the close button hides it, preserving its position until the app exits.
The main window sends session, theme, opacity, timer-availability, and pending-review-count snapshots through targeted Tauri events only while the overlay is shown.
A ready handshake and show/hide lifecycle events synchronize the latest snapshot on opening or reloading.
Both close paths publish the visibility event; listeners confirm native visibility without polling. The overlay renders these snapshots without loading or saving sessions or fetching prices,
and does not start capture. Its timer derives elapsed time from session timestamps independently of main-window visibility.
Net silver/hour uses the same tax and expense calculation as the session summary. Item badges combine quantities
by name across prices and sources, exclude expenses, and show compact large counts with exact totals in tooltips.
Custom items without a profile icon display their first two letters. Finishing or resetting a session updates the overlay.
Start, pause, and resume buttons send requests to the main window, which validates the session ID, timer state,
and close/load status before dispatching the existing session action. Requests receive an acknowledgement or an error;
the overlay never owns a second session timer. Finished sessions have no timer controls.
Settings → Appearance controls opacity from 25–100%, fading the entire overlay through a transparent native window.
The main window loads and saves this preference in SQLite and previews changes in overlay snapshots. Saves are ordered
and pending saves are awaited before closing; hiding the overlay or leaving Settings does not interrupt persistence.
Position and size are not persisted by the app.
Closing the main window retains the save-before-destroy flow, then exits the app including the overlay.
The main window has no native decorations; the React top bar is a `data-tauri-drag-region="deep"` title bar, and its
close button requests a normal close so it goes through the same flow. The main capability therefore allows dragging,
minimizing, toggling maximize, and closing. Edge resizing of the undecorated window is handled by Tauri's window layer.
On Linux that resize border lies inside the webview, so a 5px strip at the top of the bar opts out of dragging while the
window is not maximized; otherwise a press on the top edge would start both a resize and a move. The document never
scrolls: `main#workspace` is the scroll container, which keeps the scrollbar out of the title bar. Without system
decorations the app loses the title-bar system menu, desktop-specific title-bar click settings, and the Windows 11
snap-layout flyout. While a modal dialog is open, or while the app is closing, the rest of the page including the top bar
is inert; Esc closes a dialog and system window shortcuts keep working.
The overlay uses a separate capability for events, hiding, dragging, and minimized-state inspection.
Native layer placement commands accept calls only from the session overlay and only when layer-shell is active.

Browser preview disables the pop-out button. Desktop verification should cover dragging and resizing, hiding and
reopening, loot edits/removals, pause/resume/reset, continued timing while the main window is minimized, and app exit.
Always-on-top behavior depends on the desktop compositor; exclusive fullscreen games may cover the window.
Window behavior follows [Tauri's window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/).

Settings → Garmoth → Inspect consumable data performs an explicit read of the approved character-build endpoint
for a fetched character. Report version 3 includes the character response structure as well as recognized consumable fields,
including JSON-encoded objects and arrays. Scalar values and unknown field names are redacted by default.
An explicit “Include response field names” checkbox reveals unknown keys for review before copying; keys can contain
custom names, so this mode is not an anonymous report. Numeric map keys, control characters, and keys longer than 80 bytes
remain redacted. Scalar values remain redacted in both modes before crossing IPC. Reports are transient, bounded, and copied only on user action; no database or remote
writes occur. The report distinguishes missing, null, and empty fields, but an absent recognized field does not prove
that Garmoth lacks presets. No preset import or consumable upload schema is established by this diagnostic.

### Consumable presets

Settings → Integrations → Consumable presets accepts pasted Garmoth Consumable Planner exports with a `name` and comma-separated
`export` IDs. Pure TypeScript validates the export before a review table is shown. Exports contain no quantities,
prices, or reliable display-name catalog. Known item names are suggested; other identifiers retain a visible numeric
label that the user can rename. Unknown positive IDs are preserved, never treated as market item IDs automatically.

Users enter explicit total quantities for the session and integer silver unit prices (including an explicit zero for
free buffs). The second element of a Garmoth consumable pair is treated as quantity, consistent with the captured
one-hour website request and the user's explanation of three 20-minute perfumes. No duration scaling or market-price
fetch occurs. Saved presets remember the reviewed quantities and prices per region; users must review them for each
session. A preset is not an hourly schedule. Settings manages the library independently of the active session.
The grind desk's Apply preset dialog and History's upload-review dialog share the same preset-selection component
with a cost/quantity preview. Neither contains import or library-edit controls. Saving a preset does not apply it to a session. Desktop presets are validated by Rust and stored in SQLite settings, with at most 20 presets
and 100 unique consumables each. Preset names are local labels, not Garmoth account links.

Applying a preset atomically replaces the session's tagged consumable expenses, preserving ordinary manual expenses
and loot. Applying it again replaces rather than duplicates those rows. Each expense snapshots its price, quantity,
and optional Garmoth consumable ID. Later preset edits/deletion do not affect existing session entries. The ledger
allows quantity/price edits and removal while a session is unfinished. General finished-session edits retain the
existing explicit reopen rules. Presets are selected by recorded region; there is no cross-region price fallback for this workflow.

History opens a native upload-review dialog for both Upload to Garmoth and Upload again. It displays the selected
session's read-only ledger and stored prices, date, region, duration, expense total, net silver, and silver per hour.
Preset selection stays inside this dialog and only changes an in-memory draft. Cancel discards the draft. The final
Upload action approves saving the draft expenses and sending the session; repeat uploads additionally require the
existing duplicate-session confirmation. Successfully uploaded sessions may add missing consumables but cannot
replace existing consumables. The previous remote session is not changed.

Upload options are transient: global contribution defaults off, unchecked Agris is omitted, checked Agris with a blank
amount sends `-1`, and a specified amount must be a positive safe integer. The optional-field contract permits
omission of Agris; no undocumented zero/null sentinel is added. These options do not affect local silver calculations,
are preserved while retrying within the modal, and reset on reopening.

Drop buffs mirror Garmoth's manual upload form: one loot scroll level, then any other grind buffs. The bundled
`src/data/garmothBuffs.json` lists Garmoth's enabled grind buffs (`mode: 0`) with their drop rate, cap flag, drop
amount, and a curated tier group; tiers of one buff (loot scroll, Adventurer's Luck, Node War Benefit, Fortuna) are a
single choice. The drop rate adds the capped buffs up to 300% and the uncapped buffs on top (Garmoth's `is_uncapped`:
Blessing of the Morning, Eye of Arsha, Edania Buff, Castle Buff, the Defense Tokens, and Blessing of Agris Scroll). The
drop amount is the sum of the buffs' amounts. The upload sends the selected IDs as `buffs`, the drop rate as `rate` (a
percentage, so 250% sends `250`), and the drop amount as `amount`, omitting each when it is empty or zero. Rust
revalidates the IDs and tier groups against the same file and computes both totals itself. Submitting an upload stores
the selection under the `garmoth.buffs` setting, even if the upload then fails, and the next review preselects it; a
stored selection that no longer fits the catalog starts empty.

Rust validates options and preview totals and then rechecks the complete reviewed session snapshot under the Garmoth
operations lock. The lock covers the consumable correction, upload reservation, and HTTP operation. Corrections
replace only tagged expense rows in a transaction, preserving ordinary loot/expenses, historical prices, and all
session timestamps. Stale reviews, unfinished sessions, and unknown upload outcomes are rejected. Normal saves still
reject changes to finished sessions; there is no separate frontend correction command.

Local persistence and HTTP are not atomic. Once expenses have been saved, they are retained even if the request fails.
The upload result includes the saved session snapshot and a `failed`, `success`, or `unknown` outcome. The dialog uses
that snapshot for retries without reapplying the preset, and History refreshes its aggregates and any current finished
session. Known pre-transmission failures allow an explicit retry; ambiguous outcomes remain blocked. A stale-review
error before saving requires closing the dialog and reloading History.

Rust derives upload `consumables` pairs from the saved finished-session expense rows and sums quantities for repeated
IDs across price snapshots. Plain manual expenses affect net totals but are not serialized as consumables. Sessions
without tagged expenses send an empty array. The upload preview shows the number of distinct consumables. Net totals
continue to use stored expense prices; the remote treatment of costs may differ and must be checked in Garmoth.

The user confirmed that the external API accepts the nested pairs below without `consumable_build`:

```json
{"consumables": [[99999900, 1], [9692, 1], [1411, 3], [1407, 3], [761879, 1], [767969, 1], [100001510, 1]]}
```

These are evidence fixtures only; the application no longer hardcodes this preset into every upload. Automatic
account-preset fetching remains unverified. No authenticated research or live upload was performed during implementation.

### Repeat uploads

Confirmed uploads expose “Upload again” with a duplicate-session confirmation.
An explicit IPC flag allows Rust to atomically reserve a previously successful upload again. Unknown outcomes remain
blocked. A pre-transmission connect failure restores the previous success marker; a potentially transmitted failure
leaves it unknown. General finished-session editing and reopen restrictions remain intact; adding missing consumables
before an explicit repeat upload is the narrow correction described above. Repeated uploads create a new remote session,
not an update to the previous one.
