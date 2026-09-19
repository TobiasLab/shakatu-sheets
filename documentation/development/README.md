# Development

Use Node from `.node-version` and Rust from `rust-toolchain.toml`. For native Windows prerequisites, installer commands,
and outstanding validation, see [Windows support](windows.md). Install locked dependencies and run the desktop application:

Linux builds require the PipeWire development headers (`libpipewire-0.3-dev` on Debian/Ubuntu or `pipewire-devel` on
Fedora) and Clang for the Rust PipeWire bindings' generated FFI.

The offline live-loot video benchmark additionally requires FFmpeg. Benchmark videos and generated frames must not be
committed. Development builds can write 30-minute normal and rare ROI samples under the ignored
`dev-samples/live-loot/` directory. Each run also records recognized, withheld, failed, and dropped OCR events in
`ocr-issues.jsonl`. Version 2 records include native frame IDs, exact row/crop bounds, final item quantities, and individual
preprocessing passes when available; see the [capture documentation](../design/live-loot-recognition.md).

```sh
npm ci
npm run tauri dev
```

Development builds and verification run locally. No GitHub Actions workflow is configured.
For an optimized executable without creating an installer, run this from the repository root:

```sh
npm run tauri -- build --no-bundle -- --locked
```

The executable is `src-tauri/target/release/shakatu-sheets.exe` on Windows and
`src-tauri/target/release/shakatu-sheets` on Linux. Use `npm run tauri dev` when collecting debug ROI samples.

To produce a Windows `.exe` on Linux, use the [cross-compilation setup and command](windows.md#cross-compiling-an-executable-on-linux).

Run normal verification:

```sh
npm run check
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

Build an AppImage on Arch-derived Linux distributions with:

```sh
npm run bundle:linux -- --bundles appimage
```

The application disables WebKitGTK's DMA-BUF renderer on Linux Wayland to avoid NVIDIA protocol errors. Live monitor
capture uses the XDG ScreenCast portal and PipeWire directly on Linux. Windows is not affected.


## Branch workflow

Use `main` as the only long-lived branch. The former `dev` integration branch is retired; all new feature and fix pull
requests target `main` directly.

Before starting work, fetch the latest `main` and create a focused branch:

```sh
git fetch origin
git switch -c feat/short-description origin/main
```

Use `fix/short-description` for bug fixes. Keep each branch focused on one change and its documentation and tests.
Run the relevant verification before opening a pull request into `main`. Agents commit and push only when requested,
and rebase-merge after checks pass and the user authorizes the merge.

After merging, preserve any unrelated local changes, return to `main`, and update it:

```sh
git switch main
git pull --ff-only
```

The normal flow is `main` → feature branch → PR into `main`, with no intermediate integration or promotion branch.


## Performance and UI verification

See [the performance report and game-impact protocol](../design/performance.md). Enable native aggregate capture
measurements by launching the release app with `SHAKATU_CAPTURE_DIAGNOSTICS=1`. Native metrics are emitted at most once
every five seconds. For frontend analysis/OCR timing, open capture setup and expand Advanced diagnostics. Close the
panel for normal resource measurements. The debug ROI collector remains opt-in and absent from release builds.

A browser smoke test uses synthetic Tauri responses and does not access the user's database or accounts:

```sh
npm run dev
# In a separate terminal; use your installed Chromium executable.
chromium --headless --remote-debugging-port=9222 --user-data-dir=/tmp/shakatu-ui-browser about:blank
# In another terminal (Node 22+ for the built-in WebSocket client):
node scripts/smoke-loot-ui.mjs
```

The test opens and closes its own tab, uses real browser pointer and keyboard events, and verifies navigation/minimization/
preview and finish behavior, sidebar collapse/expansion and capture navigation, timer persistence isolation, dialog focus and
Escape dismissal, manual loot and expense entry,
submission feedback, shared field labels, Settings load retry and local key feedback, preset loading/retry, History empty states and date validation, expense price isolation, new-session draft/filter reset, ledger edits and filters, history filtering, all three themes, and 960/700/640px layouts. Blank-price and
Escape regressions verify that rejected/cancelled edits preserve persisted values. Screenshots include capture setup and
compact entry, history, and settings views. Screenshots go to the OS temporary directory under `shakatu-ui`; set `UI_SMOKE_OUTPUT` to
choose another directory. `UI_SMOKE_URL` overrides the default Vite URL. The browser fixture does not validate the real
PipeWire portal, Windows capture, the installed webview, Garmoth, or the game's FPS.

Set `UI_SMOKE_BACKEND=linux` or `windows` and `UI_SMOKE_SOURCE=1920x1080` or `2560x1440` to also verify synthetic
manual startup, explicit normal relocation, rare search/cancellation/confirmation, and the transition to exact ROI capture
at 80% BDO UI scale. Set `UI_SMOKE_SCALE=100` to exercise 100% native search requests, normal/rare crop sizes, and
automatic placement. These are synthetic browser fixtures, not native gameplay validation.

Set `UI_SMOKE_SOAK_SECONDS=30` when running `npm run test:ui` to exercise sustained synthetic frame delivery at the current
16 FPS trial rate. Automatic-placement fixtures supply 12 normal and six rare search frames to cover its rate-aware evaluation
cadence. This is
separate from the real-game 30-minute resource/recognition acceptance run.


For detection changes, replay developer ROI samples with `npm run benchmark:loot:roi -- /path/to/dev-samples/live-loot --ocr`. Add `--validation` for the reserved split. For the refreshed September 5 corpus, pass
`--annotations scripts/fixtures/loot-roi-2026-09-05.json` so the sample directory can remain untouched. See the [ROI replay documentation](../design/live-loot-benchmark.md#roi-sample-replay)
for scoring limits and optional JSON reports. Captured PNGs stay outside tracked source.

Use `UI_SMOKE_BACKEND=windows` for the synthetic Windows capability path (in
PowerShell set `$env:UI_SMOKE_BACKEND = 'windows'`). This remains a browser fixture, not native Windows validation. Run matrix cases sequentially in one browser: concurrent tabs
change document visibility and correctly suppress previews in the background case.

The ROI replay supports `--sample-step 2 --sample-offset 0|1` for offline sampling sensitivity checks. Reports retain native
batch IDs and distinguish recorded from replayed frame counts. This does not change gameplay capture settings. See the
[repeated-arrival evaluation](../design/repeated-loot-arrivals.md) for the reviewed fixture and reproduction commands.

## Grind spot catalog

The bundled catalog includes 97 land grind spots, including Dehkia variants. The additional 91 profiles were imported
from Garmoth's public `https://api.garmoth.com/api/external/grind-tracker` endpoint on September 11, 2026.
To refresh the imported profiles, run from the repository root:

```sh
npx vite-node scripts/sync-grind-spots.mjs
```

An optional saved metadata JSON path makes an import reproducible. The script selects land grind spots
(`spot_type >= 100`), excludes `(OLD)` and `(TBD)` entries, and preserves the original six curated profiles and IDs.
Imported profiles use stable `garmoth-<id>` IDs. It regenerates the catalog and backend upload mappings together,
and downloads missing icons using the API's image paths. Review generated changes before committing.

Taxable drops use market pricing; enhanced items require manual prices because market lookup supports base items only.
Other drops use Garmoth's supplied fixed valuation, which may represent conversion value rather than an NPC sale price.
Repeated drop keys are deduplicated; identically named treasure pieces are distinguished with their API keys.
Four event entries without artwork use the existing artifact icon. Catalog and icons work offline without an API key.
