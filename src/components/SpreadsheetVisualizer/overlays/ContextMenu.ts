export interface ContextMenuItem {
  /** Visible label. Ignored when `separator` is true. */
  label?: string;
  /** Optional right-aligned shortcut hint (e.g. "Ctrl+C"). */
  shortcut?: string;
  /** Greys out the row and skips the click handler. */
  disabled?: boolean;
  /** Renders a horizontal divider instead of an interactive row. */
  separator?: boolean;
  /** Fired when the row is activated. The menu dismisses first, then runs. */
  action?: () => void | Promise<void>;
}

export interface ContextMenuArgs {
  /** Viewport (clientX) coordinate of the right-click event. */
  x: number;
  /** Viewport (clientY) coordinate of the right-click event. */
  y: number;
  /** Items in render order. Consecutive separators are collapsed. */
  items: ContextMenuItem[];
}

/**
 * Lightweight DOM popover for the spreadsheet's right-click menu.
 * Mounts under `document.body` so it floats above the canvas without
 * needing to live inside the visualizer's scroll container. Dismisses
 * on outside click, Escape, or after an item runs.
 *
 * Singleton — `show()` destroys any existing menu before opening the
 * new one, so two visualizers can't end up showing menus at once.
 */
export class ContextMenu {
  private static active: ContextMenu | null = null;

  private element: HTMLDivElement;
  private readonly onDocumentMouseDown: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onWindowResize: () => void;

  public static show(args: ContextMenuArgs): ContextMenu {
    ContextMenu.active?.dismiss();
    const menu = new ContextMenu(args);
    ContextMenu.active = menu;
    return menu;
  }

  public static dismissActive(): void {
    ContextMenu.active?.dismiss();
  }

  private constructor(args: ContextMenuArgs) {
    this.element = document.createElement("div");
    this.element.className = "context-menu";
    this.element.setAttribute("role", "menu");
    this.element.addEventListener("mousedown", (e) => e.stopPropagation());
    this.element.addEventListener("contextmenu", (e) => e.preventDefault());

    // Collapse leading / trailing / consecutive separators so the
    // caller can build items lists conditionally without worrying
    // about producing two dividers in a row.
    const items = compactSeparators(args.items);

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu__separator";
        this.element.appendChild(sep);
        continue;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "context-menu__item";
      row.setAttribute("role", "menuitem");
      if (item.disabled) {
        row.classList.add("context-menu__item--disabled");
        row.disabled = true;
      }

      const label = document.createElement("span");
      label.className = "context-menu__label";
      label.textContent = item.label ?? "";
      row.appendChild(label);

      if (item.shortcut) {
        const shortcut = document.createElement("span");
        shortcut.className = "context-menu__shortcut";
        shortcut.textContent = item.shortcut;
        row.appendChild(shortcut);
      }

      row.addEventListener("click", async () => {
        if (item.disabled || !item.action) {
          this.dismiss();
          return;
        }
        // Dismiss before running so the action sees a clean DOM —
        // some actions (e.g. opening a dialog) want to take focus,
        // and a stale menu would compete for outside-click handling.
        this.dismiss();
        try {
          await item.action();
        } catch (err) {
          console.error("ContextMenu action threw:", err);
        }
      });

      this.element.appendChild(row);
    }

    document.body.appendChild(this.element);
    this.positionAt(args.x, args.y);

    this.onDocumentMouseDown = (e: MouseEvent) => {
      if (this.element.contains(e.target as Node)) return;
      this.dismiss();
    };
    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss();
      }
    };
    this.onWindowResize = () => this.dismiss();

    // Defer listener attachment so the mousedown that opened us
    // doesn't immediately close us.
    setTimeout(() => {
      document.addEventListener("mousedown", this.onDocumentMouseDown, true);
      document.addEventListener("keydown", this.onKeyDown, true);
      window.addEventListener("resize", this.onWindowResize);
    }, 0);
  }

  private positionAt(x: number, y: number): void {
    // Place at (x, y), then flip across the cursor if the menu would
    // overflow the viewport. Browsers cap clientWidth/Height at the
    // viewport; the menu has already been measured because it's in
    // the DOM by this point.
    const margin = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    let left = x;
    let top = y;
    if (left + w + margin > vw) left = Math.max(margin, x - w);
    if (top + h + margin > vh) top = Math.max(margin, y - h);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }

  private dismiss(): void {
    document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("resize", this.onWindowResize);
    this.element.remove();
    if (ContextMenu.active === this) ContextMenu.active = null;
  }
}

function compactSeparators(items: ContextMenuItem[]): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length === 0 || out[out.length - 1].separator) continue;
      out.push(item);
    } else {
      out.push(item);
    }
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}
