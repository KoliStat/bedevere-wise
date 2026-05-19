import { DuckDBService } from "./DuckDBService";
import { quoteIdent } from "./sqlIdent";
import { unwrapArrowValue } from "./arrowUnwrap";
import { parseDuckDBType, TypeNode } from "./duckdbTypeParser";
import {
  Column,
  ColumnStats,
  DataProvider,
  DatasetMetadata,
  DataType,
  isIntegerType,
  isNumericType,
  isTemporalType,
  isBooleanType,
  isStringType,
  isDateType,
  isTimeType,
  normalizeDuckDBType,
} from "./types";

export class DuckDBDataProvider implements DataProvider {
  private name: string = "";
  private fileName: string = "";
  private description: string = "";
  private label: string = "";
  // Cached per-column parsed type trees. Populated lazily by
  // ensureColumnTypes(); invalidated when the table is renamed or dropped.
  private parsedColumnTypes: Array<TypeNode | undefined> | null = null;

  constructor(private duckDBService: DuckDBService, name: string, fileName: string) {
    this.name = name;
    this.fileName = fileName;
  }

  private async ensureColumnTypes(): Promise<Array<TypeNode | undefined>> {
    if (this.parsedColumnTypes) return this.parsedColumnTypes;
    const info = await this.duckDBService.getTableInfo(this.name);
    this.parsedColumnTypes = info.map((c: any) => parseDuckDBType(c.column_type));
    return this.parsedColumnTypes;
  }

  public setName(name: string): void {
    this.duckDBService.executeQuery(`ALTER TABLE ${quoteIdent(this.name)} RENAME TO ${quoteIdent(name)}`).then(() => {
      this.name = name;
    });
  }

  public setDescription(description: string): void {
    this.description = description;
  }

  public setLabel(label: string): void {
    this.label = label;
  }

  public async getMetadata(): Promise<DatasetMetadata> {
    const totalRows = (await this.duckDBService.executeQuery(`SELECT COUNT(*) FROM ${quoteIdent(this.name)}`))[0].toArray()[0] as BigInt;
    const columns = await this.duckDBService.getTableInfo(this.name);

    return {
      name: this.name,
      fileName: this.fileName,
      description: this.description,
      label: this.label,
      totalRows: Number(totalRows),
      totalColumns: columns.length,
      columns: columns.map((column: any) => ({
        name: column.column_name,
        key: column.key,
        extra: column.extra,
        default: column.default,
        dataType: normalizeDuckDBType(column.column_type),
        rawType: column.column_type,
        hasNulls: column.nulls === "YES",
      })),
    };
  }

  public async fetchData(startRow: number, endRow: number): Promise<any[][]> {
    const query = `SELECT * FROM ${quoteIdent(this.name)} LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, types] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    return rows.map((row: any) =>
      (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, types[i])),
    );
  }

  public async fetchDataColumnRange(startRow: number, endRow: number, startCol: number, endCol: number): Promise<any[][]> {
    const columns = await this.duckDBService.getTableInfo(this.name);
    const columnNames = columns.map((column: any) => column.column_name).slice(startCol, endCol);
    const columnNamesString = columnNames.map(quoteIdent).join(", ");

    const query = `SELECT ${columnNamesString} FROM ${quoteIdent(this.name)} LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, types] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    // types is full column list; we sliced columnNames the same way.
    const sliceTypes = types.slice(startCol, endCol);
    return rows.map((row: any) =>
      (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, sliceTypes[i])),
    );
  }

  /**
   * For the unfiltered source provider, filtered == unfiltered. The
   * method exists so `FilteredDuckDBDataProvider` can override with a
   * temp-view path; callers that don't care about the distinction
   * should use the regular `getColumnStats`.
   */
  public async getColumnStatsFiltered(column: string | Column): Promise<ColumnStats | null> {
    return this.getColumnStats(column);
  }

  public async getColumnStats(
    column: string | Column,
    valueCountsLimit: number = 10
  ): Promise<ColumnStats | null> {
    const columnName = typeof column === "string" ? column : column.name;

    let dataType: DataType | undefined = typeof column === "string" ? undefined : column.dataType;
    if (!dataType) {
      const columnInfo = await this.duckDBService.getColumnInfo(this.name, columnName);
      dataType = normalizeDuckDBType(columnInfo?.data_type);
    }

    try {
      if (isNumericType(dataType)) {
        return await this.getNumericStats(columnName, dataType);
      }
      if (isTemporalType(dataType)) {
        return await this.getTemporalStats(columnName, dataType);
      }
      if (isBooleanType(dataType)) {
        return await this.getBooleanStats(columnName);
      }
      if (isStringType(dataType)) {
        return await this.getCategoricalStats(columnName, valueCountsLimit);
      }
      // BLOB / complex / unknown — just basic count stats
      return await this.getBasicStats(columnName);
    } catch (error) {
      console.error(`Error getting column stats for ${columnName}:`, error);
      return null;
    }
  }

  /**
   * Basic count stats only — no value counts, no histogram.
   * Used for BLOB, complex types, etc.
   */
  private async getBasicStats(columnName: string): Promise<ColumnStats> {
    const query = `
      SELECT COUNT(*) as total_count,
             COUNT(CASE WHEN "${columnName}" IS NULL THEN 1 END) as null_count,
             COUNT(DISTINCT "${columnName}") as distinct_count
      FROM ${quoteIdent(this.name)}
    `;
    const row = (await this.duckDBService.executeQuery(query))[0];
    return {
      totalCount: Number(row.total_count),
      nullCount: Number(row.null_count),
      distinctCount: Number(row.distinct_count),
      valueCounts: new Map(),
      isCategorical: false,
      numericStats: null,
    };
  }

  /**
   * Categorical stats: top-N most frequent values.
   */
  private async getCategoricalStats(columnName: string, limit: number): Promise<ColumnStats> {
    const statsQuery = `
      SELECT COUNT(*) as total_count,
             COUNT(CASE WHEN "${columnName}" IS NULL THEN 1 END) as null_count,
             COUNT(DISTINCT "${columnName}") as distinct_count
      FROM ${quoteIdent(this.name)}
    `;
    const basic = (await this.duckDBService.executeQuery(statsQuery))[0];

    const valueCountsQuery = `
      SELECT "${columnName}" as val, COUNT(*) as cnt
      FROM ${quoteIdent(this.name)}
      WHERE "${columnName}" IS NOT NULL
      GROUP BY "${columnName}"
      ORDER BY cnt DESC
      LIMIT ${limit}
    `;
    const rows = await this.duckDBService.executeQuery(valueCountsQuery);
    const valueCounts = new Map<string, number>();
    const valueCountsRaw = new Map<string, any>();
    for (const row of rows) {
      const key = String(row.val);
      valueCounts.set(key, Number(row.cnt));
      valueCountsRaw.set(key, row.val);
    }

    return {
      totalCount: Number(basic.total_count),
      nullCount: Number(basic.null_count),
      distinctCount: Number(basic.distinct_count),
      valueCounts,
      valueCountsRaw,
      isCategorical: true,
      numericStats: null,
    };
  }

  public async searchColumnValues(
    column: string | Column,
    options: { query: string; mode: "substring" | "regex"; limit: number },
  ): Promise<Array<{ value: string; count: number }>> {
    const columnName = typeof column === "string" ? column : column.name;
    const col = `"${columnName}"`;
    // CAST to VARCHAR so this works on enum / numeric / temporal columns
    // too — the categorical filter is string-typed today but searching
    // by display string is the sensible behaviour across types.
    const colExpr = `CAST(${col} AS VARCHAR)`;

    let whereClause: string;
    if (options.mode === "regex") {
      // `regexp_full_match` — the whole value must match the pattern.
      // The categorical filter's regex semantics are anchored because
      // each row in the value list is a discrete category, not free
      // text: a query like `week [24]` means "exactly Week 2 or Week 4",
      // not "any value containing those substrings". Users who want
      // substring matching can write `.*foo.*` or use the substring
      // mode toggle.
      const safe = options.query.replace(/'/g, "''");
      whereClause = `regexp_full_match(${colExpr}, '${safe}', 'i')`;
    } else {
      // ILIKE is DuckDB's case-insensitive LIKE. Escape `%` and `_`
      // so users typing them search for literal characters; use `\`
      // as the escape (DuckDB default).
      const safe = options.query.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[%_]/g, "\\$&");
      whereClause = `${colExpr} ILIKE '%${safe}%' ESCAPE '\\'`;
    }

    const query = `
      SELECT ${col} as val, COUNT(*) as cnt
      FROM ${quoteIdent(this.name)}
      WHERE ${col} IS NOT NULL AND ${whereClause}
      GROUP BY ${col}
      ORDER BY cnt DESC
      LIMIT ${options.limit}
    `;
    const rows = await this.duckDBService.executeQuery(query);
    return rows.map((row: any) => ({
      value: String(row.val),
      count: Number(row.cnt),
    }));
  }

  /**
   * Boolean stats: just TRUE/FALSE counts (and nulls).
   */
  private async getBooleanStats(columnName: string): Promise<ColumnStats> {
    const query = `
      SELECT COUNT(*) as total_count,
             COUNT(CASE WHEN "${columnName}" IS NULL THEN 1 END) as null_count,
             COUNT(CASE WHEN "${columnName}" = TRUE THEN 1 END) as true_count,
             COUNT(CASE WHEN "${columnName}" = FALSE THEN 1 END) as false_count
      FROM ${quoteIdent(this.name)}
    `;
    const row = (await this.duckDBService.executeQuery(query))[0];
    const trueCount = Number(row.true_count);
    const falseCount = Number(row.false_count);

    const valueCounts = new Map<string, number>();
    const valueCountsRaw = new Map<string, any>();
    if (trueCount > 0) {
      valueCounts.set("TRUE", trueCount);
      valueCountsRaw.set("TRUE", true);
    }
    if (falseCount > 0) {
      valueCounts.set("FALSE", falseCount);
      valueCountsRaw.set("FALSE", false);
    }

    return {
      totalCount: Number(row.total_count),
      nullCount: Number(row.null_count),
      distinctCount: (trueCount > 0 ? 1 : 0) + (falseCount > 0 ? 1 : 0),
      valueCounts,
      valueCountsRaw,
      isCategorical: true,
      numericStats: null,
    };
  }

  /**
   * Numeric stats: min/max/mean/median/stddev + dynamic-bin histogram.
   */
  private async getNumericStats(columnName: string, dataType: DataType): Promise<ColumnStats> {
    const statsQuery = `
      SELECT COUNT(*) as total_count,
             COUNT(CASE WHEN "${columnName}" IS NULL THEN 1 END) as null_count,
             COUNT(DISTINCT "${columnName}") as distinct_count,
             CAST(MIN("${columnName}") AS DOUBLE) as min_val,
             CAST(MAX("${columnName}") AS DOUBLE) as max_val,
             CAST(AVG("${columnName}") AS DOUBLE) as mean_val,
             CAST(MEDIAN("${columnName}") AS DOUBLE) as median_val,
             CAST(STDDEV("${columnName}") AS DOUBLE) as stddev_val
      FROM ${quoteIdent(this.name)}
    `;
    const row = (await this.duckDBService.executeQuery(statsQuery))[0];
    const totalCount = Number(row.total_count);
    const nullCount = Number(row.null_count);
    const distinctCount = Number(row.distinct_count);

    // If all values are NULL, skip numeric computations entirely
    if (totalCount === nullCount || row.min_val == null || row.max_val == null) {
      return {
        totalCount,
        nullCount,
        distinctCount,
        isCategorical: false,
        valueCounts: new Map(),
        histogramEdges: [],
        numericStats: null,
      };
    }

    const min = Number(row.min_val);
    const max = Number(row.max_val);

    // Pick histogram bin count dynamically
    const nonNullCount = totalCount - nullCount;
    const binCount = pickBinCount(dataType, distinctCount, min, max, nonNullCount);

    const histogram = new Map<string, number>();
    const histogramEdges: number[] = [];

    // "Discrete-category" integer path: one bin per distinct value.
    // Only when BOTH the number of distinct values AND the integer
    // range are small (a 1–5 rating, day-of-week 0–6, etc.) — Eurovision
    // Total-score columns like [11, 534] satisfy the first condition but
    // not the second, so they fall through to continuous binning and
    // render as a real distribution instead of N bars of height 1.
    const integerRange = isIntegerType(dataType) ? Math.floor(max - min) + 1 : Infinity;
    const isDiscreteIntegerCategory =
      isIntegerType(dataType) && distinctCount > 0 && distinctCount <= 20 && integerRange <= 50;

    if (min === max || nonNullCount === 0) {
      // Degenerate case — single-value histogram
      if (nonNullCount > 0) {
        const label = formatNumericRange(min, max, dataType);
        histogram.set(label, nonNullCount);
        histogramEdges.push(min, max);
      }
    } else if (isDiscreteIntegerCategory) {
      // Small-cardinality, small-range integer column: one bin per
      // distinct value (rating scales, day-of-week, etc.).
      const query = `
        SELECT "${columnName}" as val, COUNT(*) as cnt
        FROM ${quoteIdent(this.name)}
        WHERE "${columnName}" IS NOT NULL
        GROUP BY "${columnName}"
        ORDER BY val
      `;
      const rows = await this.duckDBService.executeQuery(query);
      for (const r of rows) {
        const v = Number(r.val);
        histogram.set(String(v), Number(r.cnt));
        histogramEdges.push(v);
      }
    } else {
      // Continuous histogram with `binCount` bins
      let binWidth = (max - min) / binCount;
      // For integer types, snap bin width to integer to avoid fractional edges
      if (isIntegerType(dataType)) {
        binWidth = Math.max(1, Math.ceil(binWidth));
      }

      const histQuery = `
        SELECT CAST(FLOOR((CAST("${columnName}" AS DOUBLE) - ${min}) / ${binWidth}) AS INTEGER) AS bin, COUNT(*) AS cnt
        FROM ${quoteIdent(this.name)}
        WHERE "${columnName}" IS NOT NULL
        GROUP BY bin
        ORDER BY bin
      `;
      const histResult = await this.duckDBService.executeQuery(histQuery);

      // Initialize bins with zero counts
      const labels: string[] = [];
      for (let i = 0; i < binCount; i++) {
        const binStart = min + i * binWidth;
        const binEnd = i === binCount - 1 ? max : min + (i + 1) * binWidth;
        histogramEdges.push(binStart);
        const label = formatNumericRange(binStart, binEnd, dataType);
        labels.push(label);
        histogram.set(label, 0);
      }
      histogramEdges.push(max);

      for (const r of histResult) {
        let idx = Number(r.bin);
        if (idx < 0) idx = 0;
        if (idx >= binCount) idx = binCount - 1;
        histogram.set(labels[idx], (histogram.get(labels[idx]) || 0) + Number(r.cnt));
      }
    }

    return {
      totalCount,
      nullCount,
      distinctCount,
      isCategorical: false,
      valueCounts: histogram,
      histogramEdges,
      numericStats: {
        min,
        max,
        mean: row.mean_val == null ? NaN : Number(row.mean_val),
        median: row.median_val == null ? NaN : Number(row.median_val),
        stdDev: row.stddev_val == null ? NaN : Number(row.stddev_val),
      },
    };
  }

  /**
   * Temporal stats: min/max + time-bucketed histogram.
   * For DATE/TIMESTAMP we ask DuckDB to give us epoch values so we can bin in JS.
   */
  private async getTemporalStats(columnName: string, dataType: DataType): Promise<ColumnStats> {
    // Convert to microseconds since epoch for TIMESTAMP, days since epoch for DATE,
    // and microseconds since midnight for TIME.
    let epochExpr: string;
    if (isDateType(dataType)) {
      // Days since 1970-01-01
      epochExpr = `CAST(date_diff('day', DATE '1970-01-01', "${columnName}") AS BIGINT)`;
    } else if (isTimeType(dataType)) {
      // Microseconds since midnight
      epochExpr = `CAST(EXTRACT(epoch_us FROM "${columnName}") AS BIGINT)`;
    } else {
      // Microseconds since epoch for TIMESTAMP variants
      epochExpr = `CAST(EXTRACT(epoch_us FROM "${columnName}") AS BIGINT)`;
    }

    const statsQuery = `
      SELECT COUNT(*) as total_count,
             COUNT(CASE WHEN "${columnName}" IS NULL THEN 1 END) as null_count,
             COUNT(DISTINCT "${columnName}") as distinct_count,
             CAST(MIN(${epochExpr}) AS DOUBLE) as min_val,
             CAST(MAX(${epochExpr}) AS DOUBLE) as max_val
      FROM ${quoteIdent(this.name)}
    `;
    let basic: any;
    try {
      basic = (await this.duckDBService.executeQuery(statsQuery))[0];
    } catch {
      // If epoch extraction fails (unsupported type), fall back to categorical stats
      return await this.getCategoricalStats(columnName, 10);
    }

    const totalCount = Number(basic.total_count);
    const nullCount = Number(basic.null_count);
    const distinctCount = Number(basic.distinct_count);
    const nonNullCount = totalCount - nullCount;

    // All-NULL column: skip temporal computations, leave temporalStats null
    if (nonNullCount === 0 || basic.min_val == null || basic.max_val == null) {
      return {
        totalCount,
        nullCount,
        distinctCount,
        isCategorical: false,
        valueCounts: new Map(),
        valueCountsRaw: new Map(),
        histogramEdges: [],
        numericStats: null,
        temporalStats: null,
      };
    }

    const min = Number(basic.min_val);
    const max = Number(basic.max_val);

    const histogram = new Map<string, number>();
    const valueCountsRaw = new Map<string, any>();
    const histogramEdges: number[] = [];

    if (!isFinite(min) || !isFinite(max)) {
      return {
        totalCount,
        nullCount,
        distinctCount,
        isCategorical: false,
        valueCounts: histogram,
        valueCountsRaw,
        histogramEdges,
        numericStats: null,
        temporalStats: null,
      };
    }

    if (min === max) {
      const label = formatTemporalValue(min, dataType);
      histogram.set(label, nonNullCount);
      valueCountsRaw.set(label, min);
      histogramEdges.push(min, max);
    } else {
      // Pick a bin count and granularity that fits the range.
      const binCount = Math.min(20, Math.max(5, Math.ceil(Math.log2(nonNullCount) + 1)));
      const binWidth = (max - min) / binCount;

      const histQuery = `
        SELECT CAST(FLOOR((CAST(${epochExpr} AS DOUBLE) - ${min}) / ${binWidth}) AS INTEGER) as bin, COUNT(*) as cnt
        FROM ${quoteIdent(this.name)}
        WHERE "${columnName}" IS NOT NULL
        GROUP BY bin
        ORDER BY bin
      `;
      const histResult = await this.duckDBService.executeQuery(histQuery);

      const labels: string[] = [];
      for (let i = 0; i < binCount; i++) {
        const binStart = min + i * binWidth;
        histogramEdges.push(binStart);
        const label = formatTemporalValue(binStart, dataType);
        labels.push(label);
        histogram.set(label, 0);
        valueCountsRaw.set(label, binStart);
      }
      histogramEdges.push(max);

      for (const r of histResult) {
        let idx = Number(r.bin);
        if (idx < 0) idx = 0;
        if (idx >= binCount) idx = binCount - 1;
        histogram.set(labels[idx], (histogram.get(labels[idx]) || 0) + Number(r.cnt));
      }
    }

    return {
      totalCount,
      nullCount,
      distinctCount,
      isCategorical: false,
      valueCounts: histogram,
      valueCountsRaw,
      histogramEdges,
      numericStats: null,
      temporalStats: { min, max },
    };
  }
}

// ------------- helpers -------------

/**
 * Pick a histogram bin count using a blend of Sturges' rule and data shape.
 */
function pickBinCount(
  dataType: DataType,
  distinctCount: number,
  min: number,
  max: number,
  nonNullCount: number
): number {
  if (nonNullCount <= 1) return 1;

  // For integer columns with few distinct values, use one bin per value (caller
  // handles that path separately — this is the fallback upper bound).
  if (isIntegerType(dataType)) {
    // Bin count cannot exceed the integer range: max - min + 1
    const range = Math.max(1, Math.floor(max - min) + 1);
    const sturges = Math.ceil(Math.log2(nonNullCount) + 1);
    return Math.max(5, Math.min(30, Math.min(range, sturges * 2)));
  }

  // Float columns — Sturges scaled up, clamped to [10, 30]
  const sturges = Math.ceil(Math.log2(nonNullCount) + 1);
  let bins = Math.max(10, Math.min(30, sturges * 2));
  // If distinct count is smaller, use that instead
  if (distinctCount > 0 && distinctCount < bins) bins = distinctCount;
  return bins;
}

function formatNumericRange(start: number, end: number, dataType: DataType): string {
  if (isIntegerType(dataType)) {
    const a = Math.round(start);
    const b = Math.round(end);
    if (a === b) return String(a);
    return `${a}–${b}`;
  }
  // Fixed-precision for floats; strip trailing zeros
  const fmt = (n: number) => {
    if (!isFinite(n)) return String(n);
    const abs = Math.abs(n);
    if (abs !== 0 && (abs < 0.01 || abs >= 1e6)) return n.toExponential(2);
    return Number(n.toFixed(2)).toString();
  };
  return `${fmt(start)}–${fmt(end)}`;
}

function formatTemporalValue(value: number, dataType: DataType): string {
  if (!isFinite(value)) return "";
  if (isDateType(dataType)) {
    // days since 1970-01-01
    const d = new Date(value * 86400 * 1000);
    if (isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }
  if (isTimeType(dataType)) {
    // microseconds since midnight
    const totalSec = Math.floor(value / 1_000_000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  // TIMESTAMP variants — microseconds since epoch
  const d = new Date(value / 1000);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().replace("T", " ").slice(0, 19);
}
