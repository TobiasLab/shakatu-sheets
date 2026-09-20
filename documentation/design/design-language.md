# Design language

Shakatu Sheets is a desktop workspace for tracking grind sessions. Its visual identity pairs an ink canvas with mint
surfaces, large earnings figures, a compact horizontal navigation bar, and a ledger that reads like a working document.
The light theme uses paper and green ink; moss uses forest and sage. Bundled item artwork keeps locations recognizable.

This is the reference for new and revised UI. The [design overview](README.md) documents feature behavior. Use the shared
components and tokens before introducing local variations. The redesign retains existing session, capture, persistence,
and integration behavior and adds no UI framework, remote fonts, or downloaded artwork.

## Foundations

### Color and surfaces

Use the CSS custom properties in [src/index.css](../../src/index.css). Dark remains the default. Existing `dark`, `light`,
and `moss` preference identifiers are unchanged.

| Purpose | Tokens | Usage |
| --- | --- | --- |
| Workspace and navigation | `--canvas`, `--chrome` | Page background and app bar |
| Content surfaces | `--surface`, `--surface-raised` | Working panels, dialogs, inset summaries, and table headings |
| Interaction | `--hover`, `--selected` | Hover and persistent selection, paired with a semantic state |
| Dividers | `--line`, `--row-line`, `--line-strong` | Panel/table separators and control borders |
| Text hierarchy | `--text-strong`, `--text`, `--text-soft`, `--muted` | Titles, content, secondary content, and labels |
| Controls | `--input-background`, `--button-background`, `--button-border`, `--button-hover-border` | Shared inputs and actions |
| Primary actions | `--brand`, `--brand-contrast`, `--brand-hover` | Mint on dark, green on light, and sage on moss |
| Selected surfaces | `--brand-surface`, `--brand-border` | Active navigation and selected controls |
| Leading earnings | `--feature-background`, `--feature-text` | A pale colored block with dark, high-contrast figures |
| Feedback | `--success`, `--danger` | Success, errors, destructive actions, and negative ledger values |
| Keyboard focus | `--focus-border` | Visible focus outlines and focused input borders |

Give each independent working area one bordered surface with `--panel-radius` (16px). Use dividers and spacing inside it;
do not put every control in its own card. The leading earnings block uses its own paired text/background colors in all
themes. Its static circular line motif is CSS decoration, separate from data. Reserve shadows for floating disclosures
and dialogs. State must remain understandable without color alone. Existing `--gold` is a semantic warm warning/expense
color, not a brand accent; `--mint` aliases the current brand for older capture styling.

### Typography and spacing

Use the system font stack; do not load remote fonts. The hierarchy comes from large page titles and earnings figures,
moderate section headings, and compact controls. Use sentence case and preserve game names. The clock uses the local
`--font-numeric` monospace stack. Other monetary values use tabular numerals without forcing a monospace face.

| Role | Default |
| --- | --- |
| Body | 14px, line-height 1.5 |
| Page title | 28–36px, weight 650 |
| Selected location | 20–27px, weight 550 |
| Section heading | 16px, weight 600 |
| Dialog title | 22px, weight 600 |
| Controls | 12px, weight 600 for actions |
| Supporting labels | 11–12px |
| Leading earnings | 40–64px on desktop, smaller in compact windows |
| Secondary earnings | 32–46px on desktop |

Use `--space-1` through `--space-6` for the 4, 8, 12, 16, 20, and 24px spacing steps. Standard controls use
`--control-height` (38px) and `--control-radius` (8px); compact table and toolbar controls may be smaller. Dialogs use
`--dialog-radius` (18px). Labels and control/title sizes use `--text-label`, `--text-control`, and `--text-dialog-title`.
Long names wrap where identification matters. Tiny text is reserved for secondary hints, never essential instructions.

Use the shared [Icon component](../../src/components/Icon/Icon.tsx) for monochrome interface symbols. The wordmark pairs
a solid app mark with stacked text on desktop. Bundled game icons retain their color and use a neutral frame: 56px in
the selected location, 36px in catalogs, and smaller in shortcuts and tables. Decorative icons are hidden from assistive
technology. Icon-only actions need an accessible name.

## Workspace and responsive layout

The app bar contains the wordmark and a labeled horizontal navigation group for Grind desk, History, Capture setup, and
Settings. There is no sidebar or collapse preference. At 960px and below, the navigation takes a second row and retains every
label. A running, paused, or completed session has a compact return-to-session control in the app bar. Save status shares this reserved area so autosave never shifts the workspace. Loading and
save failures remain visible independently of window width; omit idle readiness and successful-save messages.

The workspace is at most 1480px wide. The Grind desk starts with its title and region, then a single session surface:
selected spot above a three-part earnings/timer overview. The leading rate occupies a colored block; net value and timer
remain on ordinary surfaces. At 760px and below, the clock moves beneath the two earnings figures. Unknown rates show a
dash until time is recorded. Value breakdown and manual time remain disclosures.

Below the overview, a 280px capture panel sits beside the ledger on wide desktops. Setup and unresolved capture review
expand to the full width without changing the capture controller's lifecycle. Below 1100px, both sections stack in DOM
order. The ledger has a compact action header, entry count, search/filter row when populated, sticky table labels, and
inline editing. Large tables scroll within their labeled keyboard-accessible region.

History uses three overview blocks, a comparison sheet, and separate session-list/detail surfaces. Comparison bars show
the magnitude of each spot's actual duration-weighted rate relative to the largest magnitude in that comparison. Negative
rates retain their sign and use the negative color; unknown rates have no bar. The values and table remain the accessible
source of information. The methodology and sample-size context are unchanged.

Settings has a section index beside its content, turning into a wrapping link row below 760px. Market and integrations
use wide panels; appearance and capture share a row when space permits. Theme previews reflect the app bar and earnings
block. Region, prices, and the shared spot browser remain together under Market with existing session locks.

Dialogs, imports, presets, feedback, and the pop-out session use the same palette and control tokens. Native capture
previews keep dark image surfaces with readable labels in every theme. Allow control rows to wrap; use `min-width: 0`
and `minmax(0, 1fr)` for flexible content. The whole window must not scroll horizontally.

## Controls and selection

Reuse the global button classes instead of inventing a different treatment for each feature.

| Control | Convention |
| --- | --- |
| Standard action | `.button`: 38px minimum height, 12px text, 8px corners, 9px/14px padding |
| Primary action | `.button.primary-button`: reserve strong emphasis for the main next action in its context |
| Secondary or dismiss action | `.button.subtle`: transparent background and border, subtle hover surface |
| Input/select | Existing input tokens, one-pixel border, 8px corners, visible label or accessible name |
| Search | Prominent at the top of a catalog; around 42px high, with a way to clear a nonempty query |
| Selection/filter | Persistent selected surface and border, with `aria-pressed` or the appropriate native state |

Use [FormField](../../src/components/FormField/FormField.tsx) for a visible label wrapping one native input, select,
or textarea. It owns label spacing, control dimensions, disabled styling, and invalid borders. Keep refs, input types,
validation, and `aria-describedby` on the native control. Table cells, range controls, and checkboxes retain their compact
layouts. Shared fields are used in entry, screenshot review, History filters, Settings, and preset editing.

Use [SelectionButton](../../src/components/SelectionButton/SelectionButton.tsx) for immediately applied button choices,
including spot filters/shortcuts, loot rows, preset choices, and History session rows. It owns `aria-pressed`, disabled
behavior, and persistent selected/hover styling; callers own selection and content. Theme choices remain native radios
with their existing arrow-key behavior. Keep table cells flat; selectable session rows and catalog tiles use a clear surface and border.

Use native buttons, inputs, and selects where they fit the interaction. A short list such as EU/NA can remain a select.
A large catalog benefits from search and recognizable rows or tiles. A selection action and an auxiliary action such as
starring must be separate buttons; never nest buttons. Selecting a spot applies immediately, while starring keeps the
browser open. Show the selected item independently of its hover state.

Disabled controls retain their context and have an understandable reason when it is not obvious. A permanent session lock
is better represented by the chosen value and a lock explanation than by a disabled selection form. Temporary loading
should not silently change the selected value.

## Dialogs

Use native `<dialog>` with `showModal()`. Compose the shared `Surface` class from
[Dialog.module.css](../../src/components/Dialog/Dialog.module.css) and use
[DialogHeader](../../src/components/Dialog/DialogHeader.tsx) for the title and Close Esc control.
The shared component owns presentation only; each caller retains its native dialog ref, initial focus, cancellation,
and draft lifecycle. Entry, screenshot import, spot selection, and consumable preset selection use this header.
History filters and upload review also use the shared header; upload review disables dismissal while sending. The
[spot browser](../../src/components/GrindSpotPicker/GrindSpotPicker.module.css) adds its own bounded catalog layout.

### Size and composition

- Use a 900px maximum width for catalog/form dialogs, constrained to the viewport with 20px side margins on desktop.
- Use a compact content-driven height. Catalog length must not make a picker fill the window: the spot browser is capped
  at 620px, with the result area scrolling beneath its header, search, and filters.
- For longer forms, the viewport ceiling is `calc(100dvh - 48px)`. Below 760px, use 12px viewport margins and a ceiling of
  `calc(100dvh - 24px)`; retain the 620px cap for compact pickers.
- Use `--surface`, a one-pixel `--line-strong` border, 18px corners, and `--dialog-shadow`. The dark backdrop uses a subtle 4px blur.
- The header uses 20px/24px padding, a bottom divider, and a 22px title. Omit subtitles by default. Compact headers use
  16px padding. Keep the header and dismissal available while long content scrolls.
- Short confirmations should be narrower and sized to their message; the existing finish dialog uses a 520px maximum.

### Close control and keyboard behavior

Use the same visible **Close Esc** control in every task dialog. It is a subtle button with a descriptive accessible name:

```tsx
<button className="button subtle" type="button" aria-label="Close spot browser" onClick={close}>
    Close <kbd>Esc</kbd>
</button>
```

The `kbd` label uses the inherited font, 10px text, and `--muted`. Keep the button from shrinking or wrapping within itself.
Do not introduce a bordered Close button or replace this established control with an unlabeled icon.

Give the dialog an accessible title. Initially focus the first useful field, usually search, contain keyboard focus, support
Escape, and restore focus to the opener when it remains available. If it disappears, move focus to a sensible remaining
control. Close the dialog when its parent task becomes unavailable. Preserve or reset draft state according to the task;
opening or dismissing a dialog must not itself submit a draft or start a session.

## Feedback and language

Use short, concrete labels: Choose grind spot, Add loot or expense, Start timer, Clear search.

The product owner's preference is a compact interface without routine subtitles or explanatory paragraphs. Do not add
page descriptions that repeat the title, instructions for obvious controls, or prose explaining table scope, sorting,
calculation formulas, sample-size caveats, or price provenance. Make the interaction understandable through labels,
layout, selected states, and the data itself. If an interface needs a paragraph to make sense, simplify its design.
Keep calculation rules and methodological limitations in design documentation. Show concise help only when it resolves
a specific actionable problem, such as an error or an unavailable action; do not replace removed prose with generic
help disclosures or tooltips.

Routine idle capture instructions, metric explanations, auto-save descriptions, integration taglines, and repeated
manual-entry hints are omitted. Capture shows a concise recognition status only when connected. Keep actionable
source limitations, file format/scale requirements, correction guidance, and explanations of session locks. Capture
area choices and correction fields use the shared selection and field components; preview geometry stays specialized.

Keep secondary filter controls behind a Filters button using the established native dialog pattern, rather than a
permanent section above the content. A compact region value or active-filter count can appear on the button. Preserve
accessible labels, keyboard focus, Escape dismissal, and useful error feedback.

An empty state explains what is missing and the next useful action. Distinguish no data from no search results. Unknown
values use an explanatory label or a dash; do not present a made-up zero as a known value. Errors identify the failed action
and, where possible, a way to recover. Use alerts for actionable errors and polite status announcements for changing result
counts or routine feedback. Avoid announcements for every timer tick.

Use [Feedback and EmptyState](../../src/components/Feedback/Feedback.tsx) for common task messages. Feedback sits beside
the triggering control, uses a polite status or error alert, and can include a recovery action. Do not show empty data
while a load is pending. Failed preset reads hide stale choices and offer Retry. History distinguishes no completed
sessions in the current region from no matches for active filters; filtered emptiness offers Clear filters, read failure
offers Retry history, and invalid date ranges label both date fields and offer Edit filters. Garmoth key feedback stays
with the key form, character feedback stays with character setup, and initial settings read errors offer Retry settings.
Manual-entry success clears on draft edits. Screenshot import confirms the number of entries imported. Existing capture
progress/review and upload outcomes retain their task-specific controls; avoid replacing actionable detail with generic
success messages. Loading the session ledger shows a reading status instead of an empty-session prompt.

Network activity should follow an explicit user action, consistent with existing product behavior. Use bundled assets and
CSS for presentation. Controls use 120ms color, border, and background transitions, with an inset pressed treatment that does not shift layout.
Dialogs fade in over 160ms without sliding or scaling; closing remains immediate. The `--motion-fast` and
`--motion-dialog` tokens become zero under `prefers-reduced-motion`. Avoid decorative or continuous animation.
External fonts and new UI dependencies are not part of the current language.

## Reviewing a UI change

- Compare it with the existing equivalent control or dialog before choosing new styling.
- Check dark, light, and moss themes, including selected, focused, disabled, empty, and error states that apply.
- Check keyboard access, accessible names, Escape, and dialog focus restoration.
- Check a normal desktop window and a 640px-wide window, long game names, and scroll behavior. Dialogs must also fit short
  windows without hiding their dismissal or task controls.
- Keep the initial view compact. Large catalogs should add scrolling or search, not unnecessary window-sized surfaces.
- Reuse tokens and established patterns. Record deliberate changes to shared conventions here rather than creating a
  competing description in feature documentation.
