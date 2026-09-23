# Frontend polish review — 2026-09-23

Branch: `feat/bdo-frontend-polish` (continued from `feat/coherent-workspace-design`).

## Scope and visual reference

Reviewed the application shell, Grind desk, capture placement and review, loot ledger, manual entry, screenshot import,
grind-spot selection, History and filters, upload review, all Settings sections, consumable presets, shared controls,
and the separate session overlay. The review includes empty, populated, loading, failed, disabled, selected, focused,
locked, running, paused, and finished states where those states apply.

The default dark theme follows the neutral charcoal, ivory, gray controls, and subdued bronze/gold of the in-game
screenshots linked in the [design language](design-language.md#bdo-references). Saved theme IDs remain `dark`, `light`,
and `moss`. No external fonts, images, services, or UI packages were added to the application.

## Changes

| Area | Result |
| --- | --- |
| Shared visual system | Neutral charcoal default; separate primary-action, warning, expense, and success colors; compact 3px/4px/6px control/panel/dialog corners; consistent type and spacing |
| Shell and desk | Narrower desktop navigation, scrollable short-window sidebar, quieter selected navigation, restrained earnings emphasis, themed error feedback and accurate shared storage-error wording |
| Dialogs and pickers | Consistent sticky dismissal, readable fields, compact catalog rows and actions, long-name wrapping, preserved keyboard focus |
| Capture | Larger secondary labels, clearer review hierarchy, focused recovery after clearing review, truthful preview-only and startup status |
| Screenshot import | One consistent layout; accessible progress; visible invalid fields; distinct ready and review states |
| History | Visible removable filter values, selected comparison rows, compact pagination, keyboard-scrollable recorded items, long-name handling |
| Upload review | Content-sized scroll rows prevent ledger/options overlap; opening review keeps the selected-session context visible |
| Settings and presets | Full-width consumable editor, paired selectors, aligned quantity/price table, grouped expenses and actions, applied preset label |
| Session overlay | Compact three-column metrics and 40px item tiles; supported 320×180 layout; wrapped errors; consistent icons and full-location tooltip |
| Light theme | Muted text contrast increased on selected and hover surfaces |

## Verification evidence

- `npm run check`: passed, 138 files.
- `npm test`: passed, 457 tests across 31 files.
- `npm run build`: passed. Existing Vite notices remain for mixed static/dynamic Tauri window imports and the main bundle above 500 kB.
- `git diff --check`: passed.
- Focused browser fixtures exercised manual entry, catalog/spot selection, ledger editing/filtering, History filters and focus,
  Garmoth review and options, preset import/edit/save/apply, screenshot draft correction/import, and overlay controls.
- Dark, light, and moss were inspected. Main dialogs were exercised at 640×420 (below the native 960×680 main-window minimum); upload review also at 440px wide.
  Overlay controls and metric rectangles were checked at 320×180, including a wrapped error and waiting state.
- Browser screenshots were visually reviewed in addition to checking page overflow, reachable controls, focus restoration,
  row non-overlap, and runtime exceptions. No real integration requests were sent.

### Capture workflow

The final complete browser smoke passed with the Windows backend fixture and explicit 3440×1440 source:

```sh
UI_SMOKE_SOURCE=3440x1440 UI_SMOKE_BACKEND=windows UI_SMOKE_OUTPUT=/tmp/shakatu-bdo-final node scripts/smoke-loot-ui.mjs
```

It exercised manual placement, automatic search/cancel/confirmation, XML position import, local OCR review,
retry/dismiss/correction, pending-capture drain, and finishing without unresolved entries. The earlier complete Linux
fixture also passed with temporary frame diagnostics. The 1920×1080 source has no calibrated OCR profile; focused
checks verified placement and preview, the unavailable status, and that incoming frames add no review or ledger entries.

The smoke fixture now supplies blank frames during OCR startup after a Windows source gap. The exact item-frame
sequence and result assertions remain unchanged. The three-job local OCR completion wait has a bounded 30-second
budget: diagnostic evidence showed correct results arriving after the former five-second UI deadline. No production
recognition timing or algorithm was changed.

Final smoke log: `/tmp/shakatu-bdo-final-smoke.log`. Source-profile check: `/tmp/shakatu-bdo-unsupported.log`.
Detailed surface coverage and focused commands: `/tmp/shakatu-bdo-coverage.md`.

### Local review artifacts

The review fixtures and screenshots use synthetic local data. Session-local artifacts are in
`/tmp/shakatu-bdo-final/`, `/tmp/shakatu-bdo-history-settings/`, and `/tmp/shakatu-shared-components-final/`.
These paths are working-session evidence, not shipped app assets or permanent test fixtures.

## Completion criteria

| Objective | Evidence |
| --- | --- |
| Preserve the design work | Reviewed on `feat/coherent-workspace-design`, then moved to `feat/bdo-frontend-polish` for publication at the user’s request |
| Research BDO in-game colors on the web | Official guide screenshots and archived market image inspected; source links and sampled panel colors are in the design language |
| Replace the disliked default palette | `src/index.css` defines the new default charcoal/ivory/bronze palette; rendered dark-theme screens inspected |
| Review the whole frontend | Scope table above plus focused fixtures cover every view, shared dialog/control, capture surface, and overlay |
| Make the experience coherent and polished | Shared radii, typography, spacing, semantic states and actions; concrete layout/focus/contrast defects corrected and checked in rendered screens |
| Preserve normal workflows | Unit tests, production build, and full/focused browser evidence described above and in the final capture results |

## Limits

Browser fixtures exercise the frontend and mocked Tauri commands. Native OS source picking, actual monitor placement,
and platform capture backends were not exercised in a real desktop session. Capture review uses local OCR on synthetic
pixels; screenshot-import draft tests supply a synthetic recognition result so the correction UI can be verified separately
from OCR accuracy. No recognition algorithms or persisted session calculations were changed for the visual refresh.
