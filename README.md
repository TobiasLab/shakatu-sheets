# Shakatu Sheets

Shakatu Sheets is a local-first, open-source silver-per-hour tracker for Black Desert Online. The initial target is Windows and Linux, including Wayland compositors.

## Current scope

- Manual live session tracking
- Editable completed hours for manually timed sessions
- History for the 20 most recent completed sessions, with grind-spot filtering and safe session reopening
- User-triggered EU and NA Central Market price snapshots from Arsha
- Explicit Garmoth uploads for completed sessions, with local API-key and character settings
- Six grind-spot profiles covering Sycraia, Star's End, and four Edania zones
- Light, moss green, and dark theme options
- Local, user-triggered Marni loot screenshot imports with an editable review step
- English cropped screenshots at 80%, 100%, and 120% BDO UI scale as the first recognition target
- Local SQLite persistence with startup migrations

## Development

```sh
npm ci
npm run tauri dev
```

See [development setup](documentation/development/README.md) and [Windows support and validation status](documentation/development/windows.md). Windows builds use `npm run bundle:windows`; native Windows behavior and additional live-detection profiles still require validation.

On Arch-derived systems, build Linux bundles with `npm run bundle:linux`. The `NO_STRIP` workaround is required because linuxdeploy's bundled binutils do not understand Arch's RELR sections.

## License

Shakatu Sheets is licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.
