# Changelog

## v0.12-pull-the-other-one

- [Feature] **Environments.** Opening a folder auto-creates an environment named after that folder; the environment owns its datasets, its saved queries, and the workspace state (open data tabs + open query tabs + active tab). Switch via the dropdown above the file tree — closing the current env saves any drafts, swaps to the new env's datasets, and re-opens its workspace. Single-file drops register under a "default" env so casual imports don't bloat the list. Folder-handle binding survives renames so re-opening the same folder reuses its env. The shell mirrors the surface: `.env list | new <name> | switch <name> | rename <old> <new> | delete <name>`. State is JSON-serializable behind stable opaque ids, all writes go through the new `EnvironmentService`, and every persisted shape carries a schema version — the substrate for future server-sync and agent integrations.
- [Feature] **SQL editor tabs.** The single-document editor became a multi-tab editor. Each tab is a `.sql` "file" stored in the browser and owned by the active environment; new / close / rename / switch all live in the editor's own tab strip, distinct from the data/chart workspace tabs. Tab content autosaves on a 750 ms idle debounce per tab; reload restores exactly which tabs were open and which was active. Double-click a tab title to rename inline; Ctrl+S still writes the active tab's content to the named-bookmark store. The v0.11 single-slot `editorAutoSaveDraft` migrates to an untitled query in the default env on first launch.
- [Feature] **Auto-import small files + size warnings.** Drops below the size threshold (default 100 KB, configurable in Settings: 10 KB / 100 KB / 1 MB / never) import silently into DuckDB without opening a tab — convenient for ad-hoc joins where you don't want a tab for every file. Files at or above the threshold show a right-aligned size label (`12 KB`, `3.4 MB`) and a ⚠ glyph in the tree; clicking imports + opens. Folder scans (FSA picker) get the same treatment, with sizes populated lazily from the file handles.
- [Feature] **Failed-import → read-only text tab.** When a CSV / JSON / log file's import throws, the file opens as a read-only CodeMirror tab with the underlying DuckDB error banner-pinned above — so you can see the malformed row instead of just reading "could not parse" in a toast. Text-likeness is sniffed by extension first, then by a NULL-byte / non-printable scan. Binary files (e.g. PNG renamed to `.csv`) still fall through to the toast. Text tabs are ephemeral — closed on reload, not persisted into the workspace.
- [Feature] **`/embed` route — chromeless iframable Bedevere.** A separate Vite entry that renders just the editor + result panel, designed for embedding in writeups on a blog or doc site. URL prefill: `?dataset=<url>&query=<urlencoded-sql>&theme=light|dark&autorun=1&id=<opaque>`. Multiple `dataset=` params are allowed; each registers as a separate table (the file name and table name are intentionally different so the `read_*('<file>')` reference doesn't collide with the materialised table). The dataset has to be reachable by URL with permissive CORS — Bedevere doesn't host the bytes. postMessage protocol: child emits `{type:'embed-resize', height, id}` debounced 50 ms via ResizeObserver, parent sends `{type:'embed-theme', theme}` to flip themes without reload and `{type:'embed-run'}` to re-run the current query. Origin allowlist hard-codes the blog (caveofcaerbannog.com) and the standard dev ports; CSP `frame-ancestors` ships in `public/_headers` for the Workers static-asset route.
- [Feature] **Editor splitter resize + indent selector.** The horizontal split between editor and result is now draggable (drag handle in the editor's bottom border). The editor toolbar gained an indent dropdown (2 / 4 / Tab) that drives the `Tab` key behaviour. Settings persists both.
- [Enhanced] **Error and warning popovers auto-open.** Status-bar messages of severity `error` or `warning` now expand the popover automatically so the full text and any stack-trace details are visible without a click. Outside-click / Escape / close button dismiss as before, and the message's own duration timeout (10 s for errors, 6 s for warnings) still self-closes the popover. Success / info messages stay collapsed — they're short and self-contained.
- [Enhanced] **Bundled stats_duck bumped to v0.5.** The WASM binary committed under `public/extensions/stats-duck/v1.5.1/wasm_eh/` is now the v0.5 build of [the-stats-duck](https://github.com/caerbannogwhite/the-stats-duck). Production deploys serve the WASM from the same Cloudflare origin; local dev follows the env-configured path.
- [Enhanced] **Self-hosted DuckDB worker JS.** The DuckDB-WASM worker is bundled into the app via Vite `?url` imports instead of fetched from jsDelivr at runtime — one fewer external dependency at boot, and the long-tail "jsDelivr blipped → reload fails with `importScripts` error" failure mode is gone. The WASM modules themselves still load from jsDelivr (they exceed Cloudflare Workers' per-asset cap).
- [Enhanced] **Saved Queries is per-environment.** The accordion reads from the active env's `queries` array; clicking an entry opens it as an editor tab (focuses the existing one if already open). Per-env grouping means folder-scoped queries don't pollute the default-env list and vice-versa.
- [Enhanced] **Tier 2 persistence pass.** `AliasManager` and `KeymapService` join the rest of the localStorage callers behind `PersistenceService` — all storage writes now flow through one typed surface, the substrate for the env-storage envelope and a future server-sync layer.
- [Enhanced] **Dialog base class.** `HideColumnsDialog`, `HtmlPasteDialog`, and `SaveQueryDialog` extracted shared overlay / focus-trap / escape-key behaviour into a `Dialog` base; the accent colours align across the three so they read as the same family.
- [Enhanced] **HelpPanel split.** The tutorial markup, format-preset table, and About HTML moved into their own modules under `HelpPanel/`. The component stays focused on lifecycle and tab switching; release-day "refresh About" edits touch one small file instead of the umbrella component.
- [Enhanced] **DuckDB wipe on env switch.** Switching environments drops the previous env's tables before registering the new env's files, so a `result_1` from one workspace can't be queried out of the next one — keeps the SQL surface honest about what's actually loaded.
- [Bug-fix] **`CREATE OR REPLACE TABLE` refreshes its open tab.** Re-running a `CREATE OR REPLACE TABLE foo AS …` script while `foo` was already open used to leave the spreadsheet painting cached rows from the previous version — DuckDB had the new data, but the visualizer's row cache and the provider's parsed-types cache were still bound to the old schema. The dispatcher now closes the existing tab and re-opens fresh, so the new rows always show. Scroll position / selection / local filter+sort don't survive the rebuild yet; an in-place refresh is on the v0.13 list.
- [Bug-fix] **`WITH … VISUALIZE` routes to the chart path.** Queries that wrapped `VISUALIZE … DRAW` in a CTE used to fall through the SELECT classifier into the table-tab path, where stats_duck's parser-extension hook never fired. The dispatch now scans past leading `WITH` blocks before classifying — CTE-wrapped charts render.
- [Bug-fix] **Spreadsheet's last row is reachable again.** The scroll spacer underestimated the row-snap delta, so on long datasets the final row would sit just past the scrollable extent. Spacer height now includes the snap delta; you can scroll to (and select) the last row.
- [Bug-fix] **Row-snap aligns the viewport.** Vertical scrolling now snaps to row boundaries instead of leaving rows half-clipped at the top of the visible area. Programmatic scrolls (cell navigation, "go to row N") snap into the same grid.
- [Bug-fix] **`pushRecentFolder` reuses the same IDB id.** Re-picking a folder with the same name no longer leaves orphaned `folder_handles` rows in IndexedDB — the recent-folders list resolves to one stable id per folder.
- [Bug-fix] **Embed: initial-paint blank-cells / dark-theme caret.** The result panel forced a layout settle (one `requestAnimationFrame` + `resize`) after the visualizer initialises so cells render on first paint instead of waiting for a scroll/theme nudge. CodeMirror's blinking caret got an explicit `caret-color` so it's visible against the dark Tokyonight background.

## v0.11-sovereign-of-all-england

- [Feature] **Hide / show columns.** New `.hide` shell command opens a dialog with checkboxes for every column plus Show-all / Hide-all bulk toggles and a filter search. State persists per dataset and restores when you reopen the file. Filter and sort still operate on hidden columns by name — unhiding restores the previous filter / sort state automatically. Right-click a header for the same "Hide column" item.
- [Feature] **Drag-to-reorder columns.** Press and hold on a column header (past the sort-arrow zone), drag past a 4 px threshold, and a faint ghost follows the cursor with a vertical blue drop-indicator showing where the column will land. Release commits the new order; plain clicks still select the column. The order persists per dataset alongside hide / sort / filter.
- [Feature] **Right-click context menu on the spreadsheet.** Header right-click → Sort asc / desc / Clear sort / Hide column. Cell right-click → Copy / Inspect (for complex cells) / Sort by column / Hide column. Row-gutter right-click → Copy row. The menu is zone-aware so the items match where you clicked.
- [Feature] **Editor autosaves while you type, restores on reload.** The SQL editor's contents are flushed to localStorage on a 750 ms idle debounce — short enough that a browser crash or refresh loses essentially nothing, long enough that we're not pummeling storage on every keystroke. Reloading the app drops you back into the same query you were working on, and the editor opens automatically if there's a restored draft. The named-bookmark store (`.query save <name>`) is unchanged; this is a separate, single-slot working draft.
- [Feature] **Ctrl+S in the editor → "Save query as…" dialog.** Single-input modal that writes the current query to the named-bookmark store. The placeholder shows an example name; the dialog warns when the typed name would overwrite an existing bookmark (the save still proceeds — same semantics as `.query save`).
- [Feature] **Click-to-copy on column-stats labels.** Click the column-name header or any categorical-histogram value → the text writes to the clipboard with a brief cyan flash on the clicked element. Mouse drag-selection still works for free-form text copy.
- [Feature] **Search bar in the Datasets file tree.** A small search input above the file tree filters nodes by case-insensitive substring (or regex via a toggle); matching ancestors auto-expand so matches are immediately visible. Clearing the query restores the prior collapse state.
- [Feature] **Search the categorical-filter value list.** When a column has many distinct values, the Column Stats filter panel's value list gains a search input with a regex toggle. Search runs against the full column (not just the top-N already shown), and "Apply filter" while a search is active writes an *include* of (matching values ∩ checked) rather than the default *exclude* — so "show only Week 2 and Week 4" is one search + tick + apply.
- [Enhanced] **Sticky control-panel accordion headers.** The Datasets / Column Stats / Saved Queries section headers stay pinned at the top of the panel while you scroll, so you never lose the toggles when expanding a long list.
- [Enhanced] **Column Stats above Datasets** in the control panel. Reordered the accordion so the column-aware panel is closer to eye height when you're working with the active dataset; Datasets is still expanded by default.
- [Enhanced] **Categorical histogram bars share a baseline.** Restructured the chart to a CSS grid so every row's label, bar, and count line up on the same vertical edges regardless of label width — the bars now read like a proper bar chart.
- [Enhanced] **Tighter heuristic for small numeric histograms.** The "one bin per distinct value" path now requires both small distinct count *and* small integer range. Eurovision-style integer columns with a wide range and one row per value (26 distinct values across [11, 534]) fall through to the continuous-binning path and render as a real distribution.
- [Enhanced] **Bundled stats_duck bumped to v0.4.** The WASM binary committed under `public/extensions/stats-duck/v1.5.1/wasm_eh/` is now the v0.4 build of [the-stats-duck](https://github.com/caerbannogwhite/the-stats-duck) — adds `TABLE_ONE()` (the publication-style summary used in the new How-to section) and a handful of other aggregates. Production deploys serve the WASM from the same Cloudflare origin; local dev follows the env-configured path.
- [Enhanced] **Editor find panel themed.** `Ctrl+F` opens CodeMirror's find panel; F3 / Shift+F3 step through matches. Repainted with the Tokyonight palette so the inputs, buttons, and option checkboxes match the rest of the editor chrome — was previously default-white CodeMirror, jarring on a dark theme.
- [Bug-fix] **Ctrl+C now respects DOM text selections outside the spreadsheet.** When the user drag-selects text in the column-stats panel, status bar, help panel, etc., Ctrl+C copies that selection instead of the spreadsheet's cells. The spreadsheet's cell-copy still fires when no DOM selection exists or the selection lives inside the spreadsheet container.
- [Bug-fix] **Overlays no longer steal hover.** Hovering over the right-click context menu, the Hide-columns dialog, the Help panel, etc. used to keep updating the spreadsheet's hover highlight underneath. Mouse events that target an overlay now bail before reaching the spreadsheet's hover-paint path.
- [Bug-fix] **Anchored categorical filter regex.** Regex filters on categorical columns now match the *whole* value, not a substring (the old `[24]{1,1}` would have caught "Week 20 / 24 / 26"; now only "Week 2 / 4" match — what users intuitively expect when typing a category-value pattern).
- [Bug-fix] **Scroll-jump perf on wide tables (≥200 cols).** Datasets with persisted hide / sort / column-order state were paying for two DuckDB `DESCRIBE` round-trips per cache chunk fetch, which left the spreadsheet blank for several seconds after a scroll-jump on big tables. The source schema is now cached on the provider — one `DESCRIBE` for the provider's lifetime, sub-millisecond per fetch thereafter.
- [Bug-fix] **CSV / Excel imports tolerate dirty real-world data.** CSV now uses `read_csv_auto(?, sample_size=-1, …)` so DuckDB scans the whole file before inferring types (a stray `]` at row 41587 of a 200-column file widens that column to VARCHAR instead of aborting the whole import). Excel mirrors the same idea: `read_xlsx` defaults → `ignore_errors=true` → `all_varchar=true` → `st_read`, with the real DuckDB error surfaced if every attempt fails.
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
