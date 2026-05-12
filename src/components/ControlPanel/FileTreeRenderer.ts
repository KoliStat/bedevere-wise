import { FileTreeNode } from "../../data/FileTreeTypes";

export interface FileTreeCallbacks {
  onNodeClick: (node: FileTreeNode) => void;
  onNodeExpand: (node: FileTreeNode) => void;
  onNodeContextMenu: (node: FileTreeNode, e: MouseEvent) => void;
  onAliasChange: (node: FileTreeNode, alias: string) => void;
}

const FILE_ICONS: Record<string, string> = {
  folder: "📁",
  csv: "📄",
  tsv: "📄",
  json: "{}",
  parquet: "⬡",
  xlsx: "📊",
  xls: "📊",
  sas7bdat: "📈",
  xpt: "📈",
  sav: "📈",
  dta: "📈",
  sheet: "📋",
};

export class FileTreeRenderer {
  private container: HTMLElement;
  private searchInput: HTMLInputElement;
  private regexToggle: HTMLButtonElement;
  private treeContainer: HTMLElement;
  private callbacks: FileTreeCallbacks;
  // Raw query (lower-cased only in substring mode). Empty string =
  // "no filter, render everything with each node's natural isExpanded."
  private searchQuery: string = "";
  private searchUseRegex: boolean = false;
  // Cached roots so the search input can re-render without the caller.
  private lastRoots: FileTreeNode[] = [];

  constructor(container: HTMLElement, callbacks: FileTreeCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.container.innerHTML = "";

    const searchRow = document.createElement("div");
    searchRow.className = "file-tree__search-row";

    this.searchInput = document.createElement("input");
    this.searchInput.type = "search";
    this.searchInput.placeholder = "Filter files…";
    this.searchInput.className = "file-tree__search";
    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput.value;
      this.renderTree();
    });
    searchRow.appendChild(this.searchInput);

    this.regexToggle = document.createElement("button");
    this.regexToggle.type = "button";
    this.regexToggle.className = "file-tree__regex-toggle";
    this.regexToggle.textContent = ".*";
    this.regexToggle.title = "Substring match (case-insensitive). Click to switch.";
    this.regexToggle.addEventListener("click", () => {
      this.searchUseRegex = !this.searchUseRegex;
      this.regexToggle.classList.toggle("file-tree__regex-toggle--active", this.searchUseRegex);
      this.regexToggle.title = this.searchUseRegex
        ? "Regex match (case-insensitive). Click to switch."
        : "Substring match (case-insensitive). Click to switch.";
      this.searchInput.placeholder = this.searchUseRegex ? "Regex…" : "Filter files…";
      this.renderTree();
    });
    searchRow.appendChild(this.regexToggle);

    this.container.appendChild(searchRow);

    this.treeContainer = document.createElement("div");
    this.treeContainer.className = "file-tree__tree";
    this.container.appendChild(this.treeContainer);
  }

  public render(roots: FileTreeNode[]): void {
    this.lastRoots = roots;
    this.renderTree();
  }

  private renderTree(): void {
    this.treeContainer.innerHTML = "";
    // Without an active query the natural tree renders verbatim and
    // each node's stored `isExpanded` is honoured. With a query we
    // pre-walk to collect the matching set and force-expand ancestors.
    const matches = this.searchQuery ? this.collectMatches(this.lastRoots) : null;
    for (const root of this.lastRoots) {
      const el = this.renderNodeFiltered(root, 0, matches);
      if (el) this.treeContainer.appendChild(el);
    }
  }

  private matchNode(n: FileTreeNode): boolean {
    if (!this.searchQuery) return true;
    const name = n.alias || n.name;
    if (this.searchUseRegex) {
      // Invalid regex falls back to literal substring so the field
      // stays usable while the user is mid-typing (e.g. `[` without
      // a closing bracket). Mirrors ColumnStatsVisualizer.
      try {
        return new RegExp(this.searchQuery, "i").test(name);
      } catch {
        return name.toLowerCase().includes(this.searchQuery.toLowerCase());
      }
    }
    return name.toLowerCase().includes(this.searchQuery.toLowerCase());
  }

  /**
   * Returns the set of node IDs that should remain visible under the
   * current search: a node passes if it matches *or* if any descendant
   * matches (so parent folders stay visible as ancestors of matches).
   */
  private collectMatches(roots: FileTreeNode[]): Set<string> {
    const result = new Set<string>();
    const walk = (n: FileTreeNode): boolean => {
      const selfMatch = this.matchNode(n);
      let descendantMatch = false;
      if (n.children) {
        for (const child of n.children) {
          if (walk(child)) descendantMatch = true;
        }
      }
      if (selfMatch || descendantMatch) {
        result.add(n.id);
        return true;
      }
      return false;
    };
    for (const r of roots) walk(r);
    return result;
  }

  private renderNodeFiltered(
    n: FileTreeNode,
    depth: number,
    matches: Set<string> | null,
  ): HTMLElement | null {
    if (matches && !matches.has(n.id)) return null;
    // Force-expand nodes whose descendants matched so matches are
    // visible without the user having to click chevrons. The node's
    // own `isExpanded` is left untouched — clearing the search
    // restores whatever expand state was there before.
    const hasMatchingDescendant =
      matches !== null && (n.children?.some((c) => matches.has(c.id)) ?? false);
    const effectiveExpanded = hasMatchingDescendant || n.isExpanded;
    return this.renderNode(n, depth, effectiveExpanded, matches);
  }

  public updateNode(nodeId: string, updates: Partial<FileTreeNode>): void {
    const el = this.treeContainer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`) as HTMLElement;
    if (!el) return;

    if (updates.isImported !== undefined) {
      el.classList.toggle("file-tree__node--imported", updates.isImported);
    }
    if (updates.isExpanded !== undefined) {
      el.classList.toggle("file-tree__node--expanded", updates.isExpanded);
      const chevron = el.querySelector(".file-tree__chevron") as HTMLElement;
      if (chevron) {
        chevron.classList.toggle("file-tree__chevron--expanded", updates.isExpanded);
      }
      const children = el.querySelector(".file-tree__children") as HTMLElement;
      if (children) {
        children.style.display = updates.isExpanded ? "block" : "none";
      }
    }
    if (updates.alias !== undefined) {
      const nameEl = el.querySelector(".file-tree__name") as HTMLElement;
      if (nameEl) {
        nameEl.textContent = updates.alias || updates.name || "";
        if (updates.alias) {
          nameEl.title = `${updates.name} → ${updates.alias}`;
        }
      }
    }
  }

  public appendChildren(nodeId: string, children: FileTreeNode[], depth: number): void {
    const el = this.treeContainer.querySelector(`[data-node-id="${CSS.escape(nodeId)}"]`) as HTMLElement;
    if (!el) return;

    let childrenContainer = el.querySelector(".file-tree__children") as HTMLElement;
    if (!childrenContainer) {
      childrenContainer = document.createElement("div");
      childrenContainer.className = "file-tree__children";
      el.appendChild(childrenContainer);
    }

    childrenContainer.innerHTML = "";
    for (const child of children) {
      childrenContainer.appendChild(this.renderNode(child, depth + 1));
    }
    childrenContainer.style.display = "block";
  }

  private renderNode(
    node: FileTreeNode,
    depth: number,
    effectiveExpanded?: boolean,
    matches?: Set<string> | null,
  ): HTMLElement {
    const expanded = effectiveExpanded ?? node.isExpanded;
    const el = document.createElement("div");
    el.className = "file-tree__node";
    el.dataset.nodeId = node.id;

    if (node.isImported) el.classList.add("file-tree__node--imported");
    if (node.isUnavailable) el.classList.add("file-tree__node--unavailable");
    if (expanded) el.classList.add("file-tree__node--expanded");

    // Row
    const row = document.createElement("div");
    row.className = "file-tree__row";
    row.style.paddingLeft = `${depth * 16 + 8}px`;

    // Chevron (for expandable nodes): folders always expand; Excel workbooks
    // (kind === "file") expand to list their sheets. Sheet-kind children
    // inherit xlsx/xls fileType but are leaves — no chevron.
    const isExcelWorkbook =
      node.kind === "file" && (node.fileType === "xlsx" || node.fileType === "xls");
    const hasChildren = node.kind === "folder" || isExcelWorkbook;
    if (hasChildren) {
      const chevron = document.createElement("span");
      chevron.className = "file-tree__chevron";
      chevron.textContent = "▶";
      if (expanded) chevron.classList.add("file-tree__chevron--expanded");
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        node.isExpanded = !node.isExpanded;
        this.callbacks.onNodeExpand(node);
        this.updateNode(node.id, { isExpanded: node.isExpanded });
      });
      row.appendChild(chevron);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "file-tree__chevron-spacer";
      row.appendChild(spacer);
    }

    // Icon
    const icon = document.createElement("span");
    icon.className = "file-tree__icon";
    const iconKey = node.kind === "folder" ? "folder" : (node.kind === "sheet" ? "sheet" : (node.fileType || "csv"));
    icon.textContent = FILE_ICONS[iconKey] || "📄";
    row.appendChild(icon);

    // Name
    const name = document.createElement("span");
    name.className = "file-tree__name";
    name.textContent = node.alias || node.name;
    if (node.alias) {
      name.title = `${node.name} → ${node.alias}`;
    }
    if (node.isUnavailable) {
      name.title = `${node.name} — format not available (extension not loaded)`;
    }
    row.appendChild(name);

    // Click handler
    if (!node.isUnavailable) {
      row.addEventListener("click", () => this.callbacks.onNodeClick(node));
    }

    // Context menu
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.callbacks.onNodeContextMenu(node, e);
    });

    // Double-click to rename
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.startInlineEdit(name, node);
    });

    el.appendChild(row);

    // Children container
    if (node.children && node.children.length > 0) {
      const childrenContainer = document.createElement("div");
      childrenContainer.className = "file-tree__children";
      childrenContainer.style.display = expanded ? "block" : "none";

      for (const child of node.children) {
        // Under an active search, skip children that don't appear in
        // the match set so the rendered tree only shows the matches
        // plus their ancestors.
        if (matches && !matches.has(child.id)) continue;
        const childExpanded =
          matches !== null && matches !== undefined
            ? (child.children?.some((g) => matches.has(g.id)) ?? false) || child.isExpanded
            : child.isExpanded;
        childrenContainer.appendChild(
          this.renderNode(child, depth + 1, childExpanded, matches),
        );
      }
      el.appendChild(childrenContainer);
    }

    return el;
  }

  private startInlineEdit(nameEl: HTMLElement, node: FileTreeNode): void {
    const input = document.createElement("input");
    input.className = "file-tree__edit-input";
    input.value = node.alias || node.name;
    input.select();

    const originalText = nameEl.textContent || "";
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();

    const commit = () => {
      const newAlias = input.value.trim();
      input.remove();
      nameEl.textContent = newAlias || originalText;
      if (newAlias && newAlias !== node.name) {
        node.alias = newAlias;
        this.callbacks.onAliasChange(node, newAlias);
      } else {
        node.alias = undefined;
        nameEl.textContent = originalText;
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); input.remove(); nameEl.textContent = originalText; }
      e.stopPropagation(); // Don't let spreadsheet handle keys
    });
    input.addEventListener("blur", commit);
  }
}
