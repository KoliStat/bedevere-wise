import { DataProvider, SpreadsheetOptions } from "@/index";
import { FocusableComponent } from "../BedevereApp/types";
import { MouseState, ToDraw } from "./SpreadsheetVisualizerBase";
import { ColumnStatsVisualizer } from "../ColumnStatsVisualizer/ColumnStatsVisualizer";
import { SpreadsheetVisualizerSelection } from "./SpreadsheetVisualizerSelection";
import { keymapService } from "../../data/KeymapService";
import { persistenceService } from "../../data/PersistenceService";

export class SpreadsheetVisualizerFocusable extends SpreadsheetVisualizerSelection implements FocusableComponent {
  private _isFocused: boolean = false;

  public readonly componentId: string;
  public readonly canReceiveFocus: boolean = true;
  public readonly focusableElement: HTMLElement;

  constructor(
    parent: HTMLElement,
    dataProvider: DataProvider,
    options: SpreadsheetOptions = {},
    columnStatsVisualizer: ColumnStatsVisualizer,
    componentId?: string,
  ) {
    super(parent, dataProvider, options, columnStatsVisualizer);
    this.componentId = componentId ?? "spreadsheet-visualizer";
    this.focusableElement = this.getContainer();
  }

  // FocusableComponent interface methods
  public focus(): void {
    this._isFocused = true;
    this.focusableElement.focus();
  }

  public blur(): void {
    this._isFocused = false;
    this.focusableElement.blur();
  }

  public isFocused(): boolean {
    return this._isFocused;
  }

  // Event handler methods that delegate to SpreadsheetVisualizer
  public async handleMouseDown(event: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Ignore clicks outside the canvas area (e.g. control panel, stats buttons)
    if (x < 0 || y < 0 || x > this.viewportWidth || y > this.viewportHeight) {
      return false;
    }

    // Column Header
    if (this.isMouseOverColumnHeader(x, y)) {
      const cell = this.getCellAtPosition(x, y);
      if (!cell) return false;
      const { col } = cell;

      await this.selectColumn(col, {
        shift: event.shiftKey,
        ctrl: event.ctrlKey || event.metaKey,
      });
    }

    // Row gutter (left-side index strip, excluding the top-left corner
    // which is part of the column-header zone). Click selects, shift
    // extends from the last-clicked row, ctrl/cmd toggles.
    else if (x <= this.options.rowHeaderWidth && y >= this.options.cellHeight) {
      const cell = this.getCellAtPosition(x, y);
      if (cell && cell.row >= 1 && cell.row <= this.totalRows) {
        await this.selectRow(cell.row, {
          shift: event.shiftKey,
          ctrl: event.ctrlKey || event.metaKey,
        });
        await this.draw();
        return true;
      }
    }

    // Handle cell selection
    else {
      // Right click is handled by the context menu
      if (event.button === 2) {
        return false;
      }

      const cell = this.getCellAtPosition(x, y);
      if (cell) {
        if (this.selectedCols.length > 0) {
          this.selectedCols = [];
          this.selectedRows = [];
          this.selectedCells = null;

          this.statsVisualizer?.hide();
        }

        this.mouseState = MouseState.Dragging;

        this.selectedCols = [];
        this.selectedRows = [];
        this.selectedCells = {
          startRow: cell.row,
          endRow: cell.row,
          startCol: cell.col,
          endCol: cell.col,
        };

        this.updateToDraw(ToDraw.Selection);
        this.notifySelectionChange();
      }
    }

    await this.draw();
    return true;
  }

  public async handleMouseMove(event: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    let newHoverCell: { row: number; col: number } | null = null;

    switch (this.mouseState) {
      case MouseState.Dragging:
        newHoverCell = this.getCellAtPosition(x, y);

        // Update selection if dragging
        if (newHoverCell && this.selectedCells) {
          const selectionChanged = newHoverCell.row !== this.selectedCells.endRow || newHoverCell.col !== this.selectedCells.endCol;

          if (selectionChanged) {
            this.selectedCells.endRow = newHoverCell.row;
            this.selectedCells.endCol = newHoverCell.col;

            this.updateToDraw(ToDraw.Selection);
            this.notifySelectionChange();
          }
        }
        break;

      // Hovering
      default:
        newHoverCell = this.getCellAtPosition(x, y);
        const hoverChanged = newHoverCell?.row !== this.hoveredCell?.row || newHoverCell?.col !== this.hoveredCell?.col;
        if (hoverChanged) {
          this.hoveredCell = newHoverCell;
          if (this.isMouseOverColumnHeader(x, y)) {
            this.updateToDraw(ToDraw.ColHover);
          } else if (this.isMouseOverRowIndex(x, y)) {
            this.updateToDraw(ToDraw.RowHover);
          } else {
            this.updateToDraw(ToDraw.CellHover);
          }
        }
        break;
    }

    await this.draw();
    return true;
  }

  public async handleMouseUp(_: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    this.mouseState = MouseState.Idle;
    return true;
  }

  public async handleMouseLeave(_: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    this.hoveredCell = null;
    this.mouseState = MouseState.Idle;
    this.updateToDraw(ToDraw.CellHover);

    this.draw();
    return true;
  }

  public async handleWheel(event: WheelEvent): Promise<boolean> {
    if (!this._isFocused) return false;
    if (!this.container.contains(event.target as Node)) return false;

    // Only intercept Ctrl+Wheel for zoom. Regular scroll is handled natively
    // by the scroll container (which fires a scroll event → redraws).
    if (!event.ctrlKey) return false;

    event.preventDefault();

    const zoomFactor = event.deltaY > 0 ? 0.9 : 1.1;
    this.options.fontSize = Math.max(14, Math.min(24, this.options.fontSize * zoomFactor));
    this.options.cellHeight = Math.max(14, Math.min(24, this.options.cellHeight * zoomFactor));
    this.options.headerFontSize = Math.max(14, Math.min(24, this.options.headerFontSize * zoomFactor));
    this.options.cellPadding = Math.max(1, Math.min(10, this.options.cellPadding * zoomFactor));

    this.calculateColumnWidths();
    this.calculateRowHeight();
    this.updateToDraw(ToDraw.Cells);

    await this.draw();
    return true;
  }

  public async handleKeyDown(event: KeyboardEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    // The spreadsheet container isn't DOM-focusable (no tabindex), so
    // _isFocused stays true even while the user is typing inside the SQL
    // editor or another input. Without this guard, arrow keys in CodeMirror
    // would also move the cell selection. Bail when any editable element
    // has real DOM focus.
    const ae = document.activeElement as HTMLElement | null;
    if (
      ae &&
      (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)
    ) {
      return false;
    }

    const action = keymapService.matchEvent(event, "spreadsheet");
    if (!action) return false;
    event.preventDefault();

    return this.dispatchKeymapAction(action);
  }

  /**
   * Execute a spreadsheet keymap action on this instance. Shared by the
   * direct keyboard path (handleKeyDown) and by `spreadsheet.*` registry
   * commands, which route through {@link TabManager.getActiveDatasetTab}
   * so shell/palette callers hit the currently-focused tab.
   *
   * Post-processing (redraw + selection-change notification) runs for every
   * recognised action; returns false only when the action id is unknown.
   */
  public async dispatchKeymapAction(action: string): Promise<boolean> {
    const step = this.options.cellHeight * 3;

    switch (action) {
      // Scroll viewport
      case "spreadsheet.scrollUp":    this.scrollTo(this.scrollX, this.scrollY - step); break;
      case "spreadsheet.scrollDown":  this.scrollTo(this.scrollX, this.scrollY + step); break;
      case "spreadsheet.scrollLeft":  this.scrollTo(this.scrollX - step, this.scrollY); break;
      case "spreadsheet.scrollRight": this.scrollTo(this.scrollX + step, this.scrollY); break;

      // Extend selection (anchor stays, end moves)
      case "spreadsheet.extendUp":
        if (this.selectedCells) { this.selectedCells.endRow = Math.max(1, this.selectedCells.endRow - 1); this.scrollCellIntoView(this.selectedCells.endRow, this.selectedCells.endCol); }
        break;
      case "spreadsheet.extendDown":
        if (this.selectedCells) { this.selectedCells.endRow = Math.min(this.totalRows, this.selectedCells.endRow + 1); this.scrollCellIntoView(this.selectedCells.endRow, this.selectedCells.endCol); }
        break;
      case "spreadsheet.extendLeft":
        if (this.selectedCells) { this.selectedCells.endCol = Math.max(0, this.selectedCells.endCol - 1); this.scrollCellIntoView(this.selectedCells.endRow, this.selectedCells.endCol); }
        break;
      case "spreadsheet.extendRight":
        if (this.selectedCells) { this.selectedCells.endCol = Math.min(this.totalCols - 1, this.selectedCells.endCol + 1); this.scrollCellIntoView(this.selectedCells.endRow, this.selectedCells.endCol); }
        break;

      // Move selection
      case "spreadsheet.moveUp":
        if (this.selectedCells) {
          const newRow = Math.max(1, this.selectedCells.startRow - 1);
          this.selectedCells = { startRow: newRow, endRow: newRow, startCol: this.selectedCells.startCol, endCol: this.selectedCells.startCol };
          this.scrollCellIntoView(newRow, this.selectedCells.startCol);
        }
        break;
      case "spreadsheet.moveDown":
        if (this.selectedCols.length > 0) {
          const col = this.selectedCols[0];
          this.selectedCols = [];
          this.selectedRows = [];
          this.selectedCells = { startRow: 1, endRow: 1, startCol: col, endCol: col };
          this.statsVisualizer?.hide();
        } else if (this.selectedCells) {
          const newRow = Math.min(this.totalRows, this.selectedCells.startRow + 1);
          this.selectedCells = { startRow: newRow, endRow: newRow, startCol: this.selectedCells.startCol, endCol: this.selectedCells.startCol };
          this.scrollCellIntoView(newRow, this.selectedCells.startCol);
        }
        break;
      case "spreadsheet.moveLeft":
        if (this.selectedCols.length > 0) {
          const col = Math.max(0, this.selectedCols[0] - 1);
          this.selectedCols = [col];
          this.selectedCells = null;
          await this.statsVisualizer?.showStats(this.columns[col]);
          this.scrollTo(this.colOffsets[col] - this.viewportWidth / 2, this.scrollY);
        } else if (this.selectedCells) {
          const newCol = Math.max(0, this.selectedCells.startCol - 1);
          this.selectedCells = { startRow: this.selectedCells.startRow, endRow: this.selectedCells.startRow, startCol: newCol, endCol: newCol };
          this.scrollCellIntoView(this.selectedCells.startRow, newCol);
        }
        break;
      case "spreadsheet.moveRight":
        if (this.selectedCols.length > 0) {
          const col = Math.min(this.totalCols - 1, this.selectedCols[0] + 1);
          this.selectedCols = [col];
          this.selectedCells = null;
          await this.statsVisualizer?.showStats(this.columns[col]);
          this.scrollTo(this.colOffsets[col] - this.viewportWidth / 2, this.scrollY);
        } else if (this.selectedCells) {
          const newCol = Math.min(this.totalCols - 1, this.selectedCells.startCol + 1);
          this.selectedCells = { startRow: this.selectedCells.startRow, endRow: this.selectedCells.startRow, startCol: newCol, endCol: newCol };
          this.scrollCellIntoView(this.selectedCells.startRow, newCol);
        }
        break;

      case "spreadsheet.enter":
        if (!this.selectedCells && this.selectedCols.length === 0 && this.selectedRows.length === 0) {
          this.selectedCells = { startRow: 1, endRow: 1, startCol: 0, endCol: 0 };
        }
        break;

      case "spreadsheet.copy": {
        const selected = await this.getSelectedFormattedValues();
        if (selected.data.length > 0) {
          const s = persistenceService.loadAppSettings();
          const delim = s.copyDelimiter === "comma" ? "," : "\t";
          const includeHeader = s.copyIncludeHeader ?? true;
          const lines = selected.data.map((row) => row.join(delim));
          if (includeHeader) lines.unshift(selected.headers.join(delim));
          navigator.clipboard.writeText(lines.join("\n")).catch(console.error);
        }
        break;
      }

      case "spreadsheet.cancelSelection":
        this.selectedCells = null;
        break;

      default:
        return false;
    }

    this.updateToDraw(ToDraw.Selection);
    this.notifySelectionChange();
    await this.draw();
    return true;
  }

  public async handleResize(): Promise<boolean> {
    await this.updateLayout();
    this.updateToDraw(ToDraw.Cells);
    await this.draw();
    return true;
  }

  // Public method to trigger resize from external components
  public async resize(): Promise<void> {
    await this.handleResize();
  }
}
