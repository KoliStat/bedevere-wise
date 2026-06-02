import { BedevereAppMessageType } from "../BedevereApp/BedevereApp";
import { ICellSelection, SpreadsheetOptions } from "../SpreadsheetVisualizer/types";
import { MessagePopover } from "./MessagePopover";
import { CellValuePopover } from "./CellValuePopover";
import { ComplexKind, getComplexKind, isComplexType } from "../../data/types";
import { escapeHtml } from "../../utils/html";

export interface MessageOptions {
  /** Duration in ms; 0 means persistent until dismissed. Defaults per type. */
  duration?: number;
  /** Full text shown in the expanded popover (e.g. stack trace). */
  details?: string;
  /** Optional title; defaults to severity label (ERROR / WARNING / …). */
  title?: string;
}

/**
 * Render an elapsed duration with a unit that fits its magnitude:
 * sub-second → "150 ms", under a minute → "1.2 s", longer → "1m 23s".
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const DEFAULT_DURATIONS: Record<BedevereAppMessageType, number> = {
  error: 10_000,
  warning: 6_000,
  success: 3_000,
  info: 3_000,
};

const MESSAGE_ICONS: Record<BedevereAppMessageType, string> = {
  error: "\u2716", // ✖
  warning: "\u26A0", // ⚠
  success: "\u2713", // ✓
  info: "\u2139", // ℹ
};

interface ActiveMessage {
  type: BedevereAppMessageType;
  message: string;
  details?: string;
  title?: string;
  timestamp: Date;
}

export interface StatusBarItem {
  id: string;
  text: string;
  html?: string;
  tooltip?: string;
  priority: number;
  alignment: "left" | "right";
  command?: string;
  color?: string;
  backgroundColor?: string;
  visible?: boolean;
  /** Severity, used to apply modifier classes and enable click-to-expand. */
  messageType?: BedevereAppMessageType;
  /** Whether clicking this item should open the popover. */
  expandable?: boolean;
}

export class StatusBar {
  private container: HTMLElement;
  private leftSection: HTMLElement;
  private rightSection: HTMLElement;
  private version: string;
  private items: Map<string, StatusBarItem> = new Map();
  private onCommandCallback?: (command: string) => void;

  // Active transient message (for the popover)
  private activeMessage: ActiveMessage | null = null;
  private messageTimeoutId: number | null = null;
  private popover: MessagePopover;
  private cellValuePopover: CellValuePopover;
  private onHelpClickCallback?: () => void;

  // Latest complex-cell state for the cell-value inspector popover.
  private lastComplexCell: { raw: any; columnName: string; kind: ComplexKind | null } | null = null;
  private spreadsheetOptions: SpreadsheetOptions = {};
  // Suppresses auto-pop while the user is navigating through a run of complex
  // cells after explicitly dismissing the popover (Esc / outside / close /
  // chip-close). Reset whenever selection leaves complex cells.
  private autoPopDisabled = false;

  constructor(parent: HTMLElement, version: string) {
    this.container = document.createElement("div");
    this.container.className = "status-bar";

    this.leftSection = document.createElement("div");
    this.leftSection.className = "status-bar__section status-bar__section--left";

    this.rightSection = document.createElement("div");
    this.rightSection.className = "status-bar__section status-bar__section--right";

    this.container.appendChild(this.leftSection);
    this.container.appendChild(this.rightSection);
    parent.appendChild(this.container);

    this.version = version;

    this.popover = new MessagePopover(document.body);
    this.cellValuePopover = new CellValuePopover(document.body, () => { this.autoPopDisabled = true; });

    this.initializeDefaultItems();
  }

  /**
   * Cache the spreadsheet options so the cell-value popover can render
   * complex values (numbers, dates) with the same formatting as the canvas.
   * Called once during app setup; all tabs share the same numberFormat etc.
   */
  public setSpreadsheetOptions(options: SpreadsheetOptions): void {
    this.spreadsheetOptions = options;
  }

  /**
   * Show the elapsed time of the most recent user-submitted query on the
   * right side of the status bar. Persists until the next query replaces
   * it, so the user always sees what the last query cost. Reuses the
   * `status-bar__msg-icon` / `status-bar__msg-text` markup + messageType
   * modifier so the existing severity styling applies (green for success,
   * red for failure).
   */
  public updateQueryTime(elapsedMs: number, success: boolean): void {
    const formatted = formatElapsed(elapsedMs);
    const icon = success ? "\u23F1" : "\u2716"; // ⏱ / ✖
    const label = success ? `Query ${formatted}` : `Failed after ${formatted}`;
    const html =
      `<span class="status-bar__msg-icon">${icon}</span>` +
      `<span class="status-bar__msg-text">${escapeHtml(label)}</span>`;
    this.updateItem("query-time", {
      text: label,
      html,
      tooltip: success ? "Last query execution time" : "Last query failed",
      visible: true,
      messageType: success ? "success" : "error",
    });
  }

  public addItem(item: StatusBarItem): void {
    this.items.set(item.id, { ...item, visible: item.visible ?? true });
    this.render();
  }

  public updateItem(id: string, updates: Partial<StatusBarItem>): void {
    const item = this.items.get(id);
    if (item) {
      Object.assign(item, updates);
      this.render();
    }
  }

  public removeItem(id: string): void {
    this.items.delete(id);
    this.render();
  }

  public setOnCommandCallback(callback: (command: string) => void): void {
    this.onCommandCallback = callback;
  }

  public setOnHelpClickCallback(callback: () => void): void {
    this.onHelpClickCallback = callback;
  }

  public updateDatasetInfo(datasetName: string, totalRows: number, totalColumns: number): void {
    this.updateItem("dataset-info", {
      text: `${datasetName} • ${totalRows} rows • ${totalColumns} columns`,
      tooltip: `Dataset: ${datasetName}\nRows: ${totalRows}\nColumns: ${totalColumns}`,
    });
  }

  /**
   * Repurpose the status bar for a chart tab: show the chart name in the
   * `dataset-info` slot and hide the cell-related items (position,
   * selection, cell value) since charts don't have cells. The companion
   * call when switching back to a spreadsheet is `updateDatasetInfo` plus
   * `updateSelection(undefined)` etc., which the dataset-tab path already
   * runs through BedevereApp's onSelect callback.
   */
  public showChartContext(chartName: string): void {
    this.updateItem("dataset-info", {
      text: chartName,
      tooltip: `Chart: ${chartName}`,
    });
    this.updateItem("position-info", { text: "", visible: false });
    this.updateItem("selection-info", { text: "", visible: false });
    this.updateItem("cell-value", { text: "", html: undefined, visible: false, expandable: false });
    this.lastComplexCell = null;
    this.autoPopDisabled = false;
    if (this.cellValuePopover.isOpen()) this.cellValuePopover.hide();
  }

  public updateSelection(cellSelection?: ICellSelection): void {
    if (!cellSelection) {
      this.updateItem("selection-info", {
        text: "No selection",
        tooltip: "No selection",
        visible: true,
      });
      return;
    }

    // Column selection: rows is empty, columns has the selected column(s)
    if (cellSelection.rows.length === 0 && cellSelection.columns.length > 0) {
      const count = cellSelection.columns.length;
      const text = count === 1 ? "1 column selected" : `${count} columns selected`;
      this.updateItem("selection-info", {
        text,
        tooltip: `Selection: ${text}`,
        visible: true,
      });
      return;
    }

    // Cell selection
    if (cellSelection.rows.length > 0 && cellSelection.columns.length > 0) {
      const cellCount = cellSelection.rows.length * cellSelection.columns.length;
      const text = cellCount === 1 ? "1 cell selected" : `${cellCount} cells selected`;
      this.updateItem("selection-info", {
        text,
        tooltip: cellCount === 1
          ? "Selection: 1 cell selected"
          : `Selection: ${cellSelection.rows.length} rows \u00d7 ${cellSelection.columns.length} columns`,
        visible: true,
      });
      return;
    }

    this.updateItem("selection-info", {
      text: "No selection",
      tooltip: "No selection",
      visible: true,
    });
  }

  public updatePosition(cellSelection?: ICellSelection): void {
    if (!cellSelection || cellSelection.rows.length === 0) {
      this.updateItem("position-info", { text: "", visible: false });
      return;
    }

    if (cellSelection.rows.length === 1 && cellSelection.columns.length === 1) {
      const text = `${cellSelection.columns[0].name}:${cellSelection.rows[0]}`;
      this.updateItem("position-info", { text, tooltip: `Position: ${text}`, visible: true });
      return;
    }

    if (cellSelection.rows.length > 0 && cellSelection.columns.length > 0) {
      const startCol = cellSelection.columns[0].name;
      const startRow = cellSelection.rows[0];
      const endCol = cellSelection.columns[cellSelection.columns.length - 1].name;
      const endRow = cellSelection.rows[cellSelection.rows.length - 1];
      const text = `${startCol}:${startRow} \u2192 ${endCol}:${endRow}`;
      this.updateItem("position-info", { text, tooltip: `Range: ${text}`, visible: true });
      return;
    }

    this.updateItem("position-info", { text: "", visible: false });
  }

  public updateCellValue(cellSelection?: ICellSelection): void {
    if (!cellSelection || cellSelection.rows.length === 0) {
      this.lastComplexCell = null;
      this.autoPopDisabled = false;
      if (this.cellValuePopover.isOpen()) this.cellValuePopover.hide();
      this.updateItem("cell-value", { text: "", html: undefined, visible: false, expandable: false });
      return;
    }

    if (cellSelection.formatted.length > 0 && cellSelection.formatted[0].length > 0) {
      const formatted = cellSelection.formatted[0][0];
      const raw = cellSelection.values[0][0];
      const column = cellSelection.columns[0];
      const columnDataType = column?.dataType;
      const dataType = columnDataType?.toLowerCase() ?? "";
      const complex = columnDataType ? isComplexType(columnDataType) : false;

      if (complex) {
        // Stash the raw value so the popover can render the full structure.
        this.lastComplexCell = {
          raw,
          columnName: column?.name ?? "value",
          kind: getComplexKind(columnDataType!),
        };

        const escapedFormatted = escapeHtml(formatted);
        // Only show the "\u2026" expand hint when the compact preview had to
        // drop fields or collapse nested values. For a small flat struct /
        // list that fits entirely in the preview, the hint is noise.
        const hintNeeded = previewWasTruncated(raw);
        const html =
          `<span class="cell-value__formatted cell-value__formatted--${dataType}">${escapedFormatted}</span>` +
          (hintNeeded ? ` <span class="status-bar__msg-more" title="Click to expand">\u2026</span>` : "");

        this.updateItem("cell-value", {
          text: formatted,
          html,
          tooltip: "Click to inspect",
          visible: true,
          expandable: true,
        });

        // Auto-open the inspector on every complex cell unless the user has
        // dismissed it during this streak. Also refreshes content in place
        // when the popover is already open across cells.
        if ((!this.autoPopDisabled || this.cellValuePopover.isOpen()) && this.lastComplexCell.kind) {
          this.cellValuePopover.show({
            columnName: this.lastComplexCell.columnName,
            kind: this.lastComplexCell.kind,
            value: this.lastComplexCell.raw,
            options: this.spreadsheetOptions,
          });
        }
        return;
      }

      // Non-complex: preserve the legacy formatted + raw inline rendering.
      this.lastComplexCell = null;
      this.autoPopDisabled = false;
      if (this.cellValuePopover.isOpen()) this.cellValuePopover.hide();

      const hasRaw = raw != null && String(raw) !== formatted;
      const plainText = hasRaw ? `${formatted} [${raw}]` : formatted;

      const escapedFormatted = escapeHtml(formatted);
      const formattedSpan = `<span class="cell-value__formatted cell-value__formatted--${dataType}">${escapedFormatted}</span>`;
      const rawSpan = hasRaw ? ` <span class="cell-value__raw">[${escapeHtml(String(raw))}]</span>` : "";

      this.updateItem("cell-value", {
        text: plainText,
        html: formattedSpan + rawSpan,
        tooltip: `Cell value: ${plainText}`,
        visible: true,
        expandable: false,
      });
      return;
    }

    this.lastComplexCell = null;
    this.autoPopDisabled = false;
    if (this.cellValuePopover.isOpen()) this.cellValuePopover.hide();
    this.updateItem("cell-value", { text: "", html: undefined, visible: false, expandable: false });
  }

  /**
   * Open the inspector popover with an explicit payload. Wired to the
   * spreadsheet's double-click-on-complex-cell event so the user can
   * always re-open the popover even after dismissing it (resets the
   * `autoPopDisabled` streak). Updates `lastComplexCell` so a subsequent
   * `toggleCellValuePopover` keymap toggle has a valid target.
   */
  public openCellPopover(info: { columnName: string; kind: ComplexKind; value: any }): void {
    this.autoPopDisabled = false;
    this.lastComplexCell = {
      columnName: info.columnName,
      kind: info.kind,
      raw: info.value,
    };
    this.cellValuePopover.show({
      columnName: info.columnName,
      kind: info.kind,
      value: info.value,
      options: this.spreadsheetOptions,
    });
  }

  /** Toggle the inspector popover for the currently selected complex cell. */
  private toggleCellValuePopover(): void {
    if (!this.lastComplexCell || !this.lastComplexCell.kind) return;
    if (this.cellValuePopover.isOpen()) {
      this.autoPopDisabled = true;
      this.cellValuePopover.hide();
    } else {
      this.autoPopDisabled = false;
      this.cellValuePopover.show({
        columnName: this.lastComplexCell.columnName,
        kind: this.lastComplexCell.kind,
        value: this.lastComplexCell.raw,
        options: this.spreadsheetOptions,
      });
    }
  }

  public showMessage(
    message: string,
    type: BedevereAppMessageType = "info",
    options?: MessageOptions,
  ): void {
    // Clear any previously-scheduled dismissal
    if (this.messageTimeoutId !== null) {
      window.clearTimeout(this.messageTimeoutId);
      this.messageTimeoutId = null;
    }

    const duration = options?.duration ?? DEFAULT_DURATIONS[type];
    const icon = MESSAGE_ICONS[type];

    this.activeMessage = {
      type,
      message,
      details: options?.details,
      title: options?.title,
      timestamp: new Date(),
    };

    // Auto-open the popover for errors and warnings so the user sees the
    // full text (and any stack-trace details) without having to click the
    // status bar. The status-bar item is narrow and truncates long
    // messages; the popover wraps and shows details. Outside-click /
    // Escape still dismiss, and the existing duration timeout below hides
    // the popover when the transient message expires. For success / info
    // we keep the old "update in place if already open, otherwise stay
    // collapsed" behavior — those messages are short and self-contained.
    const autoOpen = type === "error" || type === "warning";
    if ((this.popover.isOpen() || autoOpen) && this.activeMessage) {
      this.popover.show(this.activeMessage);
    }

    const itemHtml =
      `<span class="status-bar__msg-icon">${icon}</span>` +
      `<span class="status-bar__msg-text">${escapeHtml(message)}</span>` +
      (options?.details ? `<span class="status-bar__msg-more" title="Click to expand">\u2026</span>` : "");

    const messageItem: StatusBarItem = {
      id: "temp-message",
      text: message,
      html: itemHtml,
      tooltip: options?.details ? `${message}\n\nClick to expand` : message,
      priority: 1000,
      alignment: "left",
      visible: true,
      messageType: type,
      expandable: true,
    };

    this.addItem(messageItem);

    if (duration > 0) {
      this.messageTimeoutId = window.setTimeout(() => {
        this.removeItem("temp-message");
        this.messageTimeoutId = null;
        this.activeMessage = null;
        this.popover.hide();
      }, duration);
    }
  }

  /**
   * Toggle the message popover open/closed for the currently-active message.
   * Called when the user clicks the transient status bar message.
   */
  private toggleMessagePopover(): void {
    if (!this.activeMessage) return;
    if (this.popover.isOpen()) {
      this.popover.hide();
    } else {
      this.popover.show(this.activeMessage);
    }
  }

  private initializeDefaultItems(): void {
    // Left side items
    this.addItem({
      id: "dataset-info",
      text: "No dataset loaded",
      priority: 100,
      alignment: "left",
      tooltip: "Dataset information",
    });

    this.addItem({
      id: "position-info",
      text: "",
      priority: 95,
      alignment: "left",
      tooltip: "Current position",
      visible: false,
    });

    this.addItem({
      id: "selection-info",
      text: "No selection",
      priority: 90,
      alignment: "left",
      tooltip: "Current selection",
    });

    this.addItem({
      id: "cell-value",
      text: "",
      priority: 80,
      alignment: "left",
      tooltip: "Current cell value",
      visible: false,
    });

    this.addItem({
      id: "query-time",
      text: "",
      priority: 85,
      alignment: "right",
      tooltip: "Last query execution time",
      visible: false,
    });
  }

  private render(): void {
    this.leftSection.innerHTML = "";
    this.rightSection.innerHTML = "";

    const leftItems = Array.from(this.items.values())
      .filter((item) => item.alignment === "left" && item.visible)
      .sort((a, b) => b.priority - a.priority);

    const rightItems = Array.from(this.items.values())
      .filter((item) => item.alignment === "right" && item.visible)
      .sort((a, b) => b.priority - a.priority);

    leftItems.forEach((item) => this.renderItem(item, this.leftSection));
    rightItems.forEach((item) => this.renderItem(item, this.rightSection));

    // Add version and made by information
    const versionElement = document.createElement("div");
    versionElement.className = "status-bar__item status-bar__item--clickable status-bar__item--version";
    versionElement.title = `Bedevere Wise v${this.version}\nClick to view changelog`;
    const dash = this.version.indexOf("-");
    const versionNum = dash >= 0 ? this.version.slice(0, dash) : this.version;
    const codename = dash >= 0 ? this.version.slice(dash + 1) : "";
    versionElement.innerHTML = codename
      ? `<span class="status-bar__version-num">v${escapeHtml(versionNum)}</span>` +
        `<span class="status-bar__version-sep">\u00B7</span>` +
        `<span class="status-bar__version-codename">${escapeHtml(codename)}</span>`
      : `<span class="status-bar__version-num">v${escapeHtml(versionNum)}</span>`;
    versionElement.addEventListener("click", () => {
      window.open("https://github.com/caerbannogwhite/bedevere-wise/blob/main/CHANGELOG.md", "_blank", "noopener,noreferrer");
    });
    this.rightSection.appendChild(versionElement);

    // Help button (opens HelpPanel — How To + About)
    const helpElement = document.createElement("div");
    helpElement.className = "status-bar__item status-bar__item--clickable status-bar__item--help";
    helpElement.title = "Open Help";
    helpElement.textContent = "Help";
    helpElement.addEventListener("click", () => this.onHelpClickCallback?.());
    this.rightSection.appendChild(helpElement);

    const createdByElement = document.createElement("div");
    createdByElement.className = "status-bar__item status-bar__item--created-by";
    createdByElement.title = "Visit the creator's GitHub profile";
    createdByElement.innerHTML = `
      <span class="created-by__text">Made with</span>
      <span class="created-by__heart">❤️</span>
      <span class="created-by__text">by</span>
      <a href="https://github.com/caerbannogwhite" target="_blank" rel="noopener noreferrer" class="created-by__link">
        caerbannogwhite
      </a>
    `;
    this.rightSection.appendChild(createdByElement);
  }

  private renderItem(item: StatusBarItem, container: HTMLElement): void {
    const element = document.createElement("div");
    element.className = "status-bar__item";
    element.setAttribute("data-id", item.id);

    if (item.messageType) {
      element.classList.add(`status-bar__item--${item.messageType}`);
    }

    if (item.html) {
      element.innerHTML = item.html;
    } else {
      element.textContent = item.text;
    }

    if (item.tooltip) {
      element.title = item.tooltip;
    }

    if (item.color) {
      element.style.color = item.color;
    }

    if (item.backgroundColor) {
      element.style.backgroundColor = item.backgroundColor;
    }

    if (item.expandable) {
      element.classList.add("status-bar__item--clickable");
      element.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.id === "cell-value") {
          this.toggleCellValuePopover();
        } else {
          this.toggleMessagePopover();
        }
      });
    } else if (item.command) {
      element.classList.add("status-bar__item--clickable");
      element.addEventListener("click", () => {
        if (this.onCommandCallback) {
          this.onCommandCallback(item.command!);
        }
      });
    }

    container.appendChild(element);
  }

  public destroy(): void {
    if (this.messageTimeoutId !== null) {
      window.clearTimeout(this.messageTimeoutId);
      this.messageTimeoutId = null;
    }
    this.popover.destroy();
    this.cellValuePopover.destroy();
    this.container.remove();
  }
}

/**
 * Does the compact cell preview drop any information? True if the complex
 * value has more than {@link PREVIEW_MAX_ENTRIES} fields/items, or if any
 * field/item is itself an object/array (which the preview collapses to
 * `{\u2026}` / `[\u2026]`). The status-bar uses this to decide whether to
 * show the "\u2026 click to expand" hint next to the cell value.
 */
const PREVIEW_MAX_ENTRIES = 3;

function previewWasTruncated(value: any): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) {
    if (value.length > PREVIEW_MAX_ENTRIES) return true;
    return value.some(isNestedForPreview);
  }
  if (typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array)) {
    const entries = Object.entries(value);
    if (entries.length > PREVIEW_MAX_ENTRIES) return true;
    return entries.some(([, v]) => isNestedForPreview(v));
  }
  return false;
}

function isNestedForPreview(v: any): boolean {
  if (v == null || typeof v !== "object") return false;
  if (v instanceof Date || v instanceof Uint8Array) return false;
  return true;
}
