/**
 * File-export format catalog.
 *
 * These are the formats the `.export` command writes via DuckDB's
 * `COPY <table> TO '<file>' (FORMAT <name>)` — as opposed to the
 * client-side, selection-based text exports (csv / tsv / html / markdown)
 * in ExportHub.ts, which serialize the formatted grid in the renderer.
 *
 * Two families:
 *   - DuckDB-native (parquet, json) — available on any DuckDB engine.
 *   - stats_duck (xpt, sav, por, sas7bdat) — the COPY functions
 *     registered by the stats_duck extension (see the-stats-duck
 *     `RegisterSasExport`). Gated behind the engine having stats_duck
 *     loaded, surfaced via `BackendCapabilities.visualize`.
 *
 * The `duckFormat` string is the exact COPY `FORMAT` name each engine
 * understands; `ext` is the file extension used for the download name
 * (web) / the native Save dialog default (desktop). Both DuckDB-native
 * and stats_duck COPY functions also infer the format from the file
 * extension, but we pass FORMAT explicitly so a user-chosen path with an
 * unexpected extension still writes the intended format.
 */

export type ExportFormat = "parquet" | "json" | "xpt" | "sav" | "por" | "sas7bdat";

export interface ExportFormatMeta {
  format: ExportFormat;
  /** File extension, no leading dot. */
  ext: string;
  /** COPY `FORMAT` name. Allowlisted host-side before interpolation. */
  duckFormat: string;
  /** MIME type for the web Blob download. */
  mime: string;
  /** Short label for help text / completion. */
  label: string;
  /**
   * True when only the stats_duck extension provides this COPY function.
   * The `.export` command hides these unless the backend reports
   * `capabilities.visualize` (the reliable "stats_duck loaded" signal).
   */
  requiresStatsDuck: boolean;
}

export const EXPORT_FORMATS: Record<ExportFormat, ExportFormatMeta> = {
  parquet: {
    format: "parquet",
    ext: "parquet",
    duckFormat: "parquet",
    mime: "application/vnd.apache.parquet",
    label: "Parquet",
    requiresStatsDuck: false,
  },
  json: {
    format: "json",
    ext: "json",
    duckFormat: "json",
    mime: "application/json",
    label: "JSON",
    requiresStatsDuck: false,
  },
  xpt: {
    format: "xpt",
    ext: "xpt",
    duckFormat: "xpt",
    mime: "application/x-sas-xport",
    label: "SAS Transport (.xpt)",
    requiresStatsDuck: true,
  },
  sav: {
    format: "sav",
    ext: "sav",
    duckFormat: "sav",
    mime: "application/x-spss-sav",
    label: "SPSS (.sav)",
    requiresStatsDuck: true,
  },
  por: {
    format: "por",
    ext: "por",
    duckFormat: "por",
    mime: "application/x-spss-por",
    label: "SPSS Portable (.por)",
    requiresStatsDuck: true,
  },
  sas7bdat: {
    format: "sas7bdat",
    ext: "sas7bdat",
    duckFormat: "sas7bdat",
    // ReadStat's sas7bdat writer is reverse-engineered: round-trips
    // through ReadStat-family readers (this app, pyreadstat, haven, R)
    // but real SAS / SAS Universal Viewer won't open it. Use .xpt for
    // SAS-native readability. See the-stats-duck README.
    mime: "application/x-sas-data",
    label: "SAS7BDAT (.sas7bdat — not real-SAS readable)",
    requiresStatsDuck: true,
  },
};

/** Ordered list for completion / menus (native first, then stat formats). */
export const EXPORT_FORMAT_ORDER: ExportFormat[] = [
  "parquet",
  "json",
  "xpt",
  "sav",
  "por",
  "sas7bdat",
];

/** Narrow an arbitrary string to a known file-export format. */
export function isExportFormat(s: string): s is ExportFormat {
  return Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, s);
}
