import { TabManager } from "../TabManager/TabManager";
import { ControlPanel } from "../ControlPanel/ControlPanel";
import { StatusBar } from "../StatusBar/StatusBar";
import { HelpPanel, HelpPanelTab } from "../HelpPanel/HelpPanel";
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_DATETIME_FORMAT,
  DEFAULT_MIN_CELL_WIDTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_NUMBER_FORMAT,
} from "../SpreadsheetVisualizer/defaults";
import penguinsCsv from "@/assets/samples/penguins.csv?raw";
import { SpreadsheetOptions } from "../SpreadsheetVisualizer/types";
import { DataProvider } from "../../data/types";
import { FocusManager } from "./FocusManager";
import { EventDispatcher } from "./EventDispatcher";
import { EventHandler } from "./types";
import { exportAsHTML, exportAsMarkdown, exportAsText } from "./ExportHub";
import { DuckDBService } from "@/data/DuckDBService";
import { PersistenceService, persistenceService } from "@/data/PersistenceService";
import { keymapService } from "@/data/KeymapService";
import { commandRegistry } from "@/data/CommandRegistry";
import { environmentService } from "@/data/environments/EnvironmentService";
import { formatCommandHelp } from "@/data/Shell";
import { FileImportService } from "@/data/FileImportService";
import { DuckDBExtensionLoader } from "@/data/DuckDBExtensionLoader";
import { ExcelFormatHandler } from "@/data/formats/ExcelFormatHandler";
import { StatFormatHandler } from "@/data/formats/StatFormatHandler";
import { HtmlFormatHandler } from "@/data/formats/HtmlFormatHandler";
import { HtmlPasteDialog } from "../HtmlPasteDialog/HtmlPasteDialog";
import { fetchAsFile } from "@/data/UrlImport";
import { AliasManager } from "@/data/AliasManager";
import { setStatsDuckFailureReason } from "@/data/statsDuckStatus";
import { FilteredDuckDBDataProvider } from "@/data/FilteredDuckDBDataProvider";
import { HideColumnsDialog } from "../HideColumnsDialog/HideColumnsDialog";

// Pre-filled SQL for the /demo route — see runDemo(). Kept verbatim from
// the user's paste so the comments and formatting render exactly as
// authored when the editor opens.
const PENGUINS_DEMO_SQL = `-- Tighten categorical text into ENUMs (less memory, only valid values)
-- and cast measurements to DOUBLE. TRY_CAST yields NULL on failure, so
-- the string "NA" becomes a real NULL.
CREATE OR REPLACE TABLE penguins_clean AS
SELECT
    species::ENUM ('Adelie', 'Gentoo', 'Chinstrap') AS species
  , island::ENUM ('Dream', 'Torgersen', 'Biscoe') AS island
  , sex::ENUM ('female', 'male') AS sex
  , TRY_CAST(bill_length_mm AS DOUBLE) AS bill_length_mm
  , TRY_CAST(bill_depth_mm AS DOUBLE) AS bill_depth_mm
  , TRY_CAST(flipper_length_mm AS DOUBLE) AS flipper_length_mm
  , TRY_CAST(body_mass_g AS DOUBLE) AS body_mass_g
FROM penguins
WHERE sex != 'NA'             -- drop rows with unknown sex
ORDER BY species, island, sex
;

-- Scatter of bill depth vs bill length, coloured by species.
VISUALIZE
    bill_depth_mm AS x
    , bill_length_mm AS y
    , species AS color
FROM penguins_clean
DRAW point
;
`;

export type BedevereAppTheme = "light" | "dark" | "auto";

export type BedevereAppMessageType = "info" | "warning" | "error" | "success";

export interface BedevereAppOptions {
  spreadsheetOptions?: SpreadsheetOptions;
  theme?: BedevereAppTheme;
  showLeftPanel?: boolean;
  statusBarVisible?: boolean;
  debugMode?: boolean;
}

export class BedevereApp implements EventHandler {
  private container: HTMLElement;
  private mainContainer!: HTMLElement;
  private leftPanelContainer!: HTMLElement;
  private spreadsheetContainer!: HTMLElement;

  private duckDBService!: DuckDBService;
  private leftPanel!: ControlPanel;
  private tabManager!: TabManager;
  private statusBar!: StatusBar;
  private helpPanel!: HelpPanel;

  private options: BedevereAppOptions;
  private theme: BedevereAppTheme = "dark";
  private version: string;

  // Persistence, views, and import
  private persistenceService: PersistenceService;
  private fileImportService: FileImportService;
  private extensionLoader: DuckDBExtensionLoader;
  private aliasManager: AliasManager;

  // Event system
  private focusManager: FocusManager;
  private eventDispatcher: EventDispatcher;

  constructor(parent: HTMLElement, duckDBService: DuckDBService, version: string, options: BedevereAppOptions = {}) {
    this.options = {
      theme: "dark",
      showLeftPanel: true,
      statusBarVisible: true,
      ...options,
    };

    this.container = document.createElement("div");
    this.container.className = "bedevere-app";
    this.setupTheme();

    this.duckDBService = duckDBService;
    this.version = version;

    // Initialize persistence, view management, and import service
    this.persistenceService = persistenceService;
    this.extensionLoader = new DuckDBExtensionLoader(duckDBService);
    this.fileImportService = new FileImportService(duckDBService);
    this.aliasManager = new AliasManager(duckDBService);

    // Initialize event system
    this.focusManager = new FocusManager({ debugMode: options.debugMode || false });
    this.eventDispatcher = new EventDispatcher(this.focusManager, { debugMode: options.debugMode || false });

    this.createLayout();
    this.setupComponents();
    this.registerCommands();
    this.setupEventSystem();

    parent.appendChild(this.container);
  }

  public async initAsync(): Promise<void> {
    // Try loading DuckDB extensions for additional file format support.
    // Probe queries verify the function actually works in WASM (catches runtime crashes).
    await this.extensionLoader.tryLoad("excel", undefined, [
      "SELECT * FROM read_xlsx('__probe_nonexistent__.xlsx') LIMIT 0",
    ]);

    // stats_duck (ggsql VISUALIZE parser). Source URL is env-configurable
    // via VITE_STATS_DUCK_URL — see .env.example for the local-build setup.
    // Page-relative paths (starting with `/`) get the origin prefixed because
    // DuckDB-WASM's INSTALL FROM requires an absolute URL.
    const rawStatsDuckUrl =
      (import.meta.env.VITE_STATS_DUCK_URL as string | undefined) ||
      "https://caerbannogwhite.github.io/the-stats-duck";
    const statsDuckUrl = rawStatsDuckUrl.startsWith("/")
      ? `${window.location.origin}${rawStatsDuckUrl}`
      : rawStatsDuckUrl;
    const installOk = await this.extensionLoader.tryLoad("stats_duck", statsDuckUrl);
    if (!installOk) {
      const reason = `INSTALL FROM '${statsDuckUrl}' rejected by DuckDB`;
      setStatsDuckFailureReason(reason);
      console.warn(`stats_duck install failed (URL: ${statsDuckUrl}). VISUALIZE / ggsql disabled.`);
    } else {
      // tryLoad's probe doesn't catch "INSTALL succeeded but parser hooks
      // didn't attach" — that path returns 0 rows from a SELECT, not an
      // error. An explicit count check is the only way to surface it,
      // and it's a real failure mode (DuckDB-WASM version mismatch with
      // the published extension build).
      const ggsqlFns = await this.duckDBService.executeQuery(
        "SELECT count(*) AS n FROM duckdb_functions() WHERE function_name LIKE 'ggsql_mark_v1_%'",
      );
      const n = Number((ggsqlFns?.[0] as { n?: unknown })?.n ?? 0);
      if (n === 0) {
        const reason =
          `loaded from ${statsDuckUrl} but registered 0 ggsql_mark_v1_* functions ` +
          "(likely a DuckDB-WASM version mismatch with @duckdb/duckdb-wasm)";
        setStatsDuckFailureReason(reason);
        console.warn(
          `stats_duck loaded from ${statsDuckUrl} but registered no ggsql_mark_v1_* ` +
            "functions — parser hooks didn't attach. Likely a DuckDB-WASM version " +
            "mismatch; run `SELECT version()` and rebuild the extension against it.",
        );
      }
    }

    // Register extension-based handlers (they self-check if extension loaded)
    this.fileImportService.register(new ExcelFormatHandler(this.extensionLoader));
    this.fileImportService.register(new StatFormatHandler(this.extensionLoader));
    // HTML import is pure DOM parsing in the main thread — no extension required.
    this.fileImportService.register(new HtmlFormatHandler());

    // Restore app settings
    const settings = this.persistenceService.loadAppSettings();
    if (settings.theme && settings.theme !== "auto") {
      this.setTheme(settings.theme);
    }
    if (settings.panelMinimized && this.leftPanel && !this.leftPanel.getIsMinimized()) {
      this.leftPanel.toggleMinimize();
    }

    const path = window.location.pathname.replace(/\/$/, "");
    if (path === "/demo") {
      await this.runDemo();
    } else if (!settings.hasSeenOnboarding) {
      this.helpPanel.show("howto");
      settings.hasSeenOnboarding = true;
      this.persistenceService.saveAppSettings(settings);
    } else {
      this.helpPanel.show("import");
    }
  }

  // Public API methods
  public async addDataset(dataset: DataProvider): Promise<void> {
    this.leftPanel.addDataset(dataset);
    this.updateStatusBarDatasetInfo();
    this.updateFocusAfterDatasetChange();
  }

  // Event system access methods
  public getEventDispatcher(): EventDispatcher {
    return this.eventDispatcher;
  }

  public getFocusManager(): FocusManager {
    return this.focusManager;
  }

  public setTheme(theme: "light" | "dark"): void {
    this.container.classList.remove(`bedevere-app--${this.theme}`);
    document.body.classList.remove(`theme-${this.theme}`);

    this.theme = theme;
    this.container.classList.add(`bedevere-app--${this.theme}`);
    document.body.classList.add(`theme-${this.theme}`);

    // Persist theme setting
    const settings = this.persistenceService.loadAppSettings();
    settings.theme = theme;
    this.persistenceService.saveAppSettings(settings);
  }

  public showMessage(
    message: string,
    type: BedevereAppMessageType = "info",
    options?: import("../StatusBar/StatusBar").MessageOptions,
  ): void {
    this.statusBar?.showMessage(message, type, options);
  }

  public destroy(): void {
    // Clean up event system
    this.eventDispatcher.removeGlobalEventHandler(this);
    this.focusManager.clearFocus();
    this.focusManager.clearFocusStack();

    this.statusBar?.destroy();
    this.leftPanel?.destroy();

    this.container.remove();
  }

  // EventHandler interface implementation
  public async handleKeyDown(e: KeyboardEvent): Promise<boolean> {
    // If the focused element (CodeMirror, an <input>, etc.) already consumed
    // this key, don't double-fire the matching global shortcut. CodeMirror's
    // defaultKeymap binds emacs-style chords like Ctrl-/, Ctrl-b, Ctrl-e
    // that overlap with our global keymap (help.toggle, app.togglePanel,
    // app.toggleSqlEditor); the editor should win when it has focus.
    if (e.defaultPrevented) return false;

    // Alt+1..9 jumps directly to tab N. Handled outside the keymap to avoid
    // nine near-identical entries — see tabs.next / tabs.prev in the keymap
    // for the rebindable cyclical shortcuts.
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      this.tabManager.switchToTabByIndex(Number(e.key) - 1);
      return true;
    }

    const action = keymapService.matchEvent(e, "global");
    if (!action) return false;
    e.preventDefault();
    if (commandRegistry.has(action)) {
      // Fire-and-forget: the keystroke is consumed regardless, and
      // user-facing command failures already surface their own
      // toasts via showMessage. Catching here keeps a stray rejection
      // from polluting the console as an unhandled promise.
      commandRegistry.run(action).catch((err) => console.error(`command ${action} failed:`, err));
    }
    return true;
  }

  public async handleResize(_e: Event): Promise<boolean> {
    this.updateDimensions();
    return true;
  }

  private createLayout(): void {
    // Main container (excluding status bar)
    this.mainContainer = document.createElement("div");
    this.mainContainer.className = "bedevere-app__main";

    // Dataset panel container
    this.leftPanelContainer = document.createElement("div");
    this.leftPanelContainer.className = "bedevere-app__control-panel";

    // Spreadsheet container
    this.spreadsheetContainer = document.createElement("div");
    this.spreadsheetContainer.className = "bedevere-app__spreadsheet";

    this.mainContainer.appendChild(this.leftPanelContainer);
    this.mainContainer.appendChild(this.spreadsheetContainer);

    this.container.appendChild(this.mainContainer);
  }

  private setupComponents(): void {
    // Status bar
    if (this.options.statusBarVisible) {
      this.statusBar = new StatusBar(this.container, this.version);
      this.statusBar.setSpreadsheetOptions(this.options.spreadsheetOptions ?? {});
    }

    // Help panel (mounted on body so it overlays the entire app)
    this.helpPanel = new HelpPanel(document.body, {
      version: this.version,
      onLoadSampleDataset: () => this.loadSampleDataset(),
      onShowMessage: (msg, type) => this.showMessage(msg, type),
      onBrowseFolder: () => this.leftPanel?.openFolderPicker(),
      onFilesReceived: (files) => this.leftPanel?.addFilesFromDrop(files, true),
      getRecentFolders: () => {
        // Only surface the recents shortcut on browsers where the FSA
        // directory handle could be persisted. The webkitdirectory
        // fallback can't re-open a folder without a fresh user pick.
        if (typeof window === "undefined" || !("showDirectoryPicker" in window)) return [];
        return this.persistenceService.getRecentFolders().map((e) => ({ id: e.id, name: e.name }));
      },
      onRecentFolderClick: (id: string) => this.leftPanel?.openRecentFolder(id),
      supportedFormats: this.fileImportService.getSupportedExtensions(),
      initialTheme: this.persistenceService.loadAppSettings().theme ?? "auto",
      onThemeChange: (theme) => {
        const resolved = theme === "auto" ? this.detectTheme() : theme;
        this.setTheme(resolved);
        // setTheme persists the resolved value; re-save to preserve "auto"
        // intent so reloads keep following OS preference.
        const s = this.persistenceService.loadAppSettings();
        s.theme = theme;
        this.persistenceService.saveAppSettings(s);
      },
      onResetKeymap: () => keymapService.resetToDefaults(),
      onClearAllData: () => this.persistenceService.clearAll(),
      getCopyOptions: () => {
        const s = this.persistenceService.loadAppSettings();
        return {
          delimiter: s.copyDelimiter ?? "tab",
          includeHeader: s.copyIncludeHeader ?? true,
          quoteEscape: s.csvQuoteEscape ?? "double",
        };
      },
      setCopyOptions: (opts) => {
        const s = this.persistenceService.loadAppSettings();
        s.copyDelimiter = opts.delimiter;
        s.copyIncludeHeader = opts.includeHeader;
        s.csvQuoteEscape = opts.quoteEscape;
        this.persistenceService.saveAppSettings(s);
      },
      getFormatOptions: () => {
        const s = this.persistenceService.loadAppSettings();
        return {
          dateFormat: s.dateFormat ?? DEFAULT_DATE_FORMAT,
          datetimeFormat: s.datetimeFormat ?? DEFAULT_DATETIME_FORMAT,
          numberMinDecimals: s.numberMinDecimals ?? DEFAULT_NUMBER_FORMAT.minimumFractionDigits,
          numberMaxDecimals: s.numberMaxDecimals ?? DEFAULT_NUMBER_FORMAT.maximumFractionDigits,
          numberUseGrouping: s.numberUseGrouping ?? true,
          minCellWidth: s.minCellWidth ?? DEFAULT_MIN_CELL_WIDTH,
          maxStringLength: s.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
        };
      },
      setFormatOptions: (opts) => {
        const s = this.persistenceService.loadAppSettings();
        s.dateFormat = opts.dateFormat;
        s.datetimeFormat = opts.datetimeFormat;
        s.numberMinDecimals = opts.numberMinDecimals;
        s.numberMaxDecimals = opts.numberMaxDecimals;
        s.numberUseGrouping = opts.numberUseGrouping;
        s.minCellWidth = opts.minCellWidth;
        s.maxStringLength = opts.maxStringLength;
        this.persistenceService.saveAppSettings(s);
        this.applyFormatSettings(opts);
      },
    });
    this.statusBar?.setOnHelpClickCallback(() => this.helpPanel.show("howto"));

    // Calculate dimensions
    this.updateDimensions();

    // Multi-dataset visualizer
    this.tabManager = new TabManager(this.spreadsheetContainer, this.options.spreadsheetOptions);

    // Initialize SQL editor within the multi-dataset visualizer
    this.tabManager.initSqlEditor(this.duckDBService);

    // Set event dispatcher on multi-dataset visualizer
    this.tabManager.setEventDispatcher(this.eventDispatcher);
    this.setOnCloseTabCallback();
    this.setOnCellSelectionCallback();

    // Surface SQL query errors in status bar
    this.tabManager.setOnQueryErrorCallback((error) => {
      this.showMessage(error.message, "error");
    });

    // Show query elapsed time on the right side of the status bar.
    this.tabManager.setOnQueryCompletedCallback(({ elapsedMs, error }) => {
      this.statusBar?.updateQueryTime(elapsedMs, !error);
    });

    // Shell text output (.help, .settings, etc.) → status bar info toast with
    // click-to-expand for long content.
    this.tabManager.setOnShellMessageCallback((text, details) => {
      this.showMessage(text, "info", { details, duration: 0 });
    });

    // Restore persisted per-dataset hide state + column order before
    // the dataset's visualizer is constructed. Setting on the filter
    // manager here fires `onChange`, but `handleFilterChange` no-ops
    // because the tab isn't registered yet — `addDataset` then sees
    // `hasAnyState` and constructs the filtered provider directly, so
    // the first render is already projected.
    this.tabManager.setOnBeforeAddDatasetCallback((metadata) => {
      const settings = this.persistenceService.loadAppSettings();
      const live = new Set(metadata.columns.map((c) => c.name));
      const fm = this.tabManager.getFilterManager();

      const persistedHidden = settings.hiddenColumns?.[metadata.name];
      if (persistedHidden && persistedHidden.length > 0) {
        // Filter to columns that still exist in the current metadata —
        // stale entries (renamed / dropped columns) are harmless to drop.
        const surviving = persistedHidden.filter((c) => live.has(c));
        if (surviving.length > 0) fm.setHiddenColumns(metadata.name, surviving);
      }

      const persistedOrder = settings.columnOrder?.[metadata.name];
      if (persistedOrder && persistedOrder.length > 0) {
        const surviving = persistedOrder.filter((c) => live.has(c));
        if (surviving.length > 0) fm.setColumnOrder(metadata.name, surviving);
      }
    });

    // Context menu's "Hide column" entry routes here so the column-
    // dialog path and the menu path share the same setHiddenColumns +
    // persist sequence. The menu emits an "add this one" intent; we
    // union with the current hidden set before applying.
    this.tabManager.setOnHideColumnCallback((req) => {
      const fm = this.tabManager.getFilterManager();
      const next = new Set(fm.getHiddenColumns(req.datasetName));
      next.add(req.columnName);
      fm.setHiddenColumns(req.datasetName, next);
      this.persistHiddenColumns(req.datasetName, next);
    });

    // Drag-to-reorder column header emits a drop intent here.
    // Resolution: look up the dataset's current visible column order
    // (which may already be customised), apply the move via the
    // filter manager, then persist the resulting order.
    this.tabManager.setOnReorderColumnCallback((req) => {
      const fm = this.tabManager.getFilterManager();
      const tab = this.tabManager.getDatasetTabByName(req.datasetName);
      if (!tab) return;
      const sourceNames = tab.metadata.columns.map((c) => c.name);
      fm.moveColumn(
        req.datasetName,
        sourceNames,
        req.sourceColumnName,
        req.targetColumnName,
        req.position,
      );
      this.persistColumnOrder(req.datasetName, fm.getColumnOrder(req.datasetName));
    });

    // Dataset panel
    if (this.options.showLeftPanel) {
      this.leftPanel = new ControlPanel(this.leftPanelContainer, this.tabManager);
      this.setOnSelectDatasetCallback();

      // Move column stats into left panel
      this.tabManager.setColumnStatsParent(this.leftPanel.getColumnStatsContainer());

      // Auto-expand column stats accordion when a column is selected
      this.tabManager.getStatsVisualizer().setOnShowStatsCallback(() => {
        this.leftPanel.expandSection("column-stats");
        if (this.leftPanel.getIsMinimized()) {
          this.leftPanel.toggleMinimize();
        }
      });

      // Wire services to panel
      this.leftPanel.setFileImportService(this.fileImportService);
      this.leftPanel.setOnAliasChangeCallback(async (tableName, alias) => {
        try {
          await this.aliasManager.setAlias(tableName, alias);
          this.showMessage(`Alias "${alias}" set for "${tableName}"`, "success");
          // Force SQL autocomplete to pick up the new name
          this.tabManager.getSqlEditor()?.refreshSchema?.();
        } catch (error) {
          this.showMessage(`Failed to set alias: ${error instanceof Error ? error.message : "unknown error"}`, "error");
        }
      });
      this.leftPanel.setPersistenceService(this.persistenceService);
      this.leftPanel.setOnShowMessageCallback((msg, type, options) =>
        this.showMessage(msg, type, options),
      );
      this.leftPanel.setOnOpenQueryCallback((sql) => {
        const editor = this.tabManager.getSqlEditor();
        if (editor) {
          editor.setQuery(sql);
          editor.expand();
        }
      });

      // Handle panel toggle
      this.leftPanel.setOnToggleCallback((isMinimized) => {
        this.container.classList.toggle("bedevere-app--panel-minimized", isMinimized);
        this.updateDimensions();

        // Persist panel state
        const settings = this.persistenceService.loadAppSettings();
        settings.panelMinimized = isMinimized;
        this.persistenceService.saveAppSettings(settings);
      });

      // Re-sync layout now that persisted panel width has been restored
      this.updateDimensions();
    }

    // Listen for dataset changes
    this.setupDatasetListeners();
  }

  private setupTheme(): void {
    this.theme = this.options.theme === "auto" ? this.detectTheme() : this.options.theme || "dark";
    this.container.classList.add(`bedevere-app--${this.theme}`);
    document.body.classList.add(`theme-${this.theme}`);
  }

  private detectTheme(): "light" | "dark" {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark";
    }
    return "light";
  }

  private setupEventSystem(): void {
    // Register BedevereApp as a global event handler
    this.eventDispatcher.addGlobalEventHandler(this);

    // Theme change detection
    if (this.options.theme === "auto") {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        this.setTheme(e.matches ? "dark" : "light");
      });
    }

    // Body-level drag-drop: users can drop files anywhere on the page as a
    // shortcut, without opening Help → Import. The files route to ControlPanel
    // through the same addFilesFromDrop pipeline.
    const preventDrag = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    document.body.addEventListener("dragenter", preventDrag);
    document.body.addEventListener("dragover", preventDrag);
    document.body.addEventListener("dragleave", preventDrag);
    document.body.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length > 0 && this.leftPanel) {
        this.leftPanel.addFilesFromDrop(files, true).catch((err) => {
          this.showMessage(`Failed to import: ${err instanceof Error ? err.message : "unknown error"}`, "error");
        });
      }
    });
  }

  private updateDimensions(): void {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const statusBarHeight = this.options.statusBarVisible ? 26 : 0;
    const panelWidth = this.options.showLeftPanel ? (this.leftPanel?.getWidth() ?? 320) : 0;

    // Update main container
    this.mainContainer.style.height = `${windowHeight - statusBarHeight}px`;
    this.mainContainer.style.paddingBottom = `${statusBarHeight}px`;

    // Sync the outer panel container width (flex layout) with the inner panel width
    if (this.leftPanelContainer) {
      // Disable transition during resize drag for instant feedback
      if (this.leftPanel?.isResizing) {
        this.leftPanelContainer.style.transition = "none";
      } else {
        this.leftPanelContainer.style.transition = "";
      }
      this.leftPanelContainer.style.width = `${panelWidth}px`;
      this.leftPanelContainer.style.minWidth = `${panelWidth}px`;
    }

    // Update spreadsheet container
    const contentWidth = windowWidth - panelWidth;
    this.spreadsheetContainer.style.width = `${contentWidth}px`;
    this.spreadsheetContainer.style.height = `${windowHeight - statusBarHeight}px`;

    // Trigger resize on the multi-dataset visualizer to update the active spreadsheet
    if (this.tabManager) {
      this.tabManager.resize().catch(console.error);
    }
  }

  private setupDatasetListeners(): void {
    // Override closeDataset to update panel state
    const originalCloseDataset = this.tabManager.closeDataset.bind(this.tabManager);
    this.tabManager.closeDataset = (id: string) => {
      originalCloseDataset(id);
      this.leftPanel?.markDatasetAsUnloaded(id);
      this.updateStatusBarDatasetInfo();
      this.updateFocusAfterDatasetChange();
    };

    // Listen for dataset switches (this would require extending TabManager)
    // For now, we'll update status bar when datasets are added
  }

  private updateFocusAfterDatasetChange(): void {
    // Set focus to the active dataset's spreadsheet, or clear focus if no active dataset
    const activeDatasetTab = this.tabManager.getActiveDatasetTab();
    if (activeDatasetTab) {
      this.eventDispatcher.setFocus(`spreadsheet-${activeDatasetTab.metadata.name}`);
    } else {
      this.focusManager.clearFocus();
    }
  }

  private registerCommands(): void {
    // Global-scope keymap actions. handleKeyDown dispatches them via
    // commandRegistry.run(action), and `.help`'s Commands tab pulls
    // them out of the same registry.
    commandRegistry.register({
      id: "app.togglePanel",
      shellName: "panel",
      title: "Toggle Left Panel",
      description: "Show or hide the left panel",
      category: "View",
      scope: "global",
      execute: () => this.toggleControlPanel(),
    });
    commandRegistry.register({
      id: "app.toggleSqlEditor",
      shellName: "sql",
      title: "Toggle SQL Editor",
      description: "Show or hide the SQL editor panel",
      category: "SQL",
      scope: "global",
      execute: () => this.toggleSqlEditor(),
    });
    commandRegistry.register({
      id: "app.toggleFullscreen",
      shellName: "fullscreen",
      title: "Toggle Fullscreen",
      description: "Toggle fullscreen mode",
      category: "View",
      scope: "global",
      execute: () => this.toggleFullscreen(),
    });
    commandRegistry.register({
      id: "help.toggle",
      title: "Toggle Help Panel",
      description: "Open or close the help panel",
      category: "View",
      scope: "global",
      execute: () => {
        if (this.helpPanel.isOpen()) this.helpPanel.hide();
        else this.helpPanel.show("howto");
      },
    });
    // Per-tab shortcut commands. Each opens the panel on its tab; if the
    // panel is already open, just switches tabs (HelpPanel.show handles
    // both states). None of these toggle.
    const HELP_TAB_COMMANDS: Array<[id: string, shellName: string, tab: HelpPanelTab, title: string]> = [
      ["help.howto",     "how-to",    "howto",     "Open How-To"],
      ["help.shortcuts", "shortcuts", "shortcuts", "Open Shortcuts"],
      ["help.feedback",  "feedback",  "feedback",  "Open Feedback"],
      ["help.about",     "about",     "about",     "Open About"],
    ];
    for (const [id, shellName, tab, title] of HELP_TAB_COMMANDS) {
      commandRegistry.register({
        id,
        shellName,
        title,
        description: `Open the ${tab} tab of the help panel`,
        category: "View",
        scope: "global",
        execute: () => this.helpPanel.show(tab),
      });
    }
    commandRegistry.register({
      id: "help.commands",
      shellName: "help",
      title: "Show Commands Help",
      description: "Open the Commands tab of the help panel. `.help <name>` shows details for one command in a popover.",
      category: "View",
      parameters: [
        {
          name: "command",
          type: "string",
          required: false,
          description: "Specific command name (omit to open the Commands tab)",
          options: () =>
            commandRegistry
              .list({ shellOnly: true })
              .map((c) => c.shellName!)
              .filter(Boolean),
        },
      ],
      execute: (params) => {
        const specific = params?.command as string | undefined;
        if (!specific) {
          this.helpPanel.show("commands");
          return;
        }
        const cmd = commandRegistry.getByShellName(specific) || commandRegistry.get(specific);
        if (!cmd) {
          this.showMessage(`Unknown command: ${specific}. Try .help`, "error");
          return;
        }
        const full = formatCommandHelp(cmd);
        const firstLine = full.split("\n", 1)[0];
        const rest = full.slice(firstLine.length + 1);
        this.showMessage(firstLine, "info", { details: rest.length > 0 ? rest : undefined, duration: 0 });
      },
    });
    commandRegistry.register({
      id: "shell.focus",
      shellName: "focus",
      title: "Focus Shell",
      description: "Move keyboard focus to the command shell input",
      category: "View",
      scope: "global",
      execute: () => this.tabManager.focusCommandBar(),
    });
    commandRegistry.register({
      id: "tabs.next",
      title: "Next Tab",
      description: "Switch to the next dataset tab",
      category: "Navigation",
      scope: "global",
      execute: () => this.tabManager.switchToNextTab(),
    });
    commandRegistry.register({
      id: "tabs.prev",
      title: "Previous Tab",
      description: "Switch to the previous dataset tab",
      category: "Navigation",
      scope: "global",
      execute: () => this.tabManager.switchToPreviousTab(),
    });

    // Spreadsheet-scope keymap actions. Registered here (not in the
    // visualizer's constructor) so shell/palette callers hit the ACTIVE
    // tab's instance instead of whichever visualizer registered last.
    // The visualizer's handleKeyDown continues to call dispatchKeymapAction
    // directly — so keyboard input skips the registry round-trip.
    const SPREADSHEET_ACTIONS: Array<[string, string, string]> = [
      ["spreadsheet.scrollUp",       "Scroll Up",         "Scroll the viewport up"],
      ["spreadsheet.scrollDown",     "Scroll Down",       "Scroll the viewport down"],
      ["spreadsheet.scrollLeft",     "Scroll Left",       "Scroll the viewport left"],
      ["spreadsheet.scrollRight",    "Scroll Right",      "Scroll the viewport right"],
      ["spreadsheet.moveUp",         "Move Up",           "Move the cell selection up"],
      ["spreadsheet.moveDown",       "Move Down",         "Move the cell selection down"],
      ["spreadsheet.moveLeft",       "Move Left",         "Move the cell selection left"],
      ["spreadsheet.moveRight",      "Move Right",        "Move the cell selection right"],
      ["spreadsheet.extendUp",       "Extend Up",         "Extend the selection up"],
      ["spreadsheet.extendDown",     "Extend Down",       "Extend the selection down"],
      ["spreadsheet.extendLeft",     "Extend Left",       "Extend the selection left"],
      ["spreadsheet.extendRight",    "Extend Right",      "Extend the selection right"],
      ["spreadsheet.enter",          "Enter Selection",   "Start a cell selection at A1"],
      ["spreadsheet.copy",           "Copy Selection",    "Copy the current selection to the clipboard"],
      ["spreadsheet.cancelSelection", "Cancel Selection", "Clear the current cell selection"],
    ];
    for (const [id, title, description] of SPREADSHEET_ACTIONS) {
      commandRegistry.register({
        id,
        title,
        description,
        category: "Spreadsheet",
        scope: "spreadsheet",
        execute: async () => {
          const active = this.tabManager.getActiveDatasetTab()?.spreadsheetVisualizer;
          if (!active) return;
          await active.dispatchKeymapAction(id);
        },
      });
    }

    // Shell-native commands (new for 0.8 — not in palette, not bound to keys).
    this.registerShellCommands();
  }

  /**
   * Commands that are introduced by the shell: `.theme`, `.tables`, `.columns`,
   * `.open`, `.close`, `.tab`. They live alongside the palette/keymap commands
   * in the registry and are reachable from `.help`.
   */
  private registerShellCommands(): void {
    commandRegistry.register({
      id: "view.setTheme",
      shellName: "theme",
      title: "Set Theme",
      description: "Set light / dark / auto",
      category: "View",
      parameters: [
        {
          name: "theme",
          type: "string",
          required: true,
          description: "light | dark | auto",
          options: () => ["light", "dark", "auto"],
        },
      ],
      execute: (params) => {
        const choice = params?.theme as "light" | "dark" | "auto" | undefined;
        if (!choice || !["light", "dark", "auto"].includes(choice)) {
          throw new Error(".theme requires one of: light, dark, auto");
        }
        const resolved = choice === "auto" ? this.detectTheme() : choice;
        this.setTheme(resolved);
        const s = this.persistenceService.loadAppSettings();
        s.theme = choice;
        this.persistenceService.saveAppSettings(s);
      },
    });

    commandRegistry.register({
      id: "shell.tables",
      shellName: "tables",
      title: "List Tables",
      description: "Open a new tab listing every table in the current database",
      category: "Dataset",
      execute: async () => {
        if (!this.duckDBService) throw new Error("Database not initialized");
        await this.tabManager.addQueryResult(
          "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
          this.duckDBService,
        );
      },
    });

    commandRegistry.register({
      id: "shell.columns",
      shellName: "columns",
      title: "Describe Table",
      description: "Open a new tab with the columns of a table (defaults to the active tab if no name is given)",
      category: "Dataset",
      parameters: [
        {
          name: "table",
          type: "string",
          required: false,
          description: "Table name (defaults to active tab)",
          options: () => this.tabManager.getDatasetIds(),
        },
      ],
      execute: async (params) => {
        const table =
          (params?.table as string | undefined) ??
          this.tabManager.getActiveDatasetTab()?.metadata.name;
        if (!table) throw new Error(".columns needs a table name (or an active dataset tab)");
        if (!this.duckDBService) throw new Error("Database not initialized");
        // information_schema.columns rather than DESCRIBE — addQueryResult
        // wraps in CREATE TABLE … AS (…) which DuckDB's DESCRIBE statement
        // can't appear inside (it's not a SELECT).
        const tableLiteral = String(table).replace(/'/g, "''");
        await this.tabManager.addQueryResult(
          `SELECT column_name, data_type, is_nullable, column_default, ordinal_position FROM information_schema.columns WHERE table_schema = 'main' AND table_name = '${tableLiteral}' ORDER BY ordinal_position`,
          this.duckDBService,
        );
      },
    });

    commandRegistry.register({
      id: "shell.hide",
      shellName: "hide",
      title: "Hide / Show Columns",
      description:
        "Open a dialog to toggle column visibility on the active dataset. Filter and sort still apply to hidden columns; the state persists per dataset name across reloads.",
      category: "Dataset",
      when: () => this.tabManager.getActiveDatasetTab() !== null,
      execute: async () => {
        const tab = this.tabManager.getActiveDatasetTab();
        if (!tab) throw new Error(".hide needs an active dataset tab");
        if (!this.duckDBService) throw new Error("Database not initialized");

        // Source-table resolution matches handleFilterChange: a filtered
        // provider knows its source; an unfiltered one is its own source.
        const sourceTableName =
          tab.dataProvider instanceof FilteredDuckDBDataProvider
            ? tab.dataProvider.getSourceTableName()
            : tab.metadata.name;

        const tableInfo = await this.duckDBService.getTableInfo(sourceTableName);
        const allCols = tableInfo.map((c: any) => c.column_name as string);

        const filterManager = this.tabManager.getFilterManager();
        const currentHidden = new Set(filterManager.getHiddenColumns(tab.metadata.name));

        HideColumnsDialog.show({
          title: `Hide / show columns — ${tab.metadata.name}`,
          allColumns: allCols,
          hidden: currentHidden,
          onApply: (next) => {
            filterManager.setHiddenColumns(tab.metadata.name, next);
            this.persistHiddenColumns(tab.metadata.name, next);
          },
        });
      },
    });

    commandRegistry.register({
      id: "shell.import",
      shellName: "import",
      title: "Import File / Folder",
      description: "Pick a file (no args) or a folder (`--folder` / `-d`) to add to Datasets",
      category: "Dataset",
      execute: async (params) => {
        if (params?.folder || params?.d) {
          this.leftPanel?.openFolderPicker();
          return;
        }
        const picker = document.createElement("input");
        picker.type = "file";
        picker.multiple = true;
        const exts = this.fileImportService.getSupportedExtensions();
        picker.accept = exts.map((e) => (e.startsWith(".") ? e : "." + e)).join(",");
        picker.addEventListener("change", async () => {
          if (picker.files && picker.files.length > 0) {
            await this.leftPanel?.addFilesFromDrop(Array.from(picker.files), true);
          }
        });
        picker.click();
      },
    });

    commandRegistry.register({
      id: "shell.paste",
      shellName: "paste",
      title: "Paste HTML table",
      description: "Open a dialog to paste an HTML table (e.g. copied from a web page) and import it as a dataset.",
      category: "Dataset",
      execute: async () => {
        // The dialog handles parsing + multi-table selection itself; we
        // just need to deliver the chosen table to FileImportService as
        // a synthetic .csv File so the standard pipeline takes it from
        // there.
        HtmlPasteDialog.show({
          defaultName: "pasted_table",
          onImport: async (csvText, name) => {
            const file = new File([csvText], `${name}.csv`, { type: "text/csv" });
            await this.leftPanel?.addFilesFromDrop([file], true);
          },
        });
      },
    });

    commandRegistry.register({
      id: "shell.fetch",
      shellName: "fetch",
      title: "Fetch and import a remote file",
      description: "Pass a URL to a CSV / JSON / Parquet / HTML resource (CORS permitting).",
      category: "Dataset",
      parameters: [
        {
          name: "url",
          type: "string",
          required: true,
          description: "URL to fetch (http:// or https://)",
        },
      ],
      execute: async (params) => {
        const url = (params?.url as string | undefined)?.trim();
        if (!url) throw new Error(".fetch needs a URL.");
        const file = await fetchAsFile(url);
        await this.leftPanel?.addFilesFromDrop([file], true);
      },
    });

    commandRegistry.register({
      id: "shell.open",
      shellName: "open",
      title: "Open Dataset",
      description: "Show a dataset from the Datasets panel in the spreadsheet (imports it first if needed)",
      category: "Dataset",
      parameters: [
        {
          name: "dataset",
          type: "string",
          required: true,
          description: "Name of a dataset/file in the Datasets panel",
          options: () => this.leftPanel?.getAllFileTreeNames() ?? [],
        },
      ],
      execute: async (params) => {
        const name = params?.dataset as string | undefined;
        if (!name) throw new Error(".open needs a name. Use .import to pick a new file from disk.");

        if (this.tabManager.getDatasetIds().includes(name)) {
          await this.tabManager.switchToDataset(name);
          return;
        }
        // openByName imports the tree leaf and TabManager.switchToDataset is
        // already called inside importNode, so no extra switch is needed here.
        const tableName = await this.leftPanel?.openByName(name);
        if (!tableName) {
          throw new Error(`No dataset named '${name}' in Datasets. Use .import to add a file.`);
        }
      },
    });

    commandRegistry.register({
      id: "shell.close",
      shellName: "close",
      title: "Close Dataset Tab",
      description: "Close the named dataset, the active tab if no name is given, or `--all` to close every open dataset",
      category: "Dataset",
      parameters: [
        {
          name: "dataset",
          type: "string",
          required: false,
          description: "Dataset name (defaults to active tab)",
          options: () => this.tabManager.getDatasetIds(),
        },
      ],
      execute: (params) => {
        if (params?.all) {
          // Snapshot first — closeDataset mutates the underlying list as it goes.
          for (const id of [...this.tabManager.getDatasetIds()]) {
            this.tabManager.closeDataset(id);
          }
          return;
        }
        const name = (params?.dataset as string | undefined) ?? this.tabManager.getActiveDatasetTab()?.metadata.name;
        if (!name) throw new Error("No active dataset to close");
        this.tabManager.closeDataset(name);
      },
    });

    commandRegistry.register({
      id: "shell.tab",
      shellName: "tab",
      title: "Switch Tab",
      description: "next | prev | <1-based index>",
      category: "Navigation",
      parameters: [
        {
          name: "target",
          type: "string",
          required: true,
          description: "next | prev | N (1-based)",
          options: () => ["next", "prev"],
        },
      ],
      execute: (params) => {
        const arg = String(params?.target ?? "").trim();
        if (arg === "next") { this.tabManager.switchToNextTab(); return; }
        if (arg === "prev") { this.tabManager.switchToPreviousTab(); return; }
        if (/^\d+$/.test(arg)) { this.tabManager.switchToTabByIndex(Number(arg) - 1); return; }
        throw new Error(".tab expects 'next', 'prev', or a 1-based index");
      },
    });

    // ---- .settings ------------------------------------------------------
    commandRegistry.register({
      id: "shell.settings",
      shellName: "settings",
      title: "Settings",
      description:
        "No args: print current settings. `key=value` (one or more): set. Known keys: theme, dateFormat, datetimeFormat, numberMinDecimals, numberMaxDecimals, numberUseGrouping, minCellWidth, maxStringLength, copyDelimiter, copyIncludeHeader.",
      category: "View",
      execute: async (params) => {
        await this.handleShellSettings(params ?? {});
      },
    });

    // ---- .query save <name> ---------------------------------------------
    commandRegistry.register({
      id: "shell.query",
      shellName: "query",
      title: "Manage Query Bookmarks",
      description: "`.query save <name>` bookmarks the editor's current query.",
      category: "Query",
      parameters: [
        { name: "action", type: "string", required: true, options: () => ["save"] },
        { name: "name", type: "string", required: true },
      ],
      execute: (params) => {
        const action = String(params?.action ?? "").trim();
        const name = String(params?.name ?? "").trim();
        if (action !== "save") throw new Error(".query currently supports only 'save'");
        if (!name) throw new Error(".query save requires a name");
        const editor = this.tabManager.getSqlEditor();
        const query = editor?.getQuery().trim();
        if (!query) throw new Error("SQL editor is empty — open it with .sql and type a query first");
        this.persistenceService.saveQueryBookmark(name, query);
        this.showMessage(`Query "${name}" bookmarked`, "success");
      },
    });

    // ---- .env [list | new | rename | delete | switch] ------------------
    commandRegistry.register({
      id: "shell.env",
      shellName: "env",
      title: "Manage environments",
      description:
        "`.env list` lists envs · `.env new <name>` creates · `.env rename <new>` renames the active env · " +
        "`.env switch <name>` activates · `.env delete <name>` removes (cannot delete the default env)",
      category: "Environment",
      parameters: [
        { name: "action", type: "string", required: true, options: () => ["list", "new", "rename", "switch", "delete"] },
        {
          name: "name",
          type: "string",
          required: false,
          // Suggest existing env names for `switch` / `delete`; for
          // `new` / `rename` the user types a fresh name. The option
          // list is harmless for those — they can ignore it.
          options: () => environmentService.list().map((e) => e.name),
        },
      ],
      execute: (params) => {
        const action = String(params?.action ?? "").trim();
        const name = String(params?.name ?? "").trim();
        const findByName = (n: string) => environmentService.list().find((e) => e.name === n);
        switch (action) {
          case "list": {
            const envs = environmentService.list();
            const activeId = environmentService.getActiveId();
            const lines = envs.map((e) => `${e.id === activeId ? "* " : "  "}${e.name}` + (e.kind === "default" ? " (default)" : ""));
            this.showMessage(`Environments:\n${lines.join("\n")}`, "info", { duration: 8000 });
            return;
          }
          case "new": {
            if (!name) throw new Error(".env new requires a name");
            if (findByName(name)) throw new Error(`An environment called "${name}" already exists`);
            const env = environmentService.create({ name, kind: "folder" });
            environmentService.setActive(env.id);
            this.showMessage(`Environment "${name}" created`, "success");
            return;
          }
          case "rename": {
            if (!name) throw new Error(".env rename requires a new name");
            const active = environmentService.getActive();
            if (!active) throw new Error("No active environment");
            if (findByName(name)) throw new Error(`An environment called "${name}" already exists`);
            environmentService.rename(active.id, name);
            this.showMessage(`Renamed environment to "${name}"`, "success");
            return;
          }
          case "switch": {
            if (!name) throw new Error(".env switch requires the name of an existing environment");
            const target = findByName(name);
            if (!target) throw new Error(`No environment called "${name}"`);
            environmentService.setActive(target.id);
            this.showMessage(`Switched to "${name}"`, "info");
            return;
          }
          case "delete": {
            if (!name) throw new Error(".env delete requires the name of an existing environment");
            const target = findByName(name);
            if (!target) throw new Error(`No environment called "${name}"`);
            if (target.kind === "default") throw new Error("Cannot delete the default environment");
            environmentService.delete(target.id);
            this.showMessage(`Deleted environment "${name}"`, "success");
            return;
          }
          default:
            throw new Error(`.env: unknown action "${action}". Try list / new / rename / switch / delete.`);
        }
      },
    });

    // ---- .export -------------------------------------------------------
    commandRegistry.register({
      id: "dataset.exportSelection",
      shellName: "export",
      title: "Export Selection / Chart",
      description:
        "Export the active dataset's selection (csv | tsv | html | markdown — clipboard + downloads) " +
        "or the active chart (png | svg — downloads only)",
      category: "Dataset",
      parameters: [
        {
          name: "format",
          type: "string",
          required: true,
          description: "csv | tsv | html | markdown (datasets); png | svg (charts)",
          // Argument-completion is per-active-tab so the user only sees the
          // formats that apply right now.
          options: () =>
            this.tabManager.getActiveChartTab() !== null
              ? ["png", "svg"]
              : ["csv", "tsv", "html", "markdown"],
        },
        { name: "includeHeader", type: "boolean", required: false, default: "true" },
        { name: "includeIndex",  type: "boolean", required: false, default: "true" },
      ],
      when: () =>
        this.tabManager.getActiveDatasetTab() !== null ||
        this.tabManager.getActiveChartTab() !== null,
      execute: async (params) => {
        const chart = this.tabManager.getActiveChartTab();
        if (chart) {
          const fmt = String(params?.format ?? "").toLowerCase();
          if (fmt !== "png" && fmt !== "svg") {
            throw new Error(`.export on a chart needs format png | svg, got '${fmt}'`);
          }
          const filename = await this.tabManager.exportActiveChart(fmt);
          this.showMessage(`Exported ${filename} to downloads`, "success");
          return;
        }
        await this.exportSelection(params);
      },
    });

    // ---- .clear -------------------------------------------------------
    commandRegistry.register({
      id: "sql.clearEditor",
      shellName: "clear",
      title: "Clear SQL Editor",
      description: "Clear the SQL editor content",
      category: "SQL",
      when: () => this.tabManager.getSqlEditor()?.isExpanded() === true,
      execute: () => this.tabManager.getSqlEditor()?.clear(),
    });

    // ---- .alias <dataset> <alias> -------------------------------------
    commandRegistry.register({
      id: "dataset.setAlias",
      shellName: "alias",
      title: "Set Dataset Alias",
      description: "Rename a dataset/table via DuckDB ALTER TABLE … RENAME",
      category: "Dataset",
      parameters: [
        {
          name: "dataset",
          type: "string",
          required: true,
          description: "Existing dataset/table name",
          options: () => this.tabManager.getDatasetIds(),
        },
        {
          name: "alias",
          type: "string",
          required: true,
          description: "New name",
        },
      ],
      when: () => this.tabManager.getDatasetIds().length > 0,
      execute: async (params) => {
        const dataset = params?.dataset as string | undefined;
        const alias = params?.alias as string | undefined;
        if (!dataset || !alias) throw new Error(".alias requires a dataset and a new name");
        await this.aliasManager.setAlias(dataset, alias);
        this.showMessage(`Alias "${alias}" set`, "success");
      },
    });
  }

  /**
   * Back-end for `.settings`. With no args, emit the current config through
   * the shell's text/details channel (so the status-bar chip stays one line
   * and the popover carries the full dump). With args, apply each as a
   * setting via the same paths as the Settings tab.
   */
  private async handleShellSettings(params: Record<string, any>): Promise<void> {
    const keys = Object.keys(params).filter((k) => k !== "_args");

    // No args → open the rich Settings tab in the HelpPanel.
    const positional = (params._args as string[] | undefined) ?? [];
    if (keys.length === 0 && positional.length === 0) {
      this.helpPanel.show("settings");
      return;
    }

    // Apply mode.
    const updates: string[] = [];
    let formatChanged = false;
    const settings = this.persistenceService.loadAppSettings();
    for (const key of keys) {
      const raw = params[key];
      switch (key) {
        case "theme": {
          const v = String(raw);
          if (!["light", "dark", "auto"].includes(v)) throw new Error(`theme must be light|dark|auto, got '${v}'`);
          settings.theme = v as "light" | "dark" | "auto";
          this.setTheme(v === "auto" ? this.detectTheme() : (v as "light" | "dark"));
          updates.push(`theme=${v}`);
          break;
        }
        case "dateFormat":      settings.dateFormat = String(raw);       formatChanged = true; updates.push(`dateFormat=${raw}`); break;
        case "datetimeFormat":  settings.datetimeFormat = String(raw);   formatChanged = true; updates.push(`datetimeFormat=${raw}`); break;
        case "numberMinDecimals": settings.numberMinDecimals = Number(raw); formatChanged = true; updates.push(`numberMinDecimals=${raw}`); break;
        case "numberMaxDecimals": settings.numberMaxDecimals = Number(raw); formatChanged = true; updates.push(`numberMaxDecimals=${raw}`); break;
        case "numberUseGrouping": settings.numberUseGrouping = raw === true || raw === "true"; formatChanged = true; updates.push(`numberUseGrouping=${settings.numberUseGrouping}`); break;
        case "minCellWidth":    settings.minCellWidth = Number(raw);     formatChanged = true; updates.push(`minCellWidth=${raw}`); break;
        case "maxStringLength": settings.maxStringLength = Number(raw);  formatChanged = true; updates.push(`maxStringLength=${raw}`); break;
        case "copyDelimiter": {
          const v = String(raw);
          if (v !== "tab" && v !== "comma") throw new Error(`copyDelimiter must be tab|comma, got '${v}'`);
          settings.copyDelimiter = v;
          updates.push(`copyDelimiter=${v}`);
          break;
        }
        case "copyIncludeHeader":
          settings.copyIncludeHeader = raw === true || raw === "true";
          updates.push(`copyIncludeHeader=${settings.copyIncludeHeader}`);
          break;
        default:
          throw new Error(`Unknown setting: ${key}. Run .settings with no args to list known keys.`);
      }
    }
    this.persistenceService.saveAppSettings(settings);

    if (formatChanged) {
      this.applyFormatSettings({
        dateFormat: settings.dateFormat ?? "yyyy-MM-dd",
        datetimeFormat: settings.datetimeFormat ?? "yyyy-MM-dd HH:mm:ss",
        numberMinDecimals: settings.numberMinDecimals ?? 2,
        numberMaxDecimals: settings.numberMaxDecimals ?? 2,
        numberUseGrouping: settings.numberUseGrouping ?? true,
        minCellWidth: settings.minCellWidth ?? 100,
        maxStringLength: settings.maxStringLength ?? 100,
      });
    }

    this.showMessage(`Updated: ${updates.join(", ")}`, "success");
  }

  private toggleControlPanel(): void {
    this.leftPanel.toggleMinimize();
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  }

  private toggleSqlEditor(): void {
    this.tabManager.toggleSqlEditor();
    const editor = this.tabManager.getSqlEditor();
    if (editor?.isExpanded()) editor.focus();
  }

  private async loadSampleDataset(): Promise<void> {
    try {
      const file = new File([penguinsCsv], "penguins.csv", { type: "text/csv" });
      await this.leftPanel.addFilesFromDrop([file], true);
      this.helpPanel.hide();
      this.showMessage("Palmer Penguins loaded \u2014 try: SELECT * FROM penguins;", "success");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown error";
      this.showMessage(`Failed to load sample: ${msg}`, "error");
      throw error;
    }
  }

  /**
   * `/demo` route: load the penguins sample, drop the cleanup +
   * VISUALIZE script into the SQL editor, and leave it for the user to
   * run with Ctrl+Enter. No auto-execute \u2014 landing on /demo should look
   * like "the app set itself up for me", not "code ran without my
   * consent".
   */
  private async runDemo(): Promise<void> {
    try {
      await this.loadSampleDataset();
      const editor = this.tabManager.getSqlEditor();
      if (editor && !editor.isExpanded()) {
        this.tabManager.toggleSqlEditor();
      }
      editor?.setQuery(PENGUINS_DEMO_SQL);
      editor?.focus();
      this.showMessage("Demo loaded \u2014 press Ctrl+Enter to run", "info");
    } catch (error) {
      // loadSampleDataset already surfaced its own error; nothing to add.
    }
  }

  private async exportSelection(params?: Record<string, any>): Promise<void> {
    const activeDataset = this.tabManager.getActiveDatasetTab();

    if (activeDataset) {
      // No selection -> fall back to the whole dataset. Matches the
      // mental model "running .export with nothing selected exports the
      // whole table"; an explicit row/col/cell selection still scopes
      // the export down.
      let selection = await activeDataset.spreadsheetVisualizer.getSelection();
      if (!selection) {
        selection = await activeDataset.spreadsheetVisualizer.exportFullDataset();
      }
      if (!selection) {
        this.showMessage("Nothing to export (dataset is empty)", "warning");
        return;
      }

      const { includeHeader, includeIndex, format } = params || {};
      const datasetName = activeDataset.metadata.name;
      const settings = this.persistenceService.loadAppSettings();
      const quoteEscape = settings.csvQuoteEscape ?? "double";

      let ext = "";
      switch (format) {
        case "csv":
          ext = "csv";
          await exportAsText(selection, includeHeader, includeIndex, ",", "\n", datasetName, quoteEscape);
          break;
        case "tsv":
          ext = "tsv";
          await exportAsText(selection, includeHeader, includeIndex, "\t", "\n", datasetName, quoteEscape);
          break;
        case "html":
          ext = "html";
          await exportAsHTML(selection, includeHeader, includeIndex, datasetName);
          break;
        case "markdown":
          ext = "md";
          await exportAsMarkdown(selection, includeHeader, includeIndex, "\n", datasetName);
          break;
      }
      this.showMessage(`Exported ${datasetName}.${ext} to clipboard + downloads`, "success");
    } else {
      this.showMessage("No active dataset to export", "warning");
    }
  }

  private async updateStatusBarDatasetInfo(dataset?: DataProvider): Promise<void> {
    if (dataset) {
      const metadata = await dataset.getMetadata();
      this.statusBar.updateDatasetInfo(metadata.name, metadata.totalRows, metadata.totalColumns);
    } else {
      const activeDataset = this.tabManager.getActiveDatasetTab();
      if (activeDataset) {
        const metadata = activeDataset.metadata;
        this.statusBar.updateDatasetInfo(metadata.name, metadata.totalRows, metadata.totalColumns);
      } else {
        this.statusBar.updateDatasetInfo("No dataset selected", 0, 0);
      }
    }
  }

  private setOnSelectDatasetCallback(): void {
    const callback = async (dataset: DataProvider) => {
      await this.updateStatusBarDatasetInfo(dataset);
      // Re-arm the cell-related items in case we're returning from a chart
      // tab (which hides them). The spreadsheet itself doesn't re-emit a
      // selection event on tab activation, so without this the items would
      // stay invisible until the user clicked a cell.
      this.statusBar.updateSelection(undefined);
      this.statusBar.updatePosition(undefined);
      this.statusBar.updateCellValue(undefined);
    };

    this.leftPanel.setOnSelectCallback(callback);
    this.tabManager.setOnSelectCallback(callback);
    this.tabManager.setOnChartActivateCallback((chartName) => {
      this.statusBar.showChartContext(chartName);
    });
  }

  private setOnCloseTabCallback(): void {
    this.tabManager.setOnCloseTabCallback(() => {
      this.updateFocusAfterDatasetChange();
      this.updateStatusBarDatasetInfo();
    });
  }

  /**
   * Set the callback for when a cell is selected.
   * Update the status bar.
   */
  private setOnCellSelectionCallback(): void {
    this.tabManager.setOnCellSelectionCallback((cellSelection) => {
      this.statusBar.updateSelection(cellSelection);
      this.statusBar.updatePosition(cellSelection);
      this.statusBar.updateCellValue(cellSelection);
    });
    this.tabManager.setOnCellInspectCallback((info) => {
      this.statusBar.openCellPopover(info);
    });
  }

  /**
   * Write the per-dataset hidden-column set back to AppSettings. Empty
   * sets prune the key so we don't accumulate dead entries for datasets
   * the user has fully un-hidden.
   */
  private persistHiddenColumns(datasetName: string, hidden: Set<string>): void {
    const settings = this.persistenceService.loadAppSettings();
    const next = { ...(settings.hiddenColumns ?? {}) };
    if (hidden.size === 0) {
      delete next[datasetName];
    } else {
      next[datasetName] = Array.from(hidden);
    }
    settings.hiddenColumns = next;
    this.persistenceService.saveAppSettings(settings);
  }

  /**
   * Write the per-dataset column-order array back to AppSettings.
   * Empty arrays prune the key.
   */
  private persistColumnOrder(datasetName: string, order: string[]): void {
    const settings = this.persistenceService.loadAppSettings();
    const next = { ...(settings.columnOrder ?? {}) };
    if (order.length === 0) {
      delete next[datasetName];
    } else {
      next[datasetName] = order;
    }
    settings.columnOrder = next;
    this.persistenceService.saveAppSettings(settings);
  }

  /**
   * Apply freshly-saved format preferences to every open tab and the status
   * bar. The numberFormat receives a new object reference so reference-keyed
   * caches (preview/popover number formatters) invalidate correctly.
   */
  private applyFormatSettings(opts: {
    dateFormat: string;
    datetimeFormat: string;
    numberMinDecimals: number;
    numberMaxDecimals: number;
    numberUseGrouping: boolean;
    minCellWidth: number;
    maxStringLength: number;
  }): void {
    const so = this.options.spreadsheetOptions ?? (this.options.spreadsheetOptions = {});
    so.dateFormat = opts.dateFormat;
    so.datetimeFormat = opts.datetimeFormat;
    so.numberFormat = {
      minimumFractionDigits: opts.numberMinDecimals,
      maximumFractionDigits: opts.numberMaxDecimals,
      useGrouping: opts.numberUseGrouping,
    };
    so.minCellWidth = opts.minCellWidth;
    so.maxStringLength = opts.maxStringLength;
    this.statusBar?.setSpreadsheetOptions(so);
    this.tabManager?.applyFormatChange(so).catch((err) => {
      console.error("applyFormatChange failed:", err);
    });
  }
}
