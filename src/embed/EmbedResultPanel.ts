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
    this.surface.textContent = "";
    const hint = document.createElement("div");
    hint.className = "embed-result__hint";
    hint.textContent = message;
    this.surface.appendChild(hint);
  }

  public showError(message: string): void {
    this.disposeCurrent();
    this.surface.textContent = "";
    const banner = document.createElement("div");
    banner.className = "embed-result__error";
    banner.textContent = message;
    this.surface.appendChild(banner);
  }

  public async showResult(provider: DuckDBDataProvider, _name: string): Promise<void> {
    this.disposeCurrent();
    this.surface.textContent = "";

    const mount = document.createElement("div");
    mount.className = "embed-result__grid";
    this.surface.appendChild(mount);

    // Force layout so SpreadsheetVisualizer's clientWidth/Height reads
    // pick up real dimensions instead of falling back to the option
    // minimums on first paint.
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
    // by yielding one frame and calling resize(); we do the same.
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
