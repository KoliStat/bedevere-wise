import {
  DEFAULT_MAX_WIDTH,
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MIN_WIDTH,
  DEFAULT_CELL_HEIGHT,
  DEFAULT_CELL_PADDING,
  DEFAULT_ROW_HEADER_WIDTH,
  DEFAULT_MIN_CELL_WIDTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_FONT_FAMILY,
  DEFAULT_HEADER_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  DEFAULT_BORDER_WIDTH,
  DEFAULT_SCROLLBAR_WIDTH,
  DEFAULT_DATE_FORMAT,
  DEFAULT_DATETIME_FORMAT,
  DEFAULT_NUMBER_FORMAT,
  DEFAULT_MAX_CELL_WIDTH,
  DEFAULT_PERCENT_FORMAT_GUESS_FIT,
  DEFAULT_MAX_FORMAT_GUESS_LENGTH,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_NA_TEXT,
  DEFAULT_TRUE_TEXT,
  DEFAULT_FALSE_TEXT,
  DEFAULT_IMAGE_SMOOTHING_ENABLED,
  DEFAULT_LETTER_SPACING,
  DEFAULT_IMAGE_SMOOTHING_QUALITY,
  DEFAULT_TEXT_RENDERING,
  DEFAULT_DATETIME_LOCALE,
  DEFAULT_INITIAL_CACHE_SIZE,
  DEFAULT_CACHE_CHUNK_SIZE,
  DEFAULT_MAX_CACHE_SIZE,
  DEFAULT_CACHE_TIME_TO_LIVE,
} from "./defaults";
import { getThemeColors } from "./utils/theme";
import { SpreadsheetOptions } from "./types";
import { DataProvider, DatasetMetadata } from "../../data/types";
import { ColumnInternal } from "./internals";
import { minMax, setMeasureSignature, truncateWithEllipsis } from "./utils/drawing";
import { formatValueIntoScratch, getFormatOptions, makeFormattedScratch } from "./utils/formatting";
import { SpreadsheetCache } from "./SpreadsheetCache";
import { ColumnFilterManager } from "../../data/ColumnFilterManager";
import { ResizeHandles } from "./overlays/ResizeHandles";

export enum ToDraw {
  None = 0,
  CellHover = 1,
  RowHover = 2,
  ColHover = 3,
  Selection = 4,
  Cells = 5,
}

export enum MouseState {
  Idle,
  Dragging,
  Hovering,
  HoveringVerticalScrollbar,
  HoveringHorizontalScrollbar,
  DraggingVerticalScrollbar,
  DraggingHorizontalScrollbar,
}

type RequiredSpreadsheetOptions = Omit<Required<SpreadsheetOptions>, "height" | "width"> & {
  height: number;
  width: number;
};

export class SpreadsheetVisualizerBase {
  protected container: HTMLElement;
  protected scrollContainer: HTMLElement;
  protected scrollSpacer: HTMLElement;
  protected canvasGroup: HTMLElement;
  protected canvas: HTMLCanvasElement;
  protected selectionCanvas: HTMLCanvasElement;
  protected hoverCanvas: HTMLCanvasElement;
  protected ctx: CanvasRenderingContext2D;
  protected selectionCtx: CanvasRenderingContext2D;
  protected hoverCtx: CanvasRenderingContext2D;
  protected dataProvider: DataProvider;
  protected metadata: DatasetMetadata | null = null;
  protected columns: ColumnInternal[];
  protected totalRows: number;
  protected totalCols: number;
  protected options: RequiredSpreadsheetOptions;

  // State variables
  protected scrollX = 0;
  protected scrollY = 0;
  protected cache: SpreadsheetCache;

  // Layout cache
  protected colWidths: number[] = [];
  protected colOffsets: number[] = [];
  protected totalWidth = 0;
  protected totalHeight = 0;
  protected totalScrollY = 0;
  protected totalScrollX = 0;

  // Viewport size in CSS pixels. Distinct from `canvas.width`/`canvas.height`
  // which now hold the dpr-scaled backing-store dimensions. All layout math
  // (scroll, hit-testing, scrollIntoView) reads these instead. `viewportHeight`
  // is snapped down to `header + N × rowHeight` so the canvas never shows
  // a partial row at the bottom (see updateLayout); `lastObservedClientHeight`
  // tracks the unsnapped scrollContainer height so the resize-observer's
  // "did anything change" check doesn't loop on the snap delta.
  protected viewportWidth = 0;
  protected viewportHeight = 0;
  protected lastObservedClientWidth = 0;
  protected lastObservedClientHeight = 0;
  protected dpr = 1;

  // Filter/sort state for header indicators
  protected filterManager: ColumnFilterManager | null = null;
  protected datasetName: string = "";

  // Theme management
  protected themeCleanup: (() => void) | null = null;

  // Reusable per-cell scratch — written by formatValueIntoScratch in the
  // tight inner loop. Lives on `this` so its allocation amortises across
  // all draws (one allocation per spreadsheet, not per cell per frame).
  private cellScratch = makeFormattedScratch();

  // Column-resize handles overlay (Phase C item 1). Mounted inside the
  // canvas group so it shares the sticky-to-viewport coordinate frame.
  protected resizeHandles!: ResizeHandles;

  constructor(container: HTMLElement, dataProvider: DataProvider, options: Partial<SpreadsheetOptions> = {}) {
    this.container = container;

    // Scroll container: native scrollbars replace the old canvas-drawn ones.
    // A spacer div inside creates the full content extent; the canvas group
    // sticks to the viewport via position:sticky.
    this.scrollContainer = document.createElement("div");
    this.scrollContainer.style.cssText = "overflow:auto;position:relative;width:100%;height:100%;outline:none;";
    this.scrollContainer.tabIndex = 0; // Make focusable for keyboard events

    this.scrollSpacer = document.createElement("div");
    this.scrollSpacer.style.cssText = "position:relative;";

    this.canvasGroup = document.createElement("div");
    this.canvasGroup.style.cssText = "position:sticky;top:0;left:0;width:0;height:0;";

    // Main canvas
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d")!;

    // Selection overlay canvas
    this.selectionCanvas = document.createElement("canvas");
    this.selectionCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;";
    this.selectionCtx = this.selectionCanvas.getContext("2d", { alpha: true })!;

    // Hover overlay canvas
    this.hoverCanvas = document.createElement("canvas");
    this.hoverCanvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none;";
    this.hoverCtx = this.hoverCanvas.getContext("2d", { alpha: true })!;

    this.canvasGroup.appendChild(this.canvas);
    this.canvasGroup.appendChild(this.selectionCanvas);
    this.canvasGroup.appendChild(this.hoverCanvas);
    this.scrollSpacer.appendChild(this.canvasGroup);
    this.scrollContainer.appendChild(this.scrollSpacer);
    this.container.appendChild(this.scrollContainer);

    // Resize-handle overlay — lazy-reads layout state through closures so
    // it's safe to instantiate before this.options is set; first call
    // happens after setData → calculateColumnWidths → relayout.
    this.resizeHandles = new ResizeHandles(this.canvasGroup, {
      getColWidths: () => this.colWidths,
      getColOffsets: () => this.colOffsets,
      getHeaderHeight: () => this.options.cellHeight,
      getViewportHeight: () => this.viewportHeight,
      getScrollX: () => this.scrollX,
      getMinCellWidth: () => this.options.minCellWidth,
      getRowHeaderWidth: () => this.options.rowHeaderWidth,
      applyColumnResize: (col, newWidth) => this.applyColumnResize(col, newWidth),
    });

    // Sync scroll position from native scrollbar to internal state.
    // The draw is deferred to the next animation frame via `scheduleDraw`
    // so a burst of scroll events in one frame collapses to a single
    // redraw — a wheel-spin that fires 20 events per frame used to paint
    // 20 times; now it paints once.
    this.scrollContainer.addEventListener("scroll", () => {
      this.scrollX = this.scrollContainer.scrollLeft;
      this.scrollY = this.scrollContainer.scrollTop;
      this.preloadDataForScroll(this.scrollY);
      this.updateToDraw(ToDraw.Cells);
      this.scheduleDraw();
      this.resizeHandles.relayout();
    });

    // Prevent the scroll container from handling navigation keys synchronously.
    // The EventDispatcher processes keydown asynchronously, so its preventDefault()
    // runs too late — the browser has already scrolled the container. This listener
    // fires synchronously during the bubble phase before the default action.
    this.scrollContainer.addEventListener("keydown", (e) => {
      const navKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
      if (navKeys.includes(e.key)) {
        e.preventDefault();
      }
    });

    // Initialize data provider
    this.dataProvider = dataProvider;

    this.columns = [];
    this.totalRows = 0;
    this.totalCols = 0;

    // Set default options
    const t = getThemeColors();
    this.options = {
      // Viewport options
      maxHeight: options.maxHeight ?? DEFAULT_MAX_HEIGHT,
      maxWidth: options.maxWidth ?? DEFAULT_MAX_WIDTH,
      minHeight: options.minHeight ?? DEFAULT_MIN_HEIGHT,
      minWidth: options.minWidth ?? DEFAULT_MIN_WIDTH,
      height: options.height ?? this.container.clientHeight,
      width: options.width ?? this.container.clientWidth,

      // Cell options
      cellHeight: options.cellHeight ?? DEFAULT_CELL_HEIGHT,
      minCellWidth: options.minCellWidth ?? DEFAULT_MIN_CELL_WIDTH,
      maxCellWidth: options.maxCellWidth ?? DEFAULT_MAX_CELL_WIDTH,
      maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
      cellPadding: options.cellPadding ?? DEFAULT_CELL_PADDING,
      rowHeaderWidth: options.rowHeaderWidth ?? DEFAULT_ROW_HEADER_WIDTH,

      // Rendering options
      textRendering: options.textRendering ?? DEFAULT_TEXT_RENDERING,
      letterSpacing: options.letterSpacing ?? DEFAULT_LETTER_SPACING,
      imageSmoothingEnabled: options.imageSmoothingEnabled ?? DEFAULT_IMAGE_SMOOTHING_ENABLED,
      imageSmoothingQuality: options.imageSmoothingQuality ?? DEFAULT_IMAGE_SMOOTHING_QUALITY,

      // Style options
      borderWidth: options.borderWidth ?? DEFAULT_BORDER_WIDTH,
      fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
      fontSize: options.fontSize ?? DEFAULT_FONT_SIZE,
      headerFontSize: options.headerFontSize ?? DEFAULT_HEADER_FONT_SIZE,
      headerBackgroundColor: options.headerBackgroundColor ?? t.headerBackgroundColor,
      headerTextColor: options.headerTextColor ?? t.headerTextColor,
      cellBackgroundColor: options.cellBackgroundColor ?? t.cellBackgroundColor,
      cellTextColor: options.cellTextColor ?? t.cellTextColor,
      stripeBackgroundColor: options.stripeBackgroundColor ?? t.stripeBackgroundColor,
      borderColor: options.borderColor ?? t.borderColor,
      selectionColor: options.selectionColor ?? t.selectionColor,
      selectionBorderColor: options.selectionBorderColor ?? t.selectionBorderColor,
      hoverColor: options.hoverColor ?? t.hoverColor,
      hoverBorderColor: options.hoverBorderColor ?? t.hoverBorderColor,

      // Scrollbar options
      scrollbarWidth: options.scrollbarWidth ?? DEFAULT_SCROLLBAR_WIDTH,
      scrollbarColor: options.scrollbarColor ?? t.scrollbarColor,
      scrollbarThumbColor: options.scrollbarThumbColor ?? t.scrollbarThumbColor,
      scrollbarHoverColor: options.scrollbarHoverColor ?? t.scrollbarHoverColor,

      dateFormat: options.dateFormat ?? DEFAULT_DATE_FORMAT,
      datetimeFormat: options.datetimeFormat ?? DEFAULT_DATETIME_FORMAT,
      datetimeLocale: options.datetimeLocale ?? DEFAULT_DATETIME_LOCALE,
      numberFormat: options.numberFormat ?? DEFAULT_NUMBER_FORMAT,

      naText: options.naText ?? DEFAULT_NA_TEXT,
      trueText: options.trueText ?? DEFAULT_TRUE_TEXT,
      falseText: options.falseText ?? DEFAULT_FALSE_TEXT,
      textAlign: options.textAlign ?? DEFAULT_TEXT_ALIGN,

      maxFormatGuessLength: options.maxFormatGuessLength ?? DEFAULT_MAX_FORMAT_GUESS_LENGTH,
      percentFormatGuessFit: options.percentFormatGuessFit ?? DEFAULT_PERCENT_FORMAT_GUESS_FIT,

      // Cache options
      initialCacheSize: options.initialCacheSize ?? DEFAULT_INITIAL_CACHE_SIZE,
      cacheChunkSize: options.cacheChunkSize ?? DEFAULT_CACHE_CHUNK_SIZE,
      maxCacheSize: options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
      cacheTimeToLive: options.cacheTimeToLive ?? DEFAULT_CACHE_TIME_TO_LIVE,
    };

    // Initialize the data cache with initial data
    this.cache = new SpreadsheetCache(this.dataProvider, this.options);

    // Apply constraints
    this.options.height = minMax(this.options.height, this.options.minHeight, this.options.maxHeight);
    this.options.width = minMax(this.options.width, this.options.minWidth, this.options.maxWidth);

    this.installContainerObservers();
    this.attachCacheListener();
  }

  /**
   * Wire the spreadsheet to the cache's "chunk loaded" event so skeleton
   * rows flip to real data on the next frame after the fetch resolves.
   * Stored subscription is disposed in {@link destroyBase}; the caller
   * must invoke this again after replacing the cache (see
   * {@link SpreadsheetVisualizer.reinitialize}).
   */
  private cacheLoadedUnsubscribe: (() => void) | null = null;
  protected attachCacheListener(): void {
    this.cacheLoadedUnsubscribe?.();
    this.cacheLoadedUnsubscribe = this.cache.onLoaded(() => {
      this.updateToDraw(ToDraw.Cells);
      this.scheduleDraw();
    });
  }

  // ResizeObserver for the spreadsheet container so the canvas reflows when
  // the dataset container changes size (left panel toggled, SQL editor
  // expanded, theme tab opened, etc.). The TabManager already has a coarser
  // observer for window resize; this one is per-instance and finer-grained.
  private resizeObserver: ResizeObserver | null = null;
  // Media query that flips when devicePixelRatio changes (laptop docking,
  // browser zoom, OS scaling). On change we re-allocate the canvas backing
  // store so retina sharpness survives the change.
  private dprMediaQuery: MediaQueryList | null = null;
  private dprChangeHandler: (() => void) | null = null;

  private installContainerObservers(): void {
    if (typeof window === "undefined") return;

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        // Defensive: only react if dimensions actually changed. ResizeObserver
        // fires on layout passes that may produce identical sizes.
        //
        // We compare against the scroll container's content-box dims (not
        // the outer container's), matching what `updateLayout` measures
        // from. Observing the scrollContainer additionally catches
        // scrollbar-toggle events — when the spacer grows enough for the
        // horizontal scrollbar to appear, the scrollContainer's
        // clientHeight shrinks even though the outer container's stays
        // put, and we re-layout the canvas to fit the new content box.
        //
        // The check tracks the *unsnapped* clientWidth/Height; the
        // snapped `viewportHeight` differs from clientHeight by up to
        // `cellHeight - 1`, so comparing to viewportHeight directly
        // would trigger a perpetual relayout loop after the first snap.
        if (
          this.scrollContainer.clientWidth !== this.lastObservedClientWidth ||
          this.scrollContainer.clientHeight !== this.lastObservedClientHeight
        ) {
          this.requestRelayout();
        }
      });
      this.resizeObserver.observe(this.container);
      this.resizeObserver.observe(this.scrollContainer);
    }

    this.armDprListener();
  }

  private armDprListener(): void {
    this.disarmDprListener();
    const current = this.dpr || 1;
    try {
      this.dprMediaQuery = window.matchMedia(`(resolution: ${current}dppx)`);
      this.dprChangeHandler = () => {
        // dpr changed → re-arm the listener at the new ratio and force
        // the canvas to re-allocate.
        this.armDprListener();
        this.requestRelayout();
      };
      this.dprMediaQuery.addEventListener("change", this.dprChangeHandler);
    } catch {
      // matchMedia with a `dppx` argument is supported broadly but guard
      // against engines that don't accept the resolution syntax.
      this.dprMediaQuery = null;
      this.dprChangeHandler = null;
    }
  }

  private disarmDprListener(): void {
    if (this.dprMediaQuery && this.dprChangeHandler) {
      this.dprMediaQuery.removeEventListener("change", this.dprChangeHandler);
    }
    this.dprMediaQuery = null;
    this.dprChangeHandler = null;
  }

  /**
   * Trigger the subclass's resize handling. Defined as a stub here; the
   * Focusable subclass overrides `handleResize()` and that's what runs at
   * runtime. Routing through a single method keeps Base ignorant of the
   * subclass surface while still letting the observers above drive a
   * relayout.
   */
  private requestRelayout(): void {
    const handler = (this as unknown as { handleResize?: () => Promise<unknown> }).handleResize;
    if (handler) handler.call(this).catch((err) => console.error("handleResize failed:", err));
  }

  // RAF-batched draw. Multiple `scheduleDraw()` calls within the same
  // frame coalesce to one paint at the next animation frame.
  private pendingDraw: number | null = null;

  protected scheduleDraw(): void {
    if (this.pendingDraw !== null) return;
    this.pendingDraw = requestAnimationFrame(() => {
      this.pendingDraw = null;
      this.draw().catch((err) => console.error("draw failed:", err));
    });
  }

  protected cancelScheduledDraw(): void {
    if (this.pendingDraw !== null) {
      cancelAnimationFrame(this.pendingDraw);
      this.pendingDraw = null;
    }
  }

  /**
   * Tear down per-instance observers. Visualizer.destroy() is the chained
   * caller; subclasses without their own destroy inherit nothing extra.
   */
  protected destroyBase(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.disarmDprListener();
    this.cancelScheduledDraw();
    this.cacheLoadedUnsubscribe?.();
    this.cacheLoadedUnsubscribe = null;
  }

  // Overridden by SpreadsheetVisualizerSelection — stubs needed for scroll listener
  protected updateToDraw(_toDraw: ToDraw): void {}
  protected async draw(): Promise<void> {}

  /** Programmatically scroll to a position via the native scroll container. */
  protected scrollTo(x: number, y: number): void {
    this.scrollContainer.scrollLeft = Math.max(0, Math.min(x, this.totalScrollX));
    this.scrollContainer.scrollTop = Math.max(0, Math.min(y, this.totalScrollY));
  }

  /** Scroll the minimum amount needed to bring a cell into the visible area. */
  protected scrollCellIntoView(row: number, col: number): void {
    const cellY = row * this.options.cellHeight;
    const cellX = col < this.colOffsets.length ? this.colOffsets[col] : 0;
    const cellW = col < this.colWidths.length ? this.colWidths[col] : 0;
    const cellH = this.options.cellHeight;
    const headerH = this.options.cellHeight; // header row height

    let newScrollY = this.scrollY;
    let newScrollX = this.scrollX;

    // Vertical: keep cell within viewport (below header)
    if (cellY < this.scrollY + headerH) {
      newScrollY = cellY - headerH;
    } else if (cellY + cellH > this.scrollY + this.viewportHeight) {
      newScrollY = cellY + cellH - this.viewportHeight;
    }

    // Horizontal: keep cell within viewport (past row header)
    const rowHeaderW = this.options.rowHeaderWidth;
    if (cellX < this.scrollX + rowHeaderW) {
      newScrollX = cellX - rowHeaderW;
    } else if (cellX + cellW > this.scrollX + this.viewportWidth) {
      newScrollX = cellX + cellW - this.viewportWidth;
    }

    if (newScrollX !== this.scrollX || newScrollY !== this.scrollY) {
      this.scrollTo(newScrollX, newScrollY);
    }
  }

  // Accessor methods for wrapper
  public getContainer(): HTMLElement {
    return this.container;
  }

  public getOptions(): SpreadsheetOptions {
    return this.options;
  }

  public getDataProvider(): DataProvider {
    return this.dataProvider;
  }

  public setFilterManager(filterManager: ColumnFilterManager, datasetName: string): void {
    this.filterManager = filterManager;
    this.datasetName = datasetName;
  }

  /**
   * Re-apply display preferences (dateFormat, datetimeFormat, datetimeLocale,
   * numberFormat, minCellWidth, maxStringLength) at runtime. Clears each
   * column's cached Intl formatter, re-seeds guessedFormat, recomputes
   * column widths (formatted-value widths depend on decimals / grouping /
   * string cap) and redraws.
   */
  public async refreshFormat(partial: Partial<SpreadsheetOptions>): Promise<void> {
    if (partial.dateFormat !== undefined) this.options.dateFormat = partial.dateFormat;
    if (partial.datetimeFormat !== undefined) this.options.datetimeFormat = partial.datetimeFormat;
    if (partial.datetimeLocale !== undefined) this.options.datetimeLocale = partial.datetimeLocale;
    if (partial.numberFormat !== undefined) this.options.numberFormat = partial.numberFormat;
    if (partial.minCellWidth !== undefined) this.options.minCellWidth = partial.minCellWidth;
    if (partial.maxStringLength !== undefined) this.options.maxStringLength = partial.maxStringLength;

    for (const col of this.columns) {
      col.cachedFormatter = null;
      col.guessedFormat = getFormatOptions(col, this.options);
    }

    await this.calculateColumnWidths();
    this.updateToDraw(ToDraw.Cells);
    await this.draw();
  }

  private guessColumnWidths(values: any[][], col: ColumnInternal, colIndex: number): number {
    const cap = this.options.maxStringLength;
    const widths = [this.ctx.measureText(col.name).width + this.options.cellPadding * 2];
    const scratch = this.cellScratch;

    for (const row of values) {
      formatValueIntoScratch(row[colIndex], this.columns[colIndex], this.options, scratch);
      this.ctx.textAlign = scratch.textAlign;
      const formatted = scratch.formatted;
      const measured = cap > 0 && formatted.length > cap ? formatted.slice(0, cap) : formatted;
      const width = this.ctx.measureText(measured).width + this.options.cellPadding * 2;
      widths.push(width);
    }

    // sort the widths and get the percentile given by percentFormatGuessFit
    const sortedWidths = widths.sort((a, b) => a - b);
    const percentile = Math.floor(sortedWidths.length * this.options.percentFormatGuessFit);
    const width = sortedWidths[percentile];

    return minMax(width, this.options.minCellWidth, this.options.maxCellWidth);
  }

  /**
   * Yield the current task back to the browser. Lets pending paint /
   * input handlers run between column-width measurement chunks instead
   * of starving the main thread for ~100ms on big tables.
   */
  private yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => {
      // setTimeout(0) yields to the macrotask queue — input + scroll
      // events get a chance to dispatch. rAF would also work but ties
      // resolution to display refresh.
      setTimeout(resolve, 0);
    });
  }

  /**
   * Compute per-column widths. The first chunk is synchronous so the
   * initial draw has reasonable widths immediately; remaining chunks
   * yield between iterations and trigger a redraw on completion. Big
   * tables (100+ cols) no longer freeze the UI for ~100ms at startup.
   */
  protected async calculateColumnWidths() {
    this.ctx.font = `${this.options.fontSize}px ${this.options.fontFamily}`;
    this.ctx.textAlign = "left";
    this.ctx.textRendering = this.options.textRendering ?? DEFAULT_TEXT_RENDERING;
    this.ctx.letterSpacing = this.options.letterSpacing ?? DEFAULT_LETTER_SPACING;
    this.ctx.imageSmoothingEnabled = this.options.imageSmoothingEnabled ?? DEFAULT_IMAGE_SMOOTHING_ENABLED;
    this.ctx.imageSmoothingQuality = this.options.imageSmoothingQuality ?? DEFAULT_IMAGE_SMOOTHING_QUALITY;

    const maxRows = Math.min(this.options.maxFormatGuessLength, this.totalRows);
    const rows = await this.cache.getData(0, maxRows);

    // Pre-seed colWidths so the first paint has something to render even
    // before any column is measured. Reuses the previous run's values
    // when possible (e.g. on a resize that doesn't change the dataset).
    if (this.colWidths.length !== this.columns.length) {
      this.colWidths = this.columns.map((col) => col.widthPx || this.options.minCellWidth);
    }

    const COLS_PER_CHUNK = 16;
    const total = this.columns.length;

    const isMultiSort =
      this.filterManager !== null && this.filterManager.getSorts(this.datasetName).length > 1;

    for (let chunkStart = 0; chunkStart < total; chunkStart += COLS_PER_CHUNK) {
      const chunkEnd = Math.min(chunkStart + COLS_PER_CHUNK, total);
      for (let i = chunkStart; i < chunkEnd; i++) {
        const col = this.columns[i];
        col.widthPx = this.guessColumnWidths(rows, col, i);

        // Reserve room for the right-edge indicator stack. Every column
        // gets the +16px sort-arrow slot now (sorted columns paint it
        // solid; unsorted columns paint a faded "sortable" hint), so
        // header text truncates consistently.
        let indicatorSpace = 16;
        if (this.filterManager) {
          if (this.filterManager.isColumnSorted(this.datasetName, col.name) && isMultiSort) {
            // Multi-sort position superscript — only when the chain
            // has 2+ keys so the lone-key case stays compact.
            indicatorSpace += 12;
          }
          if (this.filterManager.isColumnFiltered(this.datasetName, col.name)) indicatorSpace += 10;
        }
        col.widthPx = Math.min(col.widthPx + indicatorSpace, this.options.maxCellWidth);

        this.colWidths[i] = col.widthPx;
      }

      // After each chunk: refresh derived layout state so a redraw
      // mid-measurement renders correctly.
      this.recomputeLayoutFromWidths();

      // Yield between chunks so input / paint can run. The first chunk
      // runs without yielding so the very first frame has reasonable
      // widths. The Cells-level bump ensures the rAF-scheduled draw
      // actually repaints the cell canvas with the chunk's new widths
      // — without it, the next draw sees toDraw=None and no-ops, so
      // chunks 2+ silently mutate `colOffsets/colWidths` without ever
      // hitting the screen.
      if (chunkEnd < total) {
        this.updateToDraw(ToDraw.Cells);
        this.scheduleDraw();
        await this.yieldToBrowser();
      }
    }
  }

  /**
   * Derive colOffsets / totalWidth / totalScrollX / scroll-spacer from
   * the current colWidths. Called once per chunk during yielding
   * measurement so a redraw mid-pass renders correctly.
   */
  private recomputeLayoutFromWidths(): void {
    this.colOffsets = [this.options.rowHeaderWidth];
    for (let i = 1; i < this.columns.length; i++) {
      this.colOffsets.push(this.colOffsets[i - 1] + this.colWidths[i - 1]);
    }
    this.totalWidth =
      (this.colOffsets[this.colOffsets.length - 1] || 0) +
      (this.colWidths[this.colWidths.length - 1] || 0);
    this.totalScrollX = Math.max(0, this.totalWidth - this.viewportWidth);
    this.scrollSpacer.style.width = `${Math.max(this.totalWidth, this.viewportWidth)}px`;
    // Handles ride on the layout — every offset shift moves them.
    this.resizeHandles?.relayout();
  }

  /**
   * Applied by the resize-handle overlay during a drag. Updates the column
   * width in place, recomputes the layout, and schedules a redraw. The
   * minCellWidth floor is also enforced inside the overlay so the user
   * never sees the width drop below it during the drag.
   */
  protected applyColumnResize(col: number, newWidth: number): void {
    if (col < 0 || col >= this.colWidths.length) return;
    const clamped = Math.max(this.options.minCellWidth, newWidth);
    if (this.colWidths[col] === clamped) return;
    this.colWidths[col] = clamped;
    this.recomputeLayoutFromWidths();
    this.updateToDraw(ToDraw.Cells);
    this.scheduleDraw();
  }

  protected calculateRowHeight() {
    // +1 row for the header
    this.totalHeight = (this.totalRows + 1) * this.options.cellHeight;
    this.totalScrollY = Math.max(0, this.totalHeight - this.viewportHeight);

    // The native scrollbar's max scrollTop is `spacer.height − clientHeight`,
    // but `clientHeight` is the *unsnapped* scrollContainer height while
    // our draw code uses the *snapped* `viewportHeight`. Extending the
    // spacer by the snap delta keeps the two aligned — without this the
    // user could never scroll far enough for the last data row to enter
    // the snapped viewport, and the bottom row would stay hidden.
    const snapDelta = Math.max(0, this.lastObservedClientHeight - this.viewportHeight);
    this.scrollSpacer.style.height = `${Math.max(this.totalHeight + snapDelta, this.viewportHeight)}px`;
  }

  protected async preloadDataForScroll(scrollY: number): Promise<void> {
    // Calculate which rows will be visible after scrolling
    const visibleStartRow = Math.floor(scrollY / this.options.cellHeight);
    const visibleEndRow = Math.min(visibleStartRow + Math.ceil(this.viewportHeight / this.options.cellHeight), this.totalRows);

    // Preload data for visible rows plus buffer
    const bufferSize = this.options.cacheChunkSize;
    const preloadStart = Math.max(0, visibleStartRow - bufferSize);
    const preloadEnd = Math.min(this.totalRows, visibleEndRow + bufferSize);

    // Load data asynchronously without blocking
    this.cache.loadChunk(preloadStart, preloadEnd).catch(console.error);
  }

  protected isMouseOverColumnHeader(x: number, y: number): boolean {
    return x >= this.options.rowHeaderWidth && y < this.options.cellHeight;
  }

  protected isMouseOverRowIndex(x: number, _: number): boolean {
    return x <= this.options.rowHeaderWidth;
  }

  protected getFirstVisibleColumnIndex(): number {
    if (this.colOffsets.length === 0) return 0;

    // Binary search: find the rightmost column whose offset <= scrollX
    let lo = 0;
    let hi = this.colOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.colOffsets[mid] <= this.scrollX) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  }

  protected getLastVisibleColumnIndex(): number {
    if (this.colOffsets.length === 0) return 0;

    const rightEdge = this.scrollX + this.viewportWidth;

    // Binary search: find the leftmost column whose offset > rightEdge
    let lo = 0;
    let hi = this.colOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.colOffsets[mid] + this.colWidths[mid] <= rightEdge) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  protected getCellAtPosition(x: number, y: number): { row: number; col: number } | null {
    const adjustedX = x + this.scrollX;
    const adjustedY = y + this.scrollY;

    // Check if we're in the row header area
    if (adjustedX < this.options.rowHeaderWidth) {
      const row = Math.floor(adjustedY / this.options.cellHeight);
      if (row >= 0 && row < this.totalRows) {
        return { row, col: -1 };
      }
      return null;
    }

    // Find the column
    let colOffset = this.options.rowHeaderWidth;
    let col = 0;
    for (; col < this.colWidths.length; col++) {
      if (adjustedX < colOffset + this.colWidths[col]) break;
      colOffset += this.colWidths[col];
    }

    // Find the row
    const row = Math.floor(adjustedY / this.options.cellHeight);

    // Check bounds: this.totalRows is included because the row 0 is the column headers
    if (row >= 0 && row <= this.totalRows && col < this.totalCols) {
      return { row, col };
    }

    return null;
  }

  protected drawCells(startRow: number, endRow: number): void {
    // Synchronous read — never blocks the frame. Missing rows render as
    // skeleton placeholders below; the cache fires onLoaded when the
    // background fetch lands and our subscription kicks scheduleDraw().
    const dataSync = this.cache.getDataSync(startRow, endRow);
    if (dataSync.hasMissing) {
      this.cache.requestRange(startRow, endRow);
    }

    const ctx = this.ctx;
    const o = this.options;
    // Logical viewport in CSS pixels — the dpr scale on the context makes
    // these coordinates land on the correct physical pixels.
    const width = this.viewportWidth;
    const height = this.viewportHeight;
    const ch = o.cellHeight;
    const rhw = o.rowHeaderWidth;
    const pad = o.cellPadding;
    const fvc = this.getFirstVisibleColumnIndex();
    const lvc = this.getLastVisibleColumnIndex();

    // ---- 1. Clear ----
    ctx.clearRect(0, 0, width, height);

    // ---- 2. Solid backgrounds (cells, header strip, row gutter) ----
    // Cell area gets the default cell colour; type-coloured cells overdraw
    // below in pass 4 if their style differs.
    ctx.fillStyle = o.cellBackgroundColor;
    ctx.fillRect(rhw, ch, width - rhw, height - ch);
    ctx.fillStyle = o.headerBackgroundColor;
    ctx.fillRect(0, 0, width, ch);
    ctx.fillRect(0, 0, rhw, height);

    // ---- 3. Alternating row stripes ----
    // Drawn before per-cell backgrounds so that type-coloured cells overdraw
    // the stripe and stay visually distinct.
    const stripe = o.stripeBackgroundColor;
    if (stripe && stripe !== o.cellBackgroundColor) {
      ctx.fillStyle = stripe;
      let sy = ch;
      for (let row = startRow; row < endRow; row++) {
        if ((row & 1) === 1) ctx.fillRect(rhw, sy, width - rhw, ch);
        sy += ch;
      }
    }

    // ---- 4. Cell text + per-cell type-coloured backgrounds ----
    const cellFont = `${o.fontSize}px ${o.fontFamily}`;
    ctx.font = cellFont;
    ctx.letterSpacing = o.letterSpacing;
    setMeasureSignature(cellFont, o.letterSpacing);
    ctx.textBaseline = "middle";

    const scratch = this.cellScratch;
    const cap = o.maxStringLength;
    let y = ch;
    for (let row = 0; row < dataSync.rows.length; row++) {
      const rowData = dataSync.rows[row];
      if (rowData === null) {
        // Skeleton placeholder — distinct enough from cell bg to read as
        // "loading" without screaming for attention. A short muted bar
        // hints that real content will arrive.
        ctx.fillStyle = o.headerBackgroundColor;
        ctx.fillRect(rhw, y, width - rhw, ch);
        ctx.fillStyle = o.cellBackgroundColor;
        ctx.fillRect(rhw + pad, y + ch * 0.38, Math.min(80, width - rhw - pad * 2), ch * 0.24);
        y += ch;
        continue;
      }
      let x = this.colOffsets[fvc] - this.scrollX;
      for (let col = fvc; col <= lvc; col++) {
        const cellWidth = this.colWidths[col];
        const column = this.columns[col];
        formatValueIntoScratch(rowData[col], column, o, scratch);

        // Type-coloured cells overdraw the stripe / default cell bg.
        if (scratch.backgroundColor && scratch.backgroundColor !== o.cellBackgroundColor) {
          ctx.fillStyle = scratch.backgroundColor;
          ctx.fillRect(x, y, cellWidth, ch);
        }

        const align = scratch.textAlign;
        ctx.textAlign = align;
        ctx.fillStyle = scratch.textColor || o.cellTextColor;

        let textX = x + pad;
        if (align === "center") textX = x + cellWidth / 2;
        else if (align === "right") textX = x + cellWidth - pad;
        const textY = y + ch / 2;

        const formatted = scratch.formatted;
        const capped =
          cap > 0 && formatted.length > cap ? formatted.slice(0, cap) + "\u2026" : formatted;
        const maxTextWidth = cellWidth - pad * 2;
        const truncated = truncateWithEllipsis(ctx, capped, maxTextWidth);
        if (truncated.length > 0) {
          ctx.fillText(truncated, Math.round(textX), Math.round(textY));
        }

        x += cellWidth;
      }
      y += ch;
    }

    // ---- 5. Column headers (text + indicators + null-count badge) ----
    const headerFont = `${o.headerFontSize}px ${o.fontFamily}`;
    ctx.font = headerFont;
    setMeasureSignature(headerFont, o.letterSpacing);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const headerY = ch / 2;
    let hx = this.colOffsets[fvc] - this.scrollX;
    for (let col = fvc; col <= lvc; col++) {
      const column = this.columns[col];
      const colWidth = this.colWidths[col];

      // Reserve right-side space for sort arrow + filter dot + null-count
      // badge so the header text truncates BEFORE running into them.
      let sortDir: "asc" | "desc" | null = null;
      let sortPosition: number | null = null;
      let isMultiSort = false;
      let isFiltered = false;
      if (this.filterManager) {
        sortDir = this.filterManager.isColumnSorted(this.datasetName, column.name);
        sortPosition = this.filterManager.getSortPosition(this.datasetName, column.name);
        isMultiSort = this.filterManager.getSorts(this.datasetName).length > 1;
        isFiltered = this.filterManager.isColumnFiltered(this.datasetName, column.name);
      }
      const hasNullBadge = column.hasNulls === true;
      const showSortPosition = sortDir !== null && isMultiSort && sortPosition !== null;
      // Always reserve room for a sort arrow — sorted columns paint a
      // solid one, unsorted columns get a faded "sortable" hint, so the
      // affordance is consistent across the whole header strip.
      let indicatorSpace = 16;
      if (showSortPosition) indicatorSpace += 12;
      if (isFiltered) indicatorSpace += 10;
      if (hasNullBadge) indicatorSpace += 10;

      const availableWidth = Math.max(0, colWidth - pad * 2 - indicatorSpace);
      const headerText = truncateWithEllipsis(ctx, column.name, availableWidth);
      if (availableWidth > 0 && headerText.length > 0) {
        ctx.fillStyle = o.headerTextColor;
        ctx.fillText(headerText, Math.round(hx + pad), Math.round(headerY));
      }

      // Right-aligned indicator stack: sort arrow → filter dot → null badge.
      // Each consumes a fixed slot from the right edge.
      let indicatorRight = hx + colWidth - pad;
      const arrowSize = 5;

      ctx.fillStyle = o.headerTextColor;
      const arrowX = indicatorRight - arrowSize;
      if (sortDir) {
        ctx.beginPath();
        if (sortDir === "asc") {
          ctx.moveTo(arrowX - arrowSize, headerY + arrowSize / 2);
          ctx.lineTo(arrowX, headerY - arrowSize / 2);
          ctx.lineTo(arrowX + arrowSize, headerY + arrowSize / 2);
        } else {
          ctx.moveTo(arrowX - arrowSize, headerY - arrowSize / 2);
          ctx.lineTo(arrowX, headerY + arrowSize / 2);
          ctx.lineTo(arrowX + arrowSize, headerY - arrowSize / 2);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        // Disabled "sortable" hint — faded up-arrow at the same slot as
        // the active indicator so the right-edge click zone is visually
        // marked even before the user sorts. globalAlpha trims contrast
        // without re-deriving a tinted color.
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.beginPath();
        ctx.moveTo(arrowX - arrowSize, headerY + arrowSize / 2);
        ctx.lineTo(arrowX, headerY - arrowSize / 2);
        ctx.lineTo(arrowX + arrowSize, headerY + arrowSize / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      indicatorRight -= 16;

      // Multi-sort position number (1, 2, 3, ...) sits to the left of
      // the arrow. Only rendered when the chain has 2+ keys — a lone
      // "1" superscript next to a single arrow is just clutter. The
      // showSortPosition guard subsumes the sortDir check.
      if (showSortPosition) {
        ctx.save();
        ctx.font = `9px ${o.fontFamily}`;
        ctx.fillStyle = o.headerTextColor;
        ctx.globalAlpha = 0.7;
        ctx.textAlign = "right";
        ctx.fillText(String(sortPosition), Math.round(indicatorRight), Math.round(headerY));
        ctx.restore();
        indicatorRight -= 12;
      }

      if (isFiltered) {
        ctx.fillStyle = o.selectionBorderColor;
        ctx.beginPath();
        ctx.arc(indicatorRight - 4, headerY, 3, 0, 2 * Math.PI);
        ctx.fill();
        indicatorRight -= 10;
      }

      if (hasNullBadge) {
        // Tiny middle-dot glyph muted with globalAlpha so it doesn't compete
        // with sort/filter indicators. column.hasNulls is set by the data
        // provider (`types.ts`) but went unrendered until now.
        ctx.fillStyle = o.headerTextColor;
        ctx.textAlign = "right";
        ctx.globalAlpha = 0.55;
        ctx.fillText("\u00B7", Math.round(indicatorRight), Math.round(headerY));
        ctx.globalAlpha = 1;
        ctx.textAlign = "left";
      }

      hx += colWidth;
    }

    // ---- 6. Row indices (right-aligned numbers in the gutter) ----
    // Repaint the gutter background first to mask any header / cell-text
    // bleed from steps 4 and 5. Glyph rendering at the column boundary
    // (auto-width pass picks an 80th-percentile width, so long-tail values
    // sit right at the truncation threshold) plus subpixel overshoot on
    // the leading character pushes 1–2px past the column's left edge.
    // The mask covers the full gutter height (header row included) so
    // both header text and cell text get masked.
    ctx.fillStyle = o.headerBackgroundColor;
    ctx.fillRect(0, 0, rhw, height);

    ctx.fillStyle = o.headerTextColor;
    ctx.textAlign = "right";
    const indexX = rhw - pad;
    let iy = ch;
    for (let row = startRow; row < endRow; row++) {
      ctx.fillText((row + 1).toString(), Math.round(indexX), Math.round(iy + ch / 2));
      iy += ch;
    }

    // ---- 7. Single-pass crisp gridlines ----
    // One Path2D, one stroke. Lines at integer + 0.5 offsets so 1px lines
    // hit a single physical pixel row. Eliminates the double-border fuzz
    // from the per-cell strokeRect calls in the previous revision.
    ctx.strokeStyle = o.borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Header bottom (full width)
    ctx.moveTo(0, ch + 0.5);
    ctx.lineTo(width, ch + 0.5);

    // Row separators (under each body row, across the full width including
    // the row-index gutter so the gutter rows match the cell rows visually).
    let gy = ch * 2;
    for (let row = startRow; row < endRow; row++) {
      ctx.moveTo(0, gy + 0.5);
      ctx.lineTo(width, gy + 0.5);
      gy += ch;
    }

    // Row gutter right edge (full height)
    ctx.moveTo(rhw + 0.5, 0);
    ctx.lineTo(rhw + 0.5, height);

    // Column separators (right edge of each visible column). Skip lines
    // whose right edge falls inside the gutter — when the user has
    // scrolled right past col 0, the right edges of partially-scrolled
    // columns can land at x < rhw and paint over the gutter mask.
    let gx = this.colOffsets[fvc] - this.scrollX;
    for (let col = fvc; col <= lvc; col++) {
      gx += this.colWidths[col];
      if (gx > rhw) {
        ctx.moveTo(gx + 0.5, 0);
        ctx.lineTo(gx + 0.5, height);
      }
    }

    ctx.stroke();
  }
}
