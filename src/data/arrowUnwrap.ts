import { TypeNode } from "./duckdbTypeParser";

/**
 * Convert Apache Arrow Vector proxies (what DuckDB-WASM returns for LIST,
 * STRUCT, LIST<STRUCT<..., DECIMAL>>, etc.) into plain JS arrays / objects
 * with fully scaled scalar values.
 *
 * Uses a {@link TypeNode} (parsed from DuckDB's `DESCRIBE` output) as the
 * authoritative type source. Without that, decimal scale would be lost for
 * nested fields since apache-arrow's runtime type objects expose nested
 * children inconsistently across builds.
 *
 * Key quirks handled:
 *
 * 1. `Vector.toArray()` on a `List<Decimal>` returns the *flat Int32 values
 *    buffer* \u2014 Decimal128 stores each value in 4 little-endian Int32
 *    words, so 3 logical decimals become 12 Int32s. We iterate the Vector
 *    instead, which yields one logical value per step.
 *
 * 2. Each Decimal leaf arrives as a typed-array-like container with 2 or 4
 *    little-endian 32-bit words (Decimal64 / Decimal128), or as an opaque
 *    object whose `toJSON()` returns the BigInt as a quoted string.
 *
 * 3. DECIMAL scale lives on the *type*, not on the value. We thread the
 *    parsed `TypeNode` down through recursion so every nested decimal
 *    (including those inside structs inside lists) gets scaled.
 */
export function unwrapArrowValue(value: any, typeNode?: TypeNode): any {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;

  // Decimal leaf \u2014 use the TypeNode scale if available.
  if (typeNode?.kind === "decimal") {
    const scalar = tryExtractDecimalScalar(value);
    if (scalar !== null) {
      const scale = typeNode.scale;
      return typeof scale === "number" && scale > 0
        ? applyScale(scalar, Math.pow(10, scale))
        : scalar;
    }
  }
  // Heuristic fallback for decimals we land on without type context.
  if (isDecimalWords(value)) {
    return combineWordsToScalar(extractWords(value));
  }

  // Vector-like: iterate logically, pass child type to recursion.
  const len = (value as any).length;
  const isVectorLike =
    typeof len === "number" &&
    typeof (value as any).toArray === "function" &&
    typeof (value as any)[Symbol.iterator] === "function";

  if (isVectorLike) {
    const childType = typeNode?.kind === "list" ? typeNode.element : undefined;
    const out: any[] = [];
    for (const raw of value as Iterable<any>) {
      out.push(unwrapArrowValue(raw, childType));
    }
    return out;
  }

  if (Array.isArray(value)) {
    const childType = typeNode?.kind === "list" ? typeNode.element : undefined;
    return value.map((v) => unwrapArrowValue(v, childType));
  }

  // Plain object (likely a Struct row). Recurse into every field, matching
  // by name first and falling back to positional order.
  const fieldList = typeNode?.kind === "struct" ? typeNode.fields : [];
  const byName: Record<string, TypeNode> = {};
  for (const f of fieldList) byName[f.name] = f.type;

  const out: Record<string, any> = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const childType = byName[k] ?? fieldList[i]?.type;
    out[k] = unwrapArrowValue((value as any)[k], childType);
  }
  return out;
}

/**
 * Unwrap a batch of Arrow row proxies (as returned by `Backend.executeQuery`)
 * into plain JS 2-D arrays, applying {@link unwrapArrowValue} to every cell
 * with its column's parsed {@link TypeNode}. `types[i]` aligns with the row's
 * column order; pass a sliced `types` for a column-range fetch. Shared by the
 * DuckDB DataProviders' `fetchData` / `fetchDataColumnRange`.
 */
export function unwrapArrowRows(rows: any[], types: Array<TypeNode | undefined>): any[][] {
  return rows.map((row: any) =>
    (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, types[i])),
  );
}

/**
 * Attempt to extract a decimal scalar (as Number or BigInt, before scaling).
 * Handles the two Arrow shapes we've seen:
 *   (a) typed-array-like with 2 or 4 little-endian Int32/Uint32 words, and
 *   (b) an opaque object whose `toJSON()` returns the raw BigInt as a string.
 */
function tryExtractDecimalScalar(v: any): number | bigint | null {
  if (isDecimalWords(v)) {
    return combineWordsToScalar(extractWords(v));
  }
  if (typeof v === "object" && typeof (v as any).toJSON === "function") {
    try {
      const j = (v as any).toJSON();
      if (typeof j === "number" || typeof j === "bigint") return j;
      if (typeof j === "string" && j.length > 0) {
        if (/^-?\d+$/.test(j)) {
          try {
            const bi = BigInt(j);
            if (bi >= BigInt(Number.MIN_SAFE_INTEGER) && bi <= BigInt(Number.MAX_SAFE_INTEGER)) {
              return Number(bi);
            }
            return bi;
          } catch {
            /* fall through */
          }
        }
        const n = Number(j);
        if (Number.isFinite(n)) return n;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function isDecimalWords(v: any): boolean {
  if (v == null || typeof v !== "object") return false;
  if (v instanceof Date || v instanceof Uint8Array || v instanceof DataView) return false;
  const len = (v as any).length;
  if (len !== 2 && len !== 4) return false;
  for (let i = 0; i < len; i++) {
    if (typeof (v as any)[i] !== "number") return false;
  }
  return true;
}

function extractWords(v: any): number[] {
  const len = (v as any).length as number;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push((v as any)[i] | 0);
  }
  return out;
}

function combineWordsToScalar(words: number[]): number | bigint {
  if (words.length === 0) return 0;
  if (words.length === 1) return words[0];

  const topWord = words[words.length - 1];
  const isNegative = topWord < 0;

  let mag = 0n;
  for (let i = words.length - 1; i >= 0; i--) {
    mag = (mag << 32n) | BigInt(words[i] >>> 0);
  }

  if (isNegative) {
    mag -= 1n << BigInt(words.length * 32);
  }

  if (mag >= BigInt(Number.MIN_SAFE_INTEGER) && mag <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(mag);
  }
  return mag;
}

function applyScale(v: any, divisor: number): any {
  if (typeof v === "bigint") return Number(v) / divisor;
  if (typeof v === "number") return v / divisor;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n / divisor;
  }
  return v;
}

/**
 * Best-effort lift of a DECIMAL scale from an Apache Arrow schema field's
 * type. Different builds of duckdb-wasm / apache-arrow expose the scale
 * differently; tries `type.scale` first (apache-arrow's typed Decimal class)
 * and falls back to parsing the `toString()` form (`Decimal128<p,s>` /
 * `Decimal(p,s)`) for builds that wrap the type in an opaque object.
 */
function inferDecimalScale(t: any): number | undefined {
  if (!t || typeof t !== "object") return undefined;
  if (typeof t.scale === "number") return t.scale;
  if (typeof t.toString === "function") {
    const s = String(t);
    const m = /Decimal\d*\s*[<(]\s*\d+\s*,\s*(\d+)/i.exec(s);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/**
 * Build the per-column DECIMAL scale map `runVisualize` uses to scale Decimal
 * cells back to plain numbers. Walks an Arrow schema's fields, keeping only
 * columns with a positive scale. Shared by every Backend's
 * `executeQueryWithSchema` so they agree on how scale is detected.
 */
export function extractDecimalScales(
  fields: Array<{ name?: unknown; type?: unknown }> | undefined,
): Record<string, number> {
  const scales: Record<string, number> = {};
  for (const field of fields ?? []) {
    const name = String((field as any)?.name ?? "");
    if (!name) continue;
    const scale = inferDecimalScale((field as any)?.type);
    if (typeof scale === "number" && scale > 0) {
      scales[name] = scale;
    }
  }
  return scales;
}
