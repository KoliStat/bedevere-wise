import * as duckdb from "@duckdb/duckdb-wasm";
import mvpWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import coiWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.worker.js?url";
import coiPthreadWorkerUrl from "@duckdb/duckdb-wasm/dist/duckdb-browser-coi.pthread.worker.js?url";
import { DuckDBDataProvider } from "./DuckDBDataProvider";
import { quoteIdent } from "./sqlIdent";

/**
 * Best-effort lift of a DECIMAL scale from an Apache Arrow schema field's
 * type. Different builds of duckdb-wasm / apache-arrow expose the scale
 * differently; covers the two we've seen in the wild plus a defensive
 * `toString()` parse for anything else.
 */
function inferDecimalScale(t: any): number | undefined {
  if (!t || typeof t !== "object") return undefined;
  if (typeof t.scale === "number") return t.scale;
  // Some builds nest decimal config under `precision`/`scale` on a `data`
  // sub-object, others stringify as `Decimal128<10, 2>` or `Decimal(10,2)`.
  if (typeof t.toString === "function") {
    const s = String(t);
    const m = /Decimal\d*\s*[<(]\s*\d+\s*,\s*(\d+)/i.exec(s);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export class DuckDBService {
  private db: duckdb.AsyncDuckDB | null = null;
  private worker: Worker | null = null;
  private isInitialized = false;

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // jsDelivr for the .wasm modules — they're 35–41 MB each, which
      // exceeds Cloudflare Workers' 25 MiB per-asset cap, so we can't
      // ship them in our own bundle. The JS workers are <1 MB and
      // self-hosting them keeps the app functional when jsDelivr is
      // unreachable (DuckDB still pays a wasm fetch on first load,
      // but the worker won't fail to bootstrap).
      // getJsDelivrBundles() currently returns only `mvp` and `eh` — no
      // `coi`. Guard each entry so the override survives an upstream
      // change that adds COI, without breaking today's two-entry shape.
      const bundles = duckdb.getJsDelivrBundles();
      bundles.mvp.mainWorker = mvpWorkerUrl;
      if (bundles.eh) bundles.eh.mainWorker = ehWorkerUrl;
      if (bundles.coi) {
        bundles.coi.mainWorker = coiWorkerUrl;
        bundles.coi.pthreadWorker = coiPthreadWorkerUrl;
      }
      const bundle = await duckdb.selectBundle(bundles);

      this.worker = new Worker(bundle.mainWorker!);
      const logger = new duckdb.VoidLogger();
      this.db = new duckdb.AsyncDuckDB(logger, this.worker);

      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      await this.db.open({ allowUnsignedExtensions: true });
      this.isInitialized = true;

      if (import.meta.env.DEV) {
        console.log("DuckDB initialized successfully");
      }
    } catch (error) {
      console.error("Failed to initialize DuckDB:", error);
      throw error;
    }
  }

  public async getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
    if (!this.db || !this.isInitialized) {
      throw new Error("DuckDB not initialized. Call initialize() first.");
    }
    return await this.db.connect();
  }

  async executeQuery(query: string): Promise<any[]> {
    const connection = await this.getConnection();
    try {
      return (await connection.query(query)).toArray();
    } finally {
      await connection.close();
    }
  }

  /**
   * Run a query and return rows alongside per-column DECIMAL scales lifted
   * from the Arrow schema. DuckDB infers `DECIMAL(p,s)` for plain literals
   * like `1.0` and Arrow exports those as the raw integer (10 for `1.0`,
   * 100 for `2.5`, …); callers that hand the rows to a downstream consumer
   * (Vega-Lite, etc.) need the scale to recover the original value. For
   * non-decimal columns no entry is emitted in `decimalScales`.
   *
   * Tries `field.type.scale` first (apache-arrow's typed Decimal class) and
   * falls back to parsing the type's `toString()` form (`Decimal128<p,s>` /
   * `Decimal(p,s)`) for builds that wrap the type in an opaque object.
   */
  async executeQueryWithSchema(query: string): Promise<{
    rows: any[];
    decimalScales: Record<string, number>;
  }> {
    const connection = await this.getConnection();
    try {
      const table: any = await connection.query(query);
      const decimalScales: Record<string, number> = {};
      const fields: any[] = table?.schema?.fields ?? [];
      for (const field of fields) {
        const name = String(field?.name ?? "");
        if (!name) continue;
        const scale = inferDecimalScale(field?.type);
        if (typeof scale === "number" && scale > 0) {
          decimalScales[name] = scale;
        }
      }
      return { rows: table.toArray(), decimalScales };
    } finally {
      await connection.close();
    }
  }

  public async listTables(): Promise<string[]> {
    return (await this.executeQuery("SHOW TABLES")).map((row: any) => row.name);
  }

  public async getTableInfo(tableName: string): Promise<any[]> {
    return await this.executeQuery(`DESCRIBE ${quoteIdent(tableName)}`);
  }

  public async getColumnInfo(tableName: string, columnName: string): Promise<any> {
    const columns = await this.executeQuery(`DESCRIBE ${quoteIdent(tableName)}`);
    return columns.find((column: any) => column.column_name === columnName);
  }

  public async executeQueryAsDataProvider(query: string, resultName?: string): Promise<DuckDBDataProvider> {
    const tempName = resultName || `query_result_${Date.now()}`;
    // Strip a single trailing semicolon — wrapping it inside `( … ;)` is a
    // syntax error.
    const inner = query.replace(/;\s*$/, "");
    const connection = await this.getConnection();
    try {
      await connection.query(`CREATE OR REPLACE TABLE "${tempName}" AS (${inner})`);
    } finally {
      await connection.close();
    }
    return new DuckDBDataProvider(this, tempName, "");
  }

  public async registerFileText(name: string, text: string): Promise<void> {
    if (!this.db) throw new Error("DuckDB not initialized");
    await this.db.registerFileText(name, text);
  }

  public async registerFileBuffer(name: string, buffer: Uint8Array): Promise<void> {
    if (!this.db) throw new Error("DuckDB not initialized");
    await this.db.registerFileBuffer(name, buffer);
  }

  public isReady(): boolean {
    return this.isInitialized;
  }

  public async cleanup(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.db = null;
    this.isInitialized = false;
  }

  /**
   * Drop every user-created object in the `main` schema: views, tables,
   * macros, types, sequences. Used when switching environments so the new
   * env starts from a clean DuckDB instead of seeing the previous env's
   * tables / aliases / macros still hanging around.
   *
   * Order matters: views may reference tables, so views go first; macros
   * and types may reference each other in principle, so each phase is
   * isolated in its own try/catch so a single failure doesn't strand
   * the rest. Anything we couldn't enumerate (older DuckDB-WASM build
   * lacks `duckdb_types()` etc.) is logged as a warning, not raised.
   *
   * Returns a summary of what got dropped, for the caller to surface
   * via the status bar if it wants.
   */
  public async wipeUserState(): Promise<{
    tables: number;
    views: number;
    macros: number;
    types: number;
    sequences: number;
  }> {
    const summary = { tables: 0, views: 0, macros: 0, types: 0, sequences: 0 };
    if (!this.isInitialized) return summary;
    const conn = await this.getConnection();
    try {
      // Views first — they may select from tables we'd otherwise need to
      // CASCADE-drop. Iterating per-row with quoted identifiers keeps
      // names with spaces / unicode safe.
      try {
        const viewRows = (await conn.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'VIEW'",
        )).toArray() as Array<{ name: string }>;
        for (const v of viewRows) {
          try {
            await conn.query(`DROP VIEW IF EXISTS ${quoteIdent(String(v.name))} CASCADE`);
            summary.views += 1;
          } catch (err) {
            console.warn(`wipeUserState: failed to drop view ${v.name}:`, err);
          }
        }
      } catch (err) {
        console.warn("wipeUserState: failed to enumerate views:", err);
      }

      try {
        const tableRows = (await conn.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'",
        )).toArray() as Array<{ name: string }>;
        for (const t of tableRows) {
          try {
            await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(String(t.name))} CASCADE`);
            summary.tables += 1;
          } catch (err) {
            console.warn(`wipeUserState: failed to drop table ${t.name}:`, err);
          }
        }
      } catch (err) {
        console.warn("wipeUserState: failed to enumerate tables:", err);
      }

      // Macros — `duckdb_functions()` lists every function in the DB,
      // including the ~100 built-in macros that live in the `main`
      // schema (array_pop_front, histogram, date_add, …). Filtering on
      // schema alone catches all of them and produces a flood of
      // "Cannot drop internal catalog entry" errors. `internal = false`
      // is the correct filter for user-created macros.
      try {
        const macroRows = (await conn.query(
          "SELECT DISTINCT function_name AS name FROM duckdb_functions() WHERE schema_name = 'main' AND function_type IN ('macro', 'table_macro') AND internal = false",
        )).toArray() as Array<{ name: string }>;
        for (const m of macroRows) {
          try {
            await conn.query(`DROP MACRO IF EXISTS ${quoteIdent(String(m.name))}`);
            summary.macros += 1;
          } catch (err) {
            console.warn(`wipeUserState: failed to drop macro ${m.name}:`, err);
          }
        }
      } catch (err) {
        console.warn("wipeUserState: failed to enumerate macros:", err);
      }

      // User-defined types (ENUMs etc.). `duckdb_types()` has an
      // `internal` boolean that distinguishes user types from the
      // built-in ones. The outer try/catch tolerates older DuckDB
      // builds that lack `duckdb_types()` entirely.
      try {
        const typeRows = (await conn.query(
          "SELECT type_name AS name FROM duckdb_types() WHERE schema_name = 'main' AND internal = false",
        )).toArray() as Array<{ name: string }>;
        for (const t of typeRows) {
          try {
            await conn.query(`DROP TYPE IF EXISTS ${quoteIdent(String(t.name))}`);
            summary.types += 1;
          } catch (err) {
            console.warn(`wipeUserState: failed to drop type ${t.name}:`, err);
          }
        }
      } catch (err) {
        console.warn("wipeUserState: failed to enumerate types:", err);
      }

      // Sequences — `information_schema.sequences` doesn't exist in
      // DuckDB-WASM; use `duckdb_sequences()` and filter for non-
      // internal entries.
      try {
        const seqRows = (await conn.query(
          "SELECT sequence_name AS name FROM duckdb_sequences() WHERE schema_name = 'main' AND internal = false",
        )).toArray() as Array<{ name: string }>;
        for (const s of seqRows) {
          try {
            await conn.query(`DROP SEQUENCE IF EXISTS ${quoteIdent(String(s.name))}`);
            summary.sequences += 1;
          } catch (err) {
            console.warn(`wipeUserState: failed to drop sequence ${s.name}:`, err);
          }
        }
      } catch (err) {
        console.warn("wipeUserState: failed to enumerate sequences:", err);
      }
    } finally {
      await conn.close();
    }
    return summary;
  }

  /**
   * Drop a single user object by name. Tries each object kind in order
   * (table, view, macro, type, sequence) and returns the kind that
   * succeeded — or null if nothing with that name existed. Used by
   * the `.drop <name>` shell command; bulk wipe uses {@link wipeUserState}.
   */
  public async dropByName(name: string): Promise<"table" | "view" | "macro" | "type" | "sequence" | null> {
    if (!this.isInitialized) return null;
    const ident = quoteIdent(name);
    const conn = await this.getConnection();
    try {
      // Probe information_schema first so we know which kind to drop.
      // Avoids running blind `DROP TABLE ... CASCADE` on a view and the
      // reverse, which can spuriously remove other deps with CASCADE.
      const probe = (await conn.query(
        `SELECT table_type FROM information_schema.tables WHERE table_schema = 'main' AND table_name = '${name.replace(/'/g, "''")}'`,
      )).toArray() as Array<{ table_type: string }>;
      if (probe.length > 0) {
        const isView = String(probe[0].table_type).toUpperCase() === "VIEW";
        await conn.query(`${isView ? "DROP VIEW" : "DROP TABLE"} IF EXISTS ${ident} CASCADE`);
        return isView ? "view" : "table";
      }

      const macroProbe = (await conn.query(
        `SELECT 1 AS x FROM duckdb_functions() WHERE schema_name = 'main' AND function_type IN ('macro', 'table_macro') AND internal = false AND function_name = '${name.replace(/'/g, "''")}' LIMIT 1`,
      )).toArray();
      if (macroProbe.length > 0) {
        await conn.query(`DROP MACRO IF EXISTS ${ident}`);
        return "macro";
      }

      try {
        const typeProbe = (await conn.query(
          `SELECT 1 AS x FROM duckdb_types() WHERE schema_name = 'main' AND internal = false AND type_name = '${name.replace(/'/g, "''")}' LIMIT 1`,
        )).toArray();
        if (typeProbe.length > 0) {
          await conn.query(`DROP TYPE IF EXISTS ${ident}`);
          return "type";
        }
      } catch {
        // Older DuckDB-WASM lacks duckdb_types(); fall through.
      }

      try {
        const seqProbe = (await conn.query(
          `SELECT 1 AS x FROM duckdb_sequences() WHERE schema_name = 'main' AND internal = false AND sequence_name = '${name.replace(/'/g, "''")}' LIMIT 1`,
        )).toArray();
        if (seqProbe.length > 0) {
          await conn.query(`DROP SEQUENCE IF EXISTS ${ident}`);
          return "sequence";
        }
      } catch {
        // `duckdb_sequences()` missing on older builds — fall through.
      }

      return null;
    } finally {
      await conn.close();
    }
  }
}

// Export a singleton instance
export const duckDBService = new DuckDBService();
