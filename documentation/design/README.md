# Design

The application uses a normal desktop window rather than an in-game overlay. The current flow is deliberately small:

1. Select a grind spot and region.
2. Optionally fetch or refresh that profile's regional market prices.
3. Start or resume a session, or enter hours for a grind timed elsewhere.
4. Add loot and expenses manually.
5. Pause or finish the session.
6. Filter and review completed sessions, or reopen one for corrections.

The grind-spot selector is available only while a session is idle with no elapsed time or entries. It locks as soon as
time or loot is recorded so one session cannot mix profiles. The current profiles are Sycraia Ruins Lower Level and the
revamped Star's End with 155,000-silver Corrupted Sanguine Crystal trash loot.

The interface distinguishes market, vendor, and expense values. Market prices are never guessed when unavailable and
network access only occurs after the user presses the Arsha fetch button. Saved prices show when they were fetched and
remain manually editable when adding an entry. If the selected region has no saved prices, the interface clearly labels
and uses the other region's saved snapshot as a local fallback.

History can show all completed sessions or filter them by grind spot. Reopening a session returns it to the live view in
a paused state; an active session with progress is never replaced.

Automatic recognition is planned for English at 2560x1440 and 80% BDO UI scale, but no recognition controls are shown
until that feature exists.
