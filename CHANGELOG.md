# Changelog

## v0.11

- [Feature] **Editor autosaves while you type, restores on reload.** The SQL editor's contents are flushed to localStorage on a 750 ms idle debounce — short enough that a browser crash or refresh loses essentially nothing, long enough that we're not pummeling storage on every keystroke. Reloading the app drops you back into the same query you were working on. The named-bookmark store (`.query save <name>`) is unchanged; this is a separate, single-slot working draft.
- [Feature] **Ctrl+S in the editor → "Save query as…" dialog.** Single-input modal that writes the current query to the named-bookmark store. Pre-fills nothing, warns when the typed name would overwrite an existing bookmark (the save still proceeds — same semantics as `.query save`).
- [Feature] **Click-to-copy on column-stats labels.** Click the column-name header or any categorical histogram value → the text writes to the clipboard with a brief flash on the clicked element. Mouse drag-selection still works for free-form text copy.
- [Feature] **CodeMirror multi-cursor + find.** `Ctrl+D` selects the word at the cursor on first press, then extends to the next occurrence on each subsequent press (classic VS Code / Sublime multi-edit). `Alt+ArrowUp` / `Alt+ArrowDown` drop a cursor above / below the current line. `Ctrl+F` opens the editor's find panel; F3 / Shift+F3 step through matches.
- [Bug-fix] **Ctrl+C now respects DOM text selections outside the spreadsheet.** When the user drag-selects text in the column-stats panel, status bar, help panel, etc., Ctrl+C now copies that selection instead of the spreadsheet's cells. The spreadsheet's cell-copy still fires when no DOM selection exists or the selection lives inside the spreadsheet container.
- [Preview] **Import from HTML and remote URLs.** Two new shell commands round out the import surface. `.paste` opens a dialog where you can paste an HTML `<table>` (or the surrounding markup) from the clipboard — copy a table in a browser, paste with the textarea's "Paste from clipboard" button or Ctrl+V, pick which `<table>` if the source has more than one, and the rows land as a dataset. `.fetch <url>` pulls a remote CSV / JSON / Parquet / HTML directly into DuckDB. `.html` / `.htm` files dropped on the Datasets panel work the same way; multi-table HTML opens the picker automatically. Image-only cells (e.g. flag icons) fall back to the `<img>` `alt` attribute or the `src` basename, so columns of icons preserve their identifier (Eurovision flags become `AL/AM/AT/…` instead of empty strings). URL fetches are direct browser requests — CORS-permissive sources (GitHub raw, jsdelivr, public data portals) work today; CORS-blocked sites surface a clear "save and drag it in" message rather than a generic network error. Both paths funnel through the existing `read_csv_auto(..., sample_size=-1)` pipeline so dirty real-world tables tolerate stray non-numeric values without crashing the import. Marked **preview** while we shake out rough edges (table-vs-layout detection on heavily styled pages, no proxy fallback yet for CORS-blocked URLs, no streaming for very large remote files).

## v0.10-defeator-of-the-saxons

- [Feature] **Column resize + multi-column sort on the same header strip.** Drag the right edge of any column header (4px hit zone, faded line on hover) to resize. The rightmost ~22px doubles as a sort-arrow zone: plain click cycles asc → desc → unsorted, shift-click cycles in multi-key mode (small `1` / `2` / `3` superscripts mark the chain order). Every column always shows a faded up-arrow so the click target is visible before the first sort.
- [Feature] **Full-row selection from the gutter.** Click the row index → row highlighted; shift extends from the anchor, ctrl/cmd toggles single rows. Cells / columns / rows stay mutually exclusive.
- [Feature] **Double-click a complex cell → open the inspector popover.** Works on STRUCT / LIST / MAP / JSON / UNION cells regardless of whether the user previously dismissed the auto-open — double-click is the explicit override.
- [Feature] **Recent folders shortcut in Import tab.** Browse Folder picks (Chrome / Edge with the File System Access API) are persisted to IndexedDB; the Import tab surfaces the last 5 as one-click chips. Firefox / Safari fall back silently since their webkitdirectory path can't persist handles.
- [Feature] **`.export` falls back to the whole dataset** when no row / cell / column is selected, instead of warning "no selection".
- [Enhanced] **Export integrity.** Complex cells now serialise as full JSON in Ctrl+C copy and every text/HTML/Markdown export (was: truncated `{ k: v, … N more }` preview — the cell renderer still uses that because it's all the cell area can fit). Embedded-quote escape is configurable in Settings → "Copy & export format" — `""` (RFC 4180, default) or `\"` (JSON-style).
- [Enhanced] **Same-name file imports no longer collide.** `study.csv` from one folder and `study.csv` from another both register (`study`, `study__2`, …). `.alias study__2 <new-name>` renames via DuckDB's `ALTER TABLE … RENAME`.
- [Enhanced] **Selection, scroll, hover stay in lockstep with column-width changes.** Previously-selected columns / rows / cells survive sort and filter (Excel-style — selection follows the screen position, not the data); scroll position re-syncs from the native scrollbar so sorting a far-right column no longer bounces the rendered content back to column 0; chunked column-width recompute now repaints the cell canvas progressively between chunks; multi-sort columns reserve room for the position superscript.
- [Enhanced] **Column-stats display reflects the filtered view.** Filtering a column moves the side-panel summary numbers (count / null / distinct / min / mean / median / sd / max), the histogram, and the value-frequency counts with the visible rows. The filter UI controls — the categorical value checkboxes, the numeric / temporal range-slider bounds — still use the unfiltered stats so the user can broaden the filter from the panel (re-add deselected categories, drag the slider past the current filtered range).
- [Enhanced] **Stats-panel pins to the first-selected column** (click order). Multi-column ctrl-click no longer churns the panel. Borderless column / row selection + hover to match the visual language; cell-range selection keeps its border + drag handle since the selection extent matters there.
- [Enhanced] **Deploy resilience.** Stats-duck WASM is now committed to the repo (`public/extensions/stats-duck/`) so CI / clean-checkout deploys reproduce identically to a local build. `bun run build` ends with a postbuild verifier that fails fast if the WASM files are missing — catches the failure mode that broke v0.9 production (the per-machine junction silently producing an empty assets dir).
- [Bug-fix] **Ctrl+C now works for row and column selections** (copy and `.export` flow through the same unified `getSelection()` pipeline; copy previously had a cells-only code path).
- [Bug-fix] **Multi-column selection on header clicks** — shift-click extends, ctrl/cmd-click toggles. Was previously broken: every click replaced the selection with a single column.
- [Bug-fix] **No more full-dataset fetch on every column click.** Change-event notifications used to call the heavy export-shaped `getSelection()`, which for column-mode fetched every row; the cache's `onLoaded` events then churned the cell canvas with skeleton placeholders. Notification path now uses a metadata-only summary; the export path keeps the full fetch when actually called.
- [Bug-fix] **`VISUALIZE` rejection surfaces the actual cause in the UI error** (install rejected vs `ggsql_mark_v1_*` parser-hook miss) instead of "didn't load — check the console".

## v0.9-king-of-the-britons

- [Feature] **Charts via `VISUALIZE … DRAW <mark>`.** `VISUALIZE` queries are detected at dispatch time and routed past the result-table wrapper so stats_duck's parser-extension fires. The returned `(spec, layer_sqls)` row is fanned out: each layer SQL is run via DuckDB-WASM, the rows are inlined into a Vega-Lite `datasets` block, and vega-embed renders the chart in a new ChartTab alongside dataset tabs. Faceted, layered, and concat specs render correctly — the dispatcher hoists each layer's data ref to the outer spec so Vega-Lite v6's facet operator finds it. Theme-aware (re-embeds on `.theme` flip with Tokyonight-flavoured config); the vega-actions overlay is themed to match the rest of the app. Tall composite charts scroll instead of clipping and centre horizontally. vega-embed is code-split — no bundle hit for users who never plot.
- [Feature] **Chart export via `.export png|svg`.** The shell command that already handled dataset exports now also targets the active chart tab, calling the Vega view's `toImageURL("png")` / `toSVG()` and triggering a download.
- [Feature] **Non-SELECT queries.** `CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `PRAGMA`, `COPY`, `EXPORT`, `SET`, transactions: all execute directly without the `CREATE OR REPLACE TABLE result_<n> AS (…)` wrap. The wrap previously corrupted DDL/DML and silently bypassed parser extensions like stats_duck's VISUALIZE.
- [Feature] **Multi-statement SQL scripts.** The editor now splits on `;` (respecting string literals, line/block comments, and dollar-quoted bodies) and dispatches each statement by kind — `SELECT/WITH` → table tab, `VISUALIZE … DRAW` → chart tab, everything else → silent side-effect. Lines starting with `.directive` queue up for the next statement and reset after; `.no-output` is the first directive — it forces the silent path regardless of the statement's natural kind.
- [Feature] **CREATE TABLE / CREATE VIEW auto-display.** The new relation opens as a dataset tab right after the side-effect runs, unless `.no-output` precedes it. Schema-qualified targets (`schema.foo`) are skipped — only bare names auto-display.
- [Feature] **`.alias <dataset> <new>`** — shell command for renaming a dataset/table via DuckDB `ALTER TABLE … RENAME` (migrated from the deprecated palette).
- [Enhanced] **Editor autocomplete enrichment.** `VISUALIZE` / `DRAW`, common SQL types (`DOUBLE`, `INTEGER`, `VARCHAR`, `TIMESTAMP`, …), and known directives (`.no-output`) surface in the dropdown. Function suggestions auto-discover from `duckdb_functions()` so any extension's contributions (stats_duck, http, iceberg, …) appear without a hand-maintained list.
- [Enhanced] **Editor syntax highlighting** restored after the oneDark removal. GGSQL keywords + known stats_duck function names colour as builtins via a `BedevereSqlDialect` that extends PostgreSQL; full token palette (keyword / string / number / comment / type / function / operator) binds to tokyonight CSS variables so light/dark flips repaint live.
- [Enhanced] **Editor + shell keyboard consistency.** Enter accepts the highlighted autocomplete suggestion in both surfaces (Tab still accepts in the shell as a bash-style alternate). Editor Tab now inserts a tab character instead of leaking focus to the surrounding chrome, Ctrl+Enter executes the query exactly once (was double-firing through two keymap layers), and global shortcuts like Ctrl+/ defer to the editor when CodeMirror has already consumed the chord — toggling a line comment no longer also pops the help panel. Shell suggestion dropdown shows up to 50 matches (was 8) with active-row scrollIntoView on arrow-key navigation.
- [Enhanced] **Help panel refresh for 0.9.** About tab leads with a "What's new" highlights list and a vertical Dependencies list with per-library blurbs. How-to tutorial: the parse-the-dataset example wraps in `CREATE OR REPLACE TABLE penguins_clean AS …`, the "create a view" tip is gone (CommandPalette is gone), and a new "Plot it" section shows a `VISUALIZE … DRAW point` example end-to-end.
- [Enhanced] **Status bar tracks the active tab kind.** When a chart tab is focused, the status bar shows the chart name and clears the stale spreadsheet selection info; switching back to a dataset tab restores cell context.
- [Enhanced] **Control-panel duck-toggle.** When the control panel is minimized, the toggle button shows the duck icon instead of `+`.
- [Enhanced] Result tables now use friendly `result_1`, `result_2`, … names instead of `query_result_<huge-timestamp>`. Type-able in JOINs by hand; renameable via `.alias result_1 mydata` (which calls DuckDB's real ALTER TABLE so existing references keep working).
- [Bug-fix] Theme flip now repaints the spreadsheet immediately. The module-level theme-color cache was racy with the body-class MutationObserver — the listener could fire before the cache invalidator, baking stale colors into each visualizer's options. Now the listener invalidates the cache itself before recomputing.
- [Bug-fix] **DECIMAL columns plot at their real value.** Chart datasets now scale `DECIMAL(p,s)` columns when materializing rows from Arrow — both plain numbers/bigints and Decimal128 word buffers (Uint32Array) — so `errorbar`, `point`, etc. read the actual value instead of the raw integer ×10^s.
- [Removed] **CommandPalette (Ctrl+Shift+P).** Deprecated in 0.8; gone in 0.9. Every palette-only command was either covered by an existing shell command or migrated (`.alias`).
- [Removed] **View storage.** `.view save|drop`, `ViewManager`, and the `bedevere_views` localStorage key are gone. Saved views were unrecoverable across page reloads (source tables vanish), producing `worker_dispatcher` cascades on every refresh. Saved queries (`.query save`) cover the persist-my-SQL workflow; raw `CREATE VIEW` SQL works in-session now that non-SELECT queries are allowed.
- [Removed] **GitHub Pages deploy workflow.** `.github/workflows/deploy.yml` removed. Cloudflare Workers Builds (custom domain `bedeverewise.app`) is now the only deploy target.

## v0.8-from-the-castle-of-camelot

- [Feature] Dot-command shell hosted in the always-visible bar above the spreadsheet. Lines starting with `.` dispatch through a unified CommandRegistry; anything else runs as DuckDB SQL. History walks Up/Down and persists across sessions (capped at 200 lines).
- [Feature] `CommandRegistry` — the single source of truth for every verb. Palette, keymap, and shell all resolve through it.
- [Feature] Shell commands: `.help [name]`, `.how-to`, `.shortcuts`, `.feedback`, `.about`, `.tables`, `.columns [name]` (defaults to active tab), `.import [--folder]`, `.open <name>` (matches any Datasets-tree leaf, imports if needed), `.close [name | --all]`, `.theme light|dark|auto`, `.tab next|prev|N`, `.settings [key=value]` (opens Settings tab when no args), `.view save|drop <name>`, `.query save <name>`, `.export <csv|tsv|html|markdown>` (copies to clipboard AND downloads `<dataset>.<ext>`), `.clear`, plus shell shortcuts for global keymap actions (`.panel`, `.sql`, `.fullscreen`, `.palette`, `.focus`).
- [Feature] CommandBar autocomplete: command names complete on dot-prefix; positional arguments complete from each parameter's `options()` thunk (e.g. `.open ` lists Datasets-tree leaves, `.theme ` offers `light/dark/auto`). Tab completes, Up/Down navigate, Esc dismisses.
- [Feature] Help panel gains a Commands tab — registry-driven listing grouped by category. `.help` opens it instead of dumping a multi-screen manual into the status-bar tooltip.
- [Feature] Keybindings: `Ctrl+/` toggles the help panel; `` Ctrl+` `` focuses the shell input.
- [Feature] Tokyonight re-skin: Vim-flavoured palette (Day light / Storm dark) exposed via CSS custom properties; theme switching is a body-class flip with no SCSS recompile.
- [Feature] Spreadsheet renderer Phase A: HiDPI-sharp glyphs and a single-pass grid pipeline.
- [Feature] In-app feedback form (HelpPanel → Feedback) backed by a Cloudflare Worker + D1 store; `mailto:contact@bedeverewise.app` fallback for deployments without the worker.
- [Feature] Deploy story: Cloudflare Workers Builds (recommended) + GitHub Pages, custom domain `bedeverewise.app`, DuckDB-WASM loaded from jsDelivr to keep the bundle slim.
- [Enhanced] Global-scope keymap actions (`app.togglePanel`, `app.toggleSqlEditor`, `tabs.next`, `tabs.prev`, etc.) resolve via `commandRegistry.run(action)` instead of hand-maintained switch statements in three callers.
- [Enhanced] Spreadsheet-scope keymap actions (`spreadsheet.moveUp`, `spreadsheet.copy`, etc.) also unify through the registry, routing to the active tab's `SpreadsheetVisualizer`.
- [Enhanced] CommandBar is always visible — reachable before the first dataset is imported so `.import` / `.help` work from a cold start. SqlEditor input also routes through the dot-command dispatcher (a `.command` typed there + Ctrl+Enter behaves the same as in the CommandBar).
- [Enhanced] `.sql` toggle now also focuses the SQL editor; `.close --all` closes every open dataset.
- [Enhanced] Status-bar version chip uses dedicated `--version-bg` / `--version-fg` tokens (the light-theme yellow was muddy as a fill); the margin between version and adjacent message chips was dropped so success/error chips sit flush.
- [Enhanced] Suggestions dropdown anchored to a wrapper around the input (`left: 0` / `right: 0`) instead of magic pixel offsets — aligns regardless of prompt or font.
- [Bug-fix] `.columns` uses `information_schema.columns` instead of `DESCRIBE` (DuckDB's `DESCRIBE` can't appear inside a `CREATE TABLE … AS (…)` wrapper).
- [Deprecated] CommandPalette (`Ctrl+Shift+P`) is flagged for removal in 0.9. It keeps working in 0.8, backed by the new registry.
- [Removed] Duplicate palette entries `view.toggleLeftPanel` and `sql.toggleEditor` (superseded by `app.togglePanel` / `app.toggleSqlEditor`).

## v0.7-son-of-uther-pendragon

- [Feature] Inspectable STRUCT / LIST / MAP / JSON / UNION cells with a key/value popover that auto-opens as the selection lands on a complex cell (respects Esc dismissal)
- [Feature] Query execution time shown as a status-bar chip (⏱ for success / ✖ for failures) with smart unit switching (ms / s / m s)
- [Feature] Loading feedback for file and folder imports — per-file progress messages and an aggregated success / partial / failure summary at the end of a batch
- [Feature] Settings tab exposes date, datetime, number, and display preferences (decimal places, thousands separator, minimum column width, max chars per cell); preferences persist across reloads
- [Feature] Configurable keymap with a rebind UI and a Reset keymap action
- [Feature] Tab-switch keyboard shortcuts and copy-format preferences (delimiter, include-header)
- [Feature] Help panel SQL tutorial keyed on the Penguins sample dataset
- [Enhanced] Cells that overflow their column now render an ellipsis instead of horizontally squeezed glyphs
- [Enhanced] Columns keep their content-derived width instead of stretching to fill the viewport
- [Enhanced] Type-aware Arrow unwrap; DECIMAL, nested-struct, and map payloads render correctly
- [Enhanced] Arrow keys no longer move cell selection while typing in an input
- [Bug-fix] Date / datetime format presets now honour the literal pattern (previously all presets produced identical output because Intl.DateTimeFormat ignored property order)
- [Bug-fix] Numeric format settings actually apply (previously the options bag was stringified to "[object Object]" and discarded)
- [Bug-fix] Cell cache TTL was 1 minute despite a "5 minutes" comment; corrected to 5 minutes
- [Renamed] MultiDatasetVisualizer → TabManager
- [Chore] Consolidated `escapeHtml` into `src/utils/html.ts`; removed unused event-system types, container-size constants, and a broken export-dataset stub

## v0.6-it-is-i

- [Feature] DuckDB-WASM data backend replacing the previous in-memory engine
- [Feature] SQL editor with CodeMirror 6, syntax highlighting, and schema-aware autocomplete
- [Feature] Pluggable file import: CSV, TSV, JSON, Parquet, Excel (xlsx/xls), SAS, Stata, SPSS
- [Feature] Folder scanning via File System Access API with file-tree browser
- [Feature] Column filtering (include/exclude values, numeric/temporal ranges)
- [Feature] Persistence: saved views, query bookmarks, and app settings (localStorage)
- [Feature] Configurable keybindings via KeymapService
- [Feature] Table aliases (ALTER TABLE RENAME via AliasManager)
- [Feature] About panel with dependency and version info
- [Enhanced] Expanded DataType system: 30+ DuckDB types with predicates and normalization
- [Enhanced] Per-type column stats (numeric histograms, temporal ranges, boolean/categorical counts)
- [Enhanced] StatusBar message popover with severity styling and click-to-expand details
- [Enhanced] ControlPanel replaces DatasetPanel: accordion layout with resizable panel
- [Enhanced] CommandBar replaces CellValueBar; cell info moved to status bar
- [Enhanced] DragDropZone supports multi-file drops and browse-folder split button
- [Enhanced] Global scrollbar styling matching the canvas theme
- [Bug-fix] Fixed copy range when selection is dragged upward or leftward
- [Bug-fix] NULL display before numeric coercion (was showing 0 or 1970-01-01)
- Renamed from Brian to Bedevere Wise

## v0.5-who-goes-there

- [Feature] Implemented commands with parameters in Command Palette
- [Feature] Export selection commands moved from Context Menu to Command Palette
- [Enhanced] Cell and column selection behavior
- [Enhanced] Added version information to Status Bar
- [Bug-fix] Fixed dataset and selection items in Status Bar

## v0.4-halt

- [Feature] Added Command Palette for improved interactivity
- [Feature] Added drag and drop support for file upload
- [Feature] Added Status Bar
- [Feature] Added Cell Value Bar
- [Feature] Added values distribution visualization in the stats panel
- [Enhanced] Cell styling and formatting
- [Enhanced] Zooming added
- [Enhanced] New event handling system
- [Bug-fix] Fixed scrolling and column selection issues

## v0.3-guard

- [Feature] Multi-dataset support: visualize multiple datasets in different tabs
- [Feature] Export selection menu: CSV, TSV, HTML and Markdown
- [Feature] DataProvider interface updated to include metadata
- [Enhanced] Column stats visualization
- [Bug-fix] Fixed scrolling and boundaries issues

## v0.2-whoa-there

- [Feature] Added a comprehensive Stats Panel for enhanced data insights
- [Feature] Introduced cell selection functionality for improved interactivity
- [Bug-fix] Enhanced scrolling performance and responsiveness
- [Bug-fix] Fixed issues with column hovering and selection for a smoother user experience

## v0.1-arthur

- Initial release
