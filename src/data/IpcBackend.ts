/**
 * IpcBackend — a Backend that delegates every method to a host process
 * over the WebSocket sidecar.
 *
 * The Backend interface (src/data/Backend.ts) defines what the UI calls
 * into. IpcBackend implements every method by routing to the matching
 * `Bridge.call("…")` RPC, decoding wire shapes back to runtime types at
 * the boundary.
 *
 * Capability flags are populated at construction time from the options
 * (the desktop renderer flips `visualize` on after the host confirms
 * stats_duck loaded; other backends fill in what they have). The UI
 * checks `backend.capabilities.*` before exposing the affordance, so a
 * host that can't serve a feature doesn't trip a NOT_IMPLEMENTED error
 * at runtime.
 *
 * Method-name parity with {@link DuckDBService} is intentional —
 * the call sites are the same; only the implementation type changes.
 */

import type { Backend, BackendCapabilities, BackendVisualizeResult, ExportResult, ExportTableOptions, FunctionInfo } from "./Backend";
import type { DataProvider } from "./types";
import type { Bridge } from "./ipc/bridge";
import { IpcDataProvider } from "./ipc/IpcDataProvider";

export interface IpcBackendOptions {
  /**
   * Connected bridge to the host process. The caller owns
   * {@link Bridge.connect} — IpcBackend just uses it.
   */
  bridge: Bridge;
  /**
   * Capability flags the host advertises. Defaults are conservative
   * (everything off except what's needed for the basic spreadsheet view).
   * The desktop shell flips `visualize` / `sas` / `spss` / `stata` on
   * after the corresponding native libraries load.
   */
  capabilities?: Partial<BackendCapabilities>;
  /**
   * Identifier shown in diagnostics. Defaults to `"ipc"`; multi-host
   * setups (a remote relay alongside a local desktop, etc.) can pass a
   * more specific id.
   */
  id?: string;
  /**
   * Display name shown in the About tab + status bar. Defaults to
   * `"Native DuckDB (IPC)"`.
   */
  displayName?: string;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  // The IPC channel carries Arrow IPC over its binary frames — the host
  // streams `fetchData` results that way already.
  arrow: true,
  // Off by default; the desktop shell flips this on after stats_duck loads.
  visualize: false,
  // The host accepts text/buffer payloads via `registerFile` (path-based
  // today; the in-memory variants stream the bytes through the binary
  // channel — host-side support is host-dependent).
  registerFileText: true,
  registerFileBuffer: true,
  wipeUserState: false,
  dropByName: false,
  sas: false,
  spss: false,
  stata: false,
};

export class IpcBackend implements Backend {
  public readonly id: string;
  public readonly displayName: string;
  public readonly capabilities: BackendCapabilities;

  private readonly bridge: Bridge;
  private ready = false;

  constructor(opts: IpcBackendOptions) {
    this.bridge = opts.bridge;
    this.id = opts.id ?? "ipc";
    this.displayName = opts.displayName ?? "Native DuckDB (IPC)";
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(opts.capabilities ?? {}) };
  }

  // ─── lifecycle ──────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.ready) return;
    if (!this.bridge.isConnected()) {
      // Caller forgot to connect; surface a clear error rather than
      // sending RPCs into the void.
      throw new Error("IpcBackend.initialize: bridge is not connected — call bridge.connect() first");
    }
    // Round-trip the version probe so we catch mismatched hosts up
    // front instead of on the first user-triggered query.
    await this.bridge.call("getProtocolVersion", {});
    // Detect stats_duck host-side so VISUALIZE + stat-format export
    // (xpt/sav/por/sas7bdat) light up. The protocol has no capability
    // handshake yet, so probe the function catalog directly — the host
    // loads stats_duck at startup, before it accepts connections. A
    // caller that already pinned `visualize` via options is respected;
    // a probe failure just leaves the flag as-is.
    if (!this.capabilities.visualize) {
      try {
        const rows = await this.executeQuery(
          "SELECT count(*) AS n FROM duckdb_functions() WHERE function_name LIKE 'ggsql_mark_v1_%'",
        );
        const n = Number((rows?.[0] as { n?: unknown })?.n ?? 0);
        if (n > 0) this.capabilities.visualize = true;
      } catch {
        // Older host without duckdb_functions() access — leave visualize off.
      }
    }
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready && this.bridge.isConnected();
  }

  async cleanup(): Promise<void> {
    this.ready = false;
    this.bridge.close();
  }

  // ─── query path ─────────────────────────────────────────────────────

  async executeQuery(sql: string): Promise<any[]> {
    const result = await this.bridge.call("executeQuery", { sql });
    // The host replies streamId: null (not absent) for non-row-returning
    // statements (DDL/DML) — a strict undefined check would fall through
    // and await a stream that never starts. The UI mostly ignores the
    // return value but a few callers check `.length`, so hand back an
    // empty array.
    if (result.streamId == null) {
      return [];
    }
    const table = await this.bridge.awaitArrowStream(result.streamId);
    // Match DuckDBService.executeQuery's shape: an array of Arrow row
    // proxies whose named-field access (`row.column_name`) the call
    // sites rely on. Positional arrays live in IpcDataProvider only —
    // that's what the spreadsheet consumes.
    return table.toArray();
  }

  async executeQueryWithSchema(sql: string): Promise<{
    rows: any[];
    decimalScales: Record<string, number>;
  }> {
    const result = await this.bridge.call("executeQuery", { sql });
    if (result.streamId == null) {
      return { rows: [], decimalScales: {} };
    }
    const table = await this.bridge.awaitArrowStream(result.streamId);
    const rows = table.toArray();
    // Lift per-column DECIMAL scales off the Arrow schema. Used by
    // runVisualize to scale Decimal values back to plain numbers. Other
    // column types contribute nothing to this map.
    const decimalScales: Record<string, number> = {};
    for (const field of table.schema.fields) {
      const t: any = field.type;
      if (t && typeof t === "object" && typeof t.scale === "number") {
        decimalScales[field.name] = t.scale;
      }
    }
    return { rows, decimalScales };
  }

  async executeQueryAsDataProvider(
    sql: string,
    resultName?: string | null,
  ): Promise<DataProvider> {
    // `CREATE OR REPLACE TABLE <resultName> AS (<sql>)` materializes the
    // result table on the host; we then wrap it as an IpcDataProvider.
    // Matches DuckDBService.executeQueryAsDataProvider so call sites
    // don't have to know which backend they're on.
    const name = resultName ?? `result_${Date.now().toString(36)}`;
    await this.bridge.call("executeQuery", {
      sql: `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS (${sql})`,
    });
    return new IpcDataProvider(this.bridge, name, "");
  }

  getDataProvider(tableName: string, fileName?: string): DataProvider {
    return new IpcDataProvider(this.bridge, tableName, fileName ?? "");
  }

  // ─── schema introspection ───────────────────────────────────────────

  async listTables(): Promise<string[]> {
    const tables = await this.bridge.call("listTables", {});
    return tables.map((t) => t.name);
  }

  async getTableInfo(tableName: string): Promise<any[]> {
    // Mirror DuckDB's `DESCRIBE` shape. The host could expose a
    // dedicated RPC for this later; for now we round-trip a DESCRIBE
    // through executeQuery, which keeps the wire protocol smaller.
    return this.executeQuery(`DESCRIBE ${quoteIdent(tableName)}`);
  }

  async listFunctions(): Promise<FunctionInfo[]> {
    const rows = await this.executeQuery(
      "SELECT DISTINCT function_name AS name, function_type AS type FROM duckdb_functions()",
    );
    // Arrow row proxies expose the aliased names; stay permissive about
    // the un-aliased fallbacks for older hosts.
    return rows
      .map((row: any) => {
        const name = (row.name ?? row.function_name ?? "") as string;
        const type = (row.type ?? row.function_type ?? "scalar") as FunctionInfo["type"];
        return { name, type };
      })
      .filter((info) => info.name.length > 0);
  }

  // ─── ingest path ────────────────────────────────────────────────────

  async registerFileURL(name: string, url: string): Promise<void> {
    // The host's `registerFile` takes a path. For URL ingestion the
    // host needs to fetch + cache the bytes itself; today we route URLs
    // through the path channel verbatim (the host treats `http://…` as
    // a remote source it knows how to read). Adjust once a real
    // URL-fetch RPC exists on the wire.
    await this.bridge.call("registerFile", { path: url, tableName: name });
  }

  async registerFileText(name: string, text: string): Promise<string> {
    if (text.length > MAX_UPLOAD_BYTES) {
      throw new Error(uploadTooLargeMessage(name, text.length));
    }
    const { path } = await this.bridge.call("registerFileText", { name, text });
    return path;
  }

  async registerFileBuffer(name: string, buffer: Uint8Array): Promise<string> {
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(uploadTooLargeMessage(name, buffer.byteLength));
    }
    const { path } = await this.bridge.call("registerFileBuffer", {
      name,
      contentBase64: bytesToBase64(buffer),
    });
    return path;
  }

  // ─── charts ─────────────────────────────────────────────────────────

  async visualize(sql: string): Promise<BackendVisualizeResult> {
    // The host runs the VISUALIZE statement, peels the spec + layer_sqls
    // MAP server-side, executes each layer SQL, and replies with plain
    // JSON — no Arrow round-trip, no MAP-over-the-wire concerns.
    const result = await this.bridge.call("visualize", { sql });
    return { spec: result.spec, datasets: result.datasets ?? {} };
  }

  // ─── export path ────────────────────────────────────────────────────

  async exportTable(opts: ExportTableOptions): Promise<ExportResult> {
    // The host pops a native Save dialog and runs the COPY itself; the
    // bytes stay on the host. We get back either a path or a cancel.
    const res = await this.bridge.call("exportTable", {
      table: opts.table,
      format: opts.format,
      filenameHint: opts.filenameHint,
    });
    if (res.cancelled || !res.exported || !res.path) {
      return { kind: "cancelled" };
    }
    return { kind: "saved", path: res.path, rows: res.rowsExported };
  }
}

// In-memory uploads travel inside a JSON frame (text verbatim, buffers
// base64). websocketpp's inbound frame cap is 32 MB, so refuse anything
// that would blow past it after encoding overhead and point the user at
// the by-path flow instead.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function uploadTooLargeMessage(name: string, size: number): string {
  const mb = (size / (1024 * 1024)).toFixed(1);
  return (
    `${name} is ${mb} MB — too large to ship to the engine process over the wire ` +
    `(limit ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB). Use 'Open Folder' to pick it via ` +
    `the OS dialog — the host opens it by path, no size limit.`
  );
}

/** Uint8Array → base64, chunked so large buffers don't overflow the arg list. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Local DuckDB identifier quoter — mirrors sqlIdent.quoteIdent. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
