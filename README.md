# Shakatu Sheets

Shakatu Sheets is a local-first, open-source silver-per-hour tracker for Black Desert Online. The initial target is Windows and Linux, including Wayland compositors.

## Current scope

- Manual live session tracking
- Editable completed hours for manually timed sessions
- Paginated completed-session history, with region, date, and grind-spot filtering, comparisons, and safe reopening
- A persisted net-over-time trend for the active session, and personal per-spot rates in the spot browser
- User-triggered EU and NA Central Market price snapshots from Arsha
- Explicit Garmoth uploads for completed sessions, with local API-key and character settings
- Bundled grind-spot catalog, including Dehkia variants
- Dark and light themes
- Local, user-triggered Marni loot screenshot imports with an editable review step
- Session-only review of uncertain live loot captures, with item images, single-image OCR retries, and manual item/quantity correction. OCR retry suggestions are added only when confirmed. Images stay in memory until resolved, cleared, the session finishes, or the app closes.
- English cropped screenshots at 80%, 100%, and 120% BDO UI scale as the first recognition target
- Local SQLite persistence with startup migrations

See the [documentation index](documentation/README.md) for product behavior and technical references.

## Development

Use `main` plus focused feature branches, with pull requests targeting `main` directly. See the
[branch workflow](documentation/development/README.md#branch-workflow).

```sh
npm ci
npm run tauri dev
```

See [development setup](documentation/development/README.md) and [Windows support and validation status](documentation/development/windows.md). Windows builds use `npm run bundle:windows`; native Windows behavior and additional live-detection profiles still require validation.

On Arch-derived systems, build Linux bundles with `npm run bundle:linux`. The `NO_STRIP` workaround is required because linuxdeploy's bundled binutils do not understand Arch's RELR sections.

## License

Shakatu Sheets is licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.
