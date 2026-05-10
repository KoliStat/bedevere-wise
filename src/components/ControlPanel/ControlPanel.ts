import duckPng from "@/assets/duck.png?url";
import { DataProvider, DatasetMetadata } from "../../data/types";
import { PersistenceService, persistenceService } from "../../data/PersistenceService";
import { FileImportService } from "../../data/FileImportService";
import { FolderScanService } from "../../data/FolderScanService";
import { FileTreeNode, detectFileType } from "../../data/FileTreeTypes";
import { FileTreeRenderer, FileTreeCallbacks } from "./FileTreeRenderer";
import { TabManager } from "../TabManager";
import { BedevereAppMessageType } from "../BedevereApp/BedevereApp";
import type { MessageOptions } from "../StatusBar/StatusBar";

export type ShowMessageFn = (
  message: string,
  type: BedevereAppMessageType,
  options?: MessageOptions,
) => void;

function formatError(err: unknown): { message: string; details?: string } {
  if (err instanceof Error) {
    return { message: err.message, details: err.stack };
  }
  return { message: String(err) };
}

function stripExt(fileName: string): string {
  return fileName.replace(/\.[^/.]+$/, "");
}

export interface DatasetInfo {
  metadata: DatasetMetadata;
  dataset: DataProvider;
  isLoaded: boolean;
  type?: "table" | "view" | "query_result";
}

interface AccordionSection {
  id: string;
  title: string;
  isExpanded: boolean;
  headerElement: HTMLElement;
  bodyElement: HTMLElement;
}

export class ControlPanel {
  private container: HTMLElement;
  private panelElement: HTMLElement;
  private headerElement: HTMLElement;
  private contentElement: HTMLElement;
  private toggleButton: HTMLElement;
  private datasets: DatasetInfo[] = [];
  private tabManager: TabManager;
  private isMinimized: boolean = false;
  private panelWidth: number = 320;
  private onToggleCallback?: (isMinimized: boolean) => void;
  private onSelectCallback?: (dataset: DataProvider) => void;
  private persistenceService?: PersistenceService;
  private onOpenQueryCallback?: (sql: string) => void;
  private onAliasChangeCallback?: (tableName: string, alias: string) => void;
  private onShowMessageCallback?: ShowMessageFn;

  // File tree
  private fileImportService?: FileImportService;
  private folderScanService?: FolderScanService;
  private treeRenderer?: FileTreeRenderer;
  private fileTree: FileTreeNode[] = [];

  // Accordion
  private accordionSections: Map<string, AccordionSection> = new Map();
  private datasetListElement!: HTMLElement;
  private columnStatsContainer!: HTMLElement;
  private queriesListElement!: HTMLElement;

  // Resize
  private resizeHandle: HTMLElement;
  public isResizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private readonly onResizeMove: (e: MouseEvent) => void;
  private readonly onResizeEnd: (e: MouseEvent) => void;

  constructor(parent: HTMLElement, tabManager: TabManager) {
    this.tabManager = tabManager;

    // Bind resize handlers once
    this.onResizeMove = this.handleResizeMove.bind(this);
    this.onResizeEnd = this.handleResizeEnd.bind(this);

    // Create the main container
    this.container = document.createElement("div");
    this.container.className = "control-panel";

    // Create the panel element
    this.panelElement = document.createElement("div");
    this.panelElement.className = "control-panel__panel";
    this.panelElement.style.width = `${this.panelWidth}px`;

    // Create header with app name and minimize button
    this.headerElement = document.createElement("div");
    this.headerElement.className = "control-panel__header";

    const appTitle = document.createElement("span");
    appTitle.className = "control-panel__app-title";
    appTitle.innerHTML = `<img class="control-panel__app-icon" src="${duckPng}" alt="" /> Bedevere Wise`;

    this.toggleButton = document.createElement("button");
    this.toggleButton.className = "control-panel__toggle";
    this.toggleButton.innerHTML = "−";
    this.toggleButton.title = "Minimize panel";

    this.headerElement.appendChild(appTitle);
    this.headerElement.appendChild(this.toggleButton);

    // Create content area
    this.contentElement = document.createElement("div");
    this.contentElement.className = "control-panel__content";

    // Build accordion sections
    this.buildAccordion();

    // Resize handle
    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "control-panel__resize-handle";
    this.resizeHandle.addEventListener("mousedown", (e) => this.handleResizeStart(e));

    // Assemble the panel
    this.panelElement.appendChild(this.headerElement);
    this.panelElement.appendChild(this.contentElement);
    this.panelElement.appendChild(this.resizeHandle);
    this.container.appendChild(this.panelElement);

    parent.appendChild(this.container);

    this.toggleButton.addEventListener("click", () => this.toggleMinimize());
  }

  private buildAccordion(): void {
    // 1. DATASETS
    this.datasetListElement = document.createElement("div");
    this.datasetListElement.className = "control-panel__list";
    this.createAccordionSection("datasets", "Datasets", true, this.datasetListElement);

    // 2. COLUMN STATS
    this.columnStatsContainer = document.createElement("div");
    this.columnStatsContainer.className = "control-panel__column-stats";
    this.createAccordionSection("column-stats", "Column Stats", false, this.columnStatsContainer);

    // 3. SAVED QUERIES
    this.queriesListElement = document.createElement("div");
    this.createAccordionSection("saved-queries", "Saved Queries", false, this.queriesListElement);
  }

  private createAccordionSection(id: string, title: string, expanded: boolean, content: HTMLElement): void {
    const section = document.createElement("div");
    section.className = "control-panel__accordion-section";

    const header = document.createElement("div");
    header.className = "control-panel__accordion-header";

    const chevron = document.createElement("span");
    chevron.className = "control-panel__accordion-chevron";
    chevron.textContent = "▶";
    if (expanded) chevron.classList.add("control-panel__accordion-chevron--expanded");

    const titleEl = document.createElement("span");
    titleEl.className = "control-panel__accordion-title";
    titleEl.textContent = title;

    header.appendChild(chevron);
    header.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = "control-panel__accordion-body";
    if (expanded) body.classList.add("control-panel__accordion-body--expanded");
    body.appendChild(content);

    section.appendChild(header);
    section.appendChild(body);
    this.contentElement.appendChild(section);

    const sectionData: AccordionSection = { id, title, isExpanded: expanded, headerElement: header, bodyElement: body };
    this.accordionSections.set(id, sectionData);

    header.addEventListener("click", () => this.toggleSection(id));
  }

  public expandSection(id: string): void {
    const section = this.accordionSections.get(id);
    if (!section || section.isExpanded) return;
    section.isExpanded = true;
    section.bodyElement.classList.add("control-panel__accordion-body--expanded");
    section.headerElement.querySelector(".control-panel__accordion-chevron")?.classList.add("control-panel__accordion-chevron--expanded");
  }

  public collapseSection(id: string): void {
    const section = this.accordionSections.get(id);
    if (!section || !section.isExpanded) return;
    section.isExpanded = false;
    section.bodyElement.classList.remove("control-panel__accordion-body--expanded");
    section.headerElement.querySelector(".control-panel__accordion-chevron")?.classList.remove("control-panel__accordion-chevron--expanded");
  }

  public toggleSection(id: string): void {
    const section = this.accordionSections.get(id);
    if (!section) return;
    if (section.isExpanded) {
      this.collapseSection(id);
    } else {
      this.expandSection(id);
    }
  }

  // --- Column Stats Container ---

  public getColumnStatsContainer(): HTMLElement {
    return this.columnStatsContainer;
  }

  // --- Datasets ---

  public async addDataset(dataset: DataProvider): Promise<void> {
    const metadata = await dataset.getMetadata();

    const existing = this.datasets.find((d) => d.metadata.name === metadata.name);
    if (existing) return;

    this.datasets.push({ metadata, dataset, isLoaded: true });

    // If no tree node represents this dataset yet (e.g. programmatic add via
    // command palette or view materialization), synthesize one so the user
    // sees it in the panel.
    const alreadyTracked = this.findTreeNodeByTableName(metadata.name);
    if (!alreadyTracked) {
      this.fileTree.push({
        id: `dataset/${metadata.name}`,
        name: metadata.name,
        kind: "file",
        fileType: undefined,
        isImported: true,
        tableName: metadata.name,
        isExpanded: false,
      });
      this.renderTree();
    }
  }

  public markDatasetAsLoaded(name: string): void {
    const dataset = this.datasets.find((d) => d.metadata.name === name);
    if (dataset) {
      dataset.isLoaded = true;
    }
    const node = this.findTreeNodeByTableName(name);
    if (node) {
      node.isImported = true;
      this.treeRenderer?.updateNode(node.id, { isImported: true });
    }
  }

  public markDatasetAsUnloaded(name: string): void {
    const dataset = this.datasets.find((d) => d.metadata.name === name);
    if (dataset) {
      dataset.isLoaded = false;
    }
    // Reflect tab-closed state on the tree node too, so the panel no longer
    // shows the file as "open".
    const node = this.findTreeNodeByTableName(name);
    if (node) {
      node.isImported = false;
      this.treeRenderer?.updateNode(node.id, { isImported: false });
    }
  }

  private findTreeNodeByTableName(tableName: string): FileTreeNode | undefined {
    const walk = (nodes: FileTreeNode[]): FileTreeNode | undefined => {
      for (const n of nodes) {
        if (n.tableName === tableName) return n;
        if (n.children) {
          const found = walk(n.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(this.fileTree);
  }

  public getLoadedDatasets(): string[] {
    return this.datasets.filter((d) => d.isLoaded).map((d) => d.metadata.name);
  }

  public getAvailableDatasets(): DatasetInfo[] {
    return [...this.datasets];
  }

  /** Names of every importable leaf in the tree (file or sheet, imported or not). */
  public getAllFileTreeNames(): string[] {
    const names: string[] = [];
    const walk = (nodes: FileTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "file" || n.kind === "sheet") names.push(n.alias ?? n.name);
        if (n.children) walk(n.children);
      }
    };
    walk(this.fileTree);
    return names;
  }

  /**
   * Resolve a user-supplied name to a tree leaf and import it if needed,
   * then return its DuckDB table name. Returns null if no leaf matches.
   * `importNode` already calls TabManager.switchToDataset, so the caller
   * doesn't need to switch again on the import path.
   */
  public async openByName(name: string): Promise<string | null> {
    const walk = (nodes: FileTreeNode[]): FileTreeNode | null => {
      for (const n of nodes) {
        if ((n.kind === "file" || n.kind === "sheet") && (n.alias === name || n.name === name)) {
          return n;
        }
        if (n.children) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return null;
    };
    const node = walk(this.fileTree);
    if (!node) return null;
    if (node.isImported && node.tableName) return node.tableName;
    const result = await this.importNode(node);
    if (!result.ok) throw new Error(result.error.message);
    return node.tableName ?? null;
  }

  // --- File import & tree ---

  public setFileImportService(service: FileImportService): void {
    this.fileImportService = service;
    this.folderScanService = new FolderScanService(service);
  }

  public setOnAliasChangeCallback(callback: (tableName: string, alias: string) => void): void {
    this.onAliasChangeCallback = callback;
  }

  public async openFolderPicker(): Promise<void> {
    if (!this.folderScanService) return;

    let tree: FileTreeNode | null = null;

    if (this.folderScanService.supportsDirectoryPicker()) {
      const picked = await this.folderScanService.scanWithDirectoryPicker();
      if (picked) {
        tree = picked.tree;
        // Persist the handle for the recent-folders list. Best-effort —
        // a quota-exceeded or structured-clone failure shouldn't block
        // the import flow.
        persistenceService.pushRecentFolder(picked.handle).catch((e) => {
          console.warn("Recent folders: persist failed", e);
        });
      }
    } else {
      // Fallback: webkitdirectory input
      const input = document.createElement("input");
      input.type = "file";
      (input as any).webkitdirectory = true;
      input.style.display = "none";
      document.body.appendChild(input);

      tree = await new Promise<FileTreeNode | null>((resolve) => {
        input.addEventListener("change", () => {
          const result = input.files ? this.folderScanService!.scanFromFileList(input.files) : null;
          input.remove();
          resolve(result);
        });
        input.click();
      });
    }

    this.attachFolderTree(tree);
  }

  /** Re-open a folder picked earlier (recent-folders shortcut). */
  public async openRecentFolder(id: string): Promise<void> {
    const handle = await persistenceService.loadRecentFolderHandle(id);
    if (!handle) {
      this.onShowMessageCallback?.(
        "That folder is no longer accessible — re-pick it from Browse Folder.",
        "warning",
      );
      await persistenceService.removeRecentFolder(id);
      return;
    }
    try {
      // queryPermission first; only requestPermission if needed (avoids an
      // unnecessary browser prompt when access is still granted).
      const queried = await (handle as any).queryPermission?.({ mode: "read" }) ?? "granted";
      let granted = queried;
      if (granted !== "granted") {
        granted = await (handle as any).requestPermission?.({ mode: "read" });
      }
      if (granted !== "granted") {
        this.onShowMessageCallback?.(
          `Permission denied for "${handle.name}"`,
          "warning",
        );
        return;
      }
      const tree = await this.folderScanService!.scanFromHandle(handle);
      if (!tree) {
        this.onShowMessageCallback?.(
          `Couldn't read "${handle.name}" — folder may have been moved or deleted.`,
          "warning",
        );
        await persistenceService.removeRecentFolder(id);
        return;
      }
      // Touch the entry so it bumps to the top of the MRU.
      await persistenceService.pushRecentFolder(handle);
      this.attachFolderTree(tree);
    } catch (err) {
      console.error("openRecentFolder failed:", err);
      this.onShowMessageCallback?.(
        `Failed to re-open "${handle.name}"`,
        "error",
      );
    }
  }

  /** Common path for both fresh picks and recent re-opens: dedupe on
   *  matching id, otherwise push to the file tree. */
  private attachFolderTree(tree: FileTreeNode | null): void {
    if (!tree) return;
    const existingIdx = this.fileTree.findIndex((n) => n.id === tree.id);
    if (existingIdx >= 0) {
      const existing = this.fileTree[existingIdx];
      this.preserveImportedState(existing, tree);
      this.fileTree[existingIdx] = tree;
      this.renderTree();
      this.expandSection("datasets");
      this.onShowMessageCallback?.(
        `Refreshed folder "${tree.name}"`,
        "info",
      );
      return;
    }
    this.fileTree.push(tree);
    this.renderTree();
    this.expandSection("datasets");
  }

  /**
   * Copy `isImported` / `tableName` from the old tree's nodes onto the newly
   * scanned tree, keyed by node id. Ensures a re-browse doesn't reset the
   * "open" markers on files the user had already imported.
   */
  private preserveImportedState(oldTree: FileTreeNode, newTree: FileTreeNode): void {
    const oldStates = new Map<string, { isImported: boolean; tableName?: string }>();
    const collect = (n: FileTreeNode) => {
      if (n.isImported || n.tableName) {
        oldStates.set(n.id, { isImported: n.isImported, tableName: n.tableName });
      }
      n.children?.forEach(collect);
    };
    collect(oldTree);

    const apply = (n: FileTreeNode) => {
      const prev = oldStates.get(n.id);
      if (prev) {
        n.isImported = prev.isImported;
        n.tableName = prev.tableName;
      }
      n.children?.forEach(apply);
    };
    apply(newTree);
  }

  public addFileTreeNode(node: FileTreeNode): void {
    this.fileTree.push(node);
    this.renderTree();
  }

  /**
   * Add files from a drag-drop (or programmatic injection like the
   * "Load sample dataset" button). Each file becomes a top-level tree node,
   * mirroring how folder-scanned files look. If `autoImport` is true, every
   * non-Excel file is imported + opened immediately (preserves drop-to-open
   * UX); Excel files are never auto-imported because the user has to pick a
   * sheet first.
   */
  public async addFilesFromDrop(files: File[], autoImport: boolean = true): Promise<void> {
    const newNodes: FileTreeNode[] = [];
    for (const file of files) {
      const fileType = detectFileType(file.name) ?? undefined;
      const node: FileTreeNode = {
        id: `drop/${file.name}/${Date.now()}/${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        kind: "file",
        fileHandle: file,
        fileType,
        isImported: false,
        isExpanded: false,
      };
      this.fileTree.push(node);
      newNodes.push(node);
    }

    this.renderTree();
    this.expandSection("datasets");

    if (!autoImport) return;

    // Auto-import non-Excel files so dropping a CSV/Parquet still opens it
    // straight away. Excel files stay collapsed until the user picks a sheet.
    const importable = newNodes.filter((n) => n.fileType !== "xlsx" && n.fileType !== "xls");
    if (importable.length === 0) return;

    const errors: Array<{ name: string; message: string; details?: string }> = [];
    for (let i = 0; i < importable.length; i++) {
      const node = importable[i];
      const label = importable.length === 1
        ? `Loading ${node.name}\u2026`
        : `Loading ${i + 1}/${importable.length}: ${node.name}\u2026`;
      // Persistent progress line; each call replaces the previous one in the
      // status bar's single transient-message slot.
      this.onShowMessageCallback?.(label, "info", { duration: 0 });
      const result = await this.importNode(node);
      if (!result.ok) errors.push({ name: node.name, ...result.error });
    }

    this.emitBatchSummary(importable, errors);
  }

  /**
   * Emit the final toast for a completed batch import, replacing the last
   * in-progress "Loading i/N…" message. Success → 3 s auto-dismiss,
   * partial failure → 6 s warning with click-to-expand details, total
   * failure → 10 s error with details.
   */
  private emitBatchSummary(
    importable: FileTreeNode[],
    errors: Array<{ name: string; message: string; details?: string }>,
  ): void {
    if (!this.onShowMessageCallback) return;
    const total = importable.length;
    const failed = errors.length;
    const ok = total - failed;

    if (failed === 0) {
      const msg = total === 1 ? `Loaded ${importable[0].name}` : `Loaded ${total} files`;
      this.onShowMessageCallback(msg, "success");
      return;
    }

    const details = errors.map((e) => `${e.name}: ${e.message}${e.details ? "\n" + e.details : ""}`).join("\n\n");

    if (ok === 0) {
      const msg = total === 1 ? `Failed to load ${importable[0].name}: ${errors[0].message}` : `Failed to load ${total} files`;
      this.onShowMessageCallback(msg, "error", { details });
      return;
    }

    this.onShowMessageCallback(`Loaded ${ok}/${total} files \u2014 ${failed} failed`, "warning", { details });
  }

  private renderTree(): void {
    if (!this.treeRenderer) {
      const callbacks: FileTreeCallbacks = {
        onNodeClick: (node) => this.handleTreeNodeClick(node),
        onNodeExpand: (node) => this.handleTreeNodeExpand(node),
        onNodeContextMenu: (_node, _e) => { /* TODO: context menu */ },
        onAliasChange: (node, alias) => this.onAliasChangeCallback?.(node.alias || node.name, alias),
      };
      this.treeRenderer = new FileTreeRenderer(this.datasetListElement, callbacks);
    }

    this.treeRenderer.render(this.fileTree);
  }

  private async handleTreeNodeClick(node: FileTreeNode): Promise<void> {
    const isExcelFile =
      node.kind === "file" && (node.fileType === "xlsx" || node.fileType === "xls");

    // Folders and Excel files: row click toggles expand, same as chevron.
    // Excel files have sheets as children; clicking the file itself should
    // reveal them, not attempt to import the whole workbook.
    if (node.kind === "folder" || isExcelFile) {
      node.isExpanded = !node.isExpanded;
      this.treeRenderer?.updateNode(node.id, { isExpanded: node.isExpanded });
      if (node.isExpanded) {
        await this.handleTreeNodeExpand(node);
      }
      return;
    }

    if (node.isUnavailable) return;

    // Already-tracked node (we've imported this file before): re-select the
    // existing tab if open, or re-open the tab from cached DataProvider if the
    // user had closed it. Avoids a duplicate import and the "Component with id
    // X is already registered" error from a duplicate tab.
    if (node.tableName) {
      const existing = this.datasets.find((d) => d.metadata.name === node.tableName);
      if (existing) {
        const openTabs = this.tabManager.getDatasetIds();
        if (!openTabs.includes(existing.metadata.name)) {
          await this.tabManager.addDataset(existing.metadata, existing.dataset);
        }
        await this.tabManager.switchToDataset(existing.metadata.name);
        node.isImported = true;
        this.treeRenderer?.updateNode(node.id, { isImported: true });
        this.onSelectCallback?.(existing.dataset);
        return;
      }
    }

    // Show a persistent "Loading…" line immediately; it's replaced by the
    // success confirmation or the error toast below. This is the path taken
    // when a user clicks a dataset in the left-panel tree (including after
    // a folder scan), so the feedback covers folder-browsed imports too.
    this.onShowMessageCallback?.(`Loading ${node.name}\u2026`, "info", { duration: 0 });
    const result = await this.importNode(node);
    if (!result.ok) {
      this.onShowMessageCallback?.(
        `Failed to import ${node.name}: ${result.error.message}`,
        "error",
        { details: result.error.details },
      );
    } else {
      this.onShowMessageCallback?.(`Loaded ${node.name}`, "success");
    }
  }

  /**
   * Import a single file-tree node and open it as a tab. Returns success or
   * a structured error instead of firing a toast directly, so batch callers
   * can aggregate errors into a single summary. Caller is responsible for
   * short-circuiting folders / excel files / unavailable nodes / already-
   * imported nodes before calling this.
   */
  private async importNode(node: FileTreeNode): Promise<{ ok: true } | { ok: false; error: { message: string; details?: string } }> {
    if (!this.fileImportService) return { ok: false, error: { message: "File import service unavailable" } };

    try {
      let file: File;
      if (node.fileHandle instanceof File) {
        file = node.fileHandle;
      } else if (node.fileHandle && "getFile" in node.fileHandle) {
        file = await (node.fileHandle as FileSystemFileHandle).getFile();
      } else {
        return { ok: false, error: { message: "Node has no accessible file handle" } };
      }

      const baseName =
        node.kind === "sheet" && node.sheetName
          ? `${node.alias || stripExt((node.fileHandle as any)?.name || node.name)}__${node.sheetName}`
          : node.alias || stripExt(node.name);
      const tableName = baseName;
      const options = node.kind === "sheet" && node.sheetName ? { sheetName: node.sheetName } : undefined;
      const provider = await this.fileImportService.importFile(file, tableName, options);
      const metadata = await provider.getMetadata();

      node.isImported = true;
      node.tableName = metadata.name;
      this.treeRenderer?.updateNode(node.id, { isImported: true });

      this.datasets.push({ metadata, dataset: provider, isLoaded: true });

      await this.tabManager.addDataset(metadata, provider);
      await this.tabManager.switchToDataset(metadata.name);
      this.onSelectCallback?.(provider);
      return { ok: true };
    } catch (error) {
      console.error(`Failed to import ${node.name}:`, error);
      return { ok: false, error: formatError(error) };
    }
  }

  private async handleTreeNodeExpand(node: FileTreeNode): Promise<void> {
    // For Excel files: lazily enumerate sheets on first expand
    if (
      node.kind === "file" &&
      (node.fileType === "xlsx" || node.fileType === "xls") &&
      !node.children &&
      this.fileImportService
    ) {
      try {
        let file: File;
        if (node.fileHandle instanceof File) {
          file = node.fileHandle;
        } else if (node.fileHandle && "getFile" in node.fileHandle) {
          file = await (node.fileHandle as FileSystemFileHandle).getFile();
        } else {
          return;
        }

        const sheetNames = await this.fileImportService.getSheetNames(file);
        node.children = sheetNames.map((sheetName) => ({
          id: `${node.id}/${sheetName}`,
          name: sheetName,
          kind: "sheet" as const,
          fileHandle: node.fileHandle,
          fileType: node.fileType,
          sheetName,
          isImported: false,
          isExpanded: false,
        }));

        // Find depth from the DOM
        const el = this.datasetListElement.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
        const row = el?.querySelector(".file-tree__row") as HTMLElement;
        const depth = row ? Math.floor(parseInt(row.style.paddingLeft) / 16) : 0;
        this.treeRenderer?.appendChildren(node.id, node.children, depth);
      } catch (error) {
        console.error(`Failed to enumerate sheets for ${node.name}:`, error);
        const { message, details } = formatError(error);
        this.onShowMessageCallback?.(
          `Failed to read sheets for ${node.name}: ${message}`,
          "error",
          { details },
        );
      }
    }
  }

  // --- Panel state ---

  public setOnToggleCallback(callback: (isMinimized: boolean) => void): void {
    this.onToggleCallback = callback;
  }

  public setOnSelectCallback(callback: (dataset: DataProvider) => void): void {
    this.onSelectCallback = callback;
  }

  public setOnShowMessageCallback(callback: ShowMessageFn): void {
    this.onShowMessageCallback = callback;
  }

  public getIsMinimized(): boolean {
    return this.isMinimized;
  }

  public getWidth(): number {
    return this.isMinimized ? 48 : this.panelWidth;
  }

  public setWidth(width: number): void {
    this.panelWidth = Math.max(300, Math.min(600, width));
    if (!this.isMinimized) {
      this.panelElement.style.width = `${this.panelWidth}px`;
    }
  }

  public toggleMinimize(): void {
    this.isMinimized = !this.isMinimized;

    if (this.isMinimized) {
      this.panelElement.classList.add("control-panel__panel--minimized");
      this.panelElement.style.width = "48px";
      // Show the duck as the affordance to expand — clearer than a "+" and
      // matches the brand mark in the header when the panel is open.
      this.toggleButton.innerHTML =
        `<img class="control-panel__app-icon control-panel__toggle-icon" src="${duckPng}" alt="" />`;
      this.toggleButton.title = "Expand panel";
    } else {
      this.panelElement.classList.remove("control-panel__panel--minimized");
      this.panelElement.style.width = `${this.panelWidth}px`;
      this.toggleButton.innerHTML = "−";
      this.toggleButton.title = "Minimize panel";
    }

    this.onToggleCallback?.(this.isMinimized);
  }

  // --- Saved Queries ---

  public setPersistenceService(persistenceService: PersistenceService): void {
    this.persistenceService = persistenceService;
    this.renderSavedQueries();

    // Restore persisted panel width
    const settings = this.persistenceService.loadAppSettings();
    if (settings.panelWidth) {
      this.setWidth(settings.panelWidth);
    }
  }

  public setOnOpenQueryCallback(callback: (sql: string) => void): void {
    this.onOpenQueryCallback = callback;
  }

  public refreshSavedQueries(): void {
    this.renderSavedQueries();
  }

  // --- Resize ---

  private handleResizeStart(e: MouseEvent): void {
    e.preventDefault();
    this.isResizing = true;
    this.resizeStartX = e.clientX;
    this.resizeStartWidth = this.panelWidth;
    // Disable CSS transitions during drag for instant feedback
    this.panelElement.style.transition = "none";
    document.addEventListener("mousemove", this.onResizeMove);
    document.addEventListener("mouseup", this.onResizeEnd);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  private handleResizeMove(e: MouseEvent): void {
    if (!this.isResizing) return;
    const newWidth = this.resizeStartWidth + (e.clientX - this.resizeStartX);
    this.setWidth(newWidth);
    this.onToggleCallback?.(this.isMinimized);
  }

  private handleResizeEnd(_e: MouseEvent): void {
    if (!this.isResizing) return;
    this.isResizing = false;
    // Re-enable CSS transitions
    this.panelElement.style.transition = "";
    document.removeEventListener("mousemove", this.onResizeMove);
    document.removeEventListener("mouseup", this.onResizeEnd);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    // Persist width
    if (this.persistenceService) {
      const settings = this.persistenceService.loadAppSettings();
      settings.panelWidth = this.panelWidth;
      this.persistenceService.saveAppSettings(settings);
    }
  }

  // --- Destroy ---

  public destroy(): void {
    document.removeEventListener("mousemove", this.onResizeMove);
    document.removeEventListener("mouseup", this.onResizeEnd);
    this.container.remove();
  }

  // --- Renderers ---

  private renderSavedQueries(): void {
    if (!this.persistenceService) return;

    const queries = this.persistenceService.loadQueryBookmarks();
    this.queriesListElement.innerHTML = "";

    for (const query of queries) {
      const item = document.createElement("div");
      item.className = "control-panel__section-item";

      const name = document.createElement("span");
      name.className = "control-panel__section-item-name";
      name.textContent = query.name;
      name.title = query.sql;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "control-panel__section-item-delete";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Delete query";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.persistenceService!.deleteQueryBookmark(query.name);
        this.renderSavedQueries();
      });

      item.appendChild(name);
      item.appendChild(deleteBtn);

      item.addEventListener("click", () => {
        this.onOpenQueryCallback?.(query.sql);
      });

      this.queriesListElement.appendChild(item);
    }
  }

}
