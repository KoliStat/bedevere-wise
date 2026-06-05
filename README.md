# @caerbannogwhite/bedevere-wise

Embeddable browser components for DuckDB-WASM-backed data exploration:

- **`SpreadsheetVisualizer`** — canvas-rendered grid; virtually scrolled, HiDPI-sharp.
- **`ColumnStatsVisualizer`** — per-column summary stats + value-filter UI.
- **`ChartVisualizer`** — Vega-Lite renderer for `stats_duck`'s `VISUALIZE … DRAW` output.
- **`EmbedSqlEditor`** — slim CodeMirror SQL editor with Bedevere's PostgreSQL-extended dialect.
- **`DuckDBService` + `DuckDBDataProvider`** — DuckDB-WASM runtime wrapper + bridge to the UI components.

These are the same components that compose the standalone web app at [bedeverewise.app](https://bedeverewise.app). Also consumed by [tflier](https://github.com/caerbannogwhite/tflier) for clinical-trial pipeline inspection.

> **Status**: pre-stable. Shipping on the `@next` dist-tag while the embedding API settles. Breaking changes possible before `0.13.0`. Pin to an exact version in production.

## Install

```sh
bun add @caerbannogwhite/bedevere-wise@next

# Peer dependencies — install one shared copy of each in your tree:
bun add @duckdb/duckdb-wasm \
  @codemirror/autocomplete @codemirror/commands @codemirror/lang-sql \
  @codemirror/language @codemirror/search @codemirror/state \
  @codemirror/view @lezer/highlight codemirror \
  vega-embed
```

All peer deps are required if you `import` from the package's main entry today. See [Bundler compatibility](#bundler-compatibility) for the rationale and the planned UI/DuckDB entry split.

## Quick start

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

// Point DuckDB at a remote dataset; the host must serve permissive CORS.
await duck.registerFileURL("adsl.parquet", "https://example.org/adsl.parquet");
await duck.executeQuery(
  `CREATE OR REPLACE TABLE adsl AS SELECT * FROM read_parquet('adsl.parquet')`,
);

const provider = new DuckDBDataProvider(duck, "adsl", "adsl.parquet");

// One shared stats panel, mounted next to the spreadsheet:
const stats = new ColumnStatsVisualizerFocusable(
  document.querySelector("#stats")!,
  null,
);

const grid = new SpreadsheetVisualizer(
  document.querySelector("#grid")!,
  provider,
  { minHeight: 240, minWidth: 320 },
  stats,
  "my-app-grid",
);
await grid.initialize();
```

## Embedding surface

The package ships two tiers of exports.

### Embedding tier — recommended

Components in this tier accept their dependencies via constructor; no module-level singleton reach-through. Safe to mount inside any host app.

| Export | Purpose |
| --- | --- |
| `DuckDBService` | DuckDB-WASM runtime wrapper. One instance per app. |
| `DuckDBDataProvider` | Implements `DataProvider` over a DuckDB table. |
| `DataProvider` (interface) | **The integration boundary.** Implement your own to feed data from anywhere — HTTP, IPC, a server. |
| `SpreadsheetVisualizer` | Canvas-rendered spreadsheet. |
| `ColumnStatsVisualizer` / `ColumnStatsVisualizerFocusable` | Column stats + filter panel; share one across many spreadsheets. |
| `ChartVisualizer` | Renders Vega-Lite specs produced by `stats_duck`'s `VISUALIZE … DRAW`. |
| `EmbedSqlEditor` | Slim CodeMirror SQL editor with the Bedevere dialect + tokyonight palette. |
| Type helpers (`isNumericType`, `normalizeDuckDBType`, `dataTypeCategory`, …) | For consumers writing custom `DataProvider`s. |

The UI components (`SpreadsheetVisualizer`, `ColumnStatsVisualizer`, `ChartVisualizer`, `EmbedSqlEditor`) **have no hard dependency on DuckDB-WASM** — they consume the `DataProvider` interface and Vega specs respectively. A consumer can ignore `DuckDBService` / `DuckDBDataProvider` entirely and supply their own `DataProvider` over an alternative backend (HTTP API, native IPC, an in-memory pipeline, …).

### App tier — not recommended for embedding

Top-level shells that compose the standalone web app: `BedevereApp`, `TabManager`, `ControlPanel`, `StatusBar`, `CommandBar`. They assume module-level singletons (`CommandRegistry`, `EnvironmentService`, `KeymapService`, `PersistenceService`) that aren't exposed cleanly via the package. Exported for completeness, but the embedding tier is the contract you want.

## Theming

The CSS uses tokyonight defaults wired to CSS custom properties. Override them in your own stylesheet, after importing the package CSS:

```css
:root {
  --bg: #fff;
  --fg: #1a1a1a;
  --magenta: #c0007a;
  /* ... see dist/style.css for the full token list */
}
```

Body class `theme-light` / `theme-dark` triggers a re-render of theme-sensitive canvas surfaces (the spreadsheet repaints, the chart re-embeds with a matching Vega palette).

## Bundler compatibility

The package is **browser-only** and currently **Vite-friendly**. DuckDB-WASM, which `DuckDBService` depends on, ships its worker scripts as separate JS files referenced via Vite's `?url` import syntax. The compiled bundle (`dist/index.es.js`) preserves these `?url` imports verbatim; resolving them is your bundler's job.

| Bundler | Status |
| --- | --- |
| Vite | Works out of the box. This is the supported path. |
| webpack 5 | Works with `asset/resource` rules for the worker URLs. See the [DuckDB-WASM docs](https://duckdb.org/docs/api/wasm/instantiation) for setup. |
| Bun bundler / esbuild / Parcel | The `?url` suffix isn't resolved natively; needs custom plugins or loader config. Untested. |
| SSR / Node / Bun runtime | Not supported. The DuckDB worker code requires browser APIs at module load. |

If your stack can't handle `?url` and you only need the UI surfaces, the workaround today is to **omit `DuckDBService` / `DuckDBDataProvider` from your imports** — those are the chain that pulls in the worker URLs — and implement your own `DataProvider` over whatever backend you have. A future release will split the package into separate `/ui` and `/duckdb` entry points so the UI-only path doesn't drag DuckDB in at all.

## Local development against this package

The package's source lives in [bedevere-wise](https://github.com/caerbannogwhite/bedevere-wise) on the `dev-0.12` branch. To hack on both this and a consumer at once:

```sh
# in bedevere-wise/
bun run build:lib    # produces dist/
bun link             # registers @caerbannogwhite/bedevere-wise locally

# in your consumer app/
bun link @caerbannogwhite/bedevere-wise
```

After source changes in `bedevere-wise`, re-run `bun run build:lib` to refresh the linked `dist/`. The consumer's Vite dev server picks up the new code on next reload.

## Source + standalone app

Source code: [github.com/caerbannogwhite/bedevere-wise](https://github.com/caerbannogwhite/bedevere-wise). The standalone web app at [bedeverewise.app](https://bedeverewise.app) is built from the same source. End-user docs and screenshots live on the [Bedevere Wise app site](https://bedeverewise.app) (it's a desktop-only browser app; mobile isn't supported yet).

## License

MIT — see [LICENSE](LICENSE).
