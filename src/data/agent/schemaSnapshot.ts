import { DuckDBService } from "../DuckDBService";

/**
 * Per-column shape returned by DuckDB's `DESCRIBE`. The agent prompt only
 * needs the name + type; the rest is preserved for future expansion.
 */
export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaTable {
  name: string;
  columns: SchemaColumn[];
  rowCount?: number;
}

export interface SchemaSnapshot {
  tables: SchemaTable[];
  /** True when the stats_duck (ggsql) parser extension is loaded — the agent
   *  can then emit `VISUALIZE … DRAW <mark>` and stats functions. */
  statsDuckLoaded: boolean;
  /** ISO timestamp; useful for cache hit/miss diagnostics. */
  takenAt: string;
}

/**
 * Snapshot the current DuckDB-WASM state — table list, per-table column
 * info, and a stats_duck availability check. Used by both `SqlAutoComplete`
 * (for completion suggestions) and `AgentService` (for prompt context).
 *
 * The function is best-effort: any individual lookup that fails is logged
 * and skipped so an agent prompt can still go out with whatever schema we
 * could collect.
 */
export async function getSchemaSnapshot(duckDBService: DuckDBService): Promise<SchemaSnapshot> {
  const tables: SchemaTable[] = [];
  try {
    const names = await duckDBService.listTables();
    for (const name of names) {
      try {
        const rows = await duckDBService.getTableInfo(name);
        const columns: SchemaColumn[] = rows.map((r: any) => ({
          name: String(r.column_name),
          type: String(r.column_type),
        }));
        tables.push({ name, columns });
      } catch (err) {
        console.error(`schemaSnapshot: getTableInfo failed for ${name}:`, err);
      }
    }
  } catch (err) {
    console.error("schemaSnapshot: listTables failed:", err);
  }

  let statsDuckLoaded = false;
  try {
    const rows = await duckDBService.executeQuery(
      "SELECT count(*) AS n FROM duckdb_functions() WHERE function_name LIKE 'ggsql_mark_v1_%'",
    );
    const n = Number((rows?.[0] as { n?: unknown })?.n ?? 0);
    statsDuckLoaded = n > 0;
  } catch (err) {
    console.error("schemaSnapshot: stats_duck probe failed:", err);
  }

  return { tables, statsDuckLoaded, takenAt: new Date().toISOString() };
}
