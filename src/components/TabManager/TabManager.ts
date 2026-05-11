import { SpreadsheetVisualizer } from "../SpreadsheetVisualizer/SpreadsheetVisualizer";
import { SpreadsheetOptions } from "../SpreadsheetVisualizer/types";
import { ColumnStatsVisualizerFocusable } from "../ColumnStatsVisualizer/ColumnStatsVisualizerFocusable";
import { CommandBar } from "../CommandBar";
import { SqlEditor } from "../SqlEditor";
import type { ChartVisualizer } from "../ChartVisualizer";
import { DataProvider, DatasetMetadata } from "../../data/types";
import { DuckDBService } from "../../data/DuckDBService";
import { ColumnFilterManager } from "../../data/ColumnFilterManager";
import { FilteredDuckDBDataProvider } from "../../data/FilteredDuckDBDataProvider";
import { EventDispatcher } from "../BedevereApp/EventDispatcher";
import { CellInspectInfo, ICellSelection } from "../SpreadsheetVisualizer/types";
import { parseShellLine, runShellLine, ShellResult } from "../../data/Shell";
import { commandRegistry } from "../../data/CommandRegistry";
import {
  parseScript,
  classifyStatement,
  extractCreateTargetName,
  KNOWN_DIRECTIVES,
} from "../../data/sqlScript";
import { unwrapArrowValue } from "../../data/arrowUnwrap";
import { getStatsDuckFailureReason } from "../../data/statsDuckStatus";
import type { VisualizationSpec } from "vega-embed";

const KNOWN_SQL_DIRECTIVES = new Set<string>(KNOWN_DIRECTIVES);

/**
 * stats_duck v1.5.1 emits faceted (and likely repeat / concat) Vega-Lite
 * specs with `data: { name: "layer_n" }` on each inner layer rather than
 * at the outer level. Vega-Lite v6's facet operator groups *outer* data;
 * with the data only on inner layers it sees zero groups, no panels render,
 * and only the y-axis ends up on the canvas (the "57px-wide chart" symptom).
 *
 * Promote the first layer's data reference to the outer spec and strip the
 * per-layer ones so all layers inherit the faceted slice. Idempotent —
 * leaves the spec untouched when it's not composite or already has outer
 * data. (When stats_duck fixes this upstream, the patch becomes a no-op.)
 */
function patchVisualizeSpec(spec: Record<string, unknown>, datasets: Record<string, unknown[]>): void {
  const isComposite =
    "facet" in spec || "repeat" in spec || "concat" in spec || "hconcat" in spec || "vconcat" in spec;
  if (!isComposite) return;
  if (spec.data) return;

  const inner = (spec.spec as Record<string, unknown> | undefined) ?? spec;
  const layers = inner.layer as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(layers) || layers.length === 0) return;

  const seed = layers
    .map((layer) => (layer.data as { name?: string } | undefined)?.name)
    .find((name) => typeof name === "string" && name in datasets);
  if (!seed) return;

  spec.data = { name: seed };
  for (const layer of layers) {
    if (layer.data) delete layer.data;
  }
}

interface DatasetTab {
  kind: "dataset";
  metadata: DatasetMetadata;
  dataProvider: DataProvider;
  spreadsheetVisualizer: SpreadsheetVisualizer;
  container: HTMLElement;
  isActive: boolean;
  onCloseTab?: () => void;
}

interface ChartTab {
  kind: "chart";
  metadata: { name: string };
  chartVisualizer: ChartVisualizer;
  container: HTMLElement;
  isActive: boolean;
  onCloseTab?: () => void;
}

type Tab = DatasetTab | ChartTab;

export class TabManager {
  private container: HTMLElement;
  private tabsContainer: HTMLElement;
  private sqlEditorContainer: HTMLElement;
  private commandBarContainer: HTMLElement;
  private contentContainer: HTMLElement;
  private tabs: Tab[] = [];
  private chartCounter = 0;
  private activeTabId: string | null = null;
  private options: SpreadsheetOptions;
  private sharedStatsVisualizer: ColumnStatsVisualizerFocusable;
  private commandBar: CommandBar | null = null;
  private sqlEditor: SqlEditor | null = null;
  private filterManager: ColumnFilterManager = new ColumnFilterManager();
  private duckDBService: DuckDBService | null = null;
  private eventDispatcher?: EventDispatcher;
  private onCellSelectionCallback?: (cellSelection?: ICellSelection) => void;
  private onCellInspectCallback?: (info: CellInspectInfo) => void;
  private onCloseTabCallback?: () => void;
  private onSelectCallback?: (dataset: DataProvider) => void;
  private onChartActivateCallback?: (chartName: string) => void;
  private onQueryErrorCallback?: (error: Error) => void;
  private onQueryCompletedCallback?: (result: { elapsedMs: number; error?: Error }) => void;
  private onShellMessageCallback?: (text: string, details?: string) => void;
  // Monotonic counter for default result-tab names (`result_1`, `result_2`,
  // …). Resets per session — these tables don't survive a page reload.
  private resultCounter = 0;

  constructor(parent: HTMLElement, options: SpreadsheetOptions = {}) {
    this.container = document.createElement("div");
    this.container.className = "tab-manager";
    this.options = options;

    // Set explicit dimensions if provided
    if (options.width) {
      this.container.style.width = `${options.width}px`;
    }
    if (options.height) {
      this.container.style.height = `${options.height}px`;
    }

    // Create tabs container
    this.tabsContainer = document.createElement("div");
    this.tabsContainer.className = "tab-manager__tabs-container";

    // Create command bar container (above tabs)
    this.commandBarContainer = document.createElement("div");
    this.commandBarContainer.className = "tab-manager__command-bar-container";

    // Create SQL editor container (between tabs and content)
    this.sqlEditorContainer = document.createElement("div");
    this.sqlEditorContainer.className = "tab-manager__sql-editor-container";

    // Create content container
    this.contentContainer = document.createElement("div");
    this.contentContainer.className = "tab-manager__content-container";

    this.container.appendChild(this.commandBarContainer);
    this.container.appendChild(this.sqlEditorContainer);
    this.container.appendChild(this.tabsContainer);
    this.container.appendChild(this.contentContainer);
    parent.appendChild(this.container);

    // Force layout calculation
    this.container.offsetHeight;

    // Create shared stats visualizer
    this.sharedStatsVisualizer = new ColumnStatsVisualizerFocusable(this.container, null);

    // Command bar is always visible — it hosts the shell input and needs to
    // be usable before any dataset exists (.open, .help etc.). Previously
    // created lazily on the first dataset; gating moved here.
    this.commandBar = new CommandBar({ container: this.commandBarContainer });
    this.commandBar.setOnToggleSqlEditorCallback(() => this.toggleSqlEditor());

    // Setup resize handling
    this.setupResizeHandling();

    // Wire up filter changes
    this.filterManager.onChange((datasetName) => this.handleFilterChange(datasetName));
  }

  public async addDataset(metadata: DatasetMetadata, dataProvider: DataProvider): Promise<void> {
    // Create a separate container for this dataset's spreadsheet visualizer
    const datasetContainer = document.createElement("div");
    datasetContainer.className = "tab-manager__dataset-container";
    this.contentContainer.appendChild(datasetContainer);

    // Force layout calculation to get accurate dimensions
    this.container.offsetHeight;
    this.tabsContainer.offsetHeight;
    this.commandBarContainer.offsetHeight;
    this.contentContainer.offsetHeight;

    // Calculate actual available dimensions based on container size
    const containerWidth = this.container.clientWidth;
    const containerHeight = this.container.clientHeight;
    const tabsHeight = this.tabsContainer.offsetHeight || 40;
    const sqlEditorHeight = this.sqlEditorContainer.offsetHeight || 0;
    const commandBarHeight = this.commandBarContainer.offsetHeight || 32;
    const chromeHeight = tabsHeight + sqlEditorHeight + commandBarHeight;

    // Calculate dimensions that will fill the available space
    const availableWidth = containerWidth > 0 ? containerWidth : this.options.width;
    const availableHeight =
      containerHeight > 0
        ? containerHeight - chromeHeight
        : this.options.height
        ? this.options.height - chromeHeight
        : undefined;

    // Create options for the spreadsheet with calculated dimensions
    const spreadsheetOptions = {
      ...this.options,
      width: availableWidth,
      height: availableHeight,
      // Remove any fixed min/max constraints that might limit full utilization
      minWidth: Math.min(this.options.minWidth || 600, availableWidth || 600),
      minHeight: Math.min(this.options.minHeight || 400, availableHeight || 400),
    };

    // Create wrapper for event handling
    const spreadsheetVisualizer = new SpreadsheetVisualizer(
      datasetContainer,
      dataProvider,
      spreadsheetOptions,
      this.sharedStatsVisualizer,
      `spreadsheet-${metadata.name}`
    );

    // Wire filter manager for header indicators
    spreadsheetVisualizer.setFilterManager(this.filterManager, metadata.name);

    // Connect selection change to cell value bar
    spreadsheetVisualizer.addOnSelectionChangeSubscription((selection) => {
      if (this.commandBar && selection) {
        this.commandBar.updateCell(selection);
      } else if (this.commandBar) {
        this.commandBar.updateCell(undefined);
      }
    });

    // Wire the external cell-selection callback exactly once per dataset. Doing
    // this in activateTab would add a new subscription every time the user
    // switches to this tab, causing the callback to fire N times after N
    // activations.
    if (this.onCellSelectionCallback) {
      spreadsheetVisualizer.addOnSelectionChangeSubscription(this.onCellSelectionCallback);
    }
    if (this.onCellInspectCallback) {
      spreadsheetVisualizer.addOnCellInspectRequestedSubscription(this.onCellInspectCallback);
    }

    const tab: DatasetTab = {
      kind: "dataset",
      metadata,
      dataProvider,
      spreadsheetVisualizer,
      container: datasetContainer,
      isActive: false,
    };

    this.tabs.push(tab);
    this.createTabElement(tab);

    // Register with event dispatcher if available
    if (this.eventDispatcher) {
      this.eventDispatcher.registerComponent(tab.spreadsheetVisualizer);
    }

    // Initialize the spreadsheet
    await spreadsheetVisualizer.initialize();

    // If this is the first tab, activate it.
    if (this.tabs.length === 1) {
      await this.activateTab(metadata.name);
    }
  }

  public async switchToDataset(id: string): Promise<void> {
    const tab = this.tabs.find((t) => t.metadata.name === id);
    if (tab) {
      this.activateTab(id);
    }
  }

  public switchToNextTab(): void {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.isActive);
    const next = idx < 0 ? 0 : (idx + 1) % this.tabs.length;
    this.activateTab(this.tabs[next].metadata.name);
  }

  public switchToPreviousTab(): void {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex((t) => t.isActive);
    const prev = idx < 0 ? 0 : (idx - 1 + this.tabs.length) % this.tabs.length;
    this.activateTab(this.tabs[prev].metadata.name);
  }

  public switchToTabByIndex(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activateTab(this.tabs[index].metadata.name);
  }

  public closeDataset(name: string): void {
    const tabIndex = this.tabs.findIndex((t) => t.metadata.name === name);
    if (tabIndex === -1) return;

    const tab = this.tabs[tabIndex];

    if (tab.kind === "dataset") {
      if (this.eventDispatcher) {
        this.eventDispatcher.unregisterComponent(tab.spreadsheetVisualizer.componentId);
      }
    } else {
      tab.chartVisualizer.destroy();
    }

    // Remove tab element
    const tabElement = this.tabsContainer.querySelector(`[data-tab-id="${name}"]`);
    if (tabElement) {
      tabElement.remove();
    }

    // Remove dataset container from DOM
    tab.container.remove();

    // Remove from tabs array
    this.tabs.splice(tabIndex, 1);

    // If this was the active tab, switch to another tab
    if (tab.isActive) {
      if (this.tabs.length > 0) {
        const newActiveTab = tabIndex < this.tabs.length ? this.tabs[tabIndex] : this.tabs[tabIndex - 1];
        this.activateTab(newActiveTab.metadata.name);
      } else {
        this.activeTabId = null;
        this.contentContainer.innerHTML = "";
        // Hide stats visualizer when no datasets are active. The command bar
        // stays visible so the user can run `.open` etc. to get a new dataset.
        this.sharedStatsVisualizer.hide();
      }
    }

    if (this.onCloseTabCallback) {
      this.onCloseTabCallback();
    }
  }

  public getDatasetIds(): string[] {
    return this.tabs.map((t) => t.metadata.name);
  }

  public getActiveDatasetTab(): DatasetTab | null {
    const active = this.tabs.find((t) => t.isActive);
    return active && active.kind === "dataset" ? active : null;
  }

  public getActiveChartTab(): ChartTab | null {
    const active = this.tabs.find((t) => t.isActive);
    return active && active.kind === "chart" ? active : null;
  }

  /**
   * Trigger a browser download of the active chart as PNG or SVG. Mirrors
   * the entry the vega-embed action menu provides, exposed for `.export`.
   */
  public async exportActiveChart(format: "png" | "svg"): Promise<string> {
    const chart = this.getActiveChartTab();
    if (!chart) throw new Error("No active chart to export");
    const { blob, ext } = await chart.chartVisualizer.exportAsBlob(format);
    const filename = `${chart.metadata.name}.${ext}`;
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      // setTimeout so the click has a chance to dispatch before revoke.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return filename;
  }

  public setEventDispatcher(eventDispatcher: EventDispatcher): void {
    this.eventDispatcher = eventDispatcher;

    // Register all existing tabs with the event dispatcher (chart tabs aren't
    // focusable in v0.9 so they're skipped).
    for (const tab of this.tabs) {
      if (tab.kind === "dataset") {
        this.eventDispatcher.registerComponent(tab.spreadsheetVisualizer);
      }
    }
  }

  public setOnCellSelectionCallback(callback: (cellSelection?: ICellSelection) => void): void {
    this.onCellSelectionCallback = callback;
    // Back-fill any tabs that were added before the callback was wired.
    for (const tab of this.tabs) {
      if (tab.kind === "dataset") {
        tab.spreadsheetVisualizer.addOnSelectionChangeSubscription(callback);
      }
    }
  }

  public setOnCellInspectCallback(callback: (info: CellInspectInfo) => void): void {
    this.onCellInspectCallback = callback;
    for (const tab of this.tabs) {
      if (tab.kind === "dataset") {
        tab.spreadsheetVisualizer.addOnCellInspectRequestedSubscription(callback);
      }
    }
  }

  /**
   * Propagate runtime format changes to every open tab so cell rendering and
   * column widths update without recreating tabs. Fire-and-forget — errors
   * per-tab are logged but do not abort the others.
   */
  public async applyFormatChange(partial: Partial<SpreadsheetOptions>): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const tab of this.tabs) {
      if (tab.kind !== "dataset") continue;
      tasks.push(
        tab.spreadsheetVisualizer.refreshFormat(partial).catch((err: unknown) => {
          console.error(`refreshFormat failed for tab ${tab.metadata.name}:`, err);
        }),
      );
    }
    await Promise.all(tasks);
  }

  public setOnSelectCallback(callback: (dataset: DataProvider) => void): void {
    this.onSelectCallback = callback;
  }

  public setOnChartActivateCallback(callback: (chartName: string) => void): void {
    this.onChartActivateCallback = callback;
  }

  public setOnCloseTabCallback(callback: () => void): void {
    this.onCloseTabCallback = callback;
  }

  public setOnQueryErrorCallback(callback: (error: Error) => void): void {
    this.onQueryErrorCallback = callback;
  }

  public setOnQueryCompletedCallback(callback: (result: { elapsedMs: number; error?: Error }) => void): void {
    this.onQueryCompletedCallback = callback;
  }

  private createTabElement(tab: Tab): void {
    const tabElement = document.createElement("div");
    tabElement.setAttribute("data-tab-id", tab.metadata.name);
    tabElement.className = "tab-manager__tab";

    // Tab title
    const titleElement = document.createElement("span");
    titleElement.textContent = tab.metadata.name;
    titleElement.className = "tab-manager__tab-title";

    // Close button
    const closeButton = document.createElement("button");
    closeButton.innerHTML = "×";
    closeButton.className = "tab-manager__tab-close";

    // Event listeners
    tabElement.addEventListener("click", (e) => {
      if (e.target !== closeButton) {
        this.activateTab(tab.metadata.name);
      }
    });

    closeButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeDataset(tab.metadata.name);
    });

    tabElement.appendChild(titleElement);
    tabElement.appendChild(closeButton);
    this.tabsContainer.appendChild(tabElement);
  }

  private async activateTab(id: string): Promise<void> {
    // Deactivate current tab
    if (this.activeTabId) {
      const currentTab = this.tabs.find((t) => t.metadata.name === this.activeTabId);
      if (currentTab) {
        currentTab.isActive = false;
        currentTab.container.classList.remove("tab-manager__dataset-container--active");
        this.updateTabStyles(this.activeTabId, false);
      }
    }

    // Activate new tab
    const newTab = this.tabs.find((t) => t.metadata.name === id);
    if (!newTab) return;

    newTab.isActive = true;
    this.activeTabId = id;
    newTab.container.classList.add("tab-manager__dataset-container--active");
    this.updateTabStyles(id, true);

    if (newTab.kind === "dataset") {
      if (this.eventDispatcher) {
        this.eventDispatcher.setFocus(newTab.spreadsheetVisualizer.componentId);
      }

      // Force layout calculation and resize to ensure spreadsheet takes full space
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await newTab.spreadsheetVisualizer.resize();

      // Update the shared stats visualizer with the new spreadsheet visualizer and filter manager
      this.sharedStatsVisualizer.setFilterManager(this.filterManager, newTab.metadata.name);
      await this.sharedStatsVisualizer.setSpreadsheetVisualizer(newTab.spreadsheetVisualizer);

      if (this.onSelectCallback) {
        this.onSelectCallback(newTab.dataProvider);
      }
    } else {
      // Chart tabs have no spreadsheet → hide the column-stats sidebar so
      // a stale dataset's stats don't sit beside the chart, and notify the
      // host so the status bar shows the chart name instead of a stale
      // dataset's row/column count + selection info.
      this.sharedStatsVisualizer.hide();
      this.onChartActivateCallback?.(newTab.metadata.name);
    }
  }

  private updateTabStyles(tabId: string, isActive: boolean): void {
    const tabElement = this.tabsContainer.querySelector(`[data-tab-id="${tabId}"]`) as HTMLElement;
    if (tabElement) {
      if (isActive) {
        tabElement.classList.add("tab-manager__tab--active");
      } else {
        tabElement.classList.remove("tab-manager__tab--active");
      }
    }
  }

  private setupResizeHandling(): void {
    // Use ResizeObserver for better performance than window resize events
    if (window.ResizeObserver) {
      const resizeObserver = new ResizeObserver(() => {
        this.handleResize();
      });
      resizeObserver.observe(this.container);
    } else {
      // Fallback for browsers without ResizeObserver
      window.addEventListener("resize", () => this.handleResize());
    }
  }

  private async handleResize(): Promise<void> {
    // Trigger resize on the active spreadsheet visualizer
    const activeTab = this.tabs.find((tab) => tab.isActive);
    if (activeTab && activeTab.kind === "dataset") {
      // Force layout recalculation before resize
      this.container.offsetHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await activeTab.spreadsheetVisualizer.resize();
    }
    // Charts (Vega-Lite) auto-fit their container; nothing to invoke here.
  }

  public async resize(): Promise<void> {
    // Public method to trigger resize from external components (e.g., BedevereApp)
    await this.handleResize();
  }

  public getStatsVisualizer(): ColumnStatsVisualizerFocusable {
    return this.sharedStatsVisualizer;
  }

  public setColumnStatsParent(container: HTMLElement): void {
    const statsElement = this.sharedStatsVisualizer.getContainer();
    if (statsElement.parentNode) {
      statsElement.parentNode.removeChild(statsElement);
    }
    container.appendChild(statsElement);
  }

  public getFilterManager(): ColumnFilterManager {
    return this.filterManager;
  }

  public initSqlEditor(duckDBService: DuckDBService): void {
    if (this.sqlEditor) return;

    this.duckDBService = duckDBService;
    this.sqlEditor = new SqlEditor(this.sqlEditorContainer, duckDBService);

    // Register with event dispatcher
    if (this.eventDispatcher) {
      this.eventDispatcher.registerComponent(this.sqlEditor);
    }

    // Wire up query execution. Routes through dispatchInput so a `.command`
    // typed in the SQL editor + Ctrl+Enter behaves the same as in the
    // CommandBar (otherwise it'd be sent to DuckDB as raw SQL).
    this.sqlEditor.setOnExecuteCallback((query: string) => this.dispatchInput(query));

    // Sync the CommandBar's SQL-toggle state + resize on editor toggle.
    this.sqlEditor.setOnToggleCallback((isExpanded) => {
      this.commandBar?.setSqlEditorExpanded(isExpanded);
      setTimeout(() => this.handleResize(), 260);
    });

    // CommandBar shell submit is wired here because dispatch to SQL needs
    // duckDBService; dot-only commands (.help etc.) would work earlier but
    // this keeps the wiring in one place.
    this.commandBar?.setOnSubmitCallback((input) => this.dispatchInput(input));
  }

  public toggleSqlEditor(): void {
    this.sqlEditor?.toggle();
  }

  public getSqlEditor(): SqlEditor | null {
    return this.sqlEditor;
  }

  public focusCommandBar(): void {
    this.commandBar?.focusInput();
  }

  private async handleFilterChange(datasetName: string): Promise<void> {
    const tab = this.tabs.find((t) => t.metadata.name === datasetName);
    if (!tab || tab.kind !== "dataset" || !this.duckDBService) return;

    // Determine the source table name
    const currentProvider = tab.dataProvider;
    let sourceTableName: string;
    if (currentProvider instanceof FilteredDuckDBDataProvider) {
      sourceTableName = currentProvider.getSourceTableName();
    } else {
      sourceTableName = tab.metadata.name;
    }

    if (this.filterManager.hasAnyState(datasetName)) {
      // Any of filter / sort / hidden columns active — route through the
      // filtered provider, which knows how to project + WHERE + ORDER BY.
      const filteredProvider = new FilteredDuckDBDataProvider(
        this.duckDBService,
        sourceTableName,
        this.filterManager,
        datasetName,
        tab.metadata.fileName ?? ""
      );
      tab.dataProvider = filteredProvider;
      await tab.spreadsheetVisualizer.reinitialize(filteredProvider);
    } else {
      const { DuckDBDataProvider } = await import("../../data/DuckDBDataProvider");
      const originalProvider = new DuckDBDataProvider(this.duckDBService, sourceTableName, tab.metadata.fileName ?? "");
      tab.dataProvider = originalProvider;
      await tab.spreadsheetVisualizer.reinitialize(originalProvider);
    }

    // Update stats visualizer to reflect filter state
    await this.sharedStatsVisualizer.setSpreadsheetVisualizer(tab.spreadsheetVisualizer);
  }

  /**
   * SELECT/WITH path: wrap in `CREATE OR REPLACE TABLE result_<n>` and open
   * the result as a dataset tab. The auto-name is short enough to JOIN
   * against by hand, and `.alias result_n <new>` (which calls DuckDB
   * ALTER TABLE … RENAME) lets the user rename the underlying table cleanly.
   */
  public async addQueryResult(query: string, duckDBService: DuckDBService): Promise<void> {
    const start = performance.now();
    try {
      this.resultCounter += 1;
      const resultName = `result_${this.resultCounter}`;
      const dataProvider = await duckDBService.executeQueryAsDataProvider(query, resultName);
      const metadata = await dataProvider.getMetadata();
      await this.addDataset(metadata, dataProvider);
      await this.switchToDataset(metadata.name);
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start });
    } catch (error) {
      console.error("Query execution failed:", error);
      const err = error instanceof Error ? error : new Error(String(error));
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start, error: err });
      throw error;
    }
  }

  /**
   * Run a SQL script — possibly multi-statement, possibly preceded by
   * `.directive` lines — by parsing it into statements, validating any
   * directives, and routing each statement by its first keyword:
   *   - `SELECT` / `WITH` → open as a result tab (addQueryResult)
   *   - `VISUALIZE`       → route through stats_duck + vega-embed (chart tab)
   *   - everything else   → execute directly with no wrapper (DDL, DML, …)
   * The result-tab wrapper would otherwise corrupt non-result-producing
   * statements and silently bypass stats_duck's parser extension for
   * VISUALIZE.
   *
   * Supported directives (apply to the next statement, then reset):
   *   - `.no-output` — run the statement but suppress its tab/chart output.
   */
  private async executeBareSQL(input: string, duckDBService: DuckDBService): Promise<void> {
    const script = parseScript(input);
    if (script.length === 0) return;

    // Validate every directive before running anything: a typo shouldn't
    // leave the DB in a half-applied state after some statements ran.
    for (const { directives } of script) {
      for (const d of directives) {
        if (!KNOWN_SQL_DIRECTIVES.has(d.toLowerCase())) {
          throw new Error(`Unknown SQL directive: ${d}`);
        }
      }
    }

    for (const { sql, directives } of script) {
      const noOutput = directives.some((d) => d.toLowerCase() === ".no-output");
      if (noOutput) {
        await this.executeSideEffecting(sql, duckDBService);
        continue;
      }
      const kind = classifyStatement(sql);
      if (kind === "visualize") {
        await this.executeVisualize(sql, duckDBService);
      } else if (kind === "query") {
        await this.addQueryResult(sql, duckDBService);
      } else {
        await this.executeSideEffecting(sql, duckDBService);
        // Auto-display the new relation when the side-effect was a CREATE
        // TABLE / CREATE VIEW. .no-output (handled above) skips this.
        const created = extractCreateTargetName(sql);
        if (created) await this.openExistingTable(created, duckDBService);
      }
    }
  }

  /**
   * Open an existing DuckDB table or view as a dataset tab. Used by the SQL
   * dispatcher to surface the relation a user just CREATEd; switches to an
   * existing tab when one already shows the same name.
   */
  private async openExistingTable(name: string, duckDBService: DuckDBService): Promise<void> {
    if (this.getDatasetIds().includes(name)) {
      await this.switchToDataset(name);
      return;
    }
    const { DuckDBDataProvider } = await import("../../data/DuckDBDataProvider");
    const provider = new DuckDBDataProvider(duckDBService, name, "");
    const metadata = await provider.getMetadata();
    await this.addDataset(metadata, provider);
    await this.switchToDataset(metadata.name);
  }

  private async executeSideEffecting(input: string, duckDBService: DuckDBService): Promise<void> {
    const start = performance.now();
    try {
      await duckDBService.executeQuery(input);
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start, error: err });
      throw err;
    }
  }

  /**
   * stats_duck `VISUALIZE … DRAW <mark>` returns one row with two columns:
   *   - `spec`       : VARCHAR — Vega-Lite v5 JSON; references named datasets
   *                    `layer_0`, `layer_1`, … (one per DRAW clause).
   *   - `layer_sqls` : MAP(VARCHAR, VARCHAR) — `{layer_n: SELECT …}` pairs.
   * We run each layer's SQL via DuckDB-WASM, convert the resulting Arrow rows
   * to JS objects, and hand spec + datasets to vega-embed (which has a
   * `datasets` option that matches this exact shape — no spec mutation).
   */
  private async executeVisualize(input: string, duckDBService: DuckDBService): Promise<void> {
    const start = performance.now();
    try {
      let rows: any[];
      try {
        rows = await duckDBService.executeQuery(input);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        if (/syntax error/i.test(msg) && /VISUALIZE/i.test(msg)) {
          const reason = getStatsDuckFailureReason() ?? "no startup details captured (check browser console)";
          throw new Error(
            `VISUALIZE rejected by DuckDB — the stats_duck (ggsql) parser extension didn't load: ${reason}`,
          );
        }
        throw parseErr;
      }
      if (!rows || rows.length === 0) {
        throw new Error("VISUALIZE returned no rows — stats_duck parser may not be loaded");
      }
      const row = rows[0] as { spec?: string; layer_sqls?: unknown };
      if (typeof row.spec !== "string") {
        throw new Error("VISUALIZE result is missing the 'spec' column");
      }
      const spec = JSON.parse(row.spec) as VisualizationSpec;

      // DuckDB's MAP type comes back as either a plain object or, in some
      // versions of duckdb-wasm, a Map instance. Normalize to entries.
      const layerSqls = row.layer_sqls;
      const entries: Array<[string, string]> = [];
      if (layerSqls instanceof Map) {
        for (const [k, v] of layerSqls) entries.push([String(k), String(v)]);
      } else if (layerSqls && typeof layerSqls === "object") {
        for (const [k, v] of Object.entries(layerSqls as Record<string, unknown>)) {
          entries.push([k, String(v)]);
        }
      } else {
        throw new Error("VISUALIZE result is missing the 'layer_sqls' map");
      }

      const datasets: Record<string, unknown[]> = {};
      for (const [name, layerSql] of entries) {
        // executeQueryWithSchema gives us per-column DECIMAL scales on top
        // of the rows. DuckDB infers `DECIMAL(p,s)` for plain literals
        // (`1.0` → DECIMAL(2,1)) and Arrow exports those as the raw integer
        // — without scaling, `1.0` lands in the chart at 10 and the whole
        // axis appears multiplied by 10^scale.
        const { rows: layerRows, decimalScales } =
          await duckDBService.executeQueryWithSchema(layerSql);
        // Apache Arrow's `Table.toArray()` returns Row proxies that delegate
        // property access to the underlying RecordBatch. Vega-Lite's data
        // ingestion iterates with `for…of` and reads fields via `row.x`,
        // `row.species`, etc. — numeric fields tend to work, but string
        // columns can return an Arrow value wrapper rather than a plain
        // string. Materializing each row via `toJSON()` (or a shallow
        // spread fallback) sidesteps the proxy entirely.
        datasets[name] = layerRows.map((r: any) => {
          const obj: Record<string, unknown> =
            r && typeof r.toJSON === "function" ? r.toJSON() : { ...r };
          // DECIMAL columns arrive as `Uint32Array(2|4)` — Decimal64 /
          // Decimal128's little-endian word buffer, not a plain number.
          // `unwrapArrowValue` combines the words into the raw integer and
          // applies the column's scale (1.0 → raw 10 ÷ 10^1 = 1.0).
          for (const [col, scale] of Object.entries(decimalScales)) {
            obj[col] = unwrapArrowValue(obj[col], { kind: "decimal", scale });
          }
          return obj;
        });
      }

      patchVisualizeSpec(spec as Record<string, unknown>, datasets);

      await this.addChartResult(spec, datasets);
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.onQueryCompletedCallback?.({ elapsedMs: performance.now() - start, error: err });
      throw err;
    }
  }

  public async addChartResult(spec: VisualizationSpec, datasets: Record<string, unknown[]>): Promise<void> {
    const chartContainer = document.createElement("div");
    chartContainer.className = "tab-manager__dataset-container";
    this.contentContainer.appendChild(chartContainer);

    this.chartCounter += 1;
    const name = `chart_${this.chartCounter}`;

    // Dynamic import keeps the ~800 KB vega-embed bundle out of the initial
    // page-load chunk for users who never run a VISUALIZE query.
    const { ChartVisualizer } = await import("../ChartVisualizer");
    const chartVisualizer = new ChartVisualizer(chartContainer);

    const tab: ChartTab = {
      kind: "chart",
      metadata: { name },
      chartVisualizer,
      container: chartContainer,
      isActive: false,
    };
    this.tabs.push(tab);
    this.createTabElement(tab);
    // Activate BEFORE rendering so vega-embed measures a visible container
    // (chart_n containers default to display: none until --active applies;
    // rendering into a 0×0 host produces a broken chart that "leaks" the
    // previous tab's content when made visible).
    await this.activateTab(name);
    await chartVisualizer.setSpec(spec, datasets);
  }

  public destroy(): void {
    // Clean up all visualizers (spreadsheet or chart).
    this.tabs.forEach((tab) => {
      if (tab.kind === "dataset") {
        tab.spreadsheetVisualizer.destroy();
      } else {
        tab.chartVisualizer.destroy();
      }
    });

    // Hide shared stats visualizer
    this.sharedStatsVisualizer.hide();

    // Clean up SQL editor
    if (this.sqlEditor) {
      if (this.eventDispatcher) {
        this.eventDispatcher.unregisterComponent(this.sqlEditor.componentId);
      }
      this.sqlEditor.destroy();
      this.sqlEditor = null;
    }

    // Clean up cell value bar
    if (this.commandBar) {
      this.commandBar.destroy();
      this.commandBar = null;
    }
  }

  /**
   * Dispatch user input from either the CommandBar or the SqlEditor.
   * A dot-prefixed line is treated as a shell command only when the name is
   * registered (e.g. `.help`, `.open`, `.focus`). Otherwise — including SQL
   * directives like `.no-output` that prefix a multi-statement script — it
   * falls through to executeBareSQL so the script dispatcher can validate
   * directives and route statements.
   */
  private async dispatchInput(input: string): Promise<void> {
    const parsed = parseShellLine(input);
    if (parsed && commandRegistry.getByShellName(parsed.name)) {
      const result = await runShellLine(input);
      this.handleShellResult(result);
      return;
    }
    if (!this.duckDBService) {
      this.onQueryErrorCallback?.(new Error("Database not initialized"));
      return;
    }
    try {
      await this.executeBareSQL(input, this.duckDBService);
    } catch (err) {
      this.onQueryErrorCallback?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Render a {@link ShellResult}. Errors flow to `onQueryErrorCallback` so the
   * status-bar error toast fires via the same path SQL uses; text output is
   * emitted through the message popover so long `.help` / `.settings` dumps
   * remain readable.
   */
  private handleShellResult(result: ShellResult): void {
    if (result.kind === "error") {
      this.onQueryErrorCallback?.(result.error ?? new Error(result.text ?? "Shell error"));
      return;
    }
    if (result.kind === "text" && result.text && result.text.length > 0) {
      this.onShellMessageCallback?.(result.text, result.details);
    }
    // kind === "table" handling lands with Phase 6 dot-commands (.tables / .columns).
  }

  /**
   * Route shell text output (multi-line `.help`, `.settings`, etc.) to a
   * surface chosen by the host (usually StatusBar.showMessage with details
   * for click-to-expand). BedevereApp wires this during setup.
   */
  public setOnShellMessageCallback(callback: (text: string, details?: string) => void): void {
    this.onShellMessageCallback = callback;
  }
}
