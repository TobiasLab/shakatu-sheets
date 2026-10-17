# Contributing

Thanks for helping improve Shakatu Sheets. Bug reports, recognition data, and pull requests are all welcome.

## Reporting bugs

Open an issue with:

- What you did, what you expected, and what happened.
- Your OS and version, and on Linux your desktop or compositor (for example KDE Plasma, Hyprland, GNOME).
- For recognition problems: resolution, BDO UI scale, loot font, and whether you captured a monitor or the game window.
- A screenshot of the app or the loot area if it helps.

Check screenshots and logs before attaching them. Never post your Garmoth API key, and crop out anything personal.

Security problems should not go in a public issue; see [`SECURITY.md`](SECURITY.md).

## Development setup

Follow [Installation](README.md#installation) for prerequisites and `npm run tauri dev`. The
[documentation](documentation/README.md) describes the architecture, database, product behavior, and platform details;
read the part you are changing first.

## Making a change

1. For anything larger than a small fix, open an issue first so the approach can be agreed before you invest time.
2. Branch from the latest `main`: `feat/<short-description>` for features, `fix/<short-description>` for bug fixes.
3. Keep the branch focused on one change, including its tests and documentation.
4. Open a pull request into `main`. Pull requests are rebase-merged, so each commit should stand on its own.

Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`) in the imperative, describing the behavior that changed.

## Guidelines

The project values, in order: correct behavior, simple code that is easy to understand, the smallest change that solves
the problem, clear tests for important behavior, and abstraction only when there is a concrete need.

- **Architecture.** React owns presentation and transient UI state. Pure TypeScript functions own session calculations
  and state transitions. Rust owns filesystem access, SQLite, operating-system integration, capture, and HTTP. Keep
  Tauri commands thin and business logic in ordinary, testable functions.
- **TypeScript and React.** Keep Biome clean. Use named exports and no barrel files. Prefer functions, discriminated
  unions, and plain objects. Keep reducers pure. Effects synchronize with external systems; they do not compute
  derived state. Add `useMemo` or `useCallback` only for a concrete reason. Preserve keyboard and screen-reader
  behavior.
- **Rust.** Prefer modules of data types and free functions. Validate input again at the Rust boundary. Use
  transactions for multi-table writes. Keep platform-specific code behind `cfg` attributes, and make sure Linux
  workarounds do not change Windows behavior.
- **Database.** Add schema changes as new ordered migrations and never edit a released migration. Store silver as
  integers and times as milliseconds. Prices recorded in a completed session must never change.
- **Privacy.** User data stays on the device unless the user explicitly sends it. Never commit API keys, databases,
  personal screenshots, or gameplay recordings.
- **Dependencies.** Prefer existing dependencies and platform APIs. Check maintenance, license, platform support, and
  bundle size before adding one, and update [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for anything shipped
  with the app.
- **Documentation.** Update the relevant file under `documentation/` when you change architecture, schema behavior,
  setup, design rules, or dependency policy.

### Recognition changes

Live loot recognition is tuned against real gameplay recordings, and small changes can quietly reduce accuracy. A pull
request that changes recognition, tracking, or OCR settings should include before-and-after results from the
[loot benchmarks](documentation/development/live-loot-benchmark.md) on your own recordings, and must not change results
for configurations it does not target. Recordings and generated frames must not be committed.

## Checks

Run these before opening a pull request:

```sh
npm run check
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Say in the pull request which platforms you tested on. If you could not test something, such as Windows or a specific
desktop, say so.

## License

By contributing, you agree that your contributions are licensed under the project's license,
[`AGPL-3.0-only`](LICENSE).
