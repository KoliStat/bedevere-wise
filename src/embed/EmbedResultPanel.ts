import { SpreadsheetVisualizer } from "../components/SpreadsheetVisualizer/SpreadsheetVisualizer";
import { SpreadsheetOptions } from "../components/SpreadsheetVisualizer/types";
import { ColumnStatsVisualizerFocusable } from "../components/ColumnStatsVisualizer/ColumnStatsVisualizerFocusable";
import type { ChartVisualizer } from "../components/ChartVisualizer/ChartVisualizer";
import { DuckDBDataProvider } from "../data/DuckDBDataProvider";
import type { VisualizeResult } from "../data/visualize";

export interface EmbedResultPanelOptions {
  spreadsheetOptions: SpreadsheetOptions;
}

/**
 * Hard ceiling for a table result's panel height. Beyond this the grid
 * stops growing and scrolls internally instead, so a 10k-row result
 * can't blow the iframe up to a page-tall canvas.
 */
const MAX_EMBED_TABLE_HEIGHT = 600;

/**
 * Default canvas height used by `cellHeight` math when the spreadsheet
 * options omit one. Mirrors DEFAULT_CELL_HEIGHT in the visualizer
 * defaults — header row and body rows share this height (the grid's
 * own content extent is `(rows + 1) * cellHeight`).
 */
const DEFAULT_CELL_HEIGHT = 24;

/**
 * Slack added below the computed grid content height so the horizontal
 * scrollbar (when the columns are wider than the narrow embed panel)
 * doesn't eat the last row. Added unconditionally — over-reserving a
 * dozen pixels is invisible; under-reserving clips a row.
 */
const HORIZONTAL_SCROLLBAR_ALLOWANCE = 14;

/**
 * Fixed height for chart (VISUALIZE) results. Charts aren't row-based,
 * so they get a sensible default canvas instead of a table-fitted one.
 */
const EMBED_CHART_HEIGHT = 360;

/**
 * Bottom-half result surface for the /embed route. Owns one
 * SpreadsheetVisualizer or ChartVisualizer at a time — running a new
 * query tears the previous one down and constructs a fresh visualizer.
 * The main app's TabManager keeps every result around as a tab; the
 * embed is intentionally single-result so a parent page with multiple
 * iframes stays predictable in height.
 *
 * The shared ColumnStatsVisualizer is created lazily so we don't pay
 * for it on a "no dataset yet" first paint. The ChartVisualizer module
 * is loaded via dynamic import to keep the vega-embed bundle (~800 KB)
 * off the initial embed page-load — only users who run a VISUALIZE
 * query pay for it.
 */
export class EmbedResultPanel {
  private container: HTMLElement;
  /** Inner mount that holds either the current visualizer or a
   *  hint / error message. We swap children of this node when
   *  results change so the outer container's classes (height
   *  reservation) survive. */
  private surface: HTMLElement;
  private statsContainer: HTMLElement;
  private statsVisualizer: ColumnStatsVisualizerFocusable | null = null;
  private current: SpreadsheetVisualizer | null = null;
  private currentChart: ChartVisualizer | null = null;
  private options: EmbedResultPanelOptions;

  constructor(parent: HTMLElement, options: EmbedResultPanelOptions) {
    this.options = options;

    this.container = document.createElement("div");
    this.container.className = "embed-result";
    parent.appendChild(this.container);

    this.surface = document.createElement("div");
    this.surface.className = "embed-result__surface";
    this.container.appendChild(this.surface);

    // The stats visualizer (column histograms / summaries panel) is a
    // hidden child of the container; SpreadsheetVisualizer toggles its
    // visibility itself when the user clicks a column header.
    this.statsContainer = document.createElement("div");
    this.statsContainer.className = "embed-result__stats";
    this.container.appendChild(this.statsContainer);
  }

  public showHint(message: string): void {
    this.disposeCurrent();
    this.resetHeight();
    this.surface.textContent = "";
    const hint = document.createElement("div");
    hint.className = "embed-result__hint";
    hint.textContent = message;
    this.surface.appendChild(hint);
  }

  public showError(message: string): void {
    this.disposeCurrent();
    this.resetHeight();
    this.surface.textContent = "";
    const banner = document.createElement("div");
    banner.className = "embed-result__error";
    banner.textContent = message;
    this.surface.appendChild(banner);
  }

  /**
   * Drop any explicit pixel height a previous table/chart result left on
   * the container so hint/error states size to their own content (the
   * SCSS `min-height` keeps a one-line message from collapsing).
   */
  private resetHeight(): void {
    this.container.style.height = "";
  }

  public async showResult(provider: DuckDBDataProvider, _name: string): Promise<void> {
    this.disposeCurrent();
    this.surface.textContent = "";

    const mount = document.createElement("div");
    mount.className = "embed-result__grid";
    this.surface.appendChild(mount);

    // Row count drives the content height. `getMetadata()` is the
    // DataProvider contract method — for DuckDB it's a cheap
    // `SELECT COUNT(*)`. The visualizer re-reads it inside initialize();
    // we read it here too so the panel can be sized before the canvas
    // paints (one extra COUNT(*) is immaterial next to a query result).
    const rowCount = (await provider.getMetadata()).totalRows;

    // Size the result surface to hug the grid's own content extent.
    // The visualizer paints the header as one cell row and reserves
    // `(rows + 1) * cellHeight` of content; mirror that, add slack for a
    // possible horizontal scrollbar, then clamp so a 1-row table is
    // snug and a huge one caps and scrolls internally.
    const cellHeight = this.options.spreadsheetOptions.cellHeight ?? DEFAULT_CELL_HEIGHT;
    // header row + body rows, matching the grid's `(rows + 1) * cellHeight`
    const contentHeight = (rowCount + 1) * cellHeight + HORIZONTAL_SCROLLBAR_ALLOWANCE;
    // Floor = header + one row so 0/1-row results still render cleanly.
    const floor = 2 * cellHeight;
    const desiredHeight = Math.max(floor, Math.min(MAX_EMBED_TABLE_HEIGHT, contentHeight));
    this.container.style.height = `${desiredHeight}px`;

    // Force layout so SpreadsheetVisualizer's clientWidth/Height reads
    // pick up real dimensions (including the height we just set) instead
    // of falling back to the option minimums on first paint.
    void this.container.offsetHeight;

    if (!this.statsVisualizer) {
      this.statsVisualizer = new ColumnStatsVisualizerFocusable(this.statsContainer, null);
    }

    const opts: Partial<SpreadsheetOptions> = {
      ...this.options.spreadsheetOptions,
      width: mount.clientWidth || this.options.spreadsheetOptions.width,
      height: mount.clientHeight || this.options.spreadsheetOptions.height,
    };

    const viz = new SpreadsheetVisualizer(mount, provider, opts, this.statsVisualizer, "embed-result");
    this.current = viz;
    await viz.initialize();
    // The initial updateLayout inside initialize() races
    // calculateColumnWidths against draw — the unwrapped microtask order
    // can land draw() first, leaving the canvas painted with empty
    // colWidths until the next event (scroll / theme switch) forces a
    // redraw. The main app's TabManager.activateTab works around this
    // by yielding one frame and calling resize(); we do the same. The
    // resize() also snaps the canvas to the explicit height set above.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await viz.resize();
  }

  /**
   * Render a stats_duck VISUALIZE result. The spec + datasets come from
   * {@link runVisualize} (pre-processed: Arrow rows unwrapped, decimals
   * scaled, composite spec data refs patched).
   *
   * `vega-embed` is pulled in via dynamic import inside ChartVisualizer
   * so this method's first call is what loads the chart bundle —
   * downstream pages that never run VISUALIZE pay nothing for it.
   */
  public async showChart(visualizeResult: VisualizeResult, _name: string): Promise<void> {
    this.disposeCurrent();
    this.surface.textContent = "";

    const mount = document.createElement("div");
    mount.className = "embed-result__chart";
    this.surface.appendChild(mount);

    // Charts aren't row-based — give the panel a fixed, sensible canvas
    // height instead of a table-fitted one (and overwrite any height a
    // previous table result left on the container).
    this.container.style.height = `${EMBED_CHART_HEIGHT}px`;

    // Force layout so vega-embed measures the host's real
    // clientWidth/Height when computing chart size, not zero.
    void this.container.offsetHeight;

    // Dynamic import keeps the ~800 KB vega-embed bundle out of the
    // initial /embed page-load. Same trick TabManager.addChartResult uses.
    const { ChartVisualizer } = await import("../components/ChartVisualizer/ChartVisualizer");
    const viz = new ChartVisualizer(mount);
    this.currentChart = viz;
    await viz.setSpec(visualizeResult.spec, visualizeResult.datasets);
  }

  public async resize(): Promise<void> {
    if (this.current) await this.current.resize();
    // ChartVisualizer (Vega-Lite) auto-fits its container — nothing to
    // call here. The embed parent listens for ResizeObserver and
    // emits the iframe height, so the chart self-corrects on the
    // next paint.
  }

  private disposeCurrent(): void {
    if (this.current) {
      this.current.destroy();
      this.current = null;
    }
    if (this.currentChart) {
      this.currentChart.destroy();
      this.currentChart = null;
    }
  }
}
