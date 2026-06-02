/**
 * Number / date / cell-rendering preferences exposed by the Settings
 * tab. `FormatPrefs` is the shape PersistenceService round-trips; the
 * preset arrays drive the dropdowns in the dialog so users get sane
 * defaults without typing format strings.
 */
export interface FormatPrefs {
  dateFormat: string;
  datetimeFormat: string;
  numberMinDecimals: number;
  numberMaxDecimals: number;
  numberUseGrouping: boolean;
  minCellWidth: number;
  maxStringLength: number;
  /** Bytes. Files at or below this size auto-import silently on drop /
   *  folder scan; above, the user clicks-to-open. `0` disables auto-
   *  import — every file is user-driven. */
  autoImportSizeThreshold: number;
}

export const DATE_FORMAT_PRESETS: string[] = [
  "yyyy-MM-dd",
  "dd/MM/yyyy",
  "MM/dd/yyyy",
  "yyyy/MM/dd",
  "yyyyMMdd",
];

export const DATETIME_FORMAT_PRESETS: string[] = [
  "yyyy-MM-dd HH:mm:ss",
  "dd/MM/yyyy HH:mm:ss",
];

export const DECIMAL_PRESETS: number[] = [0, 1, 2, 3, 4];

export const MIN_CELL_WIDTH_PRESETS: number[] = [50, 75, 100, 150, 200];

/** 0 means "no cap" — the dropdown labels it as "None". */
export const MAX_STRING_LENGTH_PRESETS: number[] = [50, 100, 200, 500, 0];

/** Auto-import threshold presets in bytes. 0 disables auto-import
 *  (every file requires a click). The default is 1_048_576 (1 MB). */
export const AUTO_IMPORT_THRESHOLD_PRESETS: number[] = [10_240, 102_400, 1_048_576, 10_485_760, 0];
export const DEFAULT_AUTO_IMPORT_THRESHOLD = 1_048_576;

/** Friendly label for the threshold dropdown. */
export function formatThresholdLabel(bytes: number): string {
  if (bytes === 0) return "Off";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
