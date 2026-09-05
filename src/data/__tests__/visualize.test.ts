import { describe, expect, it } from "vitest";
import { runVisualize } from "../visualize";
import type { Backend } from "../Backend";

/**
 * VISUALIZE pipeline regression tests (chart path only — the
 * spreadsheet/table numeric path must NOT get these coercions).
 *
 * Bug 1: DuckDB BIGINT/HUGEINT columns arrive as JS `bigint`
 * (`range()`, `count(*)`, `SUM(int)` …). vega-interpreter's arithmetic
 * throws "Cannot convert a BigInt value to a number", so any chart with
 * an int64 aesthetic crashed. Chart coordinates never need int64
 * precision → coerce to Number at the chart-dataset boundary, on BOTH
 * the web layer-SQL path and the desktop backend.visualize path.
 *
 * Bug 2: stats_duck can't see SQL column types and emits
 * `type: "quantitative"` for VARCHAR-backed channels; vega then computes
 * an infinite extent and renders nothing. The renderer knows the real
 * values — patch string/boolean-backed quantitative channels to nominal.
 *
 * Bug 3 (renderer half): older stats_duck builds emit a Vega-Lite v5
 * `$schema` while the bundled vega-lite is v6 — normalize on ingest so
 * web and desktop stop warning regardless of extension vintage.
 */

/** Web-shaped stub: VISUALIZE row + layer SQL execution. */
function webBackend(
  spec: Record<string, unknown>,
  layerRows: Array<Record<string, unknown>>,
  decimalScales: Record<string, number> = {},
): Backend {
  return {
    executeQuery: async () => [
      { spec: JSON.stringify(spec), layer_sqls: { layer_0: "SELECT 1" } },
    ],
    executeQueryWithSchema: async () => ({ rows: layerRows, decimalScales }),
  } as unknown as Backend;
}

/** Desktop-shaped stub: the host peels spec + datasets server-side. */
function ipcBackend(
  spec: Record<string, unknown>,
  datasets: Record<string, unknown[]>,
): Backend {
  return {
    visualize: async () => ({ spec, datasets }),
    executeQuery: async () => [],
    executeQueryWithSchema: async () => ({ rows: [], decimalScales: {} }),
  } as unknown as Backend;
}

const POINT_SPEC = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  mark: "point",
  data: { name: "layer_0" },
  encoding: {
    x: { field: "x", type: "quantitative" },
    y: { field: "y", type: "quantitative" },
  },
};

describe("runVisualize — bigint coercion (Bug 1)", () => {
  it("coerces bigint cells to plain numbers on the web layer-SQL path", async () => {
    const backend = webBackend(POINT_SPEC, [
      { x: 1n, y: 2n },
      { x: 9007199254740993n, y: 0n }, // > 2^53: precision loss accepted for chart coords
    ]);
    const { datasets } = await runVisualize("VISUALIZE …", backend);
    const rows = datasets.layer_0 as Array<Record<string, unknown>>;
    expect(typeof rows[0].x).toBe("number");
    expect(rows[0].x).toBe(1);
    expect(typeof rows[0].y).toBe("number");
    expect(typeof rows[1].x).toBe("number");
  });

  it("coerces bigint cells on the backend.visualize (desktop IPC) path", async () => {
    const backend = ipcBackend(POINT_SPEC, {
      layer_0: [{ x: 3n, y: 4n }],
    });
    const { datasets } = await runVisualize("VISUALIZE …", backend);
    const rows = datasets.layer_0 as Array<Record<string, unknown>>;
    expect(typeof rows[0].x).toBe("number");
    expect(rows[0].x).toBe(3);
  });

  it("does not disturb DECIMAL scaling on the web path", async () => {
    const backend = webBackend(
      POINT_SPEC,
      [{ x: 1n, y: [10, 0] }], // Decimal64 word buffer for raw 10, scale 1 → 1.0
      { y: 1 },
    );
    const { datasets } = await runVisualize("VISUALIZE …", backend);
    const rows = datasets.layer_0 as Array<Record<string, unknown>>;
    expect(rows[0].y).toBe(1);
  });
});

describe("runVisualize — categorical encoding repair (Bug 2)", () => {
  it("rewrites a string-backed quantitative channel to nominal (unit spec)", async () => {
    const spec = {
      mark: "boxplot",
      data: { name: "layer_0" },
      encoding: {
        x: { field: "x", type: "quantitative" },
        y: { field: "y", type: "quantitative" },
      },
    };
    const backend = webBackend(spec, [
      { x: "a", y: 1n },
      { x: "b", y: 5n },
    ]);
    const result = await runVisualize("VISUALIZE …", backend);
    const enc = (result.spec as Record<string, any>).encoding;
    expect(enc.x.type).toBe("nominal"); // string-backed → categorical
    expect(enc.y.type).toBe("quantitative"); // numeric stays quantitative
  });

  it("repairs encodings inside layer arrays too", async () => {
    const spec = {
      layer: [
        {
          mark: "bar",
          data: { name: "layer_0" },
          encoding: {
            x: { field: "g", type: "quantitative" },
            y: { field: "n", type: "quantitative" },
          },
        },
      ],
    };
    const backend = webBackend(spec, [{ g: "a", n: 10n }]);
    const result = await runVisualize("VISUALIZE …", backend);
    const layer = (result.spec as Record<string, any>).layer[0];
    expect(layer.encoding.x.type).toBe("nominal");
    expect(layer.encoding.y.type).toBe("quantitative");
  });

  it("leaves user-annotated and numeric channels untouched", async () => {
    const spec = {
      mark: "bar",
      data: { name: "layer_0" },
      encoding: {
        x: { field: "g", type: "ordinal" }, // user said :ordinal — keep
        y: { field: "n", type: "quantitative" },
      },
    };
    const backend = webBackend(spec, [{ g: "a", n: 1n }]);
    const result = await runVisualize("VISUALIZE …", backend);
    const enc = (result.spec as Record<string, any>).encoding;
    expect(enc.x.type).toBe("ordinal");
    expect(enc.y.type).toBe("quantitative");
  });
});

describe("runVisualize — Vega-Lite $schema normalization (Bug 3, renderer half)", () => {
  it("rewrites an old vega-lite major $schema to the bundled major", async () => {
    const spec = {
      ...POINT_SPEC,
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    };
    const backend = ipcBackend(spec, { layer_0: [{ x: 1, y: 2 }] });
    const result = await runVisualize("VISUALIZE …", backend);
    expect((result.spec as Record<string, unknown>).$schema).toBe(
      "https://vega.github.io/schema/vega-lite/v6.json",
    );
  });

  it("leaves a spec without $schema alone", async () => {
    const { $schema: _drop, ...noSchema } = POINT_SPEC;
    const backend = ipcBackend(noSchema, { layer_0: [{ x: 1, y: 2 }] });
    const result = await runVisualize("VISUALIZE …", backend);
    expect("$schema" in (result.spec as Record<string, unknown>)).toBe(false);
  });
});
