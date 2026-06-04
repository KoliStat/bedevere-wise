/**
 * Public package surface for `@caerbannogwhite/bedevere`.
 *
 * Two tiers of exports:
 *
 *   1. **Embedding surface** — small, stable set of components + services
 *      a downstream app mounts inside its own UI. This is what external
 *      consumers should use; everything here accepts its dependencies via
 *      constructor (no module-level singleton reach-through).
 *
 *   2. **App surface** — top-level components (BedevereApp, TabManager,
 *      ControlPanel, …) that compose the standalone Bedevere app. Exported
 *      for completeness, but they assume the app's environment / persistence
 *      / command-registry singletons and are NOT recommended for embedding
 *      into a different host app.
 *
 * Styles ship as `./style.css` (compiled from `src/styles/main.scss`). The
 * full app's CSS is included; a slim embed-only stylesheet is a future
 * iteration. Consumers should override the tokyonight CSS custom properties
 * (`--bg`, `--fg`, `--magenta`, …) on `:root` to retheme.
 */

// ─── Embedding surface ────────────────────────────────────────────────
//
// The minimal contract a host app needs to mount Bedevere's
// data-inspection + SQL/chart preview panels.

// Spreadsheet + column stats — the "look at the data" pair.
export { SpreadsheetVisualizer } from "./components/SpreadsheetVisualizer/SpreadsheetVisualizer";
export { ColumnStatsVisualizer } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizer";
export { ColumnStatsVisualizerFocusable } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizerFocusable";
export type { SpreadsheetOptions } from "./components/SpreadsheetVisualizer/types";

// Chart preview — renders Vega-Lite specs produced by stats_duck's
// `VISUALIZE … DRAW <mark>` extension.
export { ChartVisualizer } from "./components/ChartVisualizer/ChartVisualizer";

// Slim SQL editor — CodeMirror 6 with the Bedevere dialect + tokyonight
// highlight palette. No singleton coupling; takes its callbacks via
// constructor. Use this in embeddings; the full SqlEditor in components/
// is heavily tied to the app's environment + persistence services.
export { EmbedSqlEditor } from "./embed/EmbedSqlEditor";
export type { EmbedSqlEditorOptions } from "./embed/EmbedSqlEditor";

// Data layer.
export { DuckDBService } from "./data/DuckDBService";
export { DuckDBDataProvider } from "./data/DuckDBDataProvider";

// Data types + helpers — consumers writing custom DataProviders need
// these to describe schemas + classify column types.
export type {
  DataProvider,
  DatasetMetadata,
  Column,
  ColumnStats,
  ColumnStatsNumeric,
  ColumnStatsTemporal,
  DataType,
  DataTypeCategory,
  ComplexKind,
} from "./data/types";

export {
  isIntegerType,
  isFloatType,
  isNumericType,
  isDateType,
  isTimeType,
  isTimestampType,
  isTemporalType,
  isBooleanType,
  isStringType,
  isBinaryType,
  isComplexType,
  getComplexKind,
  dataTypeCategory,
  normalizeDuckDBType,
} from "./data/types";

// ─── App surface ──────────────────────────────────────────────────────
//
// Top-level components that compose the standalone Bedevere app. These
// assume the app's module-level singletons (CommandRegistry, KeymapService,
// PersistenceService, EnvironmentService) and are NOT a clean embedding
// boundary. Exported for completeness; prefer the embedding surface above.

export { BedevereApp } from "./components/BedevereApp/BedevereApp";
export { TabManager } from "./components/TabManager/TabManager";
export { ControlPanel } from "./components/ControlPanel/ControlPanel";
export { StatusBar } from "./components/StatusBar/StatusBar";
export { CommandBar } from "./components/CommandBar/CommandBar";

export type { BedevereAppOptions } from "./components/BedevereApp/BedevereApp";
export type { StatusBarItem } from "./components/StatusBar/StatusBar";
export type { Command } from "./data/CommandRegistry";
export type { CommandBarOptions, CellInfo } from "./components/CommandBar/CommandBar";

// Styles
import "./styles/main.scss";
