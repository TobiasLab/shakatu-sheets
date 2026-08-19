# Design

The application uses a normal desktop window rather than an in-game overlay. The current flow is deliberately small:

1. Select a region.
2. Start or resume a session.
3. Add loot and expenses manually.
4. Pause or finish the session.

The interface distinguishes market, vendor, and expense values. Market prices are never guessed when unavailable.
Automatic recognition is planned for English at 2560x1440 and 80% BDO UI scale, but no recognition controls are shown
until that feature exists.
