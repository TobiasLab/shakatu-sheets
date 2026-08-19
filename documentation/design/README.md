# Design

The application uses a normal desktop window rather than an in-game overlay. The current flow is deliberately small:

1. Select a region.
2. Optionally fetch or refresh that region's market prices.
3. Start or resume a session.
4. Add loot and expenses manually.
5. Pause or finish the session.
6. Review completed sessions from the read-only history view.

The interface distinguishes market, vendor, and expense values. Market prices are never guessed when unavailable and
network access only occurs after the user presses the Arsha fetch button. Saved prices show when they were fetched and
remain manually editable when adding an entry. If the selected region has no saved prices, the interface clearly labels
and uses the other region's saved snapshot as a local fallback.
Automatic recognition is planned for English at 2560x1440 and 80% BDO UI scale, but no recognition controls are shown
until that feature exists.
