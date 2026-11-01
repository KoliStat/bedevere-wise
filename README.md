# bedevere wise

This repo holds the bedevere wise web app and the npm package [`@kolistat/bedevere-wise`](https://www.npmjs.com/package/@kolistat/bedevere-wise). The package has the browser components that both bedevere apps are built from:

- **`SpreadsheetVisualizer`**: a spreadsheet drawn on a canvas. It scrolls through large tables and stays sharp on high-DPI screens.
- **`ColumnStatsVisualizer`**: summary statistics for each column, with a value filter.
- **`ChartVisualizer`**: draws the Vega-Lite charts that `stats_duck`'s `VISUALIZE … DRAW` produces.
- **`EmbedSqlEditor`**: a small CodeMirror SQL editor for bedevere's SQL dialect, which extends PostgreSQL's.
- **`DuckDBService` and `DuckDBDataProvider`**: a wrapper around the DuckDB-WASM runtime, and the bridge from it to the UI components.

## bedevere

bedevere opens SAS, SPSS, Stata, Parquet, Excel, CSV, TSV and JSON files. You query them with SQL and plot them with `VISUALIZE`. It runs on [DuckDB](https://duckdb.org) and comes in three parts:

| Part | What it is | Where |
| --- | --- | --- |
| bedevere wise | The web app. DuckDB runs in the browser, and files are not uploaded. | [bedeverewise.app](https://bedeverewise.app) |
| bedevere desktop | The Windows app. It runs native DuckDB and reads files from disk. | [kolistat.com/products/bedevere](https://kolistat.com/products/bedevere) |
| `@kolistat/bedevere-wise` | The npm package with the components that both apps are built from. | [npm](https://www.npmjs.com/package/@kolistat/bedevere-wise) |

The web app and the desktop app are released together, with the same version and code name.

## Status

The package is before version 1.0. Each release is published under both the `latest` and `next` dist-tags. A new 0.x minor version can break the API, and the CHANGELOG says when it does. Pin an exact version in production.

The web app needs a desktop browser. Phones and tablets are not supported yet.

## Install

```sh
bun add @kolistat/bedevere-wise

# Peer dependencies. Install one shared copy of each in your tree:
bun add @duckdb/duckdb-wasm@1.33.1-dev65.0 apache-arrow@17 \
  @codemirror/autocomplete @codemirror/commands @codemirror/lang-sql \
  @codemirror/language @codemirror/search @codemirror/state \
  @codemirror/view @lezer/highlight codemirror \
  vega-embed
```

`@duckdb/duckdb-wasm` must be exactly `1.33.1-dev65.0`, the build that bundles DuckDB v1.5.6. npm's `latest` tag points at an older build. DuckDB extensions such as stats_duck load only in the DuckDB version they were built for. `apache-arrow` must be a 17.x release, and npm's `latest` is newer.

All peer dependencies are required if you import from the package's root entry. [Bundler compatibility](#bundler-compatibility) explains why, and lists the entries that leave out DuckDB-WASM (`/ui`, `/app`, `/ipc`).

## Quick start

```ts
import {
  DuckDBService,
  DuckDBDataProvider,
  SpreadsheetVisualizer,
  ColumnStatsVisualizerFocusable,
} from "@kolistat/bedevere-wise";
import "@kolistat/bedevere-wise/style.css";

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

The package has two tiers of exports.

### Component tier (recommended)

Components in this tier take their dependencies as constructor arguments. They do not reach into module-level singletons, so you can mount them inside any host app.

| Export | Purpose |
| --- | --- |
| `DuckDBService` | Wraps the DuckDB-WASM runtime. Use one instance per app. |
| `DuckDBDataProvider` | Implements `DataProvider` over a DuckDB table. |
| `DataProvider` (interface) | **Where a dataset plugs in.** Implement it to feed rows from any source, such as HTTP, IPC or a server. |
| `Backend` (interface) | **Where a SQL engine plugs in.** Implement it to run `BedevereApp` on an engine other than DuckDB-WASM, such as native DuckDB over IPC or a remote relay. The optional `exportTable(opts)` writes a whole table to Parquet, JSON, SAS or SPSS. `ExportFormat`, `ExportTableOptions`, `ExportResult` and `EXPORT_FORMATS` are exported for it. |
| `SpreadsheetVisualizer` | The spreadsheet, drawn on a canvas. |
| `ColumnStatsVisualizer`, `ColumnStatsVisualizerFocusable` | The column statistics and filter panel. Several spreadsheets can share one. |
| `ChartVisualizer` | Draws the Vega-Lite specs that `stats_duck`'s `VISUALIZE … DRAW` produces. |
| `EmbedSqlEditor` | A small CodeMirror SQL editor with the bedevere dialect. Its colours follow the active theme. |
| Type helpers (`isNumericType`, `normalizeDuckDBType`, `dataTypeCategory`, …) | For consumers that write their own `DataProvider`. |

The UI components (`SpreadsheetVisualizer`, `ColumnStatsVisualizer`, `ChartVisualizer` and `EmbedSqlEditor`) **do not depend on DuckDB-WASM**. They read rows through the `DataProvider` interface and charts as Vega specs. A consumer can skip `DuckDBService` and `DuckDBDataProvider`, and supply its own `DataProvider` over another backend: an HTTP API, native IPC or an in-memory pipeline.

### App-shell tier: `@kolistat/bedevere-wise/app`

This entry has the whole app shell in parts: `BedevereApp`, `TabManager`, `ControlPanel`, `StatusBar` and `CommandBar`. It also exports the `PersistenceService` singleton and `APP_VERSION`, the release name. `BedevereApp` has no default engine: you pass one as `options.backend`. So importing from `/app` pulls in **no DuckDB-WASM**. Pair it with `/duckdb` for the in-browser engine, or pass an `IpcBackend` or a remote relay. bedevere desktop runs the same UI on native DuckDB this way, through `IpcBackend`:

```ts
import { BedevereApp } from "@kolistat/bedevere-wise/app";
import { DuckDBService } from "@kolistat/bedevere-wise/duckdb";
import "@kolistat/bedevere-wise/style.css";

const backend = new DuckDBService();
await backend.initialize();
const app = new BedevereApp(document.getElementById("app")!, "1.0.0", { backend });
await app.initAsync();
```

The shell uses module-level singletons (`CommandRegistry`, `EnvironmentService`, `KeymapService` and `PersistenceService`) and expects one `BedevereApp` per page. If you need only part of the UI, use the component tier instead.

## Theming

The package ships six themes as CSS custom-property sets, in three light and dark pairs. A single body class selects one. Exactly one is applied at a time:

| Body class | Theme |
| --- | --- |
| `theme-light` | Paper, the default. It matches kolistat.com. |
| `theme-dark` | Night, Paper's dark mode |
| `theme-classic-light` | Tokyonight Day |
| `theme-classic-dark` | Tokyonight Storm |
| `theme-github-light` | GitHub Light |
| `theme-github-dark` | GitHub Dark |

Override the tokens in your own stylesheet, after the package CSS. `dist/style.css` has the full token list:

```css
body.theme-dark {
  --bg: #1f1f1f;
  --fg: #e1e4e8;
  /* ... */
}
```

Switching the body class redraws the canvas parts: the spreadsheet repaints, and the chart re-embeds with matching Vega colours. `BedevereApp` sets the class for you and exposes `setTheme()`. It starts on Paper and follows the system light or dark setting.

### Fonts

Every theme uses IBM Plex Mono for the chrome, the data grid, the editor and chart text. Paper and Night set prose in Source Sans 3. Tokyonight and GitHub use the system sans-serif font for prose. The package's `style.css` names these fonts but ships no font files. Load them yourself, for example from Fontsource, in the weights the app uses:

```sh
bun add @fontsource/ibm-plex-mono @fontsource/source-sans-3
```

```ts
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/400-italic.css";
import "@fontsource/source-sans-3/600.css";
```

Without them, the browser uses the next font in each stack.

## Bundler compatibility

The package runs **only in the browser**, and it is built for **Vite**. DuckDB-WASM, which `DuckDBService` uses, ships its worker scripts as separate JS files. The package imports them with Vite's `?url` suffix. The compiled bundle (`dist/index.es.js`) keeps these `?url` imports as written, so your bundler has to resolve them.

| Bundler | Status |
| --- | --- |
| Vite | Works without extra setup. This is the supported path. |
| webpack 5 | Works with `asset/resource` rules for the worker URLs. See the [DuckDB-WASM docs](https://duckdb.org/docs/api/wasm/instantiation) for the setup. |
| Bun bundler, esbuild, Parcel | They do not resolve the `?url` suffix, so they need plugins or loader config. Untested. |
| SSR, Node, Bun runtime | Not supported. The DuckDB worker code needs browser APIs when the module loads. |

The `?url` imports sit **only** behind the `/duckdb` entry. If your bundler cannot resolve `?url`, or you don't want DuckDB-WASM in your bundle, import from the other entries and bring your own engine:

| Entry | Pulls in DuckDB-WASM? | Use for |
| --- | --- | --- |
| `@kolistat/bedevere-wise/ui` | No | Single UI components over your own `DataProvider`. |
| `@kolistat/bedevere-wise/app` | No | The whole app shell (`BedevereApp`) with a `Backend` you pass in. |
| `@kolistat/bedevere-wise/duckdb` | **Yes** | The in-browser engine, `DuckDBService`, with the `?url` imports. |
| `@kolistat/bedevere-wise/ipc` | No | `IpcBackend`, for native or remote DuckDB over a WebSocket. |
| `@kolistat/bedevere-wise` (root) | **Yes** | Older code. It re-exports `/duckdb`, so it pulls in the `?url` imports. |

## Development

Work happens on the current `dev-X.Y` branch. Feature branches start from it, and pull requests target it.

To run the web app and the checks:

```sh
bun install
bun run dev            # Vite dev server
bunx vitest run        # tests
bun run notices:check  # checks that the third-party notices are up to date
bun run build          # type checks, production build, output check
```

To work on the package and a consumer at the same time, link a local build:

```sh
# in bedevere-wise/
bun run build:lib    # writes dist/
bun link             # registers @kolistat/bedevere-wise locally

# in the consumer
bun link @kolistat/bedevere-wise
```

After a change in bedevere-wise, run `bun run build:lib` again. The consumer's Vite dev server picks up the new `dist/` on the next reload.

## Releases

Each release has a version and a code name, such as `0.15-my-trusty-servant`. The [CHANGELOG](CHANGELOG.md) lists the changes in each release, and [RELEASING.md](RELEASING.md) has the steps. bedevere desktop is released at the same time, with the same version.

## License

MIT. See [LICENSE](LICENSE). The web app's third-party notices are in [`public/third-party-licenses.txt`](public/third-party-licenses.txt).
