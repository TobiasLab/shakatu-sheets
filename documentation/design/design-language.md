# Design language

Shakatu Sheets is a desktop workspace for tracking grind sessions. Time, earnings, the selected location, and loot should
be easy to scan. Neutral charcoal surfaces, ivory text, muted bronze controls, and system typography create a consistent hierarchy.
Game identity comes from recognizable item icons and names. Keep the workspace compact and practical.

This is the reference for new and revised UI. The [design overview](README.md) documents feature behavior. Existing
components may have local variations; use the conventions here when extending them, and update this guide when a shared
convention changes. Do not copy an inconsistent control merely because it already exists.

## Foundations

### Color and surfaces

Use the CSS custom properties in [src/index.css](../../src/index.css). BDO charcoal is the default; every component must
also work in light and moss. Theme identifiers are saved preferences and must remain compatible.

| Purpose | Tokens | Usage |
| --- | --- | --- |
| Workspace and navigation | `--canvas`, `--sidebar` | Main content and the contrasting sidebar |
| Secondary surfaces | `--surface`, `--surface-raised` | Disclosures, menus, and subtle raised areas |
| Interaction | `--hover`, `--selected` | Hover and persistent selection; selection also needs a semantic state |
| Dividers | `--line`, `--row-line`, `--line-strong` | Section/table separators; stronger borders for inputs and emphasis |
| Text hierarchy | `--text-strong`, `--text`, `--text-soft`, `--muted` | Headings, content, secondary content, and supporting labels |
| Controls | `--input-background`, `--button-background`, `--button-border`, `--button-hover-border` | Reuse existing control styling |
| Primary action | `--primary-background`, `--primary-text`, `--primary-border`, `--primary-hover` | Muted bronze emphasis, with an independent readable foreground |
| Meaningful accents | `--success`, `--danger`, `--warning`, `--negative`, `--gold` | Active/success, errors, review warnings, expenses, and navigation/favorites |
| Keyboard focus | `--focus-border` | Visible focus outlines and focused input borders |

Use the canvas as the workspace background and `--surface` for major task sections: the selected location, session
summary, capture, ledger, History panels, and Settings sections. Frame these with a one-pixel `--line` border and
`--panel-radius` corners. Use `--surface-raised` for table headers and secondary groups. Keep rows inside these sections
flat and separated by subtle dividers; avoid nested cards where spacing is enough.

Muted gold identifies active navigation, selection, and the leading earnings metric. Primary actions use a bronze
surface and ivory label rather than a bright gold fill. The session summary is one divided surface; its leading segment
uses a fine accent rule. History uses three summary tiles with recorded net accented. Green is reserved for successful or
active states, amber for review warnings, and muted red for expenses or negative amounts. Pair color with text, borders,
and semantic states. The legacy `--mint` token resolves to the theme accent and is not a primary-button background.
Reserve substantial shadows for floating surfaces and dialogs. Avoid gradients, glows, and unrelated accent colors.
Light uses warm paper and white surfaces; moss uses green ink surfaces with the same gold hierarchy.

### BDO references

The dark theme is adapted from the in-game panels shown in Pearl Abyss’s
[Game Settings guide](https://www.naeu.playblackdesert.com/en-US/Wiki?wikiNo=14),
[Interface guide](https://www.naeu.playblackdesert.com/en-US/Wiki?wikiNo=9), and the
[Central Market screenshot archived by Interface In Game](https://interfaceingame.com/screenshots/black-desert-online-central-market/).
The inspected settings screenshot has a `#242328` panel and a `#2d2c31` toolbar. The application uses the same neutral
charcoal family, with ivory text and muted bronze selections; it avoids the earlier blue-black canvas. The precise app
colors are an adaptation for readable desktop controls, not an official Pearl Abyss palette. Reference screenshots are
research material and are not shipped as application assets.

The main dark values are `--canvas: #201f24`, `--sidebar: #242328`, `--surface: #29282e`,
`--surface-raised: #323138`, `--text: #e7e1d3`, and `--gold: #d2bb7e`. Controls use separate semantic tokens,
so successful capture, uncertain recognition, expenses, and active navigation remain distinguishable.

### Typography

Use the system font stack from `src/index.css`; do not load remote fonts. Use sentence case for headings and actions,
preserving game names. Most weights are 400–600; size and spacing should establish hierarchy before boldness does.

| Role | Default |
| --- | --- |
| Body | 14px, line-height 1.5 |
| Page title | 24px, weight 600, line-height 1.35 |
| Section heading | 15px, weight 550 |
| Subheading | 14px, weight 550 |
| Dialog title | 18px, weight 550 |
| Buttons and help text | 12px; button weight 500 |
| Supporting labels | 12px, muted; 11px for compact secondary context |
| Session metrics | 28–36px; tabular numerals for values and time |

Prominent content, such as the selected grind spot, can use an intermediate 22px heading. Tiny text is reserved for compact
hints such as the 10px Esc label, never essential instructions. Long names must wrap where identification matters; do not
truncate away distinctions between location variants.

### Spacing, borders, and icons

Use the `--space-1` through `--space-6` tokens for the 4, 8, 12, 16, 20, and 24px spacing steps. Existing control-specific values such as 7px padding remain
valid. Start with 8px between related controls, 12–16px within a group, and 20–28px between sections. Favor consistent
alignment over adding containers.

Use `--control-height` (36px) and `--control-radius` (3px) for standard controls, `--panel-radius` (4px) for task sections,
and `--dialog-radius` (6px) for dialogs. Shared control, label, and dialog-title sizes use `--text-control`, `--text-label`, and `--text-dialog-title`. Borders are
normally one pixel. Use the shared [Icon component](../../src/components/Icon/Icon.tsx) for interface symbols: small,
monochrome SVG strokes, typically 18px. Bundled item icons retain their color; use roughly 22px in shortcuts,
36–40px in catalogs and tables, and 48px in the selected-location display. Decorative icons have empty alternative text or are hidden from
assistive technology. Icon-only actions need an accessible name.

## Workspace and responsive layout

Keep navigation in the sidebar and task content in the workspace. The sidebar is 208px wide on desktop and can collapse;
below 1000px it becomes a 72px icon rail with accessible labels (56px below 600px). Place the current-session block near
the bottom of the expanded sidebar, above Settings. The workspace bar provides a breadcrumb and compact session status.
The main workspace is capped at 1280px, with 28px desktop gutters and 16–24px compact gutters.

Place the current task title first, followed by setup/context, the primary overview, and working content. On the Grind desk,
the location remains in the same card when the session becomes locked, followed by a divided earnings/timer overview;
capture and the ledger use the available width. The page title remains Grind desk across session states. Place actions next to the section they
affect. Put secondary details behind clearly named disclosures, such as Value breakdown. Region selection and market price
status/refresh controls belong together in Settings → Market. Show the current grind spot there and provide access to the
shared spot browser, with the same session lock as the desk.
The workspace omits idle readiness and successful-save messages; loading, saving, and errors remain visible.

Allow control rows to wrap. Use `min-width: 0` for flexible content and `minmax(0, 1fr)` for grid columns that must shrink.
Scroll wide tables within a labeled, keyboard-accessible region. The whole window should not become horizontally scrollable.
At narrow widths, collapse multi-column pickers to one column when names and controls no longer fit comfortably.

## Controls and selection

Reuse the global button classes instead of inventing a different treatment for each feature.

| Control | Convention |
| --- | --- |
| Standard action | `.button`: 36px minimum height, 12px text, 3px corners, 7px/12px padding |
| Primary action | `.button.primary-button`: reserve strong emphasis for the main next action in its context |
| Secondary or dismiss action | `.button.subtle`: transparent background and border, subtle hover surface |
| Input/select | Existing input tokens, one-pixel border, 3px corners, visible label or accessible name |
| Search | Prominent at the top of a catalog; around 42px high, with a way to clear a nonempty query |
| Selection/filter | Persistent selected surface and border, with `aria-pressed` or the appropriate native state |

Use [FormField](../../src/components/FormField/FormField.tsx) for a visible label wrapping one native input, select,
or textarea. It owns label spacing, control dimensions, disabled styling, and invalid borders. Keep refs, input types,
validation, and `aria-describedby` on the native control. Table cells, range controls, and checkboxes retain their compact
layouts. Shared fields are used in entry, screenshot review, History filters, Settings, and preset editing.

Use [SelectionButton](../../src/components/SelectionButton/SelectionButton.tsx) for immediately applied button choices,
including spot filters/shortcuts, loot rows, preset choices, and History session rows. It owns `aria-pressed`, disabled
behavior, and persistent selected/hover styling; callers own selection and content. Theme choices remain native radios
with their existing arrow-key behavior. Keep table/list rows flat and allow catalog tiles their established corners.

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
- Use `--surface`, a one-pixel `--line-strong` border, 6px corners, `--dialog-shadow`, and a neutral `#000a` backdrop.
- The header uses 16px/24px padding, a bottom divider, and an 18px title. Omit subtitles by default. Compact headers use
  16px padding. Keep the header and dismissal available while long content scrolls.
- Short confirmations should be narrower and sized to their message; the existing finish dialog uses a 520px maximum.

### Close control and keyboard behavior

Use the same visible **Close Esc** control in every task dialog. It is a subtle button with a descriptive accessible name:

```tsx
<button className="button subtle" type="button" aria-label="Close spot browser" onClick={close}>
    Close <kbd>Esc</kbd>
</button>
```

The `kbd` label uses the inherited font, 10px text, `--muted`, and a small outlined keycap. Keep the button from shrinking or wrapping within itself.
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
permanent section above the content. A compact region value or active-filter count can appear on the button. Active date and spot values also appear as
removable chips beside the overview. Removing a chip restores focus to another available filter control. Preserve
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

## Compact session overlay

The separate overlay shares theme tokens and uses a three-column earnings/time row. At the supported 320×180 minimum,
metric values scale to 22–28px, item tiles are 40px, and timer, hide, and placement controls remain visible. Long location
names truncate in the drag handle with the full name available through its title. The overlay body can shrink below the
main app’s 320px minimum so a vertical scrollbar does not create horizontal overflow. Additional drops scroll within the
overlay. Waiting and window-control errors use explicit status/alert text; timer ticks are not live announcements.

## Reviewing a UI change

- Compare it with the existing equivalent control or dialog before choosing new styling.
- Check dark, light, and moss themes, including selected, focused, disabled, empty, and error states that apply.
- Check keyboard access, accessible names, Escape, and dialog focus restoration.
- Check a normal desktop window and a 640px-wide window, long game names, and scroll behavior. Dialogs must also fit short
  windows without hiding their dismissal or task controls.
- Keep the initial view compact. Large catalogs should add scrolling or search, not unnecessary window-sized surfaces.
- Reuse tokens and established patterns. Record deliberate changes to shared conventions here rather than creating a
  competing description in feature documentation.
