import { Column, ComplexKind } from "@/data/types";

export interface SpreadsheetOptions {
  // Viewport options
  maxHeight?: number;
  maxWidth?: number;
  minHeight?: number;
  minWidth?: number;
  height?: number | undefined;
  width?: number | undefined;

  // Cell options
  cellHeight?: number;
  minCellWidth?: number;
  maxCellWidth?: number;
  maxStringLength?: number;
  cellPadding?: number;
  rowHeaderWidth?: number;

  // Rendering options
  textRendering?: "auto" | "geometricPrecision";
  letterSpacing?: string;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: "low" | "medium" | "high";

  // Style options
  borderWidth?: number;
  fontFamily?: string;
  fontSize?: number;
  headerFontSize?: number;
  headerBackgroundColor?: string;
  headerTextColor?: string;
  cellBackgroundColor?: string;
  cellTextColor?: string;
  stripeBackgroundColor?: string;
  borderColor?: string;
  selectionColor?: string;
  selectionBorderColor?: string;
  hoverColor?: string;
  hoverBorderColor?: string;

  // Scrollbar options
  scrollbarWidth?: number;
  scrollbarColor?: string;
  scrollbarThumbColor?: string;
  scrollbarHoverColor?: string;

  naText?: string;
  trueText?: string;
  falseText?: string;
  textAlign?: "left" | "center" | "right";

  numberFormat?: Intl.NumberFormatOptions;
  dateFormat?: string;
  datetimeFormat?: string;
  datetimeLocale?: Intl.Locale;

  maxFormatGuessLength?: number;
  percentFormatGuessFit?: number;

  // Cache options
  initialCacheSize?: number;
  cacheChunkSize?: number;
  maxCacheSize?: number;
  cacheTimeToLive?: number;
}

export interface ICellSelection {
  rows: number[];
  columns: Column[];
  values: any[][];
  formatted: string[][];
}

/**
 * Payload for "user wants to inspect this cell" events (double-click on
 * a complex-typed cell). Carries everything the inspector popover needs
 * so subscribers don't depend on the selection-change pipeline timing.
 */
export interface CellInspectInfo {
  columnName: string;
  kind: ComplexKind;
  value: any;
}
