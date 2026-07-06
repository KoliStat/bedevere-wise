import { ComplexKind } from "../../data/types";
import { SpreadsheetOptions } from "../SpreadsheetVisualizer/types";
import { ICON_X } from "../icons";

export interface CellValuePopoverArgs {
  /** Column name, e.g. "stats". Becomes part of the popover title. */
  columnName: string;
  /** Complex kind for the label ("struct", "list", etc.). */
  kind: ComplexKind;
  /** The raw value (struct object, list array, etc.). */
  value: any;
  /** Spreadsheet options, used for number formatting consistency. */
  options: SpreadsheetOptions;
}

/**
 * A popover anchored above the status bar that renders a complex cell value
 * (STRUCT / LIST / MAP / JSON / UNION) as a key/value table with one level of
 * inline expansion. Nested objects/arrays collapse to compact previews at
 * this first level \u2014 enough to read stats outputs without deep drilling.
 *
 * Mirrors {@link MessagePopover} for positioning and dismissal (outside
 * click, Escape, close button).
 */
export class CellValuePopover {
  private container: HTMLElement;
  private element: HTMLDivElement;
  private isVisible = false;
  private currentArgs: CellValuePopoverArgs | null = null;
  private onUserDismiss?: () => void;

  private readonly onDocumentClick: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement, onUserDismiss?: () => void) {
    this.container = parent;
    this.onUserDismiss = onUserDismiss;
    this.element = document.createElement("div");
    this.element.className = "cell-value-popover";
    this.element.style.display = "none";
    this.element.addEventListener("mousedown", (e) => e.stopPropagation());
    this.container.appendChild(this.element);

    this.onDocumentClick = (e: MouseEvent) => {
      if (!this.isVisible) return;
      if (this.element.contains(e.target as Node)) return;
      // Ignore clicks on the triggering status-bar item \u2014 the item's own
      // click handler calls hide() explicitly so we don't double-toggle.
      const target = e.target as HTMLElement;
      if (target.closest?.(".status-bar__item")) return;
      this.dismissByUser();
    };

    this.onKeyDown = (e: KeyboardEvent) => {
      if (this.isVisible && e.key === "Escape") {
        e.stopPropagation();
        this.dismissByUser();
      }
    };
  }

  private dismissByUser(): void {
    this.onUserDismiss?.();
    this.hide();
  }

  public isOpen(): boolean {
    return this.isVisible;
  }

  public show(args: CellValuePopoverArgs): void {
    this.currentArgs = args;
    this.render(args);
    this.element.style.display = "block";
    this.isVisible = true;

    // Defer listener attachment so the click that opened us doesn't close us.
    setTimeout(() => {
      document.addEventListener("mousedown", this.onDocumentClick);
      document.addEventListener("keydown", this.onKeyDown);
    }, 0);
  }

  public hide(): void {
    if (!this.isVisible) return;
    this.element.style.display = "none";
    this.isVisible = false;
    this.currentArgs = null;
    document.removeEventListener("mousedown", this.onDocumentClick);
    document.removeEventListener("keydown", this.onKeyDown);
  }

  public destroy(): void {
    this.hide();
    this.element.remove();
  }

  private render(args: CellValuePopoverArgs): void {
    this.element.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.className = "cell-value-popover__header";

    const label = document.createElement("span");
    label.className = "cell-value-popover__label";
    label.textContent = `${args.columnName} \u00b7 ${args.kind} \u00b7 ${describeSize(args.value, args.kind)}`;
    header.appendChild(label);

    const close = document.createElement("button");
    close.className = "cell-value-popover__close";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = ICON_X; // static literal, no user data
    close.addEventListener("click", () => this.dismissByUser());
    header.appendChild(close);

    this.element.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "cell-value-popover__body";

    const table = document.createElement("table");
    table.className = "cell-value-popover__table";
    const tbody = document.createElement("tbody");

    const entries = asEntries(args.value);
    if (entries.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.className = "cell-value-popover__empty";
      cell.colSpan = 2;
      cell.textContent = Array.isArray(args.value) ? "(empty list)" : "(empty)";
      row.appendChild(cell);
      tbody.appendChild(row);
    } else {
      for (const [k, v] of entries) {
        const tr = document.createElement("tr");
        const keyCell = document.createElement("td");
        keyCell.className = "cell-value-popover__key";
        keyCell.textContent = String(k);
        const valCell = document.createElement("td");
        valCell.className = "cell-value-popover__value";
        valCell.textContent = renderInlineValue(v, args.options);
        tr.appendChild(keyCell);
        tr.appendChild(valCell);
        tbody.appendChild(tr);
      }
    }

    table.appendChild(tbody);
    body.appendChild(table);
    this.element.appendChild(body);

    // Footer
    const footer = document.createElement("div");
    footer.className = "cell-value-popover__footer";

    const copy = document.createElement("button");
    copy.className = "cell-value-popover__copy-btn";
    copy.textContent = "Copy as JSON";
    copy.title = "Copy the value as pretty-printed JSON";
    copy.addEventListener("click", async () => {
      if (!this.currentArgs) return;
      try {
        const text = JSON.stringify(
          this.currentArgs.value,
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        );
        await navigator.clipboard.writeText(text);
        const original = copy.textContent;
        copy.textContent = "Copied!";
        copy.classList.add("cell-value-popover__copy-btn--copied");
        setTimeout(() => {
          copy.textContent = original;
          copy.classList.remove("cell-value-popover__copy-btn--copied");
        }, 1500);
      } catch (err) {
        console.error("Failed to copy JSON to clipboard:", err);
      }
    });
    footer.appendChild(copy);
    this.element.appendChild(footer);
  }
}

function asEntries(value: any): Array<[string | number, any]> {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v, i) => [i, v] as [number, any]);
  if (typeof value === "object") return Object.entries(value);
  return [];
}

function describeSize(value: any, kind: ComplexKind): string {
  if (value == null) return "empty";
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  }
  if (typeof value === "object") {
    const n = Object.keys(value).length;
    const noun = kind === "map" ? "entries" : "fields";
    return `${n} ${n === 1 ? noun.slice(0, -1) : noun}`;
  }
  return "value";
}

/** Cached formatter for number rendering inside the popover. */
let popoverNumFmtCache: { opts: Intl.NumberFormatOptions; fmt: Intl.NumberFormat } | null = null;

function getPopoverNumberFormatter(options: SpreadsheetOptions): Intl.NumberFormat | null {
  const nfOpts = options.numberFormat;
  if (typeof nfOpts !== "object" || nfOpts === null) return null;
  if (popoverNumFmtCache && popoverNumFmtCache.opts === nfOpts) return popoverNumFmtCache.fmt;
  try {
    const fmt = new Intl.NumberFormat(undefined, nfOpts);
    popoverNumFmtCache = { opts: nfOpts, fmt };
    return fmt;
  } catch {
    return null;
  }
}

/**
 * Render a single value for a popover table cell. Top-level scalars get
 * their natural form; nested objects/arrays get a compact one-line preview
 * so the table stays scannable without recursive expansion.
 */
function renderInlineValue(value: any, options: SpreadsheetOptions): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return previewList(value, options);
  if (typeof value === "object") {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return "null";
      return value.toISOString().slice(0, 19).replace("T", " ");
    }
    return previewStruct(value as Record<string, any>, options);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!isFinite(value)) return String(value);
    const fmt = getPopoverNumberFormatter(options);
    return fmt ? fmt.format(value) : String(value);
  }
  if (typeof value === "string") return value; // keep strings bare in the table
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

const POPOVER_INLINE_MAX = 3;

function previewList(arr: any[], options: SpreadsheetOptions): string {
  if (arr.length === 0) return "[]";
  const shown = arr.slice(0, POPOVER_INLINE_MAX).map((v) => inlineScalar(v, options));
  const more = arr.length - shown.length;
  return more > 0 ? `[ ${shown.join(", ")}, \u2026 ${more} more ]` : `[ ${shown.join(", ")} ]`;
}

function previewStruct(obj: Record<string, any>, options: SpreadsheetOptions): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const shown = entries
    .slice(0, POPOVER_INLINE_MAX)
    .map(([k, v]) => `${k}: ${inlineScalar(v, options)}`);
  const more = entries.length - shown.length;
  return more > 0 ? `{ ${shown.join(", ")}, \u2026 ${more} more }` : `{ ${shown.join(", ")} }`;
}

function inlineScalar(value: any, options: SpreadsheetOptions): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[\u2026]";
  if (typeof value === "object") return value instanceof Date ? renderInlineValue(value, options) : "{\u2026}";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!isFinite(value)) return String(value);
    const fmt = getPopoverNumberFormatter(options);
    return fmt ? fmt.format(value) : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
