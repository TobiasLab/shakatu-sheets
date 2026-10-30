# Design language

Rules for how Shakatu Sheets looks and behaves on screen. Follow them for every UI change. The [product
reference](README.md) describes what each screen does; this file describes how it is presented.

## The idea

The main window usually sits on a second monitor while the user grinds, and is read from arm's length in a glance.
The compact session overlay is the reference for everything else: numbers carry the screen, labels are small and
quiet, item icons are the only imagery, and nothing is decorated. It is a neutral professional tool. Game identity comes
from the data (item icons, spot names), never from theming, textures, fantasy fonts, or ornaments.

Four principles decide most questions:

1. **Glance first.** On the desk, the most important value must be readable in under a second from across a desk.
   Editing and configuration are secondary layers the user opens on purpose.
2. **Structure through alignment, not boxes.** Group with spacing, alignment, and 1px hairlines. A bordered panel is
   allowed only when it marks one distinct object (a capture strip, a selected session's receipt, a dialog). Never nest
   a box inside a box.
3. **One accent.** Gold marks value (silver per hour) and the primary action. Everything else is graphite neutrals. Status
   colors appear only for status.
4. **Say less.** Short sentence-case labels, no helper paragraphs explaining how a screen works, no methodological prose.
   If a control needs a paragraph to be understood, redesign the control.

## What not to do

These are the failure modes of earlier redesigns. Treat any of them as a bug.

- Generic dashboard styling: cards everywhere, KPI tiles with icons, gradients, drop shadows on panels, big rounded
  corners, colored badges on every row.
- Reskinning. A new palette over the same layout is not a redesign; structure and hierarchy come first, color last.
- Boxes inside boxes, or a heading plus border plus background for every section.
- Values as form fields. Numbers read as plain typeset text until the user edits them.
- More than one accent color, or the accent used for decoration.
- Designing from image mockups. Judge changes in the rendered app at real window sizes.
- Fantasy or game-UI imitation: parchment, gold frames, serif display type, textured backgrounds.

## Foundations

All tokens live in `src/index.css`. Use tokens, never raw colors, in component CSS (the capture preview overlays, which
draw on a black video frame, are the only exception).

### Type

- **Typeface:** Inter Variable, bundled locally (`@fontsource-variable/inter`). Never rely on system fonts; Linux falls
  back to DejaVu Sans.
- **Figures:** `font-variant-numeric: tabular-nums` for numbers that update live or align in columns (timers, rates,
  table columns, quantities). The `time`, `data`, and `.numeric` selectors already apply it.
- **Scale:**

| Use | Size | Weight |
| --- | --- | --- |
| Desk readout metrics (`--text-metric`) | 40px | 550, −0.03em |
| History overview figures | 32px | 550 |
| Receipt and dialog figures | 24–28px | 550 |
| Spot heading on the desk | 22px | 600 |
| Page title (`h1`) | 20px | 600 |
| Section title (`h2`), dialog title | 14–16px | 600 |
| Body, controls, table cells (`--text-control`) | 13px | 400–500 |
| Labels, captions, secondary lines | 12px | 500 |
| Smallest labels (`--text-label`) | 11px | 500 |

Labels sit above or before their value in `--muted`; values are `--text-strong`. Never uppercase labels or add letter
spacing to them.

### Color

Two themes, dark (default) and light, share the same token names. Every new token needs a value in both.

| Token | Role |
| --- | --- |
| `--canvas` | Page background |
| `--sidebar` | Top bar, overlay, dialog footers |
| `--surface` | Bordered objects: capture strip, receipt, tiles, dialogs |
| `--surface-raised` | Selected rows, pressed segments, popovers |
| `--hover` | Hover background |
| `--tile-background` | Behind item icons |
| `--line`, `--line-strong`, `--row-line` | Borders, stronger borders, table row dividers |
| `--text-strong`, `--text`, `--text-soft`, `--muted` | Values, body, secondary, labels |
| `--gold` | Silver/hour, primary action, focus, selection edges |
| `--success`, `--warning`, `--danger`, `--negative` | Running or tracking, needs attention or paused, errors, expenses |

- Every text token must reach 4.5:1 contrast on `--canvas`, `--surface`, `--surface-raised`, and `--hover` in both
  themes. Check new values with a contrast calculation, not by eye.
- Status colors always come with a word or a count; color is never the only signal.
- Tints use `color-mix(in srgb, <token> N%, transparent)`: about 9–10% for note backgrounds, 14–18% for pills.

### Space, size, and shape

- Spacing steps are 4, 8, 12, 16, 20, 24, 28, 32px. Sections on a page are separated by 24–32px; related items by 8–12px.
- Controls are 32px tall (`--control-height`); compact controls inside segmented groups or rows are 26–28px.
- Radii: 4px controls (`--control-radius`), 6px panels (`--panel-radius`), 8px dialogs (`--dialog-radius`), fully
  rounded pills only for counts and status chips.
- Borders are 1px. Selection is shown with `--surface-raised` plus a 2px inset edge (`box-shadow: inset 2px 0 var(--gold)`),
  never with a thick border.
- Item icons sit in a `--tile-background` square with a 1px `--line-strong` border: 44px in inventory tiles, 28–32px in
  lists and tables.

### Motion

- Transitions use `--motion-fast` (120ms) and `--ease-out`. Dialogs fade in over `--motion-dialog`.
- Motion only communicates change (a tile flashing when its item drops, a chevron rotating). No decorative animation.
- Respect `prefers-reduced-motion`; the motion tokens drop to zero.

## Layout

- **Shell:** a 44px top bar (`AppShell`) with the app mark, the Grind desk / History / Settings tabs, and a status area:
  pending-review pill, capture status, the running session away from the desk, and save state. There is no sidebar.
  The top bar is also the window title bar: the main window has no system decorations, the bar's empty space drags the
  window, and 44px minimize, maximize/restore, and close buttons sit flush right. Close turns `--danger` on hover. The
  page itself never scrolls; the workspace scrolls beneath the bar so its scrollbar stays out of the title bar. To keep
  the bar from overlapping, it drops detail as the window narrows: at 1160px and below the app mark, the pending-review
  text (the count stays), and the running session's spot name; at 900px and below the save state (storage errors still
  show in the banner under the bar); at 760px and below the capture status.
- **Workspace:** content maxes out at 1440px with 32px side padding (16px below 900px). Pages must not scroll
  horizontally at any width down to 640px; wide tables scroll inside their own region.
- **Grind desk, top to bottom:** spot heading, readout row (silver/hour, net, session trend, time with timer
  controls), capture strip, drops. The readout, strip, and first row of drops must fit a 1440×900 window, and the layout
  must stay usable at half of a 1920px screen.
- **History:** title, filter bar, overview figures, comparison table, then the session list beside one receipt panel.
  The receipt's figures row ends with the session trend when net samples exist.
- **Settings:** a sticky section index beside open sections; each section has a label column (up to 200px) and a form
  column (up to 570px).

## Components

Reuse these before creating anything new. Class names refer to global classes in `src/index.css` or the named component.

- **Buttons:** `.button` (neutral), `.button.primary-button` (one per view or dialog, for the main action), `.button.subtle`
  (text-like, secondary and row actions). Destructive actions are subtle buttons that turn `--danger` on hover and
  always confirm.
- **Segmented control:** `.segmented` fieldset with `aria-pressed` buttons, for switching between two to four closely
  related views or values (Inventory/Ledger, Loot/Expense, EU/NA). Not for navigation between pages.
- **Readout metric:** label above value, no box. The primary metric's value is gold. See `SessionSummary.tsx`.
- **Inventory tile:** icon, quantity, value after tax, name, rate. One bordered tile per item, in an
  auto-fill grid of at least 236px.
- **Tables:** open tables with an 11px `--muted` header, `--row-line` dividers, no zebra striping, numbers right-aligned.
  Row actions (remove, delete) appear on hover or focus.
- **Editable numbers:** inputs look like plain text until hovered or focused, and show grouped digits when not focused
  (see `LootLedger.tsx`).
- **Dialogs:** native `<dialog>` with the `Surface` class and `DialogHeader` (title, "Close Esc"). Widths: 900px for
  workspaces (entry, upload), 720px for browsers (spots), 540–560px for choices and confirmations. The body scrolls; the
  header and footer stay put.
- **Feedback:** `Feedback` renders a tinted note with a 2px tone edge (neutral, success, error). `EmptyState` is a dashed
  region with one line of guidance and at most one action.
- **Disclosures:** native `<details>`; the global `summary` style draws the chevron. Use them for rarely needed detail
  (diagnostics, privacy notes, value breakdown).
- **Status:** 6px status dots (`StatusDot`) next to a word; counts in warning pills (`Needs attention`, the top-bar pill,
  the overlay header).
- **Tags:** small outlined pills for qualifiers such as region variants (`[Dehkia 2]` renders as a "Dehkia 2" tag).

## Numbers and copy

- Silver uses `formatSilver`: compact (`895.39M`, `1.45B`) in readouts, tiles, and summaries; full grouped digits
  (`2,410,000`) where the exact value matters (unit prices, editing). Rates end in `/h`.
- Durations use `formatDuration` (`01:37:13`). Relative dates use `formatRelativeDay` ("yesterday", "3 days ago").
- Expenses and negative values use a true minus (`−`) and `--negative`.
- Labels are sentence case with no trailing colon ("Net silver / hour", "Session time"). Buttons are verbs ("Add to ledger",
  "Start timer"). Status text is short and present tense ("Tracking loot", "Capture off").
- Do not explain calculations or workflows in the interface; keep that in `documentation/`.

## Charts

Follow the dataviz rules: one series per chart (a segmented switch in the title position may swap which series), a 2px line in the accent over a 10% wash, an end dot with a surface ring,
solid hairline reference lines (never dashed), no legend for a single series, and a readout that works with pointer
and keyboard alike. A chart title names the series; the one extra number shown next to it must be meaningful on its
own (for example, "Last 30 min 527.55M/h"). The end dot's ring matches the background behind the chart: `--canvas` by
default, or whatever the container sets as `--trend-ring` (the History receipt uses `--surface`). Event markers stand in
a strip above the plot, reserved only when there are markers, with a hairline stem down to the point they explain;
the active marker turns its stem to the accent and its value to strong text.

## Accessibility

- Every interactive element is reachable and operable by keyboard, with the global 2px gold focus ring. The ring
  follows the input device: a pointer press hides it, including on focus that code moves afterwards, until Tab, an
  arrow key, Home/End, or Page Up/Down moves focus again. Keys that only move the caret keep it hidden, and text
  fields keep their gold border on focus.
- Visual labels match accessible names; icon-only buttons have an `aria-label`.
- Live values that change without user action are announced sparingly (status regions), never every second.
- Contrast rules above apply to both themes.

## The session overlay

The overlay (`SessionOverlay`) is the reference design and changes only on request. It shares the theme tokens but keeps
its own compact rules: 8px padding, 10–14px text, 48px icon tiles with a dark quantity badge, and no extra labels.
While captures wait in Needs attention, a small warning pill with their count sits in the header before the session
time, so the user sees it while playing fullscreen; it is hidden when nothing is pending.

## Reviewing a UI change

Before calling a UI change done:

1. Render it in the running app at 1440×900, at about 900px wide, and at 640px wide, in both themes.
2. Check it against [What not to do](#what-not-to-do): no nested boxes, no second accent, no explanatory prose.
3. Confirm that the most important value on the screen is the most prominent thing on it.
4. Check keyboard access and focus order; confirm nothing scrolls horizontally.
5. Run the normal verification commands in the [development guide](../development/README.md), and the
   [browser smoke scripts](../development/README.md#performance-and-ui-verification) when controls or labels moved.
