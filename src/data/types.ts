export type DataType =
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

/**
 * Broad category of a data type used to drive filter/stats/rendering decisions.
 */
export type DataTypeCategory = "numeric" | "temporal" | "boolean" | "string" | "binary" | "complex" | "other";

// ----- type predicates -----

export function isIntegerType(dt: DataType): boolean {
  return (
    dt === "TINYINT" ||
    dt === "SMALLINT" ||
    dt === "INTEGER" ||
    dt === "BIGINT" ||
    dt === "HUGEINT" ||
    dt === "UTINYINT" ||
    dt === "USMALLINT" ||
    dt === "UINTEGER" ||
    dt === "UBIGINT" ||
    dt === "UHUGEINT"
  );
}

export function isFloatType(dt: DataType): boolean {
  return dt === "FLOAT" || dt === "DOUBLE" || dt === "DECIMAL";
}

export function isNumericType(dt: DataType): boolean {
  return isIntegerType(dt) || isFloatType(dt);
}

export function isDateType(dt: DataType): boolean {
  return dt === "DATE";
}

export function isTimeType(dt: DataType): boolean {
  return dt === "TIME" || dt === "TIME_TZ";
}

export function isTimestampType(dt: DataType): boolean {
  return (
    dt === "TIMESTAMP" ||
    dt === "TIMESTAMP_TZ" ||
    dt === "TIMESTAMP_NS" ||
    dt === "TIMESTAMP_MS" ||
    dt === "TIMESTAMP_S"
  );
}

export function isTemporalType(dt: DataType): boolean {
  return isDateType(dt) || isTimeType(dt) || isTimestampType(dt);
}

export function isBooleanType(dt: DataType): boolean {
  return dt === "BOOLEAN";
}

export function isStringType(dt: DataType): boolean {
  return dt === "VARCHAR" || dt === "UUID" || dt === "ENUM";
}

export function isBinaryType(dt: DataType): boolean {
  return dt === "BLOB" || dt === "BIT";
}

export function isComplexType(dt: DataType): boolean {
  return dt === "LIST" || dt === "STRUCT" || dt === "MAP" || dt === "UNION" || dt === "JSON";
}

export type ComplexKind = "struct" | "list" | "map" | "json" | "union";

/** Map a complex DataType to a lowercase label used in popover titles / status labels. */
export function getComplexKind(dt: DataType): ComplexKind | null {
  switch (dt) {
    case "STRUCT": return "struct";
    case "LIST":   return "list";
    case "MAP":    return "map";
    case "JSON":   return "json";
    case "UNION":  return "union";
    default:       return null;
  }
}

export function dataTypeCategory(dt: DataType): DataTypeCategory {
  if (isBooleanType(dt)) return "boolean";
  if (isNumericType(dt)) return "numeric";
  if (isTemporalType(dt)) return "temporal";
  if (isStringType(dt)) return "string";
  if (isBinaryType(dt)) return "binary";
  if (isComplexType(dt)) return "complex";
  return "other";
}

/**
 * Normalize DuckDB's raw column_type string (from `DESCRIBE`) into a canonical
 * DataType value. Handles parameterized types (VARCHAR(255), DECIMAL(10,2))
 * and compound names (TIMESTAMP WITH TIME ZONE, STRUCT(...), LIST(...)).
 */
export function normalizeDuckDBType(raw: string | undefined | null): DataType {
  if (!raw) return "UNKNOWN";

  // Strip leading/trailing whitespace, uppercase
  let s = raw.trim().toUpperCase();

  // Prefix-based complex types (STRUCT(a INTEGER, ...), LIST(INTEGER), MAP(...), etc.)
  if (s.startsWith("STRUCT")) return "STRUCT";
  // Array/list suffix: matches TYPE[], TYPE[N] (fixed-size ARRAY from
  // array_value / DuckDB ARRAY type), and nested forms like TYPE[3][4].
  if (s.startsWith("LIST") || /\[\d*\]/.test(s)) return "LIST";
  if (s.startsWith("MAP")) return "MAP";
  if (s.startsWith("UNION")) return "UNION";
  if (s.startsWith("ENUM")) return "ENUM";

  // Compound temporal types
  if (s === "TIMESTAMP WITH TIME ZONE" || s === "TIMESTAMPTZ") return "TIMESTAMP_TZ";
  if (s === "TIMESTAMP WITHOUT TIME ZONE") return "TIMESTAMP";
  if (s === "TIMESTAMP_NS") return "TIMESTAMP_NS";
  if (s === "TIMESTAMP_MS") return "TIMESTAMP_MS";
  if (s === "TIMESTAMP_S" || s === "TIMESTAMP(0)") return "TIMESTAMP_S";
  if (s === "TIME WITH TIME ZONE" || s === "TIMETZ") return "TIME_TZ";

  // Strip parameterization: VARCHAR(255) -> VARCHAR, DECIMAL(10,2) -> DECIMAL
  const parenIdx = s.indexOf("(");
  if (parenIdx >= 0) s = s.slice(0, parenIdx);
  s = s.trim();

  // Aliases
  switch (s) {
    case "BOOL":
    case "LOGICAL":
      return "BOOLEAN";

    case "INT1":
      return "TINYINT";
    case "INT2":
    case "SHORT":
      return "SMALLINT";
    case "INT":
    case "INT4":
    case "INT32":
      return "INTEGER";
    case "INT8":
    case "LONG":
    case "INT64":
      return "BIGINT";
    case "INT128":
      return "HUGEINT";

    case "REAL":
    case "FLOAT4":
    case "FLOAT32":
      return "FLOAT";
    case "FLOAT8":
    case "FLOAT64":
    case "DOUBLE PRECISION":
      return "DOUBLE";
    case "NUMERIC":
    case "DEC":
      return "DECIMAL";

    case "TEXT":
    case "STRING":
    case "CHAR":
    case "BPCHAR":
      return "VARCHAR";

    case "BYTEA":
    case "BINARY":
    case "VARBINARY":
      return "BLOB";

    case "BITSTRING":
      return "BIT";
  }

  // Direct matches
  const known: Record<string, DataType> = {
    BOOLEAN: "BOOLEAN",
    TINYINT: "TINYINT",
    SMALLINT: "SMALLINT",
    INTEGER: "INTEGER",
    BIGINT: "BIGINT",
    HUGEINT: "HUGEINT",
    UTINYINT: "UTINYINT",
    USMALLINT: "USMALLINT",
    UINTEGER: "UINTEGER",
    UBIGINT: "UBIGINT",
    UHUGEINT: "UHUGEINT",
    FLOAT: "FLOAT",
    DOUBLE: "DOUBLE",
    DECIMAL: "DECIMAL",
    DATE: "DATE",
    TIME: "TIME",
    TIMESTAMP: "TIMESTAMP",
    INTERVAL: "INTERVAL",
    VARCHAR: "VARCHAR",
    BLOB: "BLOB",
    BIT: "BIT",
    UUID: "UUID",
    JSON: "JSON",
    ENUM: "ENUM",
    LIST: "LIST",
    STRUCT: "STRUCT",
    MAP: "MAP",
    UNION: "UNION",
  };
  const hit = known[s];
  if (hit) return hit;

  return "UNKNOWN";
}

export interface Column {
  name: string;
  key: string | null;
  extra: string | null;
  default: string | null;
  label?: string;
  dataType: DataType;
  /** Original raw column_type string from DuckDB (e.g. "DECIMAL(10,2)") — preserved for display. */
  rawType?: string;
  length?: number;
  hasNulls?: boolean;
  format?: string | Intl.NumberFormatOptions;
}

export interface ColumnStats {
  isCategorical: boolean;
  totalCount: number;
  nullCount: number;
  distinctCount: number;
  valueCounts: Map<string, number>;
  /** Raw (unformatted) values corresponding to each key in valueCounts. Used for temporal/numeric columns where the key is a display string. */
  valueCountsRaw?: Map<string, any>;
  numericStats: ColumnStatsNumeric | null;
  /** For temporal columns: min/max as raw values (BigInt/number). */
  temporalStats?: ColumnStatsTemporal | null;
  /** Histogram bin edges (inclusive start, exclusive end except last bin). Length = binCount + 1. */
  histogramEdges?: number[];
}

export interface ColumnStatsNumeric {
  min: number;
  max: number;
  mean: number;
  median: number;
  stdDev: number;
}

export interface ColumnStatsTemporal {
  /** Min as raw value (BigInt microseconds for TIMESTAMP, etc., or Number of days for DATE). */
  min: number;
  max: number;
}

export interface DatasetMetadata {
  name: string;
  alias?: string;
  fileName?: string;
  description?: string;
  label?: string;
  totalRows: number;
  totalColumns: number;
  columns: Column[];
}

export interface DataProvider {
  getMetadata(): Promise<DatasetMetadata>;
  fetchData(startRow: number, endRow: number): Promise<any[][]>;
  fetchDataColumnRange(startRow: number, endRow: number, startCol: number, endCol: number): Promise<any[][]>;
  /**
   * Stats over the **unfiltered** source. Drives filter-UI bounds: the
   * value-checkbox list, the numeric / temporal range-slider min/max.
   * The full picture is essential there because filtering already
   * removes some categories from view, and the user needs to be able
   * to add them back.
   */
  getColumnStats(column: string | Column): Promise<ColumnStats | null>;
  /**
   * Stats over the **filtered** view (the data the user is actually
   * looking at). Drives the side-panel display: mean / median / sd /
   * histogram. Identical to `getColumnStats` when no filter is active.
   */
  getColumnStatsFiltered(column: string | Column): Promise<ColumnStats | null>;
  /**
   * Look up distinct values in a column matching a pattern. Drives the
   * categorical filter's search input, where the user wants to find a
   * value that isn't in the default top-N list.
   *
   * Always queries the **unfiltered** source for the same reason
   * `getColumnStats` does: the filter UI must let the user broaden
   * the filter to values the current filter is already hiding.
   *
   * `mode`:
   *   - "substring" — case-insensitive `LIKE '%query%'`
   *   - "regex"     — DuckDB `regexp_matches(col, query, 'i')`
   *
   * Results are sorted by count descending (most-frequent first) and
   * capped at `limit`. The caller decides what "too many" means by
   * comparing returned length to limit.
   */
  searchColumnValues(
    column: string | Column,
    options: { query: string; mode: "substring" | "regex"; limit: number },
  ): Promise<Array<{ value: string; count: number }>>;

  setName(name: string): void;
  setDescription(description: string): void;
  setLabel(label: string): void;
}
