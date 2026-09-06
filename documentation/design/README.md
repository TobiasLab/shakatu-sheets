# Design

The application uses a normal desktop window rather than an in-game overlay. The grind desk puts session time and earnings first. Neutral dark is the default for new installations; saved
light, moss, and dark preferences are retained. The current flow is:

1. Select a grind spot and region.
2. Optionally fetch or refresh that profile's regional market prices.
3. Optionally start screen capture and local loot recognition before starting the timer.
4. Start or resume the timer, or enter hours for a grind timed elsewhere.
5. Add loot and expenses manually, or review and import a cropped Marni loot tracker screenshot into an empty session.
6. Pause the timer or finish the session.
7. Filter and review completed sessions, reopen one for corrections, or permanently delete one after confirmation.

The grind-spot selector is available only while a session is idle with no elapsed time or entries. It locks as soon as
time or loot is recorded so one session cannot mix profiles. The current profiles are Sycraia Ruins Lower Level,
revamped Star's End, Zephyrus Castle, Aphrodon Temple, Hermesia Inner Castle, and Magaia Temple.

The interface distinguishes market, vendor, and expense values. Market prices are never guessed when unavailable and
network access only occurs after the user presses the Arsha fetch button. Saved prices show when they were fetched and
remain manually editable when adding an entry. If the selected region has no saved prices, the interface clearly labels
and uses the other region's saved snapshot as a local fallback.

History can show all completed sessions or filter them by grind spot. Reopening a session returns it to the live view in
a paused state; an active session with progress is never replaced. Finished sessions can be permanently deleted after an
explicit confirmation.

Screenshot recognition is local and starts only after the user chooses a file. The current importer accepts cropped English
Marni loot tracker screenshots at 80%, 100%, or 120% BDO UI scale, reads the grind spot, duration, item icons, and quantities,
then presents an editable draft. Uncertain quantities receive four alternate local OCR passes, and unmatched icons are
retried with shifted alignment. Valid low-confidence suggestions remain populated and marked for review. Confirmation
imports only complete rows and is available only for an empty idle session. Screenshots and draft thumbnails are not
persisted.

Live notification capture and recognition is described in the
[live loot recognition plan](live-loot-recognition.md).
The local video sampling and annotation contract is described in the
[live loot benchmark guide](live-loot-benchmark.md).


## Workspace design

The interface follows a restrained desktop workspace direction inspired by the Codex app: neutral dark/light surfaces,
system typography, plain section dividers, small monochrome icons, and color reserved for meaningful states. A left sidebar
provides Grind desk, History, Capture setup, and Settings, plus the current session and save state. It can collapse on desktop
and becomes a labeled-for-assistive-technology icon rail below 1000px. A thin workspace bar keeps session status visible at
compact sizes; persistence failures appear in a full-width alert. The sidebar collapse preference is transient UI state.

Main screens use flat content rather than metric cards or decorative panels. Dark, light, and moss themes retain their saved
identifiers. Theme previews reflect the sidebar/workspace contrast. Styling uses CSS, bundled item icons, and small SVGs;
there are no remote fonts, automatic network requests, new dependencies, or decorative animations.

The desk groups spot, region, and an explicit market-price disclosure above a single earnings/timer overview. The spot
selector explains its lock after time or entries are recorded. Net silver/hour shows a dash until elapsed time is available.
Manual time remains under Enter hours, while gross, expenses, and deductions are under Value breakdown. Neither timer ticks
nor local filters mutate session snapshots.

Capture and the ledger share the full workspace width. The capture strip expands inline for placement; source controls and
platform guidance remain available during a session. Entry and screenshot actions sit beside the ledger heading so they do
not cover table rows. The editable ledger follows below. Quantity and unit price are aligned in a table;
Enter saves, Escape restores the saved values, and invalid edits restore values with an explanation. A blank price is invalid,
while an explicit zero remains valid. Search and loot/expense filters only change the visible rows. Narrow windows scroll the
table within its labeled, keyboard-scrollable region rather than widening the whole app.

Add loot or expense and Import a screenshot open native dialogs. Dialogs contain focus, close with Escape, and restore the
opener; manual entry initially focuses item search. The catalog focuses quantity after item selection. A direct expense action
focuses the entry name. Submission feedback distinguishes added entries from invalid or overflowing quantities. Dialog content
stays mounted when closed, preserving screenshot review within the same session; a new session clears the import draft and
entry feedback. Import still requires an empty idle session. The import draft labels low-confidence populated suggestions for
review and does not claim they are blank.

Capture setup expands to the full desk width, with source/alignment/confirmation progress, full preview, normal and rare crop
previews, and the existing manual, automatic, nudge, scale, and confirmation controls. Confirming both areas closes setup and
returns keyboard focus to its button. Setup can reopen during capture. Previews run only while setup is visible; recognition
continues across navigation and minimization. Needs attention shows unaccepted results, distinguishes read failures from
recognized loot awaiting insertion, and explains Retry add, manual correction, and Clear. Clearing review does not remove loot.
Advanced diagnostics, diagnostic JSONL, and optional paired ROI collection retain their existing behavior and bounds.

History shows totals for the current filter over the latest 20 finished sessions, including aggregate net, elapsed time, and
net per hour weighted by elapsed time. Session selection shows its time, earnings, and recorded entries before Garmoth upload
controls. Explicit reopen and confirmed deletion remain available. The finished desk offers a direct View history action.
Settings uses divided label/form rows with section links, visual radio choices for themes, capture guidance, and sequential
Garmoth connection/character setup. Disabled character controls explain that the API connection comes first. Network requests remain explicit.
