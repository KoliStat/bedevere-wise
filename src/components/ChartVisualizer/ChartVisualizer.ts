import vegaEmbed, { type Result, type VisualizationSpec } from "vega-embed";
import { listenForThemeChanges, detectCurrentTheme } from "../SpreadsheetVisualizer/utils/theme";

/**
 * Renders a Vega-Lite spec produced by stats_duck's `VISUALIZE … DRAW <mark>`
 * extension, with per-layer datasets supplied by the caller (each layer is a
 * SQL string that bedevere-wise has already executed against DuckDB-WASM).
 *
 * Keeps lifecycle parity with SpreadsheetVisualizer: subscribe to theme
 * changes on mount, tear down on destroy. The chart re-embeds on theme flip
 * with a fresh Tokyonight-flavoured `config` block so axes / labels / grids
 * blend with the rest of the UI.
 */
export class ChartVisualizer {
  private host: HTMLElement;
  private currentSpec: VisualizationSpec | null = null;
  private currentDatasets: Record<string, unknown[]> = {};
  private currentResult: Result | null = null;
  private themeCleanup: (() => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.classList.add("chart-visualizer");
    this.themeCleanup = listenForThemeChanges(() => this.reembed());
  }

  /**
   * Mount or replace the rendered chart. Called once per VISUALIZE result;
   * theme flips reuse the cached spec + datasets via {@link reembed}.
   */
  public async setSpec(spec: VisualizationSpec, datasets: Record<string, unknown[]>): Promise<void> {
    this.currentSpec = spec;
    this.currentDatasets = datasets;
    await this.reembed();
  }

  public destroy(): void {
    if (this.themeCleanup) {
      this.themeCleanup();
      this.themeCleanup = null;
    }
    if (this.currentResult) {
      this.currentResult.finalize();
      this.currentResult = null;
    }
    this.host.innerHTML = "";
  }

  /**
   * Export the rendered chart as a Blob suitable for download. Mirrors the
   * options vega-embed's own action menu offers ("Save as PNG / SVG").
   * Throws if the chart hasn't rendered yet.
   */
  public async exportAsBlob(format: "png" | "svg"): Promise<{ blob: Blob; ext: string }> {
    if (!this.currentResult) throw new Error("Chart hasn't rendered yet");
    const view = this.currentResult.view;
    if (format === "svg") {
      const svg = await view.toSVG();
      return { blob: new Blob([svg], { type: "image/svg+xml" }), ext: "svg" };
    }
    // PNG: vega returns a `data:image/png;base64,…` URL — decode to bytes.
    const url = await view.toImageURL("png");
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) throw new Error(`unexpected toImageURL output: ${url.slice(0, 32)}…`);
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return { blob: new Blob([bytes], { type: m[1] }), ext: "png" };
  }

  private async reembed(): Promise<void> {
    if (!this.currentSpec) return;
    if (this.currentResult) {
      this.currentResult.finalize();
      this.currentResult = null;
    }
    // Wait one paint frame before measuring. The tab activation just
    // toggled the host from `display: none` to block; without this, vega
    // can read a zero `clientWidth` on the very first embed and render a
    // chart that has only the y-axis. For non-faceted specs `autosize:
    // "fit"` re-layouts after the container settles and the chart self-
    // corrects; for faceted / repeat / concat specs Vega-Lite ignores
    // autosize entirely (per its docs), so the bad initial measurement
    // sticks. Awaiting a frame fixes both paths.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const themedSpec = this.applyTheme(this.currentSpec);
    const fullSpec = this.withSizing(themedSpec);
    this.currentResult = await vegaEmbed(this.host, fullSpec, {
      actions: { export: true, source: true, compiled: true, editor: true },
      renderer: "canvas",
    });
  }

  /**
   * Vega-Lite supports a top-level `datasets` block ({name: rows[]}) that
   * is referenced by `data: { name }` inside the spec — stats_duck's spec
   * already references `layer_0`, `layer_1`, … so we inline the rows here.
   *
   * For mark / layer specs we add `width: "container"` + `height:
   * "container"` + `autosize: "fit"` so the chart fills the host. For
   * composite views (`facet`, `repeat`, `concat`, `hconcat`, `vconcat`)
   * Vega-Lite ignores autosize and the container directives don't apply
   * cleanly to the inner panels — leaving them in collapses the chart to
   * its axes. For those specs we let Vega-Lite use its per-panel defaults
   * (200×200) unless the spec explicitly sets dimensions.
   */
  private withSizing(themedSpec: VisualizationSpec): VisualizationSpec {
    const s = themedSpec as Record<string, unknown>;
    // A `column` / `row` encoding channel makes a unit (or per-layer) spec
    // faceted just like the top-level `facet` operator: Vega-Lite then ignores
    // `autosize`, and `width: "container"` doesn't apply cleanly to the inner
    // panels — it blows each facet up to the full host width, so only the first
    // is visible. stats_duck's `violin` mark facets this way (one column per x
    // category), so detect it and fall through to the composite path.
    const hasEncodingFacet = (node: unknown): boolean => {
      const enc = (node as { encoding?: Record<string, unknown> } | null)?.encoding;
      return !!enc && ("column" in enc || "row" in enc);
    };
    const isComposite =
      "facet" in s || "repeat" in s || "concat" in s || "hconcat" in s || "vconcat" in s ||
      hasEncodingFacet(s) ||
      (Array.isArray(s.layer) && (s.layer as unknown[]).some(hasEncodingFacet));
    if (isComposite) {
      return { ...themedSpec, datasets: this.currentDatasets } as VisualizationSpec;
    }
    return {
      ...themedSpec,
      width: s.width ?? "container",
      height: s.height ?? "container",
      autosize: s.autosize ?? { type: "fit", contains: "padding" },
      datasets: this.currentDatasets,
    } as VisualizationSpec;
  }

  /**
   * Inject a Tokyonight-flavoured `config` block (background, axis, view…)
   * built from the active CSS custom properties. Reads computed styles
   * once per re-embed; values match what the spreadsheet uses.
   */
  private applyTheme(spec: VisualizationSpec): VisualizationSpec {
    const css = getComputedStyle(document.body);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const ct = detectCurrentTheme();
    const isLight = ct === "light" || ct === "classic-light";

    const themeConfig = {
      background: v("--bg") || (isLight ? "#f5f5f3" : "#1f1f1f"),
      view: { stroke: v("--border") || "#3b4261" },
      axis: {
        domainColor: v("--border") || "#3b4261",
        gridColor:   v("--border") || "#292e42",
        labelColor:  v("--fg-dark") || "#a9b1d6",
        titleColor:  v("--fg") || "#c0caf5",
        tickColor:   v("--border") || "#3b4261",
      },
      legend: {
        labelColor: v("--fg-dark") || "#a9b1d6",
        titleColor: v("--fg") || "#c0caf5",
      },
      title: { color: v("--fg") || "#c0caf5" },
    };

    // Merge with any user-provided config in the spec; user wins.
    const existing = (spec as { config?: Record<string, unknown> }).config ?? {};
    return { ...spec, config: { ...themeConfig, ...existing } } as VisualizationSpec;
  }
}
