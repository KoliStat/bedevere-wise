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
