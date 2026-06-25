import { Column, DataType } from "../../data/types";
import { SpreadsheetOptions } from "./types";
import { getFormatOptions } from "./utils/formatting";

export interface CellStyle {
  backgroundColor?: string;
  textColor?: string;
  fontSize?: number;
  fontFamily?: string;
  textAlign?: "left" | "center" | "right";
  padding?: number;
  numericColor?: string;
  dateColor?: string;
  nullColor?: string;
}

export class ColumnInternal implements Column {
  name: string;
  key: string | null;
  extra: string | null;
  default: string | null;
  label?: string;
  dataType: DataType;
  rawType?: string;
  length?: number;
  format?: string | Intl.NumberFormatOptions;
  hasNulls?: boolean;
  widthPx: number = 0;
  guessedFormat: any = undefined;
  /**
   * Memoized {@link Intl.NumberFormat} or {@link Intl.DateTimeFormat} for this
   * column. Populated lazily on first use; avoids reconstructing the formatter
   * per cell render.
   */
  cachedFormatter: Intl.NumberFormat | Intl.DateTimeFormat | null = null;

  constructor(column: Column, options: SpreadsheetOptions) {
    this.name = column.name;
    this.key = column.key;
    this.extra = column.extra;
    this.default = column.default;
    this.dataType = column.dataType;
    this.rawType = column.rawType;
    this.label = column.label;
    this.length = column.length;
    this.format = column.format;
    this.hasNulls = column.hasNulls;
    this.widthPx = 0;
    this.guessedFormat = getFormatOptions(this, options);
  }
}
