# Bedevere Wise

**Open SAS, SPSS, Stata, Parquet, and Excel files in your browser. Query them with SQL — no install, no upload.**

Drop a `.sas7bdat`, `.sav`, `.dta`, `.xpt`, `.parquet`, `.xlsx`, `.csv`, or `.tsv` and start querying. Runs entirely in your browser via [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) — your data never leaves your machine.

[**Live app · bedeverewise.app**](https://bedeverewise.app/) · [Changelog](CHANGELOG.md)

## Screenshots

<p align="center">
  <img src="docs/media/light.png" alt="Bedevere Wise — light theme" width="48%" />
  <img src="docs/media/dark.png"  alt="Bedevere Wise — dark theme"  width="48%" />
</p>

## Why this exists

Most SQL clients (DBeaver, TablePlus, DataGrip) speak to database servers and won't open `.sas7bdat`. Most "open my SAS file" tools (the SAS Universal Viewer, IBM SPSS Statistics) are vendor-locked desktop apps without SQL. Pandas can do it but needs a Python install plus boilerplate per file. Bedevere Wise sits in the gap: drop the file, get a spreadsheet view, and run SQL against it in seconds.

## Features

- **Stats-software file formats** — `.sas7bdat`, `.sav` (SPSS), `.dta` (Stata), `.xpt` (SAS Transport)
- **General data formats** — CSV, TSV, JSON, Parquet, Excel (.xlsx / .xls)
- **SQL editor** — CodeMirror 6 with schema-aware autocomplete; results open in their own tabs
- **Inline column statistics** — per-type summaries, histograms, and value filters next to the table
- **High-performance grid** — canvas-rendered, virtually scrolled, HiDPI-sharp
- **Dot-command shell** — `.import`, `.open`, `.export`, `.tables`, `.columns`, `.help`, plus argument autocomplete
- **Persistent workspace** — saved queries and settings survive page reloads
- **Fully client-side** — no server, no uploads; data stays in your browser

## Usage as a library

Beyond the standalone app, Bedevere's data-inspection components ship as an npm package: `@caerbannogwhite/bedevere-wise`. Drop the spreadsheet + column-stats + chart visualizers into your own UI, share a single DuckDB-WASM instance, retheme via CSS variables. Used by [tflier](https://github.com/caerbannogwhite/tflier) (clinical-trial TFL designer) for the "look at the data" panels.

### Install

```bash
bun add @caerbannogwhite/bedevere-wise@next
# plus the peer dependencies the package shares with you so there's
# only one copy of each in your tree:
bun add @duckdb/duckdb-wasm \
  @codemirror/autocomplete @codemirror/commands @codemirror/lang-sql \
  @codemirror/language @codemirror/search @codemirror/state \
  @codemirror/view @lezer/highlight codemirror \
  vega-embed
```

### Minimal example

```ts
import {
  DuckDBService,
  DuckDBDataProvider,
  SpreadsheetVisualizer,
  ColumnStatsVisualizerFocusable,
} from "@caerbannogwhite/bedevere-wise";
import "@caerbannogwhite/bedevere-wise/style.css";

const duck = new DuckDBService();
await duck.initialize();

// Register a remote dataset; consumer must serve it with permissive CORS.
await duck.registerFileURL("adsl.parquet", "https://example.org/adsl.parquet");
await duck.executeQuery(
  `CREATE OR REPLACE TABLE adsl AS SELECT * FROM read_parquet('adsl.parquet')`,
);

const provider = new DuckDBDataProvider(duck, "adsl", "adsl.parquet");

// One shared stats panel, mounted next to the spreadsheet:
const statsMount = document.querySelector("#stats")!;
const stats = new ColumnStatsVisualizerFocusable(statsMount as HTMLElement, null);

const gridMount = document.querySelector("#grid")!;
const grid = new SpreadsheetVisualizer(
  gridMount as HTMLElement,
  provider,
  { minHeight: 240, minWidth: 320 },
  stats,
  "my-app-grid",
);
await grid.initialize();
```

### Embedding surface

| Export | Purpose |
| --- | --- |
| `DuckDBService` | One shared DuckDB-WASM instance for your whole app |
| `DuckDBDataProvider` | Wrap a DuckDB table as a `DataProvider` |
| `DataProvider` (interface) | Implement your own provider over arbitrary row sources |
| `SpreadsheetVisualizer` | Canvas-rendered spreadsheet — the "look at the data" surface |
| `ColumnStatsVisualizer` / `ColumnStatsVisualizerFocusable` | Per-column stats + filters; share one across many spreadsheets |
| `ChartVisualizer` | Renders Vega-Lite specs produced by `stats_duck`'s `VISUALIZE … DRAW` |
| `EmbedSqlEditor` | Slim CodeMirror SQL editor with Bedevere's dialect + tokyonight palette |
| Type helpers (`isNumericType`, `normalizeDuckDBType`, …) | For consumers writing custom DataProviders |

The `BedevereApp` / `TabManager` / `ControlPanel` / `CommandBar` exports are the *standalone app's* surface and depend on module-level singletons (CommandRegistry, EnvironmentService, etc.). They're exported for completeness but **not recommended for embedding** — use the embedding surface above.

### Theming

The package's CSS uses tokyonight defaults wired to CSS custom properties. To retheme, override the variables in your own stylesheet after importing the package CSS:

```css
:root {
  --bg: #fff;
  --fg: #1a1a1a;
  --magenta: #c0007a;
  /* … see dist/style.css for the full token list */
}
```

### Status

Pre-stable — published under the `next` dist-tag while the embedding surface settles. Breaking changes are possible before `0.13`. Pin to an exact version in production until then.

## License

MIT — see [LICENSE](LICENSE) for details.
