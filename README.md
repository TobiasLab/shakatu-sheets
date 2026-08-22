# Shakatu Sheets

Shakatu Sheets is a local-first, open-source silver-per-hour tracker for Black Desert Online. The initial target is Windows and Linux, including Wayland compositors.

## Current scope

- Manual live session tracking
- Editable completed hours for manually timed sessions
- History for the 20 most recent completed sessions, with grind-spot filtering and safe session reopening
- User-triggered EU and NA Central Market price snapshots from Arsha
- Sycraia Ruins Lower Level and revamped Star's End grind-spot profiles
- Light, dark, and system theme options
- English at 2560x1440 and 80% BDO UI scale as the first recognition target
- Local SQLite persistence with startup migrations

## Development

```sh
npm install
npm run tauri dev
```

On Arch-derived systems, build Linux bundles with `npm run bundle:linux`. The `NO_STRIP` workaround is required because linuxdeploy's bundled binutils do not understand Arch's RELR sections.

## License

Shakatu Sheets is licensed under the GNU Affero General Public License v3.0 only. See `LICENSE`.
