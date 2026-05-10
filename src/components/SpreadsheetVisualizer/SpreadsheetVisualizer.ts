import { SpreadsheetOptions } from "./types";
import { DataProvider } from "../../data/types";
import { ColumnStatsVisualizer } from "../ColumnStatsVisualizer/ColumnStatsVisualizer";
import { SpreadsheetVisualizerFocusable } from "./SpreadsheetVisualizerFocusable";
import { SpreadsheetCache } from "./SpreadsheetCache";
import { getThemeColors, listenForThemeChanges } from "./utils/theme";
import { ColumnInternal } from "./internals";
import { ToDraw } from "./SpreadsheetVisualizerBase";

export class SpreadsheetVisualizer extends SpreadsheetVisualizerFocusable {
  constructor(
    container: HTMLElement,
    dataProvider: DataProvider,
    options: Partial<SpreadsheetOptions> = {},
    statsVisualizer: ColumnStatsVisualizer,
    componentId?: string,
  ) {
    super(container, dataProvider, options, statsVisualizer, componentId ?? "spreadsheet-visualizer");

    // Use provided stats visualizer or create a new one
    this.statsVisualizer = statsVisualizer ?? new ColumnStatsVisualizer(this.container, this);
    this.statsVisualizer.setSpreadsheetVisualizer(this).catch(console.error);

    // Setup theme change listener
    this.themeCleanup = listenForThemeChanges(() => {
      this.updateThemeColors();
      // `draw()` is gated on `this.toDraw`; without forcing a Cells-level
      // repaint here, the next frame would no-op and the canvas would keep
      // the old palette until the user scrolled / clicked.
      this.updateToDraw(ToDraw.Cells);
      // Recompute column widths before redrawing — the cached metrics in
      // ColumnInternal.widthPx were measured against the previous theme's
      // font/letter-spacing; a theme flip can change the resolved
      // monospace fallback and produce stale widths.
      this.calculateColumnWidths()
        .then(() => this.draw())
        .catch(console.error);
    });
  }

  public async initialize() {
    this.metadata = await this.dataProvider.getMetadata();
    if (!this.metadata) return;

    this.columns = this.metadata.columns.map((col) => new ColumnInternal(col, this.options));
    this.totalRows = this.metadata.totalRows;
    this.totalCols = this.metadata.totalColumns;

    await this.cache.initialize(this.totalRows);
    await this.updateLayout();
  }

  public async reinitialize(dataProvider: DataProvider): Promise<void> {
    this.dataProvider = dataProvider;
    this.cache.clear();
    this.cache = new SpreadsheetCache(this.dataProvider, this.options);
    // Re-subscribe to the new cache's load events so skeleton rows flip
    // to real data on fetch resolution. The previous cache's listeners
    // were wiped by its own clear() above.
    this.attachCacheListener();
    // Selection state is preserved across reinitialize. Sort doesn't
    // change which cells live at a given screen position (only which
    // *data* sits under them); filters shrink the row count, but the
    // selection-painting paths skip out-of-range entries. Keeping the
    // selection means clicking a stats-panel sort button doesn't drop
    // the column the user just sorted.
    //
    // Hover state is the exception — `hoveredCell` is a transient
    // pointer position. Null it out so the next mouse move repaints
    // hover at the post-sort layout instead of ghosting an old rect.
    this.hoveredCell = null;
    await this.initialize();
    // Sync scrollX/Y to whatever the scroll container is showing — for
    // sort-only changes the user's pre-reinit position stays valid
    // (columns and row count don't change); for filter changes the
    // browser already clamped scrollTop when the scroll spacer shrank,
    // and we mirror that here so the canvas paint and the scrollbar
    // position can't desync. Without this, a sort-from-the-far-right
    // scrolled the rendered content back to column 0.
    this.scrollX = Math.min(this.scrollContainer.scrollLeft, this.totalScrollX);
    this.scrollY = Math.min(this.scrollContainer.scrollTop, this.totalScrollY);
    this.scrollContainer.scrollLeft = this.scrollX;
    this.scrollContainer.scrollTop = this.scrollY;
  }

  public show(): void {
    this.container.style.display = "block";
  }

  public hide(): void {
    this.container.style.display = "none";
    this.statsVisualizer?.hide();
  }

  public destroy(): void {
    // Clean up theme listener
    if (this.themeCleanup) {
      this.themeCleanup();
      this.themeCleanup = null;
    }

    // ResizeObserver + dpr media-query listener installed by the Base.
    this.destroyBase();

    this.statsVisualizer?.hide();

    // Clear the data cache
    this.cache.clear();
  }

  private updateThemeColors(): void {
    const t = getThemeColors();
    this.options.headerBackgroundColor = t.headerBackgroundColor;
    this.options.headerTextColor = t.headerTextColor;
    this.options.cellBackgroundColor = t.cellBackgroundColor;
    this.options.cellTextColor = t.cellTextColor;
    this.options.stripeBackgroundColor = t.stripeBackgroundColor;
    this.options.borderColor = t.borderColor;
    this.options.selectionColor = t.selectionColor;
    this.options.selectionBorderColor = t.selectionBorderColor;
    this.options.hoverColor = t.hoverColor;
    this.options.hoverBorderColor = t.hoverBorderColor;
    this.options.scrollbarColor = t.scrollbarColor;
    this.options.scrollbarThumbColor = t.scrollbarThumbColor;
    this.options.scrollbarHoverColor = t.scrollbarHoverColor;
  }
}
