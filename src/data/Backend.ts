/**
 * Backend interface — the contract for any SQL engine Bedevere talks to.
 *
 * The same Bedevere UI works against multiple Backend implementations:
 *
 *   - DuckDBService — DuckDB-WASM in the browser. The web app at
 *     bedeverewise.app injects it, as does most any consumer importing
 *     `@kolistat/bedevere-wise`; BedevereApp now requires a backend
 *     explicitly (there is no built-in default).
 *   - IpcBackend — talks to a native DuckDB sitting in a separate
 *     process over a localhost WebSocket. Used by bedevere-desktop
 *     (C++ shell); a future host (a Python or R kernel, a remote
 *     DuckDB fronted by a relay) would slot in the same way.
 *
 * Whatever engine sits behind the Backend, the contract assumes
 * DuckDB-flavored SQL plus the C Data Interface (Arrow) for results
 * that benefit from streaming. Backends that can't speak DuckDB SQL
 * are out of scope (see RELEASING.md + the design doc that birthed
 * this interface — Reading C was the chosen interpretation).
 *
 * Method-name parity with DuckDBService is intentional: most of the
 * UI was written against `duckDBService.foo(...)` directly. The
 * refactor that introduces this interface preserves call-site
 * ergonomics — every `duckDBService.foo` becomes `backend.foo` with
 * no other change.
 */

import type { DataProvider } from "./types";
import type { ExportFormat } from "./exportFormats";

export interface Backend {
  /**
   * Stable identifier for the backend kind. Used for diagnostics +
   * conditional behavior on the caller side ("only flip on the Arrow-
   * streamy path when backend.id === 'ipc'"). Should be a short
   * lowercase token: `"duckdb-wasm"`, `"ipc"`, etc.
   */
  readonly id: string;

  /**
   * Human-readable name for status-bar diagnostics + the About tab.
   */
  readonly displayName: string;

  /**
   * Capability flags. Backends that can't serve a feature flip its
   * flag to false; the UI hides the affordance rather than letting
   * the user trigger a NOT_IMPLEMENTED error.
   */
  readonly capabilities: BackendCapabilities;

  // ─── lifecycle ────────────────────────────────────────────────────

  /**
   * Initialize the underlying engine. Resolves once the backend is
   * ready to accept queries. Idempotent — repeated calls are no-ops.
   */
  initialize(): Promise<void>;

  /** Whether the backend has finished initialize() and not been cleaned up. */
  isReady(): boolean;

  /**
   * Tear down the underlying engine. Frees any resources held by the
   * backend (DuckDB-WASM worker, WebSocket connection, etc.). Callers
   * shouldn't issue queries after cleanup() resolves.
   */
  cleanup(): Promise<void>;

  // ─── query path ───────────────────────────────────────────────────

  /**
   * Run a SQL statement and return the rows as a JS array. The exact
   * shape of each row is engine-defined but conventionally each row is
   * an object whose keys are the column names. Use this for
   * one-shot queries that return small result sets — listing tables,
   * inspecting metadata, running side-effecting DDL.
   *
   * For result sets that drive a spreadsheet, prefer
   * executeQueryAsDataProvider (Arrow streaming where supported,
   * lazy fetching at the visualizer's granularity).
   */
  executeQuery(sql: string): Promise<any[]>;

  /**
   * Run a query and also surface the Arrow schema's per-column DECIMAL
   * scales. Used by the VISUALIZE pipeline to post-process Decimal cells
   * back into JS numbers — the scale lives on the Arrow schema, not in
   * the row data, so it would otherwise be lost when results land as JS
   * objects. Backends that can't surface schema metadata should return
   * `decimalScales: {}` (the post-processor skips columns it doesn't
   * find).
   */
  executeQueryWithSchema(sql: string): Promise<{
    rows: any[];
    decimalScales: Record<string, number>;
  }>;

  /**
   * Run a SELECT (or `WITH ... SELECT`) and wrap the result as a
   * DataProvider — the contract SpreadsheetVisualizer + the stats
   * panels consume. The provider materializes the result table inside
   * the backend (typically `CREATE OR REPLACE TABLE <resultName> AS
   * (<sql>)`) and points its fetchData / getColumnStats methods at it.
   *
   * `resultName` is the name the materialized table gets. Pass `null`
   * or undefined to let the backend pick (`result_<n>` convention in
   * the DuckDB backend).
   */
  executeQueryAsDataProvider(
    sql: string,
    resultName?: string | null,
  ): Promise<DataProvider>;

  /**
   * Wrap an already-existing table as a DataProvider. Used by the
   * file-import path which has already materialized the table via
   * `registerFileBuffer` + a CREATE TABLE SQL — we just need the
   * spreadsheet-facing handle for it. Synchronous because no query
   * runs; each backend constructs its own DataProvider implementation
   * (DuckDBDataProvider, IpcDataProvider, …) that knows how to fetch
   * from the engine sitting behind it.
   */
  getDataProvider(tableName: string, fileName?: string): DataProvider;

  // ─── schema introspection ─────────────────────────────────────────

  /**
   * List all user-visible tables in the current database. View names
   * are included when supported; macros / sequences / types are not.
   */
  listTables(): Promise<string[]>;

  /**
   * Describe a table's columns. Each row should have at least
   * `column_name` and `column_type` keys; additional fields (key,
   * extra, default, null) are nice-to-haves the UI uses when present.
   * Shape mirrors DuckDB's `DESCRIBE <table>` output.
   */
  getTableInfo(tableName: string): Promise<any[]>;

  /**
   * List functions available in the current backend session. Drives
   * the SqlEditor's autocomplete dropdown. Implementations should
   * return DuckDB-style names + a coarse type classification.
   */
  listFunctions(): Promise<FunctionInfo[]>;

  // ─── ingest path ──────────────────────────────────────────────────
  //
  // Backends can pick which of the three register* methods they
  // support. The UI checks the capability flag before issuing the
  // call; the optional method makes the call site typeable as
  // `if (backend.registerFileBuffer) await backend.registerFileBuffer(...)`.

  /**
   * Register a file referenced by URL. Backends MAY fetch the bytes
   * up front or defer to query time (DuckDB-WASM defers via
   * DuckDBDataProtocol.HTTP). The URL must be reachable from wherever
   * the backend lives — a desktop backend won't necessarily resolve
   * the same URLs a browser can.
   *
   * `sheet` is an optional worksheet selector for multi-sheet `.xlsx`
   * workbooks. The out-of-process host forwards it to `read_xlsx`'s
   * `sheet=` argument so the chosen sheet is imported; backends that
   * decode bytes in-process (DuckDB-WASM) read sheets through
   * registerFileBuffer + a SQL `sheet=` instead and ignore it here.
   */
  registerFileURL(name: string, url: string, sheet?: string): Promise<void>;

  /**
   * Register an in-memory text blob as a virtual file. Backends that
   * truly can't accept in-memory data (e.g. a remote read-only connection)
   * should throw a NOT_SUPPORTED-style error. The `capabilities.registerFileText`
   * flag lets the UI hide affordances that would trigger that error.
   *
   * Returns the effective name/path the caller must reference in
   * subsequent SQL (`read_csv_auto('<effective>')`). A `void` return
   * means "use the `name` you passed" — the in-process WASM backend
   * registers the blob under that virtual name. The IPC backend ships
   * the bytes to the host, which writes a real temp file and returns
   * its absolute path; the virtual name wouldn't resolve there.
   */
  registerFileText(name: string, text: string): Promise<string | void>;

  /**
   * Register an in-memory byte buffer as a virtual file. See
   * `registerFileText` for the throw-on-unsupported convention and the
   * effective-name return contract.
   */
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<string | void>;

  // ─── workspace management ─────────────────────────────────────────

  /**
   * Optional: wipe all user-created state inside the backend (tables,
   * views, macros, registered files). Used by the `.drop --all`
   * shell command + the env-switch hard reset. Backends that don't
   * own user state (e.g. a connection to a remote shared DB) shouldn't
   * implement this.
   */
  wipeUserState?(): Promise<WipeUserStateSummary>;

  /**
   * Optional: drop a named object (table, view, macro, type,
   * sequence) without the caller having to know which kind it is.
   * Returns the kind it dropped, or null if no object by that name
   * existed.
   */
  dropByName?(name: string): Promise<DropKind | null>;

  // ─── charts ───────────────────────────────────────────────────────

  /**
   * Optional: run a stats_duck `VISUALIZE … DRAW <mark>` script
   * end-to-end and return the Vega-Lite spec plus the per-layer row
   * objects. When present, `runVisualize` delegates here instead of
   * driving the statement through `executeQuery` — the IPC backend
   * implements it via the host's dedicated `visualize` RPC, which
   * extracts the spec + layer_sqls MAP server-side (the MAP column
   * doesn't round-trip the generic Arrow streaming path today).
   * Backends whose `executeQuery` returns the VISUALIZE row directly
   * (DuckDB-WASM) leave this undefined.
   */
  visualize?(sql: string): Promise<BackendVisualizeResult>;

  // ─── export path ──────────────────────────────────────────────────

  /**
   * Optional: write a whole table to a file in a binary/columnar format
   * via DuckDB `COPY <table> TO '<file>' (FORMAT …)`. Drives the
   * `.export` command's parquet / json / xpt / sav / por / sas7bdat
   * options (the stat formats require stats_duck — see
   * {@link BackendCapabilities.visualize}). The text formats
   * (csv / tsv / html / markdown) do NOT come here; they serialize the
   * spreadsheet selection client-side in ExportHub.
   *
   * The result is engine-shaped on purpose:
   *   - In-process WASM (DuckDBService) writes to its virtual FS, reads
   *     the bytes back, and returns them as `{ kind: "bytes" }` for the
   *     UI to download via a Blob.
   *   - Out-of-process hosts (IpcBackend) pop a native Save dialog and
   *     run the COPY host-side, returning `{ kind: "saved", path }` —
   *     the bytes never cross the wire — or `{ kind: "cancelled" }` if
   *     the user dismissed the dialog.
   *
   * Backends that can't write files leave this undefined; the UI hides
   * the binary-format options when `backend.exportTable` is absent.
   */
  exportTable?(opts: ExportTableOptions): Promise<ExportResult>;
}

export interface ExportTableOptions {
  /** The relation to export (a DuckDB table/view name on the engine). */
  table: string;
  format: ExportFormat;
  /**
   * Suggested base filename (no extension) — the dataset's display name.
   * Used for the web download name and the desktop Save-dialog default.
   */
  filenameHint?: string;
}

/**
 * Outcome of {@link Backend.exportTable}, discriminated by `kind`:
 *   - `"bytes"`     — the caller downloads `data` (web / in-process engine).
 *   - `"saved"`     — the engine already wrote the file at `path` (host engine).
 *   - `"cancelled"` — the user dismissed the host's Save dialog; no-op.
 */
export type ExportResult =
  | { kind: "bytes"; data: Uint8Array; filename: string; mime: string }
  | { kind: "saved"; path: string; rows?: number }
  | { kind: "cancelled" };

/**
 * Result shape of {@link Backend.visualize}: the parsed Vega-Lite spec
 * (`unknown` here — vega-embed's `VisualizationSpec` at the call site)
 * plus `layer_n` → row-object arrays matching the spec's data names.
 */
export interface BackendVisualizeResult {
  spec: unknown;
  datasets: Record<string, unknown[]>;
}

export interface BackendCapabilities {
  /**
   * The backend can stream result sets as Arrow IPC. When true, large
   * fetches use the streaming path; when false, results materialize
   * as JS arrays.
   */
  arrow: boolean;

  /**
   * stats_duck is loaded — `VISUALIZE … DRAW` works. Chart-related
   * UI affordances stay enabled when true; the dispatcher returns a
   * structured error when false.
   */
  visualize: boolean;

  /** registerFileText is implemented. */
  registerFileText: boolean;

  /** registerFileBuffer is implemented. */
  registerFileBuffer: boolean;

  /**
   * The backend implements wipeUserState — the `.drop --all` shell
   * command + env-switch cleanup is available.
   */
  wipeUserState: boolean;

  /** dropByName is implemented. */
  dropByName: boolean;

  /** SAS file formats are readable (.sas7bdat, .xpt). */
  sas: boolean;

  /** SPSS file formats are readable (.sav). */
  spss: boolean;

  /** Stata file formats are readable (.dta). */
  stata: boolean;
}

export interface FunctionInfo {
  name: string;
  type: FunctionKind;
}

export type FunctionKind =
  | "scalar"
  | "aggregate"
  | "table"
  | "pragma"
  | "macro";

export interface WipeUserStateSummary {
  tables: number;
  views: number;
  macros: number;
  types: number;
  sequences: number;
}

export type DropKind = "table" | "view" | "macro" | "type" | "sequence";
