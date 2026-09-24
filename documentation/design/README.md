# Design

See the [design language](design-language.md) for visual foundations, component conventions, modal sizing, and UI review
criteria. This page describes screen behavior and product flows.

The application uses a normal desktop window rather than an in-game overlay. The grind desk puts session time and earnings first. Ink dark is the default for new installations; saved
light, moss, and dark preferences are retained. The current flow is:

1. Select a grind spot and region.
2. Optionally fetch or refresh that profile's regional market prices.
3. Optionally start screen capture and local loot recognition before starting the timer.
4. Start or resume the timer, or enter hours for a grind timed elsewhere.
5. Add loot and expenses manually, or review and import a cropped Marni loot tracker screenshot into an empty session.
6. Pause the timer or finish the session.
7. Filter and review completed sessions, reopen one for corrections, or permanently delete one after confirmation.

The Grind desk shows the selected spot with its trash-loot icon, up to four quick-access shortcuts, and a searchable
**Browse all spots** dialog. Favorites lead the shortcuts in the order starred; recent selections fill remaining spaces
without duplicates. Favorites and the last eight distinct selections are saved locally as UI preferences. The browser
provides All (alphabetical), Favorites, and Recent filters; search ignores case and punctuation and matches words in any
order. Starring does not select a spot. Selecting immediately updates the session and closes the browser.

Selection is available only while a session is idle with no elapsed time or entries, and is temporarily disabled while
loading the database or fetching market prices. After time or loot is recorded, selection controls disappear and the
selected-location card stays in place with a lock explanation. The page title remains Grind desk. The browser uses a native modal dialog with search focus, Escape
to close, and focus restoration. It uses bundled item icons and existing theme tokens with no network requests.

Aphrodon Temple includes Sealed Black Magic Crystal following the
[September 10, 2026 patch](https://www.naeu.playblackdesert.com/en-US/News/Detail?countryType=en-US&groupContentNo=10577).
The profile reuses the existing market item and local icon, ID `768160`, with export key `768160_0`, verified against
[Garmoth's grind-tracker metadata](https://api.garmoth.com/api/external/grind-tracker). The shared profile supplies the
manual loot catalog, recognition dictionary, market-price requests, and export mapping.

The interface distinguishes market, vendor, and expense values. Market prices are never guessed when unavailable and
network access only occurs after the user presses the Arsha fetch button. Saved prices show when they were fetched and
remain manually editable when adding an entry. If the selected region has no saved prices, the interface clearly labels
and uses the other region's saved snapshot as a local fallback.

History browses all completed sessions in pages of 20, filtered by recorded region, completion dates, and grind spot. Reopening a session returns it to the live view in
a paused state; an active session with progress is never replaced. Finished sessions can be permanently deleted after an
explicit confirmation.

Screenshot recognition is local and starts only after the user chooses a file. The current importer accepts cropped English
Marni loot tracker screenshots at 80%, 100%, or 120% BDO UI scale, reads the grind spot, duration, item icons, and quantities,
then presents an editable draft. Uncertain quantities receive four alternate local OCR passes, and unmatched icons are
retried with shifted alignment. Valid low-confidence suggestions remain populated and marked for review. Confirmation
imports only complete rows and is available only for an empty idle session. Screenshots and draft thumbnails are not
persisted.

Live notification capture and recognition is described in the
[live loot recognition plan](live-loot-recognition.md).
The local video sampling and annotation contract is described in the
[live loot benchmark guide](live-loot-benchmark.md).


See the [frontend polish review](frontend-polish-review.md) for the September 2026 visual audit and verification scope.

## Workspace design

The shared visual rules and BDO reference sources are defined in the [design language](design-language.md). A left sidebar provides Grind desk,
History, Capture setup, and Settings, plus the current session and save state. It can collapse on desktop and becomes a
labeled-for-assistive-technology icon rail below 1000px. A thin workspace bar keeps session status visible at compact sizes;
persistence failures appear in a full-width alert. The sidebar collapse preference is transient UI state.

The desk shows the selected spot in a framed location card above a divided earnings/timer overview. The spot card
explains its lock after time or entries are recorded, without moving its name or icon. Region and market-price controls
remain together in Settings → Market. Net silver/hour shows a dash until elapsed time is available.
Manual time remains under Enter hours, while gross, expenses, and deductions are under Value breakdown. Neither timer ticks
nor local filters mutate session snapshots.

Capture and the ledger share the full workspace width. The capture strip expands inline for placement; source controls and
platform guidance remain available during a session. Entry and screenshot actions sit beside the ledger heading so they do
not cover table rows. The editable ledger follows below. Quantity and unit price are aligned in a table;
Enter saves, Escape restores the saved values, and invalid edits restore values with an explanation. A blank price is invalid,
while an explicit zero remains valid. Search and loot/expense filters only change the visible rows. Narrow windows scroll the
table within its labeled, keyboard-scrollable region rather than widening the whole app.

Add loot or expense and Import a screenshot open native dialogs. Dialogs contain focus, close with Escape, and restore the
opener; manual entry initially focuses item search. The catalog focuses quantity after item selection. A direct expense action
focuses the entry name. Submission feedback distinguishes added entries from invalid or overflowing quantities. Dialog content
stays mounted when closed, preserving screenshot review within the same session; a new session clears the import draft and
entry feedback. A new session also resets the manual-entry draft and ledger filters. Expense draft prices stay independent
of market-region changes. Ledger item cells show the name and icon without valuation or capture-source subtitles. Import still requires an empty idle session. The import draft labels low-confidence populated suggestions for
review and does not claim they are blank.

Capture setup expands to the full desk width, with source/alignment/confirmation progress, full preview, normal and rare crop
previews, and the existing manual, automatic, nudge, scale, and confirmation controls. The alignment panel groups area
selection and UI scale above placement guidance. Fine positioning uses a cross-shaped directional pad with labeled one-source-pixel
actions and a separate reset named for the selected area. Layout import lives in an expandable section, and confirmation
is emphasized in the footer. Confirming both areas closes setup and
returns keyboard focus to its button. Setup can reopen during capture. Previews run only while setup is visible; recognition
continues across navigation and minimization. Needs attention distinguishes read failures from recognized loot awaiting
insertion in a selectable queue with one correction editor. Switching captures preserves item/quantity drafts. Retry OCR
offers a suggestion that must be explicitly applied and added. Dismiss all asks for confirmation and keeps ledger entries.
Advanced diagnostics, diagnostic JSONL, and optional paired ROI collection retain their existing behavior and bounds.

History shows totals for all completed sessions matching the current filter, including aggregate net, elapsed time, and
net per hour weighted by elapsed time. Session selection shows its time, earnings, and recorded entries before Garmoth upload
controls. Explicit reopen and confirmed deletion remain available. The finished desk offers a direct View history action.
Settings uses framed sections with aligned label/form columns, section links, theme previews with native radio controls,
a full-width consumable editor with paired selectors and a clearly grouped expense table,
capture guidance, and sequential Garmoth connection/character setup. Connection diagnostics are in a native disclosure. Disabled character controls explain that the API connection comes first. Network requests remain explicit.

## History comparisons

Place the recorded-net, tracked-time, and net/hour overview directly below the page header, followed by grind-spot
comparisons and then the session list and detail.

History defaults to the current session region and all dates. Completion-date inputs use local calendar days, including
both selected dates. A Filters button opens a native dialog using the same styling as the entry dialog. Region, dates,
and spot apply immediately; Clear filters restores the initial region, all dates, and all spots. The button shows the
region and additional active-filter count. Active date and spot values also appear as removable chips; selecting a spot
comparison marks its row selected. Escape and Close return focus to the button. Filters remain usable for empty
results. Previous/Next controls browse 20 records at a time with a matching-session count. Page descriptions and
methodological explanations stay out of the interface; the calculation rules are documented below.

The comparison table covers all spots in the selected region/date range, independently of the spot selector and page.
Selecting a comparison row filters the session list. Rates sort descending with undefined rates last; equal rates sort
by spot ID. Each row shows completed-session count, total tracked time, and recorded net alongside the rate. Distinct
spot IDs remain distinct, including location variants. Unknown catalog IDs display their stored ID.

Net is stored revenue quantity × unit price × sale multiplier minus recorded expenses. Duration-weighted net/hour is
positive-duration session net × 3,600,000 ÷ total elapsed milliseconds. Zero-duration sessions remain visible and count
in recorded net and session count, but their earnings are excluded from the rate. A compact timed-session count is
shown when it differs from the total; a sample with no tracked time displays an em dash. Negative earnings remain valid.

Counts and time provide sample-size context without an arbitrary confidence threshold. Short samples and rare drops
can skew the ranking. Prices are recorded valuations, not confirmed sales, and are never refreshed for completed
sessions. EU and NA are compared separately using recorded session region; historical price-source provenance is not
available, so fallback or manually entered prices may differ from that region's market.

Deletion refreshes the page and aggregates, including clamping an emptied final page. Failed refreshes hide stale
comparisons and expose a retry. Reopened sessions leave completed history until finished again, at which point their
new completion timestamp determines date membership. Existing active-session and Garmoth reopen restrictions apply.


## Consumable presets

Settings → Integrations → Consumable presets owns Garmoth export import and local preset editing/deletion. Users review item names and enter
session quantities and unit prices; zero prices must be explicit. Presets are region-specific and editable independently
of whether the active session is finished. Saving a preset never changes session expenses.

The grind desk exposes Apply preset. In History, Upload to Garmoth and Upload again always open one native review
modal containing the selected session's read-only ledger, stored expenses, date, duration, region, and totals. Select
preset opens the shared selection content inside the same modal; import and library editing remain in Settings.
Clicking a preset applies it immediately and highlights its row, without expanding item details or requiring another
confirmation. The selection stays highlighted and labelled Applied when the picker is reopened; Undo clears the draft selection.
Selecting a preset updates draft expenses and net/hour totals only. Cancel discards the draft; the final upload action
saves the expenses and submits the session. Users can also upload without selecting a preset.

The upload modal follows the desk's visual hierarchy: selected spot, the shared divided earnings/time overview, then the
existing ledger with preset actions alongside its heading. Garmoth options form one compact wrapping row beneath the
ledger. Use the standard 900px dialog width and Close Esc header; the body scrolls while the header and upload footer
remain visible. Body grid rows size to their content so short windows cannot compress the ledger into the upload options.
Opening review preserves the selected-session context at the top. Do not wrap upload options in an additional card or
repeat totals below the ledger.

The modal includes Contribute to global data (off by default), Used Agris with an optional amount (blank means unknown),
and optional Drop rate %. Options persist across failed attempts in the open modal and reset when it is reopened.
Labels stay concise; no explanatory subtitles are added. Native focus trapping and Escape cancellation apply, while
closing and duplicate submissions are disabled during the upload. An unknown outcome disables retries.

Preset quantities are session totals and never scale silently with duration. Applying replaces only tagged consumables,
leaving ordinary expenses and loot unchanged. Confirmed uploads can add missing consumables but cannot replace existing
ones; a repeat upload creates another remote session after confirmation. General historical editing requires reopening.
Saved expenses are retained if HTTP fails, with an explicit error message and updated local/history totals.
