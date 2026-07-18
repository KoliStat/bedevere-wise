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
 * `@kolistat/bedevere-wise/ui` consumers (the desktop
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
 * The Vega-Lite major bundled with this package (via vega-embed). Bump in
 * lockstep with the vega-embed dependency.
 */
const BUNDLED_VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v6.json";

/**
 * Rewrite a stale Vega-Lite `$schema` (e.g. v5 from an older stats_duck
 * build, as bundled by bedevere-desktop) to the major this package
 * actually renders with. The spec shapes stats_duck emits are compatible
 * across those majors; without this every desktop chart logs
 * "The input spec uses Vega-Lite v5, but the current version is v6…".
 * Specs without a `$schema`, or with a non-vega-lite one, are left alone.
 */
function normalizeVegaLiteSchema(spec: Record<string, unknown>): void {
  const s = spec.$schema;
  if (typeof s === "string" && s.includes("/vega-lite/") && s !== BUNDLED_VEGA_LITE_SCHEMA) {
    spec.$schema = BUNDLED_VEGA_LITE_SCHEMA;
  }
}

/**
 * Coerce `bigint` cells to plain numbers, in place. DuckDB int64/int128
 * columns (`range()`, `count(*)`, `SUM(<int>)`, `year(date)`, …) arrive as
 * JS BigInt from both DuckDB-WASM and the desktop IPC decode, and
 * vega-interpreter's arithmetic throws "Cannot convert a BigInt value to a
 * number" — crashing any chart with an int64 aesthetic. Chart coordinates
 * never need int64 precision, so the >2^53 rounding this implies is
 * accepted HERE ONLY — the spreadsheet/table path keeps exact bigints and
 * must never route through this.
 */
function coerceBigIntsInDatasets(datasets: Record<string, unknown[]>): void {
  for (const rows of Object.values(datasets)) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const rec = row as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        if (typeof rec[key] === "bigint") rec[key] = Number(rec[key]);
      }
    }
  }
}

/** Every `encoding` block in a unit / layered / faceted spec. */
function collectEncodings(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.encoding && typeof n.encoding === "object") {
      out.push(n.encoding as Record<string, unknown>);
    }
    if (Array.isArray(n.layer)) for (const l of n.layer) visit(l);
    if (n.spec) visit(n.spec); // facet / repeat wrap the unit spec here
  };
  visit(spec);
  return out;
}

/** First non-null value of `field` across all layer datasets. */
function sampleFieldValue(datasets: Record<string, unknown[]>, field: string): unknown {
  for (const rows of Object.values(datasets)) {
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const v = (row as Record<string, unknown>)[field];
      if (v != null) return v;
    }
  }
  return undefined;
}

/**
 * stats_duck can't see SQL column types, so it emits
 * `type: "quantitative"` for every un-annotated channel — including ones
 * backed by VARCHAR/BOOLEAN columns. Vega then computes an infinite
 * numeric extent ("Infinite extent for field …") and renders nothing;
 * users had to hand-annotate `:nominal`. The renderer has the actual
 * values, so patch string/boolean-backed quantitative channels to
 * `nominal`. Explicit user annotations (`:ordinal` etc.) are untouched —
 * only the `quantitative` default is second-guessed. (Also reported
 * upstream to the-stats-duck for real type inference.)
 */
function patchEncodingTypes(
  spec: Record<string, unknown>,
  datasets: Record<string, unknown[]>,
): void {
  for (const encoding of collectEncodings(spec)) {
    for (const def of Object.values(encoding)) {
      if (!def || typeof def !== "object") continue;
      const channel = def as { field?: unknown; type?: unknown };
      if (channel.type !== "quantitative" || typeof channel.field !== "string") continue;
      const sample = sampleFieldValue(datasets, channel.field);
      if (typeof sample === "string" || typeof sample === "boolean") {
        channel.type = "nominal";
      }
    }
  }
}

/**
 * Post-process a VISUALIZE result for rendering. Single funnel shared by
 * BOTH transport paths (web layer-SQL execution and the desktop
 * `backend.visualize` RPC) so fixes land on every platform at once.
 */
function finalizeVisualizeResult(
  spec: Record<string, unknown>,
  datasets: Record<string, unknown[]>,
): void {
  patchVisualizeSpec(spec, datasets);
  coerceBigIntsInDatasets(datasets);
  patchEncodingTypes(spec, datasets);
  normalizeVegaLiteSchema(spec);
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
    finalizeVisualizeResult(spec as Record<string, unknown>, datasets);
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

  finalizeVisualizeResult(spec as Record<string, unknown>, datasets);

  return { spec, datasets };
}
