/**
 * Wire types for the Bedevere Backend Protocol (v1.0).
 *
 * The IPC sidecar — bedevere-desktop's C++ shell today; other host
 * processes (pip-installable python kernel, R session, remote relay)
 * tomorrow — speaks JSON over text frames and Arrow IPC streaming
 * over binary frames on a single localhost WebSocket connection.
 * This file is the canonical TypeScript source of truth for what
 * travels on that wire.
 *
 * Companion document: ../../../docs/backend-protocol.md (moved from
 * bedevere-desktop/docs/ipc-protocol.md in v0.13 when the protocol
 * was generalized away from being "desktop's IPC" into "Bedevere's
 * universal backend protocol").
 *
 * Hierarchy:
 *   - Section 1: Frame envelopes  (RpcRequest / RpcResponse / JsonEvent / BinaryHeader)
 *   - Section 2: Method catalog   (per-method Params / Result aliases)
 *   - Section 3: Wire data types  (Wire-prefixed mirrors of bedevere-wise/types.ts)
 *   - Section 4: Plugin types     (mirror shell/plugins/manifest.h)
 *   - Section 5: License types    (mirror shell/licensing/license_store.h)
 *   - Section 6: Error registry
 *
 * Notes:
 *   - "Wire" types use JSON-serializable shapes (Map → [key, value][], etc.).
 *     Translation to the runtime shapes consumed by bedevere-wise/ui happens
 *     in the IpcDataProvider boundary.
 *   - This file is import-only. It does not register any side effects.
 */

import type { Table } from "apache-arrow";

// ============================================================================
// Section 1 — Frame envelopes
// ============================================================================

/** Protocol version reported by `getProtocolVersion()`. Bump on breaking changes. */
export const IPC_PROTOCOL_VERSION = "1.0" as const;
export type IpcProtocolVersion = typeof IPC_PROTOCOL_VERSION;

/**
 * A JSON request frame from renderer → host.
 *
 * `id` is any non-empty string the renderer chooses (a uuid in practice).
 * `method` is one of the literal strings in {@link IpcMethod}.
 * `params` is method-specific; see Section 2.
 */
export interface RpcRequest<M extends IpcMethod = IpcMethod> {
  id: string;
  method: M;
  params?: MethodParams<M>;
}

/** Discriminated union: `ok: true` carries `result`, `ok: false` carries `error`. */
export type RpcResponse<T> = RpcResponseSuccess<T> | RpcResponseError;

export interface RpcResponseSuccess<T> {
  id: string;
  ok: true;
  result: T;
}

export interface RpcResponseError {
  id: string;
  ok: false;
  error: {
    code: IpcErrorCode;
    message: string;
  };
}

/**
 * Unsolicited server → client text frame. v0 only emits {@link StreamEndEvent};
 * future events extend the discriminated union via the `event` tag.
 */
export type JsonEvent = StreamEndEvent;

/**
 * Sent by the host to signal that a binary stream has ended.
 *
 *  - `ok: true`  — every chunk has been delivered; the renderer can hand the
 *                  accumulated bytes to `tableFromIPC` / `RecordBatchStreamReader`.
 *  - `ok: false` — the host aborted mid-stream (e.g. DuckDB threw). The
 *                  renderer MUST discard any partial chunks buffered for
 *                  this `streamId` and surface `error` to the awaiting RPC.
 */
export interface StreamEndEvent {
  event: "streamEnd";
  streamId: number;
  ok: boolean;
  error?: {
    code: IpcErrorCode;
    message: string;
  };
}

/**
 * Decoded view of the 8-byte little-endian header that prefixes every Arrow
 * binary frame. The header is followed by raw Arrow IPC streaming bytes.
 *
 * Byte layout:
 *   bytes 0..3 — u32 LE  streamId    (server-allocated, monotonic, starts at 1; 0 is reserved)
 *   bytes 4..7 — u32 LE  chunkIndex  (0-based; renderer may use for reorder buffering)
 */
export interface BinaryHeader {
  streamId: number;
  chunkIndex: number;
}

/** Width of the binary-frame header in bytes (see {@link BinaryHeader}). */
export const ARROW_HEADER_BYTES = 8 as const;
/** Reserved sentinel — valid stream ids start at 1 on the host side. */
export const RESERVED_STREAM_ID = 0 as const;

// ============================================================================
// Section 2 — Method catalog
// ============================================================================

/** Every RPC method name the host accepts in v1.0. */
export type IpcMethod =
  // Data
  | "getMetadata"
  | "fetchData"
  | "fetchDataColumnRange"
  | "getColumnStats"
  | "getColumnStatsFiltered"
  | "searchColumnValues"
  // DataProvider mutators (server-side state)
  | "setName"
  | "setDescription"
  | "setLabel"
  // Session
  | "registerFile"
  | "executeQuery"
  | "listTables"
  | "visualize"
  // Persistence (kv snapshot — see IpcFilesystemPersistence)
  | "loadPersistence"
  | "savePersistence"
  // Plugins
  | "getPluginCatalog"
  | "loadPlugin"
  | "unloadPlugin"
  // Licensing
  | "listLicenses"
  | "addLicense"
  | "removeLicense"
  // Meta
  | "getProtocolVersion";

// ----- Data methods ---------------------------------------------------------

export interface GetMetadataParams {
  table: string;
}
export type GetMetadataResult = WireDatasetMetadata;

export interface FetchDataParams {
  table: string;
  /** 0-based, inclusive. */
  start: number;
  /** Exclusive upper bound. */
  end: number;
}
export interface FetchDataResult {
  streamId: number;
  totalRows: number;
}

export interface FetchDataColumnRangeParams {
  table: string;
  start: number;
  end: number;
  startCol: number;
  endCol: number;
}
export type FetchDataColumnRangeResult = FetchDataResult;

export interface GetColumnStatsParams {
  table: string;
  column: string;
}
export type GetColumnStatsResult = WireColumnStats | null;

export interface GetColumnStatsFilteredParams {
  table: string;
  column: string;
  /**
   * Filter IR applied before stats are computed. v0 mirrors bedevere-wise's
   * {@link WireColumnFilter}; see docs/backend-protocol.md §6 for the IR.
   */
  filter?: WireColumnFilter[];
}
export type GetColumnStatsFilteredResult = WireColumnStats | null;

export interface SearchColumnValuesParams {
  table: string;
  column: string;
  query: string;
  mode: "substring" | "regex";
  limit: number;
}
export type SearchColumnValuesResult = Array<{ value: string; count: number }>;

// ----- DataProvider mutators ------------------------------------------------

export interface SetNameParams {
  table: string;
  name: string;
}
export interface SetDescriptionParams {
  table: string;
  description: string;
}
export interface SetLabelParams {
  table: string;
  label: string;
}
/** All mutators return an empty success ack. */
export type SetMutatorResult = Record<string, never>;

// ----- Session methods ------------------------------------------------------

export interface RegisterFileParams {
  path: string;
  tableName: string;
}
export interface RegisterFileResult {
  tableName: string;
  totalRows: number;
  totalColumns: number;
}

export interface ExecuteQueryParams {
  sql: string;
}
/**
 * `executeQuery` distinguishes row-returning SQL (SELECT, WITH ... SELECT)
 * from DDL/DML by the presence of `streamId`. Rows ship over the binary
 * channel; non-row statements report `affectedRows`.
 */
export interface ExecuteQueryResult {
  streamId?: number;
  totalRows?: number;
  affectedRows?: number;
}

export type ListTablesParams = Record<string, never>;
export type ListTablesResult = Array<{
  name: string;
  totalRows: number;
  totalColumns: number;
}>;

export interface VisualizeParams {
  sql: string;
}
/**
 * Server-pre-executed chart result. The host runs `VISUALIZE … DRAW`
 * through stats_duck → gets back `(spec, layer_sqls)` → executes each
 * layer SQL → returns the spec + a dict of layer-name → row arrays.
 *
 * Shape mirrors `runVisualize`'s `VisualizeResult` so a renderer can pass
 * the result directly to `ChartVisualizer.setSpec(spec, datasets)`. Saves
 * one IPC round-trip per layer compared to returning layer SQLs and
 * re-querying.
 */
export interface VisualizeResult {
  spec: unknown;
  datasets: Record<string, unknown[]>;
}

// ----- Persistence methods --------------------------------------------------

export type LoadPersistenceParams = Record<string, never>;
/**
 * Full snapshot of the kv store, as written by {@link SavePersistenceParams}.
 * Keys are the same Bedevere-namespaced strings the web app writes to
 * localStorage (`bedevere_settings`, `bedevere_environments`, …); values
 * are their JSON-stringified payloads.
 */
export interface LoadPersistenceResult {
  data: Record<string, string>;
}

export interface SavePersistenceParams {
  data: Record<string, string>;
}
export type SavePersistenceResult = Record<string, never>;

// ----- Plugin methods -------------------------------------------------------

export type GetPluginCatalogParams = Record<string, never>;
export type GetPluginCatalogResult = WirePluginRuntimeView[];

export interface LoadPluginParams {
  name: string;
}
export interface LoadPluginResult {
  name: string;
  status: WirePluginStatus;
}

export interface UnloadPluginParams {
  name: string;
}
export type UnloadPluginResult = LoadPluginResult;

// ----- License methods ------------------------------------------------------

export type ListLicensesParams = Record<string, never>;
export type ListLicensesResult = WireLicense[];

export interface AddLicenseParams {
  /** Full signed JSON token as the user pasted it. */
  token: string;
}
export interface AddLicenseResult {
  licenseId: string;
  extensions: string[];
}

export interface RemoveLicenseParams {
  licenseId: string;
}
export interface RemoveLicenseResult {
  removed: boolean;
}

// ----- Meta -----------------------------------------------------------------

export type GetProtocolVersionParams = Record<string, never>;
export interface GetProtocolVersionResult {
  version: IpcProtocolVersion;
}

// ----- Method registry (Params / Result lookup) -----------------------------

/**
 * Mapping from method name → `{ params, result }`. Used by helpers that
 * need to look up the shape of a method by its name string.
 */
export interface IpcMethodMap {
  getMetadata: { params: GetMetadataParams; result: GetMetadataResult };
  fetchData: { params: FetchDataParams; result: FetchDataResult };
  fetchDataColumnRange: {
    params: FetchDataColumnRangeParams;
    result: FetchDataColumnRangeResult;
  };
  getColumnStats: { params: GetColumnStatsParams; result: GetColumnStatsResult };
  getColumnStatsFiltered: {
    params: GetColumnStatsFilteredParams;
    result: GetColumnStatsFilteredResult;
  };
  searchColumnValues: {
    params: SearchColumnValuesParams;
    result: SearchColumnValuesResult;
  };
  setName: { params: SetNameParams; result: SetMutatorResult };
  setDescription: { params: SetDescriptionParams; result: SetMutatorResult };
  setLabel: { params: SetLabelParams; result: SetMutatorResult };
  registerFile: { params: RegisterFileParams; result: RegisterFileResult };
  executeQuery: { params: ExecuteQueryParams; result: ExecuteQueryResult };
  listTables: { params: ListTablesParams; result: ListTablesResult };
  visualize: { params: VisualizeParams; result: VisualizeResult };
  loadPersistence: { params: LoadPersistenceParams; result: LoadPersistenceResult };
  savePersistence: { params: SavePersistenceParams; result: SavePersistenceResult };
  getPluginCatalog: {
    params: GetPluginCatalogParams;
    result: GetPluginCatalogResult;
  };
  loadPlugin: { params: LoadPluginParams; result: LoadPluginResult };
  unloadPlugin: { params: UnloadPluginParams; result: UnloadPluginResult };
  listLicenses: { params: ListLicensesParams; result: ListLicensesResult };
  addLicense: { params: AddLicenseParams; result: AddLicenseResult };
  removeLicense: { params: RemoveLicenseParams; result: RemoveLicenseResult };
  getProtocolVersion: {
    params: GetProtocolVersionParams;
    result: GetProtocolVersionResult;
  };
}

export type MethodParams<M extends IpcMethod> = IpcMethodMap[M]["params"];
export type MethodResult<M extends IpcMethod> = IpcMethodMap[M]["result"];

// ============================================================================
// Section 3 — Wire data types (mirror src/data/types.ts)
// ============================================================================

/**
 * Canonical column type strings. Mirrors {@link DataType} in
 * src/data/types.ts.
 */
export type WireDataType =
  // Boolean
  | "BOOLEAN"
  // Signed integers
  | "TINYINT"
  | "SMALLINT"
  | "INTEGER"
  | "BIGINT"
  | "HUGEINT"
  // Unsigned integers
  | "UTINYINT"
  | "USMALLINT"
  | "UINTEGER"
  | "UBIGINT"
  | "UHUGEINT"
  // Floating-point / decimal
  | "FLOAT"
  | "DOUBLE"
  | "DECIMAL"
  // Temporal
  | "DATE"
  | "TIME"
  | "TIME_TZ"
  | "TIMESTAMP"
  | "TIMESTAMP_TZ"
  | "TIMESTAMP_NS"
  | "TIMESTAMP_MS"
  | "TIMESTAMP_S"
  | "INTERVAL"
  // Textual
  | "VARCHAR"
  // Binary / special
  | "BLOB"
  | "BIT"
  | "UUID"
  | "JSON"
  | "ENUM"
  // Complex
  | "LIST"
  | "STRUCT"
  | "MAP"
  | "UNION"
  // Fallback
  | "UNKNOWN";

export interface WireColumn {
  name: string;
  key: string | null;
  extra: string | null;
  default: string | null;
  label?: string;
  dataType: WireDataType;
  rawType?: string;
  length?: number;
  hasNulls?: boolean;
  /**
   * `format` may be either a printf-ish format string or an
   * `Intl.NumberFormatOptions` literal — both are JSON-safe.
   */
  format?: string | Record<string, unknown>;
}

export interface WireDatasetMetadata {
  name: string;
  alias?: string;
  fileName?: string;
  description?: string;
  label?: string;
  totalRows: number;
  totalColumns: number;
  columns: WireColumn[];
}

export interface WireColumnStatsNumeric {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
}

/**
 * Temporal min/max as raw values (BigInt is serialized as JSON number for
 * v0; values outside the safe-integer range need string encoding — see
 * `OPEN_QUESTION` block in docs/backend-protocol.md §6).
 */
export interface WireColumnStatsTemporal {
  min: number;
  max: number;
}

/**
 * On-wire counterpart of {@link ColumnStats}. Map fields are serialized as
 * `[key, value][]`; pass through `new Map(arr)` at the renderer boundary.
 */
export interface WireColumnStats {
  isCategorical: boolean;
  totalCount: number;
  nullCount: number;
  distinctCount: number;
  /** `[displayKey, count][]`. Pass through `new Map(...)` to rehydrate. */
  valueCounts: Array<[string, number]>;
  /** `[displayKey, rawValue][]` for temporal / numeric columns. Optional. */
  valueCountsRaw?: Array<[string, unknown]>;
  numericStats: WireColumnStatsNumeric | null;
  temporalStats?: WireColumnStatsTemporal | null;
  histogramEdges?: number[];
}

/**
 * Wire-compatible filter IR. Mirrors `ColumnFilter` in
 * src/data/ColumnFilterManager.ts as of v0; the field set is stable but
 * the IR's evolution is owned by bedevere-wise. The host must accept (and
 * may safely ignore) unknown forward-compatible fields.
 */
export interface WireColumnFilter {
  columnName: string;
  dataType?: WireDataType;
  filterType: "include" | "exclude" | "range";
  values?: string[];
  min?: number;
  max?: number;
  /** ISO-8601 strings for temporal range filters. */
  minStr?: string;
  maxStr?: string;
}

// ============================================================================
// Section 4 — Plugin types (mirror shell/plugins/manifest.h)
// ============================================================================

export interface WirePluginManifest {
  name: string;
  displayName: string;
  version: string;
  description: string;
  licenseRequired: boolean;
  dependsOn: string[];
  vendor?: string;
  homepage?: string;
}

/** Lower-camel string union mirroring `bedevere::plugins::PluginStatus`. */
export type WirePluginStatus =
  | "available"
  | "unlicensed"
  | "licensed"
  | "loaded"
  | "error";

export interface WirePluginRuntimeView {
  manifest: WirePluginManifest;
  status: WirePluginStatus;
  /** Populated when `status === "error"`. */
  errorMessage?: string;
}

// ============================================================================
// Section 5 — License types (mirror shell/licensing/license_store.h + token)
// ============================================================================

/**
 * Renderer-facing license summary as returned by `listLicenses`. The raw
 * signed token is NOT included; the host holds it for round-trip persistence.
 */
export interface WireLicense {
  licenseId: string;
  extensions: string[];
  issuedTo: string;
  /** Unix timestamp (seconds). */
  issuedAt: number;
  /** Unix timestamp (seconds), or `null` for perpetual licenses. */
  expiresAt: number | null;
  versionConstraint?: string | null;
}

/**
 * The full signed JSON token as documented in
 * bedevere-desktop/PROJECT_PLAN.md §2.6. The renderer never constructs
 * one; it only forwards the verbatim string the user pasted into the
 * License panel to `addLicense`.
 */
export interface WireLicenseToken {
  license_id: string;
  extensions: string[];
  issued_to: string;
  issued_at: number;
  expires_at: number | null;
  version_constraint?: string | null;
  /** `ed25519:<base64>` over the canonical JSON of the token sans `signature`. */
  signature: string;
}

// ============================================================================
// Section 6 — Error registry
// ============================================================================

/**
 * Canonical `error.code` values the host may emit. Renderers SHOULD branch
 * on `code` rather than parsing `message`. Unknown codes MUST be treated as
 * generic failures rather than rejected — the registry is open-ended within
 * a minor version.
 */
export type IpcErrorCode =
  /** Auth handshake failed (bad token / missing query param). */
  | "UNAUTHORIZED"
  /** Method name not recognised. */
  | "UNKNOWN_METHOD"
  /** `params` failed shape / type validation. */
  | "INVALID_PARAMS"
  /** Requested table / column / streamId / licenseId does not exist. */
  | "NOT_FOUND"
  /** DuckDB threw — `message` carries DuckDB's text. */
  | "DUCKDB_ERROR"
  /** SQL parse or planning failure (subset of DUCKDB_ERROR). */
  | "SQL_ERROR"
  /** A licensed extension was requested without entitlement. */
  | "UNLICENSED"
  /** Ed25519 signature did not verify against the baked-in public key. */
  | "INVALID_SIGNATURE"
  /** Token's `expires_at` is in the past. */
  | "EXPIRED"
  /** License with the same `license_id` is already installed. */
  | "DUPLICATE"
  /** Token JSON could not be parsed or required fields are missing. */
  | "MALFORMED_TOKEN"
  /** Internal host error not attributable to user input. */
  | "INTERNAL";

// ============================================================================
// Re-exports for callers that import the Arrow Table type alongside wire shapes
// ============================================================================

export type { Table };
