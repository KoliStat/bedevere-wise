import type { VisualizationSpec } from "vega-embed";
import type { Backend } from "./Backend";
import { unwrapArrowValue } from "./arrowUnwrap";
import { getStatsDuckFailureReason } from "./statsDuckStatus";

/**
 * @deprecated Pass a {@link Backend} directly. `SqlExecutor` was an
 * earlier, narrower contract that only required `executeQuery` +
 * `executeQueryWithSchema`. The Backend interface (introduced in
 * v0.13) supersedes it — both methods are part of the Backend
 * contract — and the rest of the codebase has standardized on
 * Backend. Alias kept for one release so downstream
 * `@caerbannogwhite/bedevere-wise/ui` consumers (the desktop
 * renderer + any external embedders) don't break on upgrade.
 */
export type SqlExecutor = Pick<Backend, "executeQuery" | "executeQueryWithSchema">;

/**
 * Result of running a `VISUALIZE … DRAW <mark>` script through stats_duck:
 * the Vega-Lite spec (with `data: { name: "layer_n" }` references) plus
 * the per-layer row arrays that match those names.
 */
export interface VisualizeResult {
  spec: VisualizationSpec;
  /** `layer_0`, `layer_1`, … → row arrays. */
  datasets: Record<string, unknown[]>;
}

/**
 * stats_duck v1.5.1 emits faceted (and likely repeat / concat) Vega-Lite
 * specs with `data: { name: "layer_n" }` on each inner layer rather than
 * at the outer level. Vega-Lite v6's facet operator groups *outer* data;
 * with the data only on inner layers it sees zero groups, no panels render,
 * and only the y-axis ends up on the canvas (the "57px-wide chart" symptom).
 *
 * Promote the first layer's data reference to the outer spec and strip the
 * per-layer ones so all layers inherit the faceted slice. Idempotent —
 * leaves the spec untouched when it's not composite or already has outer
 * data. (When stats_duck fixes this upstream, the patch becomes a no-op.)
 */
function patchVisualizeSpec(spec: Record<string, unknown>, datasets: Record<string, unknown[]>): void {
  const isComposite =
    "facet" in spec || "repeat" in spec || "concat" in spec || "hconcat" in spec || "vconcat" in spec;
  if (!isComposite) return;
  if (spec.data) return;

  const inner = (spec.spec as Record<string, unknown> | undefined) ?? spec;
  const layers = inner.layer as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(layers) || layers.length === 0) return;

  const seed = layers
    .map((layer) => (layer.data as { name?: string } | undefined)?.name)
    .find((name) => typeof name === "string" && name in datasets);
  if (!seed) return;

  spec.data = { name: seed };
  for (const layer of layers) {
    if (layer.data) delete layer.data;
  }
}

/**
 * Run a `VISUALIZE … DRAW <mark>` script through stats_duck and return the
 * Vega-Lite spec + per-layer row arrays ready to hand to
 * {@link ChartVisualizer.setSpec} (or any vega-embed call site).
 *
 * Pipeline:
 *   1. Execute the VISUALIZE SQL — stats_duck returns one row with
 *      `spec` (Vega-Lite JSON) + `layer_sqls` (`{layer_n: SELECT …}` MAP).
 *   2. Parse the spec and normalize the layer_sqls map (DuckDB-WASM returns
 *      it as either a plain object or a `Map` instance depending on version).
 *   3. Run each layer SQL, convert Arrow row proxies to plain JS objects,
 *      and scale DECIMAL columns back to scalar numbers using the schema
 *      scale (Arrow ships `1.0` as the raw integer `10` for `DECIMAL(2,1)`).
 *   4. Apply {@link patchVisualizeSpec} so faceted specs from stats_duck
 *      v1.5.1 render their panels (upstream bug — see helper docs).
 *
 * The stats_duck failure-reason cache ({@link getStatsDuckFailureReason})
 * is read on parse-time syntax errors so the error message names the
 * actual cause (e.g. "extension didn't load — WASM signature mismatch")
 * instead of a generic "syntax error near VISUALIZE". That cache lives
 * in this package and is populated by `BedevereApp.initAsync` during
 * extension probe — DuckDB-WASM coupling is intentional and OK; a
 * non-WASM caller will simply get `undefined` and the generic message.
 */
export async function runVisualize(
  sql: string,
  backend: SqlExecutor & Pick<Backend, "visualize">,
): Promise<VisualizeResult> {
  // Backends with a dedicated visualize entry point (IPC: the host
  // extracts spec + layer rows server-side) skip the SQL round-trip
  // entirely. The faceted-spec patch still applies — it fixes a
  // stats_duck output bug, not a transport one.
  if (backend.visualize) {
    const result = await backend.visualize(sql);
    const spec = result.spec as VisualizationSpec;
    const datasets = result.datasets;
    patchVisualizeSpec(spec as Record<string, unknown>, datasets);
    return { spec, datasets };
  }

  let rows: any[];
  try {
    rows = await backend.executeQuery(sql);
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    if (/syntax error/i.test(msg) && /VISUALIZE/i.test(msg)) {
      const reason = getStatsDuckFailureReason() ?? "no startup details captured (check browser console)";
      throw new Error(
        `VISUALIZE rejected by DuckDB — the stats_duck (ggsql) parser extension didn't load: ${reason}`,
      );
    }
    throw parseErr;
  }
  if (!rows || rows.length === 0) {
    throw new Error("VISUALIZE returned no rows — stats_duck parser may not be loaded");
  }
  const row = rows[0] as { spec?: string; layer_sqls?: unknown };
  if (typeof row.spec !== "string") {
    throw new Error("VISUALIZE result is missing the 'spec' column");
  }
  const spec = JSON.parse(row.spec) as VisualizationSpec;

  // DuckDB's MAP type comes back as either a plain object or, in some
  // versions of duckdb-wasm, a Map instance. Normalize to entries.
  const layerSqls = row.layer_sqls;
  const entries: Array<[string, string]> = [];
  if (layerSqls instanceof Map) {
    for (const [k, v] of layerSqls) entries.push([String(k), String(v)]);
  } else if (layerSqls && typeof layerSqls === "object") {
    for (const [k, v] of Object.entries(layerSqls as Record<string, unknown>)) {
      entries.push([k, String(v)]);
    }
  } else {
    throw new Error("VISUALIZE result is missing the 'layer_sqls' map");
  }

  const datasets: Record<string, unknown[]> = {};
  for (const [name, layerSql] of entries) {
    // executeQueryWithSchema gives us per-column DECIMAL scales on top
    // of the rows. DuckDB infers `DECIMAL(p,s)` for plain literals
    // (`1.0` → DECIMAL(2,1)) and Arrow exports those as the raw integer
    // — without scaling, `1.0` lands in the chart at 10 and the whole
    // axis appears multiplied by 10^scale.
    const { rows: layerRows, decimalScales } = await backend.executeQueryWithSchema(layerSql);
    // Apache Arrow's `Table.toArray()` returns Row proxies that delegate
    // property access to the underlying RecordBatch. Vega-Lite's data
    // ingestion iterates with `for…of` and reads fields via `row.x`,
    // `row.species`, etc. — numeric fields tend to work, but string
    // columns can return an Arrow value wrapper rather than a plain
    // string. Materializing each row via `toJSON()` (or a shallow
    // spread fallback) sidesteps the proxy entirely.
    datasets[name] = layerRows.map((r: any) => {
      const obj: Record<string, unknown> =
        r && typeof r.toJSON === "function" ? r.toJSON() : { ...r };
      // DECIMAL columns arrive as `Uint32Array(2|4)` — Decimal64 /
      // Decimal128's little-endian word buffer, not a plain number.
      // `unwrapArrowValue` combines the words into the raw integer and
      // applies the column's scale (1.0 → raw 10 ÷ 10^1 = 1.0).
      for (const [col, scale] of Object.entries(decimalScales)) {
        obj[col] = unwrapArrowValue(obj[col], { kind: "decimal", scale });
      }
      return obj;
    });
  }

  patchVisualizeSpec(spec as Record<string, unknown>, datasets);

  return { spec, datasets };
}
