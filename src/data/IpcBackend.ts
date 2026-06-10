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

import type { Backend, BackendCapabilities, FunctionInfo } from "./Backend";
import type { DataProvider } from "./types";
import type { Bridge } from "./ipc/bridge";
import { IpcDataProvider } from "./ipc/IpcDataProvider";
import { arrowTableToRowArrays } from "./ipc/arrow";

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
    if (result.streamId === undefined) {
      // Non-row-returning statement (DDL/DML); the UI mostly ignores
      // the return value but a few callers check it for `.length`, so
      // hand back an empty array rather than `undefined`.
      return [];
    }
    const table = await this.bridge.awaitArrowStream(result.streamId);
    return arrowTableToRowArrays(table);
  }

  async executeQueryWithSchema(sql: string): Promise<{
    rows: any[];
    decimalScales: Record<string, number>;
  }> {
    const result = await this.bridge.call("executeQuery", { sql });
    if (result.streamId === undefined) {
      return { rows: [], decimalScales: {} };
    }
    const table = await this.bridge.awaitArrowStream(result.streamId);
    const rows = arrowTableToRowArrays(table);
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
    // The DESCRIBE-style query above returns Arrow rows as arrays; the
    // SELECT path returns row objects. Be permissive about shape.
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

  async registerFileText(_name: string, _text: string): Promise<void> {
    throw new Error(IPC_NO_INMEMORY_INGEST);
  }

  async registerFileBuffer(_name: string, _buffer: Uint8Array): Promise<void> {
    throw new Error(IPC_NO_INMEMORY_INGEST);
  }
}

// Surfaced when a format handler tries to push browser-side bytes
// (drag-drop, browser file picker) at the host. v1.0 of the wire
// protocol has no upload channel — the host can only read files it
// can open by path. The UX answer for desktop is to use the native
// folder picker (`Open Folder` → IpcFileSource.pickFolder), which
// returns OS paths the host reads directly. The error text guides
// the user toward that path instead of leaking the wire-internal
// "not yet implemented" framing.
const IPC_NO_INMEMORY_INGEST =
  "Browser drag-drop / paste isn't supported when the engine runs in a separate process " +
  "(the wire has no upload channel). Use 'Open Folder' to pick the file via the OS dialog " +
  "— the host opens it by path.";

/** Local DuckDB identifier quoter — mirrors sqlIdent.quoteIdent. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
