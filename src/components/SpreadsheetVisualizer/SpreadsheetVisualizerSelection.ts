import { CellInspectInfo, HideColumnRequest, ICellSelection, ReorderColumnRequest, SpreadsheetOptions } from "./types";
import { DataProvider, Column } from "../../data/types";
import { ColumnStatsVisualizer } from "../ColumnStatsVisualizer/ColumnStatsVisualizer";
import { formatForExport, getFormattedValueAndStyle } from "./utils/formatting";
import { SpreadsheetVisualizerBase, ToDraw, MouseState } from "./SpreadsheetVisualizerBase";
import {
  DEFAULT_IMAGE_SMOOTHING_ENABLED,
  DEFAULT_IMAGE_SMOOTHING_QUALITY,
  DEFAULT_LETTER_SPACING,
  DEFAULT_TEXT_RENDERING,
} from "./defaults";
import { getDpr, minMax } from "./utils/drawing";

export class SpreadsheetVisualizerSelection extends SpreadsheetVisualizerBase {
  // State variables for selection and hovering
  protected hoveredCell: { row: number; col: number } | null = null;
  protected selectedCells: { startRow: number; endRow: number; startCol: number; endCol: number } | null = null;
  protected mouseState = MouseState.Idle;
  protected toDraw = ToDraw.Cells;
  protected dragStartX = 0;
  protected dragStartY = 0;
  protected lastScrollX = 0;
  protected lastScrollY = 0;
  protected selectedRows: number[] = [];
  protected selectedCols: number[] = [];

  // Anchor for shift-extend on row-gutter clicks. Set on every plain or
  // ctrl click; shift-click extends from this anchor without overwriting
  // it, so successive shift-clicks pivot around the same origin (Excel
  // behaviour). Null until the user has clicked at least once.
  protected lastRowAnchor: number | null = null;

  // Same anchor concept for column-header shift-extend.
  protected lastColAnchor: number | null = null;

  // Stats visualizer (now lives in the ControlPanel, not as an overlay)
  protected statsVisualizer: ColumnStatsVisualizer;

  // Selection change callback
  private onSelectionChange: ((selection?: ICellSelection) => void)[] = [];

  constructor(
    container: HTMLElement,
    dataProvider: DataProvider,
    options: Partial<SpreadsheetOptions> = {},
    statsVisualizer: ColumnStatsVisualizer,
  ) {
    super(container, dataProvider, options);
    this.statsVisualizer = statsVisualizer;
  }

  protected async updateLayout() {
    // Use the scroll container's content-box dimensions, not the outer
    // container's — `scrollContainer.clientWidth/Height` is the visible
    // area *excluding* the native scrollbars. The outer container's
    // `clientWidth/Height` includes whatever space the scrollbars
    // currently occupy, which used to leave the bottom row half-covered
    // by the horizontal scrollbar (and the rightmost column shifted
    // under the vertical scrollbar).
    const rawClientWidth = this.scrollContainer.clientWidth;
    const rawClientHeight = this.scrollContainer.clientHeight;
    this.lastObservedClientWidth = rawClientWidth;
    this.lastObservedClientHeight = rawClientHeight;
    let width = Math.floor(minMax(rawClientWidth, this.options.minWidth, this.options.maxWidth));
    let height = Math.floor(minMax(rawClientHeight, this.options.minHeight, this.options.maxHeight));

    // Snap the height down to `header + N × rowHeight` so the visible
    // canvas always holds an integer number of full rows. Without this,
    // a pixel mismatch (e.g. viewport 250 px, row 24 px → 9 full rows
    // fit but one extra row is drawn half-clipped at the bottom) leaves
    // the bottom row half-visible. The leftover pixels — at most
    // `cellHeight - 1` — sit below the canvas, inside the scrollContainer
    // and above any horizontal scrollbar; they show through to
    // `#spreadsheet-container`'s background, which matches the cell
    // background in both themes, so the gap is visually seamless.
    const ch = this.options.cellHeight;
    if (height > ch) {
      const dataRowsThatFit = Math.floor((height - ch) / ch);
      height = ch + dataRowsThatFit * ch;
    }

    // Fallback to options dimensions if container has no size (e.g., during initialization)
    if (width <= 0 && this.options.width !== undefined) {
      width = Math.floor(minMax(this.options.width, this.options.minWidth, this.options.maxWidth));
    }
    if (height <= 0 && this.options.height !== undefined) {
      height = Math.floor(minMax(this.options.height, this.options.minHeight, this.options.maxHeight));
    }

    // Ensure we have valid dimensions
    if (width <= 0) width = this.options.minWidth;
    if (height <= 0) height = this.options.minHeight;

    // Stats panel logic is handled by derived classes

    // Size all three canvases to the viewport. Backing store is dpr-scaled
    // for crisp rendering on retina; CSS size stays in CSS pixels. After the
    // backing-store assignment the context state (font, transform, etc.)
    // resets — drawCells / calculateColumnWidths reapply them.
    const dpr = getDpr();
    this.dpr = dpr;
    this.viewportWidth = width;
    this.viewportHeight = height;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    const canvases: Array<[HTMLCanvasElement, CanvasRenderingContext2D]> = [
      [this.canvas, this.ctx],
      [this.selectionCanvas, this.selectionCtx],
      [this.hoverCanvas, this.hoverCtx],
    ];
    for (const [cvs, c2d] of canvases) {
      cvs.width = bw;
      cvs.height = bh;
      cvs.style.width = `${width}px`;
      cvs.style.height = `${height}px`;
      // Switch the context to CSS-pixel coordinates so all subsequent draw
      // calls (in drawCells / drawSelection / drawHover) work as if the
      // canvas were 1× — the dpr lift is invisible to drawing code.
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // The canvas group needs explicit size so sticky positioning works
    this.canvasGroup.style.width = `${width}px`;
    this.canvasGroup.style.height = `${height}px`;

    // Recalculate column widths and redraw.
    // Setting canvas.width/height above clears all pixel content, so we must
    // force a full cell redraw regardless of the current toDraw state.
    this.calculateColumnWidths();
    this.calculateRowHeight();
    this.updateToDraw(ToDraw.Cells);

    await this.draw();
  }

  public async getSelectedFormattedValues(): Promise<{ headers: string[]; indices: number[]; data: string[][] }> {
    // Delegates to getSelection so all three selection modes (cells /
    // rows / cols) flow through the same fetch + format pipeline. The
    // copy keymap action (Ctrl+C) was wired to this method and would
    // silently return empty for row/col selections before.
    const sel = await this.getSelection();
    if (!sel) return { headers: [], indices: [], data: [] };
    return {
      headers: sel.columns.map((c) => c.name),
      indices: sel.rows,
      data: sel.formatted,
    };
  }

  protected updateToDraw(newToDraw: ToDraw) {
    this.toDraw = Math.max(this.toDraw, newToDraw);
  }

  protected async draw() {
    // Use CSS-pixel viewport, not canvas.height (which is dpr-scaled and
    // would over-compute visible rows by the dpr factor).
    const height = this.viewportHeight;

    // Calculate visible area
    const visibleStartRow = Math.floor(this.scrollY / this.options.cellHeight);
    const visibleEndRow = Math.min(visibleStartRow + Math.ceil(height / this.options.cellHeight), this.totalRows);

    this.ctx.textRendering = this.options.textRendering ?? DEFAULT_TEXT_RENDERING;
    this.ctx.letterSpacing = this.options.letterSpacing ?? DEFAULT_LETTER_SPACING;
    this.ctx.imageSmoothingEnabled = this.options.imageSmoothingEnabled ?? DEFAULT_IMAGE_SMOOTHING_ENABLED;
    this.ctx.imageSmoothingQuality = this.options.imageSmoothingQuality ?? DEFAULT_IMAGE_SMOOTHING_QUALITY;

    // Cascading draw: higher-priority operations include all lower-priority ones.
    // Cells (5) → Selection (4) → CellHover (1). ColHover is independent.
    if (this.toDraw === ToDraw.ColHover) {
      this.drawColHover();
    } else if (this.toDraw === ToDraw.RowHover) {
      this.drawRowHover(visibleStartRow);
    } else {
      if (this.toDraw >= ToDraw.Cells) {
        // Sync now — cache misses no longer block the frame, they render
        // skeleton placeholders and trigger a repaint via the cache's
        // onLoaded subscription.
        this.drawCells(visibleStartRow, visibleEndRow);
        // Drop the hover dirty-rect — see `lastCellHoverRect` doc.
        this.lastCellHoverRect = null;
      }
      if (this.toDraw >= ToDraw.Selection) {
        this.drawSelection(visibleStartRow);
      }
      if (this.toDraw >= ToDraw.CellHover) {
        this.drawCellHover(visibleStartRow);
      }
    }

    this.toDraw = ToDraw.None;
  }

  protected async selectColumn(col: number, mods: { shift: boolean; ctrl: boolean } = { shift: false, ctrl: false }) {
    if (mods.shift && this.lastColAnchor !== null) {
      const start = Math.min(this.lastColAnchor, col);
      const end = Math.max(this.lastColAnchor, col);
      const range: number[] = [];
      for (let c = start; c <= end; c++) range.push(c);
      this.selectedCols = range;
      this.selectedRows = [];
      this.selectedCells = null;
    } else if (mods.ctrl) {
      if (this.selectedCols.includes(col)) {
        this.selectedCols = this.selectedCols.filter((c) => c !== col);
      } else {
        this.selectedCols = [...this.selectedCols, col];
        this.selectedRows = [];
        this.selectedCells = null;
      }
      this.lastColAnchor = col;
    } else {
      this.selectedCols = [col];
      this.selectedRows = [];
      this.selectedCells = null;
      this.lastColAnchor = col;
    }

    // Stats panel: pin to the first selected column (click order). Hide
    // when the last column is deselected. With multi-column selections
    // this avoids the N-stats-panes problem and gives the user a stable
    // reading even as they ctrl-click around.
    if (this.statsVisualizer) {
      if (this.selectedCols.length > 0) {
        await this.statsVisualizer.showStats(this.columns[this.selectedCols[0]]);
      } else {
        this.statsVisualizer.hide();
      }
    }

    this.updateToDraw(ToDraw.Selection);
    this.notifySelectionChange();
  }

  /**
   * Row-gutter click handler. `row` is the absolute row index returned by
   * `getCellAtPosition` (1-indexed; row 0 is the column-header strip and
   * is filtered out by the caller).
   *
   * Modifier semantics mirror Excel:
   *   - plain click   → replace selection with just `row`, set anchor
   *   - shift click   → extend from anchor to `row` (anchor unchanged)
   *   - ctrl click    → toggle `row` in the current selection, set anchor
   *
   * Selecting a row clears any cell or column selection — the three
   * selection modes are mutually exclusive.
   */
  protected async selectRow(row: number, mods: { shift: boolean; ctrl: boolean }) {
    if (mods.shift && this.lastRowAnchor !== null) {
      const start = Math.min(this.lastRowAnchor, row);
      const end = Math.max(this.lastRowAnchor, row);
      const range: number[] = [];
      for (let r = start; r <= end; r++) range.push(r);
      this.selectedRows = range;
      this.selectedCols = [];
      this.selectedCells = null;
    } else if (mods.ctrl) {
      if (this.selectedRows.includes(row)) {
        this.selectedRows = this.selectedRows.filter((r) => r !== row);
      } else {
        this.selectedRows = [...this.selectedRows, row];
        this.selectedCols = [];
        this.selectedCells = null;
      }
      this.lastRowAnchor = row;
    } else {
      this.selectedRows = [row];
      this.selectedCols = [];
      this.selectedCells = null;
      this.lastRowAnchor = row;
    }

    this.updateToDraw(ToDraw.Selection);
    this.notifySelectionChange();
  }

  /**
   * Last cell-hover rect painted onto the hover canvas. `drawCellHover`
   * uses it to scope its clear to the previous paint instead of wiping
   * the full canvas on every mouse-move. `null` means the canvas may
   * hold non-cell-hover content (column tint from `drawColHover`, or
   * a stale paint after a Cells-level redraw); the next `drawCellHover`
   * full-clears in that case.
   */
  private lastCellHoverRect: { x: number; y: number; w: number; h: number } | null = null;

  /**
   * Run `paint` with `ctx` clipped to the cell area (excludes the
   * row-index gutter). Stops 2px overlay strokes — which canvas centers
   * on the path, so `strokeRect(rhw, …)` paints `[rhw-1, rhw+1]` — from
   * bleeding 1px into the gutter on column-0 hovers / selections.
   */
  private withCellAreaClip(ctx: CanvasRenderingContext2D, paint: () => void): void {
    const rhw = this.options.rowHeaderWidth;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rhw, 0, this.viewportWidth - rhw, this.viewportHeight);
    ctx.clip();
    paint();
    ctx.restore();
  }

  /**
   * Stroke a rect, optionally skipping the left and/or bottom edge.
   * `skipLeft` keeps the centered 2px stroke from clipping to a 1px
   * strip at the gutter boundary; `skipBottom` matches the existing
   * "table overflows the viewport" path that signals "continues below".
   */
  private strokeRectEdges(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    skipLeft: boolean = false,
    skipBottom: boolean = false,
  ): void {
    if (!skipLeft && !skipBottom) {
      ctx.strokeRect(x, y, w, h);
      return;
    }
    ctx.beginPath();
    if (skipLeft && skipBottom) {
      // Top + right.
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
    } else if (skipLeft) {
      // Top + right + bottom.
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
    } else {
      // skipBottom only — left + top + right.
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h);
    }
    ctx.stroke();
  }

  private drawCellHover(visibleStartRow: number) {
    // Dirty-rect clear when we have a previous paint, full-clear otherwise.
    // 3px padding covers the 2px stroke. A null `prev` means the canvas
    // may hold a column-hover paint or a stale rect after a Cells-level
    // redraw (see draw()); full-clear keeps both from ghosting.
    const prev = this.lastCellHoverRect;
    if (prev) {
      this.hoverCtx.clearRect(prev.x - 3, prev.y - 3, prev.w + 6, prev.h + 6);
    } else {
      this.hoverCtx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    }
    this.lastCellHoverRect = null;

    if (!this.hoveredCell) return;
    const { row, col } = this.hoveredCell;

    const y = (row - visibleStartRow) * this.options.cellHeight;
    const height = this.options.cellHeight;

    const rhw = this.options.rowHeaderWidth;
    let x = this.colOffsets[col] - this.scrollX;
    let width = this.colWidths[col];
    if (x < rhw) {
      x = rhw;
      width = this.colOffsets[col + 1] - this.scrollX - rhw;
    }
    if (width <= 0) return; // cell is fully behind the gutter

    const atBoundary = x === rhw;

    this.withCellAreaClip(this.hoverCtx, () => {
      this.hoverCtx.fillStyle = this.options.hoverColor;
      this.hoverCtx.strokeStyle = this.options.hoverBorderColor || this.options.borderColor;
      this.hoverCtx.fillRect(x, y, width, height);

      this.hoverCtx.lineWidth = 2;
      this.strokeRectEdges(this.hoverCtx, x, y, width, height, atBoundary);

      this.hoverCtx.lineWidth = 1;
      this.strokeRectEdges(this.hoverCtx, x + 1, y + 1, width - 2, height - 2, atBoundary);
    });

    this.lastCellHoverRect = { x, y, w: width, h: height };
  }

  private drawColHover() {
    // Full-canvas clear — invalidates any prior cell-hover dirty rect.
    this.hoverCtx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    this.lastCellHoverRect = null;

    if (!this.hoveredCell) return;
    const { col } = this.hoveredCell;

    const rhw = this.options.rowHeaderWidth;
    const height = Math.min(this.totalHeight, this.hoverCanvas.height);

    let x = this.colOffsets[col] - this.scrollX;
    let width = this.colWidths[col];
    if (x < rhw) {
      x = rhw;
      width = this.colOffsets[col + 1] - this.scrollX - rhw;
    }
    if (width <= 0) return;

    this.withCellAreaClip(this.hoverCtx, () => {
      this.hoverCtx.fillStyle = this.options.hoverColor;
      this.hoverCtx.fillRect(x, 0, width, height);
    });
  }

  /**
   * Row-gutter hover: paints across the full width including the gutter,
   * matching `drawRowSelection`'s borderless fill style. Header strip
   * stays uncovered via the same Math.max-clip the row selection uses.
   */
  private drawRowHover(visibleStartRow: number) {
    this.hoverCtx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    this.lastCellHoverRect = null;

    if (!this.hoveredCell) return;
    const { row } = this.hoveredCell;
    if (row < 1) return; // header row is not a body row

    const cellH = this.options.cellHeight;
    const headerH = this.options.cellHeight;
    const width = Math.min(this.totalWidth, this.viewportWidth);

    const y = (row - visibleStartRow) * cellH;
    if (y + cellH <= headerH) return;
    if (y >= this.viewportHeight) return;

    const drawY = Math.max(y, headerH);
    const drawH = y + cellH - drawY;
    if (drawH <= 0) return;

    this.hoverCtx.fillStyle = this.options.hoverColor;
    this.hoverCtx.fillRect(0, drawY, width, drawH);
  }

  private drawSelection(visibleStartRow: number) {
    this.selectionCtx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);
    // Row selection extends across the full width including the gutter
    // (clicking a row index highlights the index too), so it paints
    // *outside* the cell-area clip the cell/col selections are scoped to.
    this.drawRowSelection(visibleStartRow);
    this.withCellAreaClip(this.selectionCtx, () => {
      this.drawCellSelection(visibleStartRow);
      this.drawColSelection();
    });
  }

  private drawRowSelection(visibleStartRow: number) {
    if (this.selectedRows.length === 0) return;

    this.selectionCtx.fillStyle = this.options.selectionColor;

    const cellH = this.options.cellHeight;
    const headerH = this.options.cellHeight; // header row occupies y=0..cellHeight
    const width = Math.min(this.totalWidth, this.viewportWidth);

    this.selectedRows.forEach((row) => {
      const y = (row - visibleStartRow) * cellH;
      if (y + cellH <= headerH) return; // entirely behind the header
      if (y >= this.viewportHeight) return; // off-screen below

      // Clip the top of the row when it's partly behind the header so we
      // don't paint over the column-name strip.
      const drawY = Math.max(y, headerH);
      const drawH = y + cellH - drawY;
      if (drawH <= 0) return;

      this.selectionCtx.fillRect(0, drawY, width, drawH);
    });
  }

  private drawCellSelection(visibleStartRow: number) {
    // Draw selection
    if (this.selectedCells) {
      const { startRow, endRow, startCol, endCol } = this.selectedCells;
      this.selectionCtx.fillStyle = this.options.selectionColor;

      const minRow = Math.min(startRow, endRow);
      const maxRow = Math.max(startRow, endRow);
      const minCol = Math.min(startCol, endCol);
      const maxCol = Math.max(startCol, endCol);

      const height = this.options.cellHeight;
      let selectionBounds = { x: 0, y: 0, width: 0, height: 0 };

      // Draw selection backgrounds
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const y = (row - visibleStartRow) * this.options.cellHeight;

          let x = this.colOffsets[col] - this.scrollX;
          let width = this.colWidths[col];
          if (x < this.options.rowHeaderWidth) {
            x = this.options.rowHeaderWidth;
            width = this.colOffsets[col + 1] - this.scrollX - this.options.rowHeaderWidth;
          }

          if (x + width > 0 && x < this.viewportWidth && y + height > 0 && y < this.viewportHeight) {
            this.selectionCtx.fillRect(x, y, width, height);

            // Track the bounds for the selection border and handle
            if (row === minRow && col === minCol) {
              selectionBounds = { x, y, width: 0, height: 0 };
            }
            if (row === maxRow && col === maxCol) {
              selectionBounds.width = x + width - selectionBounds.x;
              selectionBounds.height = y + height - selectionBounds.y;
            }
          }
        }
      }

      // Draw enhanced selection border
      if (selectionBounds.width > 0 && selectionBounds.height > 0) {
        this.selectionCtx.strokeStyle = this.options.selectionBorderColor || this.options.borderColor;
        const sb = selectionBounds;
        const atBoundary = sb.x === this.options.rowHeaderWidth;

        this.selectionCtx.lineWidth = 2;
        this.strokeRectEdges(this.selectionCtx, sb.x, sb.y, sb.width, sb.height, atBoundary);
        this.selectionCtx.lineWidth = 1;
        this.strokeRectEdges(this.selectionCtx, sb.x + 1, sb.y + 1, sb.width - 2, sb.height - 2, atBoundary);

        // Draw selection handle (dot) in bottom-right corner
        const handleSize = 8;
        const handleX = selectionBounds.x + selectionBounds.width - handleSize / 8;
        const handleY = selectionBounds.y + selectionBounds.height - handleSize / 8;

        this.selectionCtx.fillStyle = this.options.selectionBorderColor || this.options.borderColor;
        // this.selectionCtx.ellipse(handleX, handleY, handleSize / 2, handleSize / 2, 0, 0, 2 * Math.PI);
        this.selectionCtx.beginPath();
        this.selectionCtx.arc(handleX, handleY, handleSize / 2, 0, 2 * Math.PI);
        this.selectionCtx.fill();

        // Add white outline to the handle for better visibility
        this.selectionCtx.strokeStyle = "#ffffff";
        this.selectionCtx.lineWidth = 1;
        this.selectionCtx.stroke();
      }
    }
  }

  private drawColSelection() {
    if (this.selectedCols.length === 0) return;
    this.selectionCtx.fillStyle = this.options.selectionColor;

    const rhw = this.options.rowHeaderWidth;
    const height = Math.min(this.totalHeight, this.selectionCanvas.height);

    this.selectedCols.forEach((col) => {
      if (this.colOffsets[col + 1] - this.scrollX < rhw) return; // off-screen

      let x = this.colOffsets[col] - this.scrollX;
      let width = this.colWidths[col];
      if (x < rhw) {
        x = rhw;
        width = this.colOffsets[col + 1] - this.scrollX - rhw;
      }
      if (width <= 0) return;

      this.selectionCtx.fillRect(x, 0, width, height);
    });
  }

  /**
   * Whole-dataset selection shape for `.export` when no rows/cols/cells
   * are selected — every row, every column, formatted via
   * `formatForExport` so complex cells JSON-serialise the same way they
   * do for partial-selection exports.
   */
  public async exportFullDataset(): Promise<{ rows: number[]; columns: Column[]; values: any[][]; formatted: string[][] } | null> {
    if (this.totalRows === 0 || this.columns.length === 0) return null;
    try {
      const allRows = await this.cache.getData(0, this.totalRows);
      const formatted = allRows.map((row) =>
        row.map((cell, idx) => {
          const column = this.columns[idx];
          if (!column) return "";
          return formatForExport(cell, column, this.options);
        }),
      );
      const indices = Array.from({ length: allRows.length }, (_, i) => i + 1);
      return {
        rows: indices,
        columns: this.columns as Column[],
        values: allRows,
        formatted,
      };
    } catch (error) {
      console.error("Failed to fetch full dataset for export:", error);
      return null;
    }
  }

  public async getSelection(): Promise<{ rows: number[]; columns: Column[]; values: any[][]; formatted: string[][] } | null> {
    // Column selection: every row, sliced to the selected columns. Cols
    // are emitted in left-to-right visual order regardless of click order
    // so exports are deterministic.
    if (this.selectedCols.length > 0) {
      try {
        const sortedCols = [...this.selectedCols].sort((a, b) => a - b);
        const allRows = await this.cache.getData(0, this.totalRows);
        const data = allRows.map((row) => sortedCols.map((c) => row[c]));
        const formatted = data.map((row) =>
          row.map((cell, idx) => {
            const column = this.columns[sortedCols[idx]];
            if (!column) return "";
            return formatForExport(cell, column, this.options);
          }),
        );
        const columns = sortedCols.map((c) => this.columns[c]) as Column[];
        const indices = Array.from({ length: allRows.length }, (_, i) => i + 1);
        return { rows: indices, columns, values: data, formatted };
      } catch (error) {
        console.error("Failed to fetch column data for selection:", error);
        return null;
      }
    }

    // Row selection: fetch each contiguous run of selected rows, concat
    // the results, emit every column. Splitting by run keeps shift-extend
    // selections to a single fetch and ctrl-click selections to as many
    // fetches as there are gaps — both better than over-fetching the
    // outer hull when the selection is sparse.
    if (this.selectedRows.length > 0) {
      try {
        const sorted = [...this.selectedRows].sort((a, b) => a - b);
        const runs: { start: number; end: number }[] = [];
        let curStart = sorted[0];
        let curEnd = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === curEnd + 1) {
            curEnd = sorted[i];
          } else {
            runs.push({ start: curStart, end: curEnd });
            curStart = sorted[i];
            curEnd = sorted[i];
          }
        }
        runs.push({ start: curStart, end: curEnd });

        const data: any[][] = [];
        const indices: number[] = [];
        for (const run of runs) {
          // selectedRows are 1-indexed (row 0 = header), cache is 0-indexed.
          const rows = await this.cache.getData(run.start - 1, run.end);
          for (let i = 0; i < rows.length; i++) {
            data.push(rows[i]);
            indices.push(run.start + i);
          }
        }

        const formatted = data.map((row) =>
          row.map((cell, idx) => {
            const column = this.columns[idx];
            if (!column) return "";
            return formatForExport(cell, column, this.options);
          }),
        );

        return {
          rows: indices,
          columns: this.columns as Column[],
          values: data,
          formatted,
        };
      } catch (error) {
        console.error("Failed to fetch row data for selection:", error);
        return null;
      }
    }

    if (this.selectedCells) {
      try {
        const firstVisibleColumnIndex = this.getFirstVisibleColumnIndex();
        const lastVisibleColumnIndex = this.getLastVisibleColumnIndex();

        // selectedCells rows are 1-indexed (row 0 = header), cache is 0-indexed
        const data = (await this.cache.getData(this.selectedCells.startRow - 1, this.selectedCells.endRow)).map((row) =>
          row.slice(this.selectedCells?.startCol ?? firstVisibleColumnIndex, (this.selectedCells?.endCol ?? lastVisibleColumnIndex) + 1),
        );

        const formatted = data.map((row) =>
          row.map((cell, index) => {
            const column = this.columns[index + this.selectedCells!.startCol];
            if (!column) return "";
            return formatForExport(cell, column, this.options);
          }),
        );

        const rows = Array.from(
          { length: this.selectedCells.endRow - this.selectedCells.startRow + 1 },
          (_, i) => this.selectedCells!.startRow + i,
        );
        const columns = this.columns.filter(
          (_, index) => this.selectedCells!.startCol <= index && index <= this.selectedCells!.endCol,
        ) as Column[];

        return {
          rows,
          columns,
          values: data,
          formatted,
        };
      } catch (error) {
        console.error("Failed to fetch cell data for selection:", error);
        return null;
      }
    } else {
      return null;
    }
  }

  protected async notifySelectionChange(): Promise<void> {
    // IMPORTANT: must NOT call getSelection() here. The col-selection
    // branch of getSelection fetches every row in the dataset to build
    // the full data matrix — fine for a copy/export call site, fatal for
    // a notification fired on every click (column clicks would trigger
    // a full-dataset cache load + skeleton placeholders + redraws).
    //
    // The status-bar / command-bar listeners only need counts + column
    // metadata + (optionally) the first cell's formatted value. Build
    // that summary cheaply without touching the cache except for the
    // single first-cell preview.
    const selection = await this.buildSelectionSummary();
    this.onSelectionChange.forEach((callback) => callback(selection));
  }

  /**
   * Cheap selection metadata for change notifications. Skips the full
   * data fetch `getSelection()` does. Cells mode delegates to
   * getSelection (its fetch is bounded to the selected range, not the
   * whole dataset). Rows mode fetches one cell for the status-bar
   * preview. Cols mode returns metadata only — the status bar's
   * cell-value display ignores col selections anyway.
   */
  private async buildSelectionSummary(): Promise<ICellSelection | undefined> {
    if (this.selectedCols.length > 0) {
      const sortedCols = [...this.selectedCols].sort((a, b) => a - b);
      return {
        rows: [],
        columns: sortedCols.map((c) => this.columns[c]).filter(Boolean) as Column[],
        values: [],
        formatted: [],
      };
    }
    if (this.selectedRows.length > 0) {
      const sortedRows = [...this.selectedRows].sort((a, b) => a - b);
      let values: any[][] = [];
      let formatted: string[][] = [];
      try {
        const firstRow = await this.cache.getData(sortedRows[0] - 1, sortedRows[0]);
        if (firstRow.length > 0 && this.columns.length > 0) {
          const firstValue = firstRow[0][0];
          values = [[firstValue]];
          formatted = [[getFormattedValueAndStyle(firstValue, this.columns[0], this.options).formatted]];
        }
      } catch {
        // Preview is optional — fall through with empty values.
      }
      return {
        rows: sortedRows,
        columns: this.columns as Column[],
        values,
        formatted,
      };
    }
    if (this.selectedCells) {
      const sel = await this.getSelection();
      return sel ?? undefined;
    }
    return undefined;
  }

  // Public methods for external access to selection state
  public getHoveredCell(): { row: number; col: number } | null {
    return this.hoveredCell;
  }

  public getSelectedCells(): { startRow: number; endRow: number; startCol: number; endCol: number } | null {
    return this.selectedCells;
  }

  public getMouseState(): MouseState {
    return this.mouseState;
  }

  public getSelectedRows(): number[] {
    return this.selectedRows;
  }

  public getSelectedCols(): number[] {
    return this.selectedCols;
  }

  public setHoveredCell(cell: { row: number; col: number } | null): void {
    this.hoveredCell = cell;
  }

  public setSelectedCells(cells: { startRow: number; endRow: number; startCol: number; endCol: number } | null): void {
    this.selectedCells = cells;
  }

  public setMouseState(state: MouseState): void {
    this.mouseState = state;
  }

  public setSelectedRows(rows: number[]): void {
    this.selectedRows = rows;
  }

  public setSelectedCols(cols: number[]): void {
    this.selectedCols = cols;
  }

  public addOnSelectionChangeSubscription(callback: (selection?: ICellSelection) => void): void {
    this.onSelectionChange.push(callback);
  }

  public removeOnSelectionChangeSubscription(callback: (selection?: ICellSelection) => void): void {
    this.onSelectionChange = this.onSelectionChange.filter((cb) => cb !== callback);
  }

  // Inspect-requested fires on user-driven double-click of a complex
  // cell. Carries the cell's payload so subscribers don't have to race
  // against the selection-change notification path.
  private onCellInspectRequested: ((info: CellInspectInfo) => void)[] = [];

  public addOnCellInspectRequestedSubscription(callback: (info: CellInspectInfo) => void): void {
    this.onCellInspectRequested.push(callback);
  }

  public removeOnCellInspectRequestedSubscription(callback: (info: CellInspectInfo) => void): void {
    this.onCellInspectRequested = this.onCellInspectRequested.filter((cb) => cb !== callback);
  }

  protected notifyCellInspectRequested(info: CellInspectInfo): void {
    this.onCellInspectRequested.forEach((cb) => cb(info));
  }

  // Hide-column-requested fires from the right-click context menu's
  // "Hide column" entry. The data layer (setHiddenColumns + persist)
  // is owned by BedevereApp, so the visualizer just emits intent.
  private onHideColumnRequested: ((req: HideColumnRequest) => void)[] = [];

  public addOnHideColumnRequestedSubscription(callback: (req: HideColumnRequest) => void): void {
    this.onHideColumnRequested.push(callback);
  }

  public removeOnHideColumnRequestedSubscription(callback: (req: HideColumnRequest) => void): void {
    this.onHideColumnRequested = this.onHideColumnRequested.filter((cb) => cb !== callback);
  }

  protected notifyHideColumnRequested(req: HideColumnRequest): void {
    this.onHideColumnRequested.forEach((cb) => cb(req));
  }

  // Reorder-column-requested fires from the drag-to-reorder
  // interaction on the column header. Like hide, the data layer
  // (moveColumn + persist) is owned by BedevereApp; the visualizer
  // emits the drop intent and waits for the filter-manager change
  // event to redraw with the new projection.
  private onReorderColumnRequested: ((req: ReorderColumnRequest) => void)[] = [];

  public addOnReorderColumnRequestedSubscription(callback: (req: ReorderColumnRequest) => void): void {
    this.onReorderColumnRequested.push(callback);
  }

  public removeOnReorderColumnRequestedSubscription(callback: (req: ReorderColumnRequest) => void): void {
    this.onReorderColumnRequested = this.onReorderColumnRequested.filter((cb) => cb !== callback);
  }

  protected notifyReorderColumnRequested(req: ReorderColumnRequest): void {
    this.onReorderColumnRequested.forEach((cb) => cb(req));
  }

  public getSelectedColumns(): Column[] {
    return this.selectedCols.map((colIndex) => this.columns[colIndex] as Column).filter((col) => col !== undefined);
  }
}
