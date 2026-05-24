import duckPng from "@/assets/duck.png?url";
import { DataProvider, DatasetMetadata } from "../../data/types";
import { PersistenceService, persistenceService } from "../../data/PersistenceService";
import { FileImportService } from "../../data/FileImportService";
import { FolderScanService } from "../../data/FolderScanService";
import { FileTreeNode, detectFileType } from "../../data/FileTreeTypes";
import { MultipleHtmlTablesError } from "../../data/formats/htmlTables";
import { environmentService } from "../../data/environments/EnvironmentService";
import { HtmlPasteDialog } from "../HtmlPasteDialog/HtmlPasteDialog";
import { FileTreeRenderer, FileTreeCallbacks } from "./FileTreeRenderer";
import { TabManager } from "../TabManager/TabManager";
import { EnvironmentSwitcher } from "../EnvironmentSwitcher/EnvironmentSwitcher";
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

/** Extensions we'll happily treat as text without sniffing — covers
 *  the formats the import pipeline understands plus a few obvious
 *  text-y siblings the user might drop accidentally. */
const TEXT_EXTENSIONS = new Set([
  "txt", "csv", "tsv", "json", "html", "htm", "md", "log", "sql",
  "yml", "yaml", "xml", "ini", "conf",
]);

/** Reasonable heuristic for "is this a file we should show in a
 *  text view". A known text extension is a yes. Otherwise sniff a
 *  sample: a single NULL byte means binary; otherwise look at the
 *  density of non-printable chars (anything below 0x20 except tab /
 *  LF / CR). Mirrors the plan from v0.12 spec. */
function isLikelyText(file: File, sample: string): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  if (sample.length === 0) return false;
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) nonPrintable++;
  }
  return nonPrintable / sample.length < 0.05;
}

/** Read the first `maxBytes` of a file as UTF-8 for the binary-sniff.
 *  Returns null if the slice can't be decoded. */
async function readTextSample(file: File, maxBytes: number): Promise<string | null> {
  try {
    const slice = file.slice(0, Math.min(maxBytes, file.size));
    return await slice.text();
  } catch {
    return null;
  }
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
  private onOpenQueryCallback?: (queryId: string) => void;
  /** Tab-state for the inline-rename UI in Saved Queries. Single id at
   *  most — clicking on another row commits and switches focus. */
  private renamingQueryId: string | null = null;
  private onAliasChangeCallback?: (tableName: string, alias: string) => void;
  private onShowMessageCallback?: ShowMessageFn;

  // File tree
  private fileImportService?: FileImportService;
  private folderScanService?: FolderScanService;
  private treeRenderer?: FileTreeRenderer;
  private fileTree: FileTreeNode[] = [];

  // Environment switcher (top of the panel, above the accordion)
  private envSwitcher: EnvironmentSwitcher | null = null;
  // Watches the EnvironmentService for active-id changes so every
  // mutation source — switcher click, `.env switch` shell command,
  // initial page-reload restore — converges through a single
  // `applyActiveEnvironment` call. Without this, only the switcher
  // path applied the tab-close / folder-rescan side-effects.
  private envUnsubscribe?: () => void;
  private lastActiveEnvId: string | null = null;

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

    // Assemble the panel. The env switcher sits between the header
    // chrome and the accordion content so it reads as a workspace-
    // wide context selector for everything below it. The switcher
    // only mutates the active id via `environmentService.setActive`;
    // the actual "close tabs + re-scan folder" side-effects are
    // handled by the onChange subscription below, so the shell
    // `.env switch` command and the startup-restore path get the
    // same behaviour as the GUI without each having to remember to
    // fire it themselves.
    this.panelElement.appendChild(this.headerElement);
    this.envSwitcher = new EnvironmentSwitcher(this.panelElement);
    this.panelElement.appendChild(this.contentElement);
    this.panelElement.appendChild(this.resizeHandle);
    this.container.appendChild(this.panelElement);

    parent.appendChild(this.container);

    this.toggleButton.addEventListener("click", () => this.toggleMinimize());

    // Watch for active-env changes from any source (switcher click,
    // `.env switch`, programmatic `setActive`, env-creation flows that
    // activate the new env). The listener fires on every mutation —
    // we guard with `lastActiveEnvId` so unrelated changes (rename,
    // addQuery, …) don't trigger a needless re-scan.
    this.lastActiveEnvId = environmentService.getActiveId();
    this.envUnsubscribe = environmentService.onChange(() => {
      const nextId = environmentService.getActiveId();
      // Saved Queries lists the active env's queries — re-render on
      // every emit so add/delete/rename are reflected without waiting
      // for a switch.
      this.renderSavedQueries();
      if (nextId === this.lastActiveEnvId) return;
      this.lastActiveEnvId = nextId;
      if (nextId) {
        this.applyActiveEnvironment(nextId).catch((err) => {
          console.error("Apply active environment failed:", err);
        });
      }
    });
  }

  private buildAccordion(): void {
    // 1. COLUMN STATS
    this.columnStatsContainer = document.createElement("div");
    this.columnStatsContainer.className = "control-panel__column-stats";
    this.createAccordionSection("column-stats", "Column Stats", false, this.columnStatsContainer);

    // 2. DATASETS
    this.datasetListElement = document.createElement("div");
    this.datasetListElement.className = "control-panel__list";
    this.createAccordionSection("datasets", "Datasets", true, this.datasetListElement);

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
    let folderHandleId: string | undefined;

    if (this.folderScanService.supportsDirectoryPicker()) {
      const picked = await this.folderScanService.scanWithDirectoryPicker();
      if (picked) {
        tree = picked.tree;
        // Persist the handle for the recent-folders list AND so the
        // env-binding hook below has a stable id to look up by. Best-
        // effort — a quota-exceeded or structured-clone failure
        // shouldn't block the import flow; the env still gets created,
        // just without a handle binding (and so won't auto-reopen on
        // a fresh session).
        try {
          const entry = await persistenceService.pushRecentFolder(picked.handle);
          if (entry) folderHandleId = entry.id;
        } catch (e) {
          console.warn("Recent folders: persist failed", e);
        }
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

    this.attachFolderTree(tree, folderHandleId);
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
      this.attachFolderTree(tree, id);
    } catch (err) {
      console.error("openRecentFolder failed:", err);
      this.onShowMessageCallback?.(
        `Failed to re-open "${handle.name}"`,
        "error",
      );
    }
  }

  /** Common path for both fresh picks and recent re-opens: dedupe on
   *  matching id, otherwise push to the file tree. The optional
   *  `folderHandleId` (only set on the FSA-API branch) binds the
   *  folder to an environment so re-opening the same folder picks up
   *  where the user left off. */
  private attachFolderTree(tree: FileTreeNode | null, folderHandleId?: string): void {
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
    } else {
      this.fileTree.push(tree);
      this.renderTree();
      this.expandSection("datasets");
    }
    this.bindFolderToEnvironment(tree, folderHandleId);

    // Auto-import small files in the folder. Fire-and-forget — the
    // tree is already visible, so a slow import doesn't block the
    // user. Already-imported leaves (carried over by
    // `preserveImportedState`) are filtered out so a folder re-scan
    // doesn't redo work.
    const leaves = this.collectFileLeaves(tree).filter((n) => !n.isImported);
    if (leaves.length > 0) {
      this.autoImportBatch(leaves).catch((err) => {
        console.error("Folder auto-import failed:", err);
      });
    }
  }

  private collectFileLeaves(node: FileTreeNode): FileTreeNode[] {
    const out: FileTreeNode[] = [];
    const walk = (n: FileTreeNode): void => {
      if (n.kind === "file" && n.fileType) out.push(n);
      if (n.children) for (const c of n.children) walk(c);
    };
    walk(node);
    return out;
  }

  /**
   * Find or create the environment for a folder and make it active.
   * Match priority: by `folderHandleId` first (so re-opening the same
   * folder reuses the same env even if it was renamed); then by name
   * (covers webkitdirectory where there's no persistent handle id).
   * Falls through to `create` if nothing matched.
   */
  private bindFolderToEnvironment(tree: FileTreeNode, folderHandleId?: string): void {
    let env = folderHandleId ? environmentService.findByFolderHandleId(folderHandleId) : null;
    if (!env) {
      env = environmentService.list().find(
        (e) => e.kind === "folder" && !e.folderHandleId && e.name === tree.name,
      ) ?? null;
    }
    if (!env) {
      env = environmentService.create({
        name: tree.name,
        kind: "folder",
        folderHandleId,
      });
    } else if (folderHandleId && !env.folderHandleId) {
      // Upgrade an existing name-matched env (webkitdirectory) to a
      // handle-bound env when the FSA API becomes available. No
      // dedicated service method for this — the binding is just a
      // field on the env, and `create()` would lose the queries the
      // user has already saved.
      env.folderHandleId = folderHandleId;
    }
    if (environmentService.getActiveId() !== env.id) {
      environmentService.setActive(env.id);
    }
    this.collectLeavesIntoEnv(env.id, tree, "");
  }

  /**
   * Walk a freshly-attached tree and add every file leaf to the env's
   * dataset list. Idempotent — `addDataset` deduplicates by nodeId so
   * re-scans of the same folder don't multiply entries.
   */
  private collectLeavesIntoEnv(envId: string, node: FileTreeNode, pathPrefix: string): void {
    if (node.kind === "file" && node.fileType) {
      const relativePath = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
      environmentService.addDataset(envId, {
        nodeId: node.id,
        name: node.name,
        relativePath,
      });
    }
    if (node.children) {
      const nextPrefix = pathPrefix
        ? `${pathPrefix}/${node.name}`
        : (node.kind === "folder" ? node.name : "");
      for (const child of node.children) {
        this.collectLeavesIntoEnv(envId, child, nextPrefix);
      }
    }
  }

  /**
   * Apply the side-effects of "this env is now active" to the panel:
   * close every open dataset tab, clear the in-memory file tree, and
   * — for folder envs — re-acquire permission and re-scan the bound
   * directory so the tree reflects the env's contents. Default envs
   * land on an empty tree (their drops can't be re-acquired after a
   * reload; the env list still describes what was loaded).
   *
   * Invoked from a single subscriber to `environmentService.onChange`
   * (above) and from `restoreActiveEnvironment` on app boot. The
   * switcher / shell command / programmatic `setActive` paths all
   * converge here through the service emit.
   */
  private async applyActiveEnvironment(envId: string): Promise<void> {
    // Close every open dataset tab. The TabManager API works by name;
    // snapshot first so we don't mutate while iterating.
    const openIds = this.tabManager.getDatasetIds();
    for (const id of openIds) {
      this.tabManager.closeDataset(id);
    }

    // Reset the panel's in-memory state.
    this.fileTree = [];
    this.datasets = [];
    this.renderTree();
    this.renderSavedQueries();

    const env = environmentService.get(envId);
    if (!env) return;
    if (env.kind === "folder" && env.folderHandleId) {
      // Re-scan via the recent-folder pathway: it already handles
      // permission prompts and stale-handle cleanup.
      await this.openRecentFolder(env.folderHandleId);
    }
  }

  /**
   * Apply the currently-active env to the panel. Called by BedevereApp
   * once during boot (after all the panel callbacks have been wired)
   * so a folder env restored from the previous session actually has
   * its directory re-scanned — without this, the switcher label would
   * show the right env name but the dataset tree would stay empty.
   * After boot, the onChange subscription keeps things in sync.
   */
  public async restoreActiveEnvironment(): Promise<void> {
    const activeId = environmentService.getActiveId();
    if (!activeId) return;
    this.lastActiveEnvId = activeId;
    await this.applyActiveEnvironment(activeId);
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
        size: file.size,
      };
      this.fileTree.push(node);
      newNodes.push(node);
    }

    // Record the dropped files in whichever environment is currently
    // active (default for fresh sessions, the folder env if the user
    // dropped onto an open folder workspace). The env stores name +
    // relative path so a future "reopen workspace" can show what was
    // loaded — even though dropped File objects can't be re-acquired
    // after a reload (no FSA handle).
    const activeEnvId = environmentService.getActiveId();
    if (activeEnvId) {
      for (const node of newNodes) {
        environmentService.addDataset(activeEnvId, {
          nodeId: node.id,
          name: node.name,
          relativePath: node.name,
        });
      }
    }

    this.renderTree();
    this.expandSection("datasets");

    if (!autoImport) return;
    await this.autoImportBatch(newNodes);
  }

  /**
   * Size-aware silent-import for a batch of file nodes (drop or
   * folder scan). Behaviour per node:
   *
   * - Excel (`xlsx` / `xls`): always user-driven (needs the sheet
   *   picker). Skipped entirely.
   * - `size` known and over `autoImportSizeThreshold` (or unknown
   *   size, treated as over): skipped. The tree shows a warning glyph
   *   and the user clicks-to-open via the existing import path.
   * - Else: silent import \u2014 DuckDB table registered, dataset added to
   *   the in-memory list, but no spreadsheet tab is opened.
   *
   * Threshold of `0` disables auto-import entirely. The threshold
   * comes from AppSettings (Settings tab \u2192 Import \u2192 "Auto-import
   * threshold"); defaults to 100 KB.
   */
  private async autoImportBatch(nodes: FileTreeNode[]): Promise<void> {
    const threshold = persistenceService.loadAppSettings().autoImportSizeThreshold ?? 102_400;
    const importable = nodes.filter((n) => {
      if (n.fileType === "xlsx" || n.fileType === "xls") return false;
      if (threshold === 0) return false;
      // Files with no known size (unusual \u2014 only happens for
      // drag-and-drop where `file.size` was 0 or for synthetic nodes)
      // are conservatively skipped so they go through the explicit
      // user-click path.
      if (n.size === undefined) return false;
      return n.size <= threshold;
    });
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
      const result = await this.importNode(node, { silent: true });
      if (!result.ok) errors.push({ name: node.name, ...result.error });
    }

    // Re-render so the now-imported nodes show the imported-tick state.
    this.renderTree();
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
        onAliasChange: (node, alias) => this.onAliasChangeCallback?.(node.alias || node.name, alias),
      };
      this.treeRenderer = new FileTreeRenderer(this.datasetListElement, callbacks);
    }

    // Re-apply the threshold on every render — cheap, and ensures
    // a Settings-tab change shows up next time the tree refreshes
    // without needing a dedicated listener.
    const threshold = persistenceService.loadAppSettings().autoImportSizeThreshold ?? 102_400;
    this.treeRenderer.setAutoImportThreshold(threshold);
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
  private async importNode(
    node: FileTreeNode,
    options: { silent?: boolean } = {},
  ): Promise<{ ok: true } | { ok: false; error: { message: string; details?: string } }> {
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
      const importOpts = node.kind === "sheet" && node.sheetName ? { sheetName: node.sheetName } : undefined;

      let provider;
      try {
        provider = await this.fileImportService.importFile(file, tableName, importOpts);
      } catch (importErr) {
        if (importErr instanceof MultipleHtmlTablesError) {
          // Multi-table HTML — defer to the picker so the user chooses
          // which table to ingest. The picker hands us a CSV string,
          // which we route back through the import pipeline as a
          // synthetic .csv file so the rest of the flow (provider
          // construction, TabManager wiring, persistence) stays
          // unchanged. The picker is interactive, so even silent
          // imports surface it — there's no sensible silent fallback.
          const picked = await HtmlPasteDialog.showAsync({
            title: `Pick a table — ${importErr.sourceName}`,
            initialTables: importErr.tables,
            defaultName: tableName,
          });
          if (!picked) {
            return { ok: false, error: { message: "Cancelled — no table picked." } };
          }
          const csvFile = new File([picked.csvText], `${picked.name}.csv`, { type: "text/csv" });
          provider = await this.fileImportService.importFile(csvFile, picked.name);
        } else {
          throw importErr;
        }
      }

      const metadata = await provider.getMetadata();

      node.isImported = true;
      node.tableName = metadata.name;
      this.treeRenderer?.updateNode(node.id, { isImported: true });

      this.datasets.push({ metadata, dataset: provider, isLoaded: true });

      if (!options.silent) {
        await this.tabManager.addDataset(metadata, provider);
        await this.tabManager.switchToDataset(metadata.name);
        this.onSelectCallback?.(provider);
      }
      return { ok: true };
    } catch (error) {
      // Log + return structured error: the batch caller
      // (`addFilesFromDrop`) aggregates these into a single user-facing
      // summary toast, so we don't surface here. Console log is for
      // debug/dev visibility into the underlying DuckDB / fetch / I-O
      // failure.
      console.error(`Failed to import ${node.name}:`, error);
      const formatted = formatError(error);

      // Failed-import → text-tab fallback. Only for non-silent imports
      // (silent imports must stay silent — opening a tab from a folder
      // scan would be jarring). The file is opened read-only with the
      // import error as a banner so the user can see what tripped the
      // parser. Binary files fall through to the existing error toast.
      if (!options.silent && node.fileHandle) {
        try {
          const file =
            node.fileHandle instanceof File
              ? node.fileHandle
              : await (node.fileHandle as FileSystemFileHandle).getFile();
          const sample = await readTextSample(file, 4096);
          if (sample !== null && isLikelyText(file, sample)) {
            const full = await file.text();
            this.tabManager.addTextTab(node.name, full, formatted.message);
            // User has a visible result; the batch summary doesn't
            // need to count this as an error.
            return { ok: true };
          }
        } catch (fallbackErr) {
          console.warn(`Text-tab fallback failed for ${node.name}:`, fallbackErr);
        }
      }

      return { ok: false, error: formatted };
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
        // Two-channel surfacing: console.error for debug visibility of
        // the underlying read failure, plus a user-facing toast so the
        // user knows the expand action didn't silently succeed. Caught
        // here (not propagated) because expand is a UI affordance —
        // there's no caller waiting on a Promise that needs to know.
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

  public setOnOpenQueryCallback(callback: (queryId: string) => void): void {
    this.onOpenQueryCallback = callback;
  }

  /** Re-render the file tree. Called by BedevereApp after the Settings
   *  tab changes the auto-import threshold so warning glyphs update
   *  immediately. */
  public refreshTree(): void {
    this.renderTree();
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
    this.envUnsubscribe?.();
    this.envUnsubscribe = undefined;
    this.envSwitcher?.destroy();
    this.envSwitcher = null;
    this.container.remove();
  }

  // --- Renderers ---

  private renderSavedQueries(): void {
    const env = environmentService.getActive();
    this.queriesListElement.innerHTML = "";
    if (!env) return;

    // Sort: most recently updated first, falls back to created.
    const queries = env.queries.slice().sort(
      (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
    );

    for (const query of queries) {
      this.queriesListElement.appendChild(this.buildSavedQueryRow(env.id, query));
    }
  }

  private buildSavedQueryRow(
    envId: string,
    query: { id: string; name: string; sql: string },
  ): HTMLElement {
    const item = document.createElement("div");
    item.className = "control-panel__section-item";
    item.dataset.queryId = query.id;

    if (this.renamingQueryId === query.id) {
      this.fillRenamingRow(item, envId, query);
    } else {
      this.fillNormalRow(item, envId, query);
    }
    return item;
  }

  private fillNormalRow(
    item: HTMLElement,
    envId: string,
    query: { id: string; name: string; sql: string },
  ): void {
    const name = document.createElement("span");
    name.className = "control-panel__section-item-name";
    name.textContent = query.name;
    name.title = query.sql || query.name;
    // Double-click on the name → inline rename. Click stops propagation
    // so the row's click handler (open in editor) doesn't fire too.
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this.renamingQueryId = query.id;
      this.renderSavedQueries();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "control-panel__section-item-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "Delete query";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      environmentService.deleteQuery(envId, query.id);
      // Service emit re-renders us via the onChange subscription.
    });

    item.appendChild(name);
    item.appendChild(deleteBtn);

    item.addEventListener("click", () => {
      this.onOpenQueryCallback?.(query.id);
    });
  }

  private fillRenamingRow(
    item: HTMLElement,
    envId: string,
    query: { id: string; name: string },
  ): void {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "control-panel__section-item-rename";
    input.value = query.name;
    input.spellcheck = false;

    const commit = (apply: boolean): void => {
      if (this.renamingQueryId !== query.id) return;
      const next = input.value.trim();
      this.renamingQueryId = null;
      if (apply && next && next !== query.name) {
        environmentService.updateQuery(envId, query.id, { name: next });
        // Service emit triggers re-render.
      } else {
        this.renderSavedQueries();
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

    item.appendChild(input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

}
