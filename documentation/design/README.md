# Design

The application uses a normal desktop window rather than an in-game overlay. The current flow is deliberately small:

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
