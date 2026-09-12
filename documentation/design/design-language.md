# Design language

Shakatu Sheets is a restrained desktop workspace for tracking grind sessions. Time, earnings, the selected location, and
loot should be easy to scan. The interface uses neutral surfaces, system typography, flat sections, small icons, and color
with a specific purpose. Game identity comes from recognizable item icons and names.

This is the reference for new and revised UI. The [design overview](README.md) documents feature behavior. Existing
components may have local variations; use the conventions here when extending them, and update this guide when a shared
convention changes. Do not copy an inconsistent control merely because it already exists.

## Foundations

### Color and surfaces

Use the CSS custom properties in [src/index.css](../../src/index.css). Neutral dark is the default; every component must
also work in light and moss. Theme identifiers are saved preferences and must remain compatible.

| Purpose | Tokens | Usage |
| --- | --- | --- |
| Workspace and navigation | `--canvas`, `--sidebar` | Main content and the contrasting sidebar |
| Secondary surfaces | `--surface`, `--surface-raised` | Disclosures, menus, and subtle raised areas |
| Interaction | `--hover`, `--selected` | Hover and persistent selection; selection also needs a semantic state |
| Dividers | `--line`, `--row-line`, `--line-strong` | Section/table separators; stronger borders for inputs and emphasis |
| Text hierarchy | `--text-strong`, `--text`, `--text-soft`, `--muted` | Headings, content, secondary content, and supporting labels |
| Controls | `--input-background`, `--button-background`, `--button-border`, `--button-hover-border` | Reuse existing control styling |
| Primary action | `--mint`, `--accent-contrast`, `--accent-hover` | The primary button; token names do not imply a fixed hue |
| Meaningful accents | `--success`, `--danger`, `--gold` | Success, errors/destructive actions, and favorites |
| Keyboard focus | `--focus-border` | Visible focus outlines and focused input borders |

Keep ordinary page sections flat, with spacing and one-pixel dividers establishing groups. Use bordered tiles when each
item is selectable, as in the spot browser. Reserve substantial shadows for floating surfaces and dialogs. Avoid decorative
metric cards, gradients, glowing borders, and arbitrary colors. State must remain understandable without color alone.

### Typography

Use the system font stack from `src/index.css`; do not load remote fonts. Use sentence case for headings and actions,
preserving game names. Most weights are 400–550; size and spacing should establish hierarchy before boldness does.

| Role | Default |
| --- | --- |
| Body | 14px, line-height 1.5 |
| Page title | 24px, weight 550, line-height 1.35 |
| Section heading | 15px, weight 550 |
| Subheading | 14px, weight 550 |
| Dialog title | 18px, weight 550 |
| Buttons and help text | 12px; button weight 500 |
| Supporting labels | 11–12px, muted |
| Session metrics | 27–36px; tabular numerals for values and time |

Prominent content, such as the selected grind spot, can use an intermediate 22px heading. Tiny text is reserved for compact
hints such as the 10px Esc label, never essential instructions. Long names must wrap where identification matters; do not
truncate away distinctions between location variants.

### Spacing, borders, and icons

Use 4, 8, 12, 16, 20, and 24px as preferred spacing steps. Existing control-specific values such as 7px padding remain
valid. Start with 8px between related controls, 12–16px within a group, and 20–28px between sections. Favor consistent
alignment over adding containers.

Use 7px corners for standard controls, 6–8px for compact shortcuts and selectable tiles, and 16px for dialogs. Borders are
normally one pixel. Use the shared [Icon component](../../src/components/Icon/Icon.tsx) for interface symbols: small,
monochrome SVG strokes, typically 18px. Bundled item icons may retain their color; use roughly 22px in shortcuts and
36–40px in spot tiles or selected-location displays. Decorative icons have empty alternative text or are hidden from
assistive technology. Icon-only actions need an accessible name.

## Workspace and responsive layout

Keep navigation in the sidebar and task content in the workspace. The sidebar is 224px wide on desktop and can collapse;
below 1000px it becomes an icon rail with accessible labels. The workspace bar provides compact session context.

Place the current task title first, followed by setup/context, the primary overview, and working content. On the Grind desk,
time and earnings lead the overview; capture and the ledger use the available width. Place actions next to the section they
affect. Put secondary details behind clearly named disclosures, such as Market prices or Value breakdown.

Allow control rows to wrap. Use `min-width: 0` for flexible content and `minmax(0, 1fr)` for grid columns that must shrink.
Scroll wide tables within a labeled, keyboard-accessible region. The whole window should not become horizontally scrollable.
At narrow widths, collapse multi-column pickers to one column when names and controls no longer fit comfortably.

## Controls and selection

Reuse the global button classes instead of inventing a different treatment for each feature.

| Control | Convention |
| --- | --- |
| Standard action | `.button`: 34px minimum height, 12px text, 7px corners, 7px/12px padding |
| Primary action | `.button.primary-button`: reserve strong emphasis for the main next action in its context |
| Secondary or dismiss action | `.button.subtle`: transparent background and border, subtle hover surface |
| Input/select | Existing input tokens, one-pixel border, 7px corners, visible label or accessible name |
| Search | Prominent at the top of a catalog; around 42px high, with a way to clear a nonempty query |
| Selection/filter | Persistent selected surface and border, with `aria-pressed` or the appropriate native state |

Use native buttons, inputs, and selects where they fit the interaction. A short list such as EU/NA can remain a select.
A large catalog benefits from search and recognizable rows or tiles. A selection action and an auxiliary action such as
starring must be separate buttons; never nest buttons. Selecting a spot applies immediately, while starring keeps the
browser open. Show the selected item independently of its hover state.

Disabled controls retain their context and have an understandable reason when it is not obvious. A permanent session lock
is better represented by the chosen value and a lock explanation than by a disabled selection form. Temporary loading
should not silently change the selected value.

## Dialogs

Use native `<dialog>` with `showModal()`. The reference header and close control are in
[SessionTools](../../src/views/LiveSession/SessionTools.tsx), with styling in
[LiveSession.module.css](../../src/views/LiveSession/LiveSession.module.css). The
[spot browser](../../src/components/GrindSpotPicker/GrindSpotPicker.module.css) demonstrates a bounded catalog with internal
scrolling. These are reference implementations; there is currently no shared dialog component.

### Size and composition

- Use a 900px maximum width for catalog/form dialogs, constrained to the viewport with 20px side margins on desktop.
- Use a compact content-driven height. Catalog length must not make a picker fill the window: the spot browser is capped
  at 620px, with the result area scrolling beneath its header, search, and filters.
- For longer forms, the viewport ceiling is `calc(100dvh - 48px)`. Below 760px, use 12px viewport margins and a ceiling of
  `calc(100dvh - 24px)`; retain the 620px cap for compact pickers.
- Use `--canvas`, a one-pixel `--line-strong` border, 16px corners, `0 20px 70px #0004` shadow, and a `#0007` backdrop.
- The header uses 22px/24px padding, a bottom divider, an 18px title, and optional 12px muted help text. Compact headers use
  18px padding. Keep the header and dismissal available while long content scrolls.
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

Use short, concrete labels: Choose grind spot, Add loot or expense, Start timer, Clear search. Supporting text should explain
what to do or why an action is unavailable. Keep implementation details in diagnostics unless they help the user decide.

An empty state explains what is missing and the next useful action. Distinguish no data from no search results. Unknown
values use an explanatory label or a dash; do not present a made-up zero as a known value. Errors identify the failed action
and, where possible, a way to recover. Use alerts for actionable errors and polite status announcements for changing result
counts or routine feedback. Avoid announcements for every timer tick.

Network activity should follow an explicit user action, consistent with existing product behavior. Use bundled assets and
CSS for presentation. Decorative animation, external fonts, and new UI dependencies are not part of the current language.

## Reviewing a UI change

- Compare it with the existing equivalent control or dialog before choosing new styling.
- Check dark, light, and moss themes, including selected, focused, disabled, empty, and error states that apply.
- Check keyboard access, accessible names, Escape, and dialog focus restoration.
- Check a normal desktop window and a 640px-wide window, long game names, and scroll behavior. Dialogs must also fit short
  windows without hiding their dismissal or task controls.
- Keep the initial view compact. Large catalogs should add scrolling or search, not unnecessary window-sized surfaces.
- Reuse tokens and established patterns. Record deliberate changes to shared conventions here rather than creating a
  competing description in feature documentation.
