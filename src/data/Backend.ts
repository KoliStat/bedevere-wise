/**
 * Backend interface — the contract for any SQL engine Bedevere talks to.
 *
 * The same Bedevere UI works against multiple Backend implementations:
 *
 *   - DuckDBService — DuckDB-WASM in the browser (the default, ships
 *     with the web app at bedeverewise.app and any consumer importing
 *     `@caerbannogwhite/bedevere-wise` and constructing BedevereApp
 *     without specifying a backend).
 *   - IpcBackend — talks to a native DuckDB sitting in a separate
 *     process over a localhost WebSocket. Used by bedevere-desktop
 *     (C++ shell) and any future host process — `pip install
 *     bedevere-py`, `install.packages("bedeverer")`, a remote DuckDB
 *     fronted by a relay.
 *   - MockBackend (test only) — short-circuits queries with canned
 *     results for component tests.
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

export interface Backend {
  /**
   * Stable identifier for the backend kind. Used for diagnostics +
   * conditional behavior on the caller side ("only flip on the Arrow-
   * streamy path when backend.id === 'ipc'"). Should be a short
   * lowercase token: `"duckdb-wasm"`, `"ipc"`, `"mock"`, etc.
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
   */
  registerFileURL(name: string, url: string): Promise<void>;

  /**
   * Register an in-memory text blob as a virtual file. Backends that
   * truly can't accept in-memory data (e.g. a remote read-only connection)
   * should throw a NOT_SUPPORTED-style error. The `capabilities.registerFileText`
   * flag lets the UI hide affordances that would trigger that error.
   */
  registerFileText(name: string, text: string): Promise<void>;

  /**
   * Register an in-memory byte buffer as a virtual file. See
   * `registerFileText` for the throw-on-unsupported convention.
   */
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void>;

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
