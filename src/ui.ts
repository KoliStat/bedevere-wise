/**
 * UI-only entry — no DuckDB-WASM dependency.
 *
 * Mounts the spreadsheet / column-stats / chart / editor components
 * against any `DataProvider` implementation. Safe to import from
 * bundlers that don't understand Vite's `?url` syntax (the DuckDB
 * worker imports live in the `/duckdb` sub-entry).
 *
 *   import {
 *     SpreadsheetVisualizer,
 *     ColumnStatsVisualizerFocusable,
 *   } from "@caerbannogwhite/bedevere-wise/ui";
 *   import "@caerbannogwhite/bedevere-wise/style.css";
 */

// UI components.
export { SpreadsheetVisualizer } from "./components/SpreadsheetVisualizer/SpreadsheetVisualizer";
export { ColumnStatsVisualizer } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizer";
export { ColumnStatsVisualizerFocusable } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizerFocusable";
export type { SpreadsheetOptions } from "./components/SpreadsheetVisualizer/types";

export { ChartVisualizer } from "./components/ChartVisualizer/ChartVisualizer";

// stats_duck VISUALIZE pipeline. Decoupled from DuckDB-WASM (takes any
// SqlExecutor) so downstream consumers — bedevere-desktop's native
// renderer, etc. — can drive the same pipeline against their own backend.
export { runVisualize } from "./data/visualize";
export type { SqlExecutor, VisualizeResult } from "./data/visualize";

export { EmbedSqlEditor } from "./embed/EmbedSqlEditor";
export type { EmbedSqlEditorOptions } from "./embed/EmbedSqlEditor";

// Data layer — interface + types + helpers (no DuckDB dependency).
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

// Styles. UI components share the same tokyonight palette + canvas
// styling, so the CSS belongs here (not in `/duckdb`).
import "./styles/main.scss";
