export const DEFAULT_MAX_HEIGHT = Number.MAX_SAFE_INTEGER;
export const DEFAULT_MAX_WIDTH = Number.MAX_SAFE_INTEGER;

export const DEFAULT_MIN_HEIGHT = 400;
export const DEFAULT_MIN_WIDTH = 600;

export const DEFAULT_CELL_HEIGHT = 24;
export const DEFAULT_MIN_CELL_WIDTH = 100;
export const DEFAULT_MAX_CELL_WIDTH = 1000;
export const DEFAULT_MAX_STRING_LENGTH = 100;

export const DEFAULT_CELL_PADDING = 8;
export const DEFAULT_ROW_HEADER_WIDTH = 60;

// Rendering options
export const DEFAULT_TEXT_RENDERING = "geometricPrecision";
// 0px lets the font's native kerning land on integer pixels. The previous
// 1px polish accumulated half-pixel misalignment over long strings on
// non-integer-dpr displays.
export const DEFAULT_LETTER_SPACING = "0px";
// Disabled because the canvas is text-heavy: bilinear interpolation blurs
// 1px gridlines and softens letter-forms when the backing store is dpr-
// scaled (which it always is now). Re-enable only if we ever paint bitmap
// images into cells.
export const DEFAULT_IMAGE_SMOOTHING_ENABLED = false;
export const DEFAULT_IMAGE_SMOOTHING_QUALITY = "high";

export const DEFAULT_BORDER_WIDTH = 1;
export const DEFAULT_FONT_FAMILY = "Consolas, 'Courier New', monospace";
export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_HEADER_FONT_SIZE = 14;

export const DEFAULT_SCROLLBAR_WIDTH = 12;

export const DEFAULT_NA_TEXT = "NULL";
export const DEFAULT_TRUE_TEXT = "TRUE";
export const DEFAULT_FALSE_TEXT = "FALSE";
export const DEFAULT_TEXT_ALIGN = "left" as const;
export const DEFAULT_DATE_FORMAT = "yyyy-MM-dd";
export const DEFAULT_DATETIME_FORMAT = "yyyy-MM-dd HH:mm:ss";
export const DEFAULT_NUMBER_FORMAT = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
export const DEFAULT_DATETIME_LOCALE = new Intl.Locale("en-UK");

export const DEFAULT_MAX_FORMAT_GUESS_LENGTH = 200; // same as cache chunk size
export const DEFAULT_PERCENT_FORMAT_GUESS_FIT = 0.8;

// Cache options
export const DEFAULT_INITIAL_CACHE_SIZE = 200;
export const DEFAULT_CACHE_CHUNK_SIZE = 50;
export const DEFAULT_MAX_CACHE_SIZE = 1000;
export const DEFAULT_CACHE_TIME_TO_LIVE = 1000 * 60 * 5; // 5 minutes
