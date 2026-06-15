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
 *   } from "@kolistat/bedevere-wise/ui";
 *   import "@kolistat/bedevere-wise/style.css";
 */

// UI components.
export { SpreadsheetVisualizer } from "./components/SpreadsheetVisualizer/SpreadsheetVisualizer";
export { ColumnStatsVisualizer } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizer";
export { ColumnStatsVisualizerFocusable } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizerFocusable";
export type { SpreadsheetOptions } from "./components/SpreadsheetVisualizer/types";

export { ChartVisualizer } from "./components/ChartVisualizer/ChartVisualizer";

// stats_duck VISUALIZE pipeline. Decoupled from DuckDB-WASM — takes any
// Backend so downstream consumers (bedevere-desktop's native renderer,
// any host process running an IpcBackend) can drive the same pipeline
// against their own engine. `SqlExecutor` stays exported as a deprecated
// structural alias for `Pick<Backend, "executeQuery" | "executeQueryWithSchema">`.
export { runVisualize } from "./data/visualize";
export type { SqlExecutor, VisualizeResult } from "./data/visualize";
export type {
  Backend,
  BackendCapabilities,
  BackendVisualizeResult,
  ExportTableOptions,
  ExportResult,
  FunctionInfo,
  FunctionKind,
  WipeUserStateSummary,
  DropKind,
} from "./data/Backend";

// File-export format catalog. `ExportFormat` is referenced by
// `Backend.exportTable`, so it must be nameable by anyone implementing
// or calling the interface; the const map + helper let consumers build
// their own export menu off the same metadata the `.export` command uses.
export type { ExportFormat, ExportFormatMeta } from "./data/exportFormats";
export { EXPORT_FORMATS, EXPORT_FORMAT_ORDER, isExportFormat } from "./data/exportFormats";

// PersistenceBackend — the kv substrate PersistenceService writes into.
// Hosts that want to persist user state outside localStorage (the desktop
// shell, server-synced accounts) implement this and call
// `persistenceService.setBackend(...)` before BedevereApp constructs.
export type { PersistenceBackend } from "./data/persistence/PersistenceBackend";
export { LocalStoragePersistenceBackend } from "./data/persistence/LocalStoragePersistenceBackend";

// FileSource — host-agnostic file/folder picker + reader. FsaFileSource
// is the web default (File System Access API); hosts that own a
// native picker (the desktop's IpcFileSource) substitute it before
// the file panel constructs.
export type { FileSource, FileSourceFolder, FileSourceFile } from "./data/files/FileSource";
export { FsaFileSource } from "./data/files/FsaFileSource";

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
