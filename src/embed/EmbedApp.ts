import type { DuckDBService } from "../data/DuckDBService";
import { EmbedSqlEditor } from "./EmbedSqlEditor";
import { EmbedResultPanel } from "./EmbedResultPanel";
import { dispatchEmbedScript } from "./embedDispatch";
import { describeDatasetUrl, EmbedConfig } from "./embedConfig";
import { applyTheme, resolveTheme, EmbedTheme } from "./embedTheme";
import { installParentListener, installResizeReporter, postToParent } from "./embedMessages";
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_DATETIME_FORMAT,
  DEFAULT_MIN_CELL_WIDTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_NUMBER_FORMAT,
} from "../components/SpreadsheetVisualizer/defaults";

export interface EmbedAppOptions {
  duck: DuckDBService;
  config: EmbedConfig;
}

/**
 * Top-level orchestrator for the /embed route. Two visible regions:
 *   - editor on top (slim CodeMirror via EmbedSqlEditor)
 *   - result panel below (SpreadsheetVisualizer via EmbedResultPanel)
 *
 * The constructor mounts the layout synchronously; `bootstrap()`
 * runs the async work (theme apply → dataset registration →
 * autorun) so the parent can await ready state.
 */
export class EmbedApp {
  private duck: DuckDBService;
  private config: EmbedConfig;
  private root: HTMLElement;
  private editor: EmbedSqlEditor;
  private result: EmbedResultPanel;
  private currentTheme: EmbedTheme;
  private teardownResize: (() => void) | null = null;
  private teardownParent: (() => void) | null = null;

  constructor(parent: HTMLElement, options: EmbedAppOptions) {
    this.duck = options.duck;
    this.config = options.config;

    this.root = document.createElement("div");
    this.root.className = "embed-root";
    parent.replaceChildren(this.root);

    this.currentTheme = resolveTheme(this.config.theme);
    applyTheme(this.currentTheme);

    const editorWrap = document.createElement("div");
    editorWrap.className = "embed-root__editor";
    this.root.appendChild(editorWrap);

    const resultWrap = document.createElement("div");
    resultWrap.className = "embed-root__result";
    this.root.appendChild(resultWrap);

    this.editor = new EmbedSqlEditor(editorWrap, {
      initialQuery: this.config.query ?? "",
      onExecute: (sql) => this.run(sql),
    });

    this.result = new EmbedResultPanel(resultWrap, {
      spreadsheetOptions: {
        minHeight: 200,
        minWidth: 320,
        minCellWidth: DEFAULT_MIN_CELL_WIDTH,
        maxStringLength: DEFAULT_MAX_STRING_LENGTH,
        dateFormat: DEFAULT_DATE_FORMAT,
        datetimeFormat: DEFAULT_DATETIME_FORMAT,
        numberFormat: { ...DEFAULT_NUMBER_FORMAT, useGrouping: true },
      },
    });
  }

  public async bootstrap(): Promise<void> {
    // Hint while datasets register so the iframe isn't a blank panel.
    if (this.config.datasets.length === 0) {
      this.result.showHint(
        "No dataset loaded — pass ?dataset= to register one, or drop the page into the full Bedevere Wise app.",
      );
    } else {
      this.result.showHint(`Loading ${this.config.datasets.length} dataset(s)…`);
    }

    // Wire postMessage listeners before dataset work starts so an early
    // theme switch from the parent isn't dropped on the floor.
    this.teardownParent = installParentListener({
      onSetTheme: (theme) => this.setTheme(theme),
      onRunRequested: () => this.editor.execute(),
    });
    // Resize reporter is installed after first paint so the initial
    // emitted height reflects the actual rendered layout, not the
    // pre-bootstrap loader.
    requestAnimationFrame(() => {
      this.teardownResize = installResizeReporter(document.body, this.config.id);
    });

    // Dataset registration is sequential — parallel registerFileURL
    // calls would race in DuckDB-WASM's virtual filesystem and can
    // produce confusing "file already registered" errors when two
    // identical URLs are passed.
    //
    // File-name and table-name are intentionally different (e.g.
    // "adsl.parquet" vs "adsl") so the read_*('<file>') reference
    // doesn't collide with the materialized table the user queries.
    // Same pattern as StatFormatHandler.
    const registered: Array<{ name: string }> = [];
    for (const url of this.config.datasets) {
      const desc = describeDatasetUrl(url);
      if (!desc) {
        this.result.showError(`Unsupported dataset URL: ${url}`);
        return;
      }
      try {
        await this.duck.registerFileURL(desc.fileName, url);
        await this.duck.executeQuery(
          `CREATE OR REPLACE TABLE "${desc.tableName}" AS SELECT * FROM ${desc.readerSql(desc.fileName)}`,
        );
        registered.push({ name: desc.tableName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // DuckDB-WASM surfaces a CORS-blocked fetch as a generic IO
        // error; we can't tell from the message whether the parent
        // server failed CORS preflight or the URL 404'd, so the
        // banner reports both possibilities.
        this.result.showError(
          `Could not load dataset: ${url}\n${msg}\n` +
            "If the file exists, verify the host serves an `Access-Control-Allow-Origin` header for this origin.",
        );
        return;
      }
    }

    if (registered.length > 0) {
      this.result.showHint(`Loaded: ${registered.map((r) => r.name).join(", ")}`);
    }

    if (this.config.autorun && this.config.query) {
      await this.run(this.config.query);
    }

    postToParent({ type: "embed-ready", ...(this.config.id ? { id: this.config.id } : {}) });
  }

  public setTheme(theme: EmbedTheme): void {
    if (theme === this.currentTheme) return;
    this.currentTheme = theme;
    applyTheme(theme);
    // The canvas-based spreadsheet redraws via its own theme listener;
    // a manual resize keeps layout aligned in case any container
    // dimensions shifted as part of the theme swap.
    this.result.resize().catch(console.error);
  }

  public destroy(): void {
    this.teardownResize?.();
    this.teardownParent?.();
    this.teardownResize = null;
    this.teardownParent = null;
    this.editor.destroy();
    this.root.remove();
  }

  private async run(sql: string): Promise<void> {
    try {
      const result = await dispatchEmbedScript(sql, this.duck);
      if (result.kind === "table") {
        await this.result.showResult(result.resultProvider, result.resultName);
      } else if (result.kind === "chart") {
        await this.result.showChart(result.visualizeResult, result.resultName);
      } else {
        this.result.showHint("Statement executed — no rows to display.");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.result.showError(msg);
    }
  }
}
