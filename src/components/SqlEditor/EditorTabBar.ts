/**
 * Tab strip rendered above the CodeMirror view. Pure UI — receives a
 * list of tab descriptors + the active id, fires callbacks for user
 * actions. Doesn't know about EnvironmentService or queries; the
 * SqlEditor wires those.
 *
 * Mounts its own DOM into a parent the SqlEditor provides. One row
 * of tabs scrolls horizontally when overflowing (rather than wrapping
 * — wrap-to-second-row would shove the editor down by an unpredictable
 * amount). Last visible element is a "+" button for opening a new
 * untitled query.
 */

export interface EditorTabDescriptor {
  /** Stable id (matches `EnvironmentQuery.id` in the SqlEditor's caller). */
  id: string;
  /** User-facing label; updates trigger a re-render if it changed. */
  name: string;
}

export interface EditorTabBarOptions {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, newName: string) => void;
  onNew: () => void;
}

export class EditorTabBar {
  private root: HTMLDivElement;
  private tabsScroll: HTMLDivElement;
  private newBtn: HTMLButtonElement;
  private tabs: EditorTabDescriptor[] = [];
  private activeId: string | null = null;
  private renamingId: string | null = null;
  private readonly options: EditorTabBarOptions;

  constructor(parent: HTMLElement, options: EditorTabBarOptions) {
    this.options = options;

    this.root = document.createElement("div");
    this.root.className = "editor-tab-bar";

    this.tabsScroll = document.createElement("div");
    this.tabsScroll.className = "editor-tab-bar__tabs";
    this.root.appendChild(this.tabsScroll);

    this.newBtn = document.createElement("button");
    this.newBtn.type = "button";
    this.newBtn.className = "editor-tab-bar__new";
    this.newBtn.textContent = "+";
    this.newBtn.title = "New query";
    this.newBtn.setAttribute("aria-label", "New query");
    this.newBtn.addEventListener("click", () => this.options.onNew());
    this.root.appendChild(this.newBtn);

    parent.appendChild(this.root);
  }

  public setTabs(tabs: EditorTabDescriptor[], activeId: string | null): void {
    this.tabs = tabs.slice();
    this.activeId = activeId;
    // If the renaming tab is no longer present, drop the rename mode.
    if (this.renamingId && !this.tabs.some((t) => t.id === this.renamingId)) {
      this.renamingId = null;
    }
    this.render();
  }

  public destroy(): void {
    this.root.remove();
  }

  // ---- Render --------------------------------------------------------

  private render(): void {
    this.tabsScroll.innerHTML = "";
    for (const tab of this.tabs) {
      this.tabsScroll.appendChild(this.buildTab(tab));
    }
    // Scroll the active tab into view so it stays visible after a
    // switch from the keyboard / shell.
    if (this.activeId !== null) {
      const activeEl = this.tabsScroll.querySelector(
        `[data-tab-id="${cssEscape(this.activeId)}"]`,
      ) as HTMLElement | null;
      activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private buildTab(tab: EditorTabDescriptor): HTMLElement {
    const el = document.createElement("div");
    el.className = "editor-tab-bar__tab";
    if (tab.id === this.activeId) el.classList.add("editor-tab-bar__tab--active");
    el.dataset.tabId = tab.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", tab.id === this.activeId ? "true" : "false");

    if (this.renamingId === tab.id) {
      this.fillRenameTab(el, tab);
    } else {
      this.fillNormalTab(el, tab);
    }
    return el;
  }

  private fillNormalTab(el: HTMLElement, tab: EditorTabDescriptor): void {
    const name = document.createElement("span");
    name.className = "editor-tab-bar__name";
    name.textContent = tab.name;
    name.title = tab.name;
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      this.options.onSelect(tab.id);
    });
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.renamingId = tab.id;
      this.render();
    });
    el.appendChild(name);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "editor-tab-bar__close";
    close.setAttribute("aria-label", `Close ${tab.name}`);
    close.title = "Close";
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.options.onClose(tab.id);
    });
    el.appendChild(close);
  }

  private fillRenameTab(el: HTMLElement, tab: EditorTabDescriptor): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "editor-tab-bar__rename-input";
    input.value = tab.name;
    input.spellcheck = false;

    const commit = (apply: boolean): void => {
      if (this.renamingId !== tab.id) return;
      const next = input.value.trim();
      this.renamingId = null;
      if (apply && next && next !== tab.name) {
        this.options.onRename(tab.id, next);
        // Re-render driven by the caller's onChange listener; defensive
        // re-render here too in case the caller's update is async.
        this.render();
      } else {
        this.render();
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        commit(false);
      }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());

    el.appendChild(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }
}

/**
 * CSS.escape isn't universally available in TS lib targets; the
 * fallback is enough for our id format (`q_<uuid>`) which is already
 * safe for selectors. Kept defensive so a future id format with
 * unusual characters doesn't crash the scrollIntoView lookup.
 */
function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
