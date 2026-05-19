import { DataProvider, SpreadsheetOptions } from "@/index";
import { FocusableComponent } from "../BedevereApp/types";
import { MouseState, ToDraw } from "./SpreadsheetVisualizerBase";
import { ColumnStatsVisualizer } from "../ColumnStatsVisualizer/ColumnStatsVisualizer";
import { SpreadsheetVisualizerSelection } from "./SpreadsheetVisualizerSelection";
import { keymapService } from "../../data/KeymapService";
import { persistenceService } from "../../data/PersistenceService";
import { getComplexKind, isComplexType } from "../../data/types";
import { ContextMenu, ContextMenuItem } from "./overlays/ContextMenu";

export class SpreadsheetVisualizerFocusable extends SpreadsheetVisualizerSelection implements FocusableComponent {
  private _isFocused: boolean = false;

  public readonly componentId: string;
  public readonly canReceiveFocus: boolean = true;
  public readonly focusableElement: HTMLElement;

  // Column-header drag state. A header mousedown sets the candidate;
  // a move past a small pixel threshold promotes it to an active drag
  // (creates the ghost + drop indicator). Mouseup commits the drop
  // when active, or falls through to the original `selectColumn`
  // path when it was just a click.
  //
  // Document-level listeners (rather than the EventDispatcher-routed
  // ones) so the drag continues even when the cursor exits the
  // canvas. They live only for the duration of one gesture.
  private static readonly HEADER_DRAG_THRESHOLD_PX = 4;
  private headerDragCandidate: {
    col: number;
    columnName: string;
    startClientX: number;
    startClientY: number;
    modifiers: { shift: boolean; ctrl: boolean };
  } | null = null;
  private headerDragActive: boolean = false;
  private headerDragGhostEl: HTMLElement | null = null;
  private headerDropIndicatorEl: HTMLElement | null = null;
  private headerDropTarget: { columnName: string; position: "before" | "after" } | null = null;

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

    // Skip clicks targeting a sibling element (e.g. an overlay
    // positioned over the canvas — context menu, dialog backdrop,
    // help panel). The bounds check below catches clicks physically
    // outside the canvas; this catches clicks on overlays that sit
    // *above* the canvas, where bounds still pass. Mirrors the
    // existing `handleWheel` pattern.
    if (!this.container.contains(event.target as Node)) return false;

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

      // Sort-arrow click zone: rightmost slice of the column header.
      // Plain click cycles the column's sort (asc -> desc -> off);
      // shift-click does the same in multi-key mode (preserves the
      // rest of the chain). Anywhere else on the header keeps the
      // selection behaviour, so shift-click on the header text still
      // extends the column-selection range.
      if (this.filterManager && col >= 0 && col < this.columns.length) {
        const colRight = this.colOffsets[col] + this.colWidths[col] - this.scrollX;
        const sortZoneWidth = 22;
        if (x >= colRight - sortZoneWidth) {
          this.filterManager.cycleSort(
            this.datasetName,
            this.columns[col].name,
            event.shiftKey,
          );
          return true;
        }
      }

      // Defer the click resolution: this might be the start of a
      // drag-to-reorder. The document-level mouseup listener
      // installed below either commits the drop (if a drag
      // activated) or falls back to `selectColumn` (pure click).
      if (col >= 0 && col < this.columns.length) {
        this.headerDragCandidate = {
          col,
          columnName: this.columns[col].name,
          startClientX: event.clientX,
          startClientY: event.clientY,
          modifiers: { shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey },
        };
        this.headerDragActive = false;
        this.installHeaderDragListeners();
        return true;
      }
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

    // A column-header drag is in flight — its document-level mousemove
    // listener owns the gesture. Skip the canvas hover-tracking path
    // so it doesn't fight with the drag ghost / drop indicator.
    if (this.headerDragCandidate) return false;

    // Cursor over an overlay (context menu, dialog, help panel) must
    // not update the canvas hover highlight. Drag-select past the
    // canvas edge stops updating once the cursor enters the overlay
    // and resumes when it returns — acceptable trade-off.
    if (!this.container.contains(event.target as Node)) return false;

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

  /**
   * Double-click on a body cell whose column carries a complex value
   * (STRUCT / LIST / MAP / JSON / UNION) opens the cell-value inspector
   * popover directly. Non-complex cells get no special treatment — the
   * preceding mousedown pair has already moved the cell selection.
   *
   * The cell payload is read here and passed through the
   * `onCellInspectRequested` callback so the popover doesn't have to
   * race the asynchronous selection-change notification path for its
   * `lastComplexCell` to be in sync.
   */
  public async handleDoubleClick(event: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > this.viewportWidth || y > this.viewportHeight) return false;

    const cell = this.getCellAtPosition(x, y);
    if (!cell || cell.col < 0 || cell.row < 1) return false;

    const column = this.columns[cell.col];
    if (!column || !isComplexType(column.dataType)) return false;

    // isComplexType already screened the column, but getComplexKind
    // returns ComplexKind | null so TS still needs the check.
    const kind = getComplexKind(column.dataType);
    if (!kind) return false;

    const value = await this.cache.getValue(cell.row - 1, cell.col);
    this.notifyCellInspectRequested({
      columnName: column.name,
      kind,
      value,
    });
    return true;
  }

  /**
   * Right-click → DOM context menu positioned at the cursor. Hit-tests
   * which zone of the canvas was clicked (header / row gutter / cell)
   * and builds the menu accordingly. `preventDefault` is unconditional
   * so the native menu never leaks even if the click falls outside
   * a known zone.
   *
   * For body cells / row gutter clicks the visualizer also moves the
   * selection to the clicked target unless that target is already
   * inside the current selection — matches the Excel / Sheets
   * convention so "Copy" in the menu always copies what the user
   * just right-clicked on.
   */
  public async handleContextMenu(event: MouseEvent): Promise<boolean> {
    if (!this._isFocused) return false;

    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > this.viewportWidth || y > this.viewportHeight) return false;

    event.preventDefault();

    const cell = this.getCellAtPosition(x, y);
    if (!cell) {
      ContextMenu.dismissActive();
      return true;
    }

    const overHeader = this.isMouseOverColumnHeader(x, y);
    const overRowGutter =
      x <= this.options.rowHeaderWidth && y >= this.options.cellHeight && cell.row >= 1;

    let items: ContextMenuItem[];
    if (overHeader && cell.col >= 0) {
      items = this.buildHeaderContextMenu(cell.col);
    } else if (overRowGutter) {
      if (!this.isRowInCurrentSelection(cell.row)) {
        await this.selectRow(cell.row, { shift: false, ctrl: false });
        await this.draw();
      }
      items = this.buildRowContextMenu();
    } else if (cell.row >= 1 && cell.col >= 0) {
      if (!this.isCellInCurrentSelection(cell.row, cell.col)) {
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
        await this.draw();
      }
      items = await this.buildCellContextMenu(cell.row, cell.col);
    } else {
      ContextMenu.dismissActive();
      return true;
    }

    if (items.length === 0) {
      ContextMenu.dismissActive();
      return true;
    }

    ContextMenu.show({ x: event.clientX, y: event.clientY, items });
    return true;
  }

  private isCellInCurrentSelection(row: number, col: number): boolean {
    if (this.selectedCells) {
      const { startRow, endRow, startCol, endCol } = this.selectedCells;
      const inRows = row >= Math.min(startRow, endRow) && row <= Math.max(startRow, endRow);
      const inCols = col >= Math.min(startCol, endCol) && col <= Math.max(startCol, endCol);
      if (inRows && inCols) return true;
    }
    if (this.selectedCols.includes(col)) return true;
    if (this.selectedRows.includes(row)) return true;
    return false;
  }

  private isRowInCurrentSelection(row: number): boolean {
    if (this.selectedRows.includes(row)) return true;
    if (this.selectedCells) {
      const { startRow, endRow } = this.selectedCells;
      if (row >= Math.min(startRow, endRow) && row <= Math.max(startRow, endRow)) return true;
    }
    return false;
  }

  private buildHeaderContextMenu(col: number): ContextMenuItem[] {
    const column = this.columns[col];
    if (!column) return [];
    const dir = this.filterManager?.isColumnSorted(this.datasetName, column.name) ?? null;
    return [
      {
        label: "Sort ascending",
        disabled: dir === "asc",
        action: () => {
          this.filterManager?.setSort(this.datasetName, { columnName: column.name, direction: "asc" });
        },
      },
      {
        label: "Sort descending",
        disabled: dir === "desc",
        action: () => {
          this.filterManager?.setSort(this.datasetName, { columnName: column.name, direction: "desc" });
        },
      },
      {
        label: "Clear sort",
        disabled: dir === null,
        action: () => {
          this.filterManager?.removeSort(this.datasetName, column.name);
        },
      },
      { separator: true },
      {
        label: "Hide column",
        action: () => {
          this.notifyHideColumnRequested({ datasetName: this.datasetName, columnName: column.name });
        },
      },
    ];
  }

  private async buildCellContextMenu(_row: number, col: number): Promise<ContextMenuItem[]> {
    const column = this.columns[col];
    if (!column) return [];

    const items: ContextMenuItem[] = [
      {
        label: "Copy",
        shortcut: "Ctrl+C",
        action: async () => {
          await this.dispatchKeymapAction("spreadsheet.copy");
        },
      },
    ];

    // Inspect: only meaningful when the column carries a complex
    // payload. We fetch the value at click time (same as
    // handleDoubleClick) rather than precomputing, so the menu opens
    // synchronously and only pays the cache hit if the user picks it.
    if (isComplexType(column.dataType)) {
      items.push({
        label: "Inspect",
        action: async () => {
          const target = this.selectedCells;
          if (!target) return;
          const kind = getComplexKind(column.dataType);
          if (!kind) return;
          const value = await this.cache.getValue(target.startRow - 1, target.startCol);
          this.notifyCellInspectRequested({ columnName: column.name, kind, value });
        },
      });
    }

    const dir = this.filterManager?.isColumnSorted(this.datasetName, column.name) ?? null;
    items.push(
      { separator: true },
      {
        label: "Sort by this column ↑",
        disabled: dir === "asc",
        action: () => {
          this.filterManager?.setSort(this.datasetName, { columnName: column.name, direction: "asc" });
        },
      },
      {
        label: "Sort by this column ↓",
        disabled: dir === "desc",
        action: () => {
          this.filterManager?.setSort(this.datasetName, { columnName: column.name, direction: "desc" });
        },
      },
      { separator: true },
      {
        label: "Hide column",
        action: () => {
          this.notifyHideColumnRequested({ datasetName: this.datasetName, columnName: column.name });
        },
      },
    );

    return items;
  }

  private buildRowContextMenu(): ContextMenuItem[] {
    return [
      {
        label: "Copy row",
        shortcut: "Ctrl+C",
        action: async () => {
          await this.dispatchKeymapAction("spreadsheet.copy");
        },
      },
    ];
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

    // Zoom changes cellHeight, which changes the row-snap result for the
    // viewport. Re-run updateLayout (rather than just calculateRowHeight)
    // so the snapped viewportHeight tracks the new cellHeight.
    await this.updateLayout();
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

    // Defer the copy action to the browser's native handler when the
    // user has selected text in the DOM *outside* the spreadsheet
    // (column-stats panel, status bar, help panel, etc.). Without
    // this guard the spreadsheet's cell-copy wins every Ctrl+C even
    // when the user clearly intended to copy what their mouse drag
    // selected.
    if (action === "spreadsheet.copy") {
      const selection = window.getSelection();
      const selText = selection ? selection.toString() : "";
      if (selText.length > 0) {
        // Inspect the selection's anchor — if it sits outside the
        // spreadsheet container, the browser will copy the selected
        // text natively when we don't preventDefault. The spreadsheet
        // has its own selection model (canvas-rendered cells); a
        // DOM selection there is essentially impossible, so this
        // check effectively means "real text is highlighted somewhere
        // else on the page".
        const anchor = selection?.anchorNode;
        const anchorEl = anchor && anchor.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor?.parentElement ?? null;
        if (anchorEl && !this.container.contains(anchorEl)) {
          return false;
        }
      }
    }

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

  // -- Column-header drag-to-reorder ----------------------------------

  /**
   * Document-level listeners are installed lazily on header mousedown
   * and torn down on mouseup. They run *outside* the
   * EventDispatcher-routed handlers so the gesture continues even when
   * the cursor leaves the canvas (e.g. mid-drag to the page edge).
   */
  private installHeaderDragListeners(): void {
    document.addEventListener("mousemove", this.headerDragMouseMove, true);
    document.addEventListener("mouseup", this.headerDragMouseUp, true);
  }

  private uninstallHeaderDragListeners(): void {
    document.removeEventListener("mousemove", this.headerDragMouseMove, true);
    document.removeEventListener("mouseup", this.headerDragMouseUp, true);
  }

  private headerDragMouseMove = (event: MouseEvent): void => {
    if (!this.headerDragCandidate) return;

    if (!this.headerDragActive) {
      // Activate only after the cursor has moved more than the
      // threshold. Below that, the gesture is treated as a click and
      // resolved in mouseup → `selectColumn`.
      const dx = Math.abs(event.clientX - this.headerDragCandidate.startClientX);
      const dy = Math.abs(event.clientY - this.headerDragCandidate.startClientY);
      if (dx < SpreadsheetVisualizerFocusable.HEADER_DRAG_THRESHOLD_PX &&
          dy < SpreadsheetVisualizerFocusable.HEADER_DRAG_THRESHOLD_PX) {
        return;
      }
      this.headerDragActive = true;
      this.createHeaderDragGhost(this.headerDragCandidate.columnName);
    }

    this.updateHeaderDragGhost(event.clientX, event.clientY);
    this.updateHeaderDropIndicator(event.clientX);
  };

  private headerDragMouseUp = async (_event: MouseEvent): Promise<void> => {
    this.uninstallHeaderDragListeners();
    const candidate = this.headerDragCandidate;
    this.headerDragCandidate = null;
    if (!candidate) return;

    if (this.headerDragActive) {
      const dropTarget = this.headerDropTarget;
      this.headerDragActive = false;
      this.headerDropTarget = null;
      this.removeHeaderDragGhost();
      this.removeHeaderDropIndicator();

      if (dropTarget && dropTarget.columnName !== candidate.columnName) {
        this.notifyReorderColumnRequested({
          datasetName: this.datasetName,
          sourceColumnName: candidate.columnName,
          targetColumnName: dropTarget.columnName,
          position: dropTarget.position,
        });
      }
      return;
    }

    // No drag — treat as a plain click on the column header.
    await this.selectColumn(candidate.col, candidate.modifiers);
    await this.draw();
  };

  private createHeaderDragGhost(columnName: string): void {
    const el = document.createElement("div");
    el.className = "spreadsheet__column-drag-ghost";
    el.textContent = columnName;
    document.body.appendChild(el);
    this.headerDragGhostEl = el;

    const indicator = document.createElement("div");
    indicator.className = "spreadsheet__column-drop-indicator";
    document.body.appendChild(indicator);
    this.headerDropIndicatorEl = indicator;
  }

  private updateHeaderDragGhost(clientX: number, clientY: number): void {
    if (!this.headerDragGhostEl) return;
    // Small offset so the ghost doesn't sit directly under the cursor
    // (and so the cursor remains free to hit-test the drop target).
    this.headerDragGhostEl.style.left = `${clientX + 12}px`;
    this.headerDragGhostEl.style.top = `${clientY + 6}px`;
  }

  private updateHeaderDropIndicator(clientX: number): void {
    if (!this.headerDropIndicatorEl) return;

    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;

    // Outside the canvas or in the row-header gutter → no drop target.
    if (x < this.options.rowHeaderWidth || x > this.viewportWidth) {
      this.headerDropTarget = null;
      this.headerDropIndicatorEl.style.display = "none";
      return;
    }

    // Find the column under the cursor; left half → drop before, right
    // half → drop after. Boundary x-coords are canvas-local (account
    // for scrollX) but the indicator is fixed-positioned so add the
    // canvas's left rect offset.
    for (let i = 0; i < this.columns.length; i++) {
      const colLeft = this.colOffsets[i] - this.scrollX;
      const colRight = colLeft + this.colWidths[i];
      if (x >= colLeft && x < colRight) {
        const mid = colLeft + this.colWidths[i] / 2;
        const position: "before" | "after" = x < mid ? "before" : "after";
        const localBoundary = position === "before" ? colLeft : colRight;
        this.headerDropTarget = { columnName: this.columns[i].name, position };
        this.headerDropIndicatorEl.style.display = "block";
        this.headerDropIndicatorEl.style.left = `${rect.left + localBoundary - 1}px`;
        this.headerDropIndicatorEl.style.top = `${rect.top}px`;
        this.headerDropIndicatorEl.style.height = `${rect.height}px`;
        return;
      }
    }

    this.headerDropTarget = null;
    this.headerDropIndicatorEl.style.display = "none";
  }

  private removeHeaderDragGhost(): void {
    if (this.headerDragGhostEl) {
      this.headerDragGhostEl.remove();
      this.headerDragGhostEl = null;
    }
  }

  private removeHeaderDropIndicator(): void {
    if (this.headerDropIndicatorEl) {
      this.headerDropIndicatorEl.remove();
      this.headerDropIndicatorEl = null;
    }
  }
}
