import { DEFAULT_FALSE_TEXT, DEFAULT_NA_TEXT, DEFAULT_TRUE_TEXT } from "../defaults";
import { getThemeColors } from "./theme";
import { SpreadsheetOptions } from "../types";
import {
  DataType,
  isBooleanType,
  isComplexType,
  isDateType,
  isNumericType,
  isStringType,
  isTemporalType,
  isTimeType,
  isTimestampType,
} from "../../../data/types";
import { ColumnInternal, CellStyle } from "../internals";

export function parseFormat(format: string | undefined, type: DataType): any {
  if (!format) return undefined;

  try {
    return JSON.parse(format);
  } catch (e) {
    if (isDateType(type) || isTimestampType(type)) {
      const formatMap: { [key: string]: Intl.DateTimeFormatOptions } = {
        "yyyy-MM-dd": { year: "numeric", month: "2-digit", day: "2-digit" },
        "dd/MM/yyyy": { day: "2-digit", month: "2-digit", year: "numeric" },
        "MM/dd/yyyy": { month: "2-digit", day: "2-digit", year: "numeric" },
        "yyyy/MM/dd": { year: "numeric", month: "2-digit", day: "2-digit" },
        "dd-MM-yyyy": { day: "2-digit", month: "2-digit", year: "numeric" },
        "MM-dd-yyyy": { month: "2-digit", day: "2-digit", year: "numeric" },
        yyyyMMdd: { year: "numeric", month: "2-digit", day: "2-digit" },
        ddMMyyyy: { day: "2-digit", month: "2-digit", year: "numeric" },
        MMddyyyy: { month: "2-digit", day: "2-digit", year: "numeric" },
        "yyyy-MM-dd HH:mm:ss": {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        },
        "dd/MM/yyyy HH:mm:ss": {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        },
      };

      const matchedFormat = formatMap[format];
      if (matchedFormat) {
        return matchedFormat;
      }

      if (format.includes("yyyy") || format.includes("MM") || format.includes("dd")) {
        return {
          year: format.includes("yyyy") ? "numeric" : undefined,
          month: format.includes("MM") ? "2-digit" : undefined,
          day: format.includes("dd") ? "2-digit" : undefined,
          hour: format.includes("HH") ? "2-digit" : undefined,
          minute: format.includes("mm") ? "2-digit" : undefined,
          second: format.includes("ss") ? "2-digit" : undefined,
        };
      }
    }
    return undefined;
  }
}

export function getFormatOptions(column: ColumnInternal, options: SpreadsheetOptions): any {
  if (column.format) {
    const parsedFormat = parseFormat(column.format.toString(), column.dataType);
    if (parsedFormat) return parsedFormat;
  }

  if (isNumericType(column.dataType)) {
    // `numberFormat` is typed as Intl.NumberFormatOptions (an object). Feeding
    // it through parseFormat() would stringify it to "[object Object]" and
    // throw away the user's settings, so pass the object through directly.
    return options.numberFormat;
  }
  if (isDateType(column.dataType)) {
    return parseFormat(options.dateFormat?.toString(), column.dataType);
  }
  if (isTimestampType(column.dataType)) {
    return parseFormat(options.datetimeFormat?.toString(), column.dataType);
  }
  return undefined;
}

/**
 * Lazily build and cache an {@link Intl.NumberFormat} or {@link Intl.DateTimeFormat}
 * on the column itself. These constructors are measurably expensive — before
 * memoization they were called on every cell render.
 */
function getColumnFormatter(column: ColumnInternal, options: SpreadsheetOptions): Intl.NumberFormat | Intl.DateTimeFormat | null {
  if (column.cachedFormatter) return column.cachedFormatter;

  const formatOptions = column.guessedFormat || getFormatOptions(column, options);
  if (!formatOptions) return null;

  const locale = options.datetimeLocale;
  if (isNumericType(column.dataType)) {
    column.cachedFormatter = new Intl.NumberFormat(locale, formatOptions);
    return column.cachedFormatter;
  }
  if (isDateType(column.dataType) || isTimestampType(column.dataType)) {
    column.cachedFormatter = new Intl.DateTimeFormat(locale, formatOptions);
    return column.cachedFormatter;
  }
  return null;
}

/**
 * Expand date/time pattern tokens against a {@link Date}'s local-time fields.
 * Intl.DateTimeFormat ignores property order in its options bag (the visual
 * order is locale-driven), so we format literally when the user has picked a
 * pattern string — otherwise switching between "yyyy-MM-dd" and "dd/MM/yyyy"
 * in Settings would produce identical output.
 */
function formatByPattern(value: Date, pattern: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss/g, (tok) => {
    switch (tok) {
      case "yyyy": return String(value.getFullYear());
      case "MM": return pad(value.getMonth() + 1);
      case "dd": return pad(value.getDate());
      case "HH": return pad(value.getHours());
      case "mm": return pad(value.getMinutes());
      case "ss": return pad(value.getSeconds());
      default: return tok;
    }
  });
}

/**
 * Return the effective pattern string for a date / timestamp column, or null
 * to defer to the Intl-based fallback. A column-level `format` string wins
 * over the global setting unless it parses as JSON (in which case the caller
 * should treat it as {@link Intl.DateTimeFormatOptions} via `parseFormat`).
 */
function getDatePattern(
  column: ColumnInternal,
  options: SpreadsheetOptions,
  kind: "date" | "datetime",
): string | null {
  if (typeof column.format === "string") {
    const trimmed = column.format.trim();
    if (trimmed.length > 0 && trimmed[0] !== "{" && trimmed[0] !== "[") {
      return trimmed;
    }
  }
  const fallback = kind === "date" ? options.dateFormat : options.datetimeFormat;
  return typeof fallback === "string" ? fallback : null;
}

/**
 * Format DuckDB TIME values (microseconds since midnight) as HH:MM:SS.
 */
function formatTime(microsSinceMidnight: number): string {
  const totalSeconds = Math.floor(microsSinceMidnight / 1_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Convert a BLOB (Uint8Array) to a hex-encoded string with a length prefix.
 * Limits long blobs to avoid runaway render costs.
 */
function formatBlob(value: any): string {
  if (value == null) return "";
  if (value instanceof Uint8Array) {
    const limit = 32;
    const slice = value.subarray(0, limit);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
    const suffix = value.length > limit ? `... (${value.length}B)` : ` (${value.length}B)`;
    return `0x${hex}${suffix}`;
  }
  return String(value);
}

/**
 * Maximum entries/fields shown in the compact preview before collapsing
 * to "\u2026 N more". Chosen to fit a typical cell width without clipping
 * the closing brace.
 */
const COMPLEX_PREVIEW_MAX_ENTRIES = 3;

/** Cache for the preview number formatter, keyed on the options reference. */
let previewNumFmtCache: { opts: Intl.NumberFormatOptions; fmt: Intl.NumberFormat } | null = null;

function getPreviewNumberFormatter(options: SpreadsheetOptions): Intl.NumberFormat | null {
  const nfOpts = options.numberFormat;
  if (typeof nfOpts !== "object" || nfOpts === null) return null;
  if (previewNumFmtCache && previewNumFmtCache.opts === nfOpts) return previewNumFmtCache.fmt;
  try {
    const fmt = new Intl.NumberFormat(undefined, nfOpts);
    previewNumFmtCache = { opts: nfOpts, fmt };
    return fmt;
  } catch {
    return null;
  }
}

/**
 * Export-flavoured formatter. Complex cells (STRUCT/LIST/MAP/JSON/UNION)
 * serialise to JSON so copy + .export carry the *whole* structure; the
 * truncated `formatComplex` preview is for screen rendering only. Everything
 * else falls through to the regular formatter so dates, numbers, blobs etc.
 * keep their user-configured presentation.
 *
 * BigInt and binary values are coerced to JSON-safe forms (number string
 * for BigInt, regular array for Uint8Array). Defensive `try/catch` falls
 * back to `String(value)` so a circular or otherwise pathological structure
 * doesn't break the whole export.
 */
export function formatForExport(value: any, column: ColumnInternal, options: SpreadsheetOptions): string {
  if (isComplexType(column.dataType)) {
    return stringifyForExport(value);
  }
  return getFormattedValueAndStyle(value, column, options).formatted;
}

function stringifyForExport(value: any): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, (_, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
      if (v instanceof Uint8Array) return Array.from(v);
      return v;
    });
  } catch {
    return String(value);
  }
}

/**
 * Format a complex type (LIST, STRUCT, MAP, JSON) as a compact one-line
 * preview. Objects render as `{ k: v, k: v, k: v, \u2026 N more }`; arrays
 * as `[ v, v, v, \u2026 N more ]`. Nested objects/arrays collapse to
 * `{\u2026}` / `[\u2026]` placeholders to keep the preview single-line.
 * Numbers respect `options.numberFormat` so cell text and status bar agree.
 */
function formatComplex(value: any, options: SpreadsheetOptions): string {
  if (value == null) return "";
  try {
    return previewAny(value, options, false);
  } catch {
    // Defensive fallback so a pathological value doesn't break rendering.
    try {
      return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch {
      return String(value);
    }
  }
}

function previewAny(value: any, options: SpreadsheetOptions, asNested: boolean): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return asNested ? "[\u2026]" : previewArray(value, options);
  }
  if (typeof value === "object") {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return "null";
      return value.toISOString().slice(0, 19).replace("T", " ");
    }
    if (value instanceof Uint8Array) return formatBlob(value);
    return asNested ? "{\u2026}" : previewObject(value as Record<string, any>, options);
  }
  return previewScalar(value, options);
}

function previewArray(arr: any[], options: SpreadsheetOptions): string {
  if (arr.length === 0) return "[]";
  const shown = arr.slice(0, COMPLEX_PREVIEW_MAX_ENTRIES).map((v) => previewAny(v, options, true));
  const more = arr.length - shown.length;
  const parts = shown.join(", ");
  return more > 0 ? `[ ${parts}, \u2026 ${more} more ]` : `[ ${parts} ]`;
}

function previewObject(obj: Record<string, any>, options: SpreadsheetOptions): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const shown = entries
    .slice(0, COMPLEX_PREVIEW_MAX_ENTRIES)
    .map(([k, v]) => `${k}: ${previewAny(v, options, true)}`);
  const more = entries.length - shown.length;
  const parts = shown.join(", ");
  return more > 0 ? `{ ${parts}, \u2026 ${more} more }` : `{ ${parts} }`;
}

function previewScalar(value: any, options: SpreadsheetOptions): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!isFinite(value)) return String(value);
    const fmt = getPreviewNumberFormatter(options);
    return fmt ? fmt.format(value) : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

export const formatValue = (value: any, column: ColumnInternal, options: SpreadsheetOptions): { raw: any; formatted: string } => {
  const naText = options.naText || DEFAULT_NA_TEXT;

  // Handle null/undefined BEFORE any type coercion. Number(null) = 0 and
  // new Date(null) = 1970-01-01, so coercing first would mask real NULLs.
  if (value === null || value === undefined) {
    return { raw: null, formatted: naText };
  }

  // Preserve the original raw value (pre-normalization) for binary/complex types
  const original = value;

  // Normalize BigInt early so isNaN/Date/Number all work
  if (typeof value === "bigint") {
    value = Number(value);
  }

  const dt = column.dataType;

  // Convert to date or number if needed
  if (isNumericType(dt)) {
    value = Number(value);
  }

  if (isDateType(dt) || isTimestampType(dt)) {
    value = value instanceof Date ? value : new Date(value);
  }

  // NaN check only makes sense for numeric coercions; skip for strings, binary, complex
  if ((isNumericType(dt) || isTemporalType(dt)) && typeof value === "number" && isNaN(value)) {
    return { raw: null, formatted: naText };
  }
  if ((isDateType(dt) || isTimestampType(dt)) && value instanceof Date && isNaN(value.getTime())) {
    return { raw: null, formatted: naText };
  }

  // BOOLEAN
  if (isBooleanType(dt)) {
    return { raw: value, formatted: value ? options.trueText || DEFAULT_TRUE_TEXT : options.falseText || DEFAULT_FALSE_TEXT };
  }

  // Numeric
  if (isNumericType(dt)) {
    const formatter = getColumnFormatter(column, options) as Intl.NumberFormat | null;
    return formatter ? { raw: value, formatted: formatter.format(value) } : { raw: value, formatted: value.toLocaleString() };
  }

  // DATE
  if (isDateType(dt)) {
    const pattern = getDatePattern(column, options, "date");
    if (pattern) return { raw: value, formatted: formatByPattern(value as Date, pattern) };
    const formatter = getColumnFormatter(column, options) as Intl.DateTimeFormat | null;
    return formatter ? { raw: value, formatted: formatter.format(value) } : { raw: value, formatted: (value as Date).toLocaleDateString() };
  }

  // TIME / TIME_TZ
  if (isTimeType(dt)) {
    return { raw: value, formatted: formatTime(value) };
  }

  // TIMESTAMP variants
  if (isTimestampType(dt)) {
    const pattern = getDatePattern(column, options, "datetime");
    if (pattern) return { raw: value, formatted: formatByPattern(value as Date, pattern) };
    const formatter = getColumnFormatter(column, options) as Intl.DateTimeFormat | null;
    return formatter ? { raw: value, formatted: formatter.format(value) } : { raw: value, formatted: (value as Date).toLocaleString() };
  }

  // INTERVAL - DuckDB returns interval objects; stringify
  if (dt === "INTERVAL") {
    return { raw: value, formatted: String(value) };
  }

  // String-like (VARCHAR, UUID, ENUM)
  if (isStringType(dt)) {
    return { raw: value, formatted: String(value) };
  }

  // Binary
  if (dt === "BLOB" || dt === "BIT") {
    return { raw: original, formatted: formatBlob(original) };
  }

  // Complex / JSON
  if (isComplexType(dt)) {
    return { raw: original, formatted: formatComplex(original, options) };
  }

  // Unknown — fall back to string
  return { raw: value, formatted: String(value) };
};

// ----------------------------------------------------------------------
// Cell-format scratch struct + hot-path entrypoint
// ----------------------------------------------------------------------
//
// The render loop calls `formatValueIntoScratch` once per visible cell,
// reusing a single FormattedScratch instance. That eliminates the
// per-cell `{ raw, formatted, style: {...} }` object literal that
// `getFormattedValueAndStyle` allocates — at 1,600 visible cells × 60fps
// that's ~96k allocations/sec saved off the GC, plus the nested
// `style: {}` literal.
//
// The CellStyle pointers (textColor / backgroundColor / textAlign) are
// constants on the theme object — so the scratch holds string references,
// not copies, and switches between them by pointer.

export interface FormattedScratch {
  raw: any;
  formatted: string;
  textAlign: "left" | "center" | "right";
  textColor: string;
  backgroundColor: string;
}

export function makeFormattedScratch(): FormattedScratch {
  return {
    raw: null,
    formatted: "",
    textAlign: "left",
    textColor: "",
    backgroundColor: "",
  };
}

/**
 * Hot-path formatter. Mutates `out` in place and returns nothing.
 *
 * Style pointers are taken directly from the theme cache; the theme
 * object itself is module-cached and only rebuilt on theme flip, so this
 * function allocates exactly the strings produced by `formatValue`
 * (which it can't avoid — the formatted text is genuinely new each call).
 */
export function formatValueIntoScratch(
  value: any,
  column: ColumnInternal,
  options: SpreadsheetOptions,
  out: FormattedScratch,
): void {
  const dt = column.dataType;
  const theme = getThemeColors();

  if (value === null || value === undefined) {
    out.raw = null;
    out.formatted = formatValue(value, column, options).formatted;
    out.textAlign = "left";
    out.textColor = theme.nullStyle.textColor;
    out.backgroundColor = theme.nullStyle.backgroundColor;
    return;
  }

  const { raw, formatted } = formatValue(value, column, options);
  out.raw = raw;
  out.formatted = formatted;

  if (isBooleanType(dt)) {
    out.textAlign = "center";
    out.textColor = theme.booleanStyle.textColor;
    out.backgroundColor = theme.booleanStyle.backgroundColor;
    return;
  }
  if (isNumericType(dt)) {
    out.textAlign = "right";
    out.textColor = theme.numericStyle.textColor;
    out.backgroundColor = theme.numericStyle.backgroundColor;
    return;
  }
  if (isDateType(dt) || isTimeType(dt)) {
    out.textAlign = "left";
    out.textColor = theme.dateStyle.textColor;
    out.backgroundColor = theme.dateStyle.backgroundColor;
    return;
  }
  if (isTimestampType(dt)) {
    out.textAlign = "left";
    out.textColor = theme.datetimeStyle.textColor;
    out.backgroundColor = theme.datetimeStyle.backgroundColor;
    return;
  }
  // VARCHAR, UUID, ENUM, BLOB, INTERVAL, complex, unknown
  out.textAlign = "left";
  out.textColor = theme.stringStyle.textColor;
  out.backgroundColor = theme.stringStyle.backgroundColor;
}

/**
 * Allocating wrapper kept for cold-path callers (selection export, copy
 * formatting). Hot-path callers should use `formatValueIntoScratch` with
 * a long-lived scratch object.
 */
export function getFormattedValueAndStyle(
  value: any,
  column: ColumnInternal,
  options: SpreadsheetOptions,
): { raw: any; formatted: string; style: Partial<CellStyle> } {
  const out = makeFormattedScratch();
  formatValueIntoScratch(value, column, options, out);
  return {
    raw: out.raw,
    formatted: out.formatted,
    style: {
      textAlign: out.textAlign,
      textColor: out.textColor,
      backgroundColor: out.backgroundColor,
    },
  };
}
