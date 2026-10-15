import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPanel } from "../ControlPanel";
import { environmentService } from "../../../data/environments/EnvironmentService";
import type { FileTreeNode } from "../../../data/FileTreeTypes";

function makePanel(overrides: Record<string, unknown> = {}): any {
  const panel: any = Object.create(ControlPanel.prototype);
  panel.fileTree = [];
  panel.datasets = [];
  panel.workspaceSaveSuspended = false;
  panel.pendingAutoImport = null;
  panel.renderTree = () => {};
  panel.expandSection = () => {};
  panel.treeRenderer = undefined;
  panel.onShowMessageCallback = vi.fn();
  panel.tabManager = {
    getDatasetIds: () => [],
    getActiveTabId: () => null,
    getBackend: () => undefined,
    addDataset: vi.fn(async () => {}),
    switchToDataset: vi.fn(async () => {}),
  };
  Object.assign(panel, overrides);
  return panel;
}

function file(id: string, name: string, extra: Partial<FileTreeNode> = {}): FileTreeNode {
  return { id, name, kind: "file", fileType: "csv", isImported: false, isExpanded: false, ...extra };
}

let envId: string;
beforeEach(() => {
  localStorage.clear();
  envId = environmentService.create({ name: "data", kind: "folder", folderHandleId: "ipc:C:/data" }).id;
  environmentService.setActive(envId);
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("restoreWorkspaceTabs", () => {
  it("reopens saved tabs in order, reusing silently imported tables, then activates the saved one", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isImported: true });
    const b = file("ipc/C:/data/b.csv", "b.csv");
    const opened: string[] = [];
    const panel = makePanel({
      fileTree: [a, b],
      datasets: [{ metadata: { name: "a" }, dataset: {}, isLoaded: true }],
      importNode: vi.fn(async (node: FileTreeNode) => {
        node.tableName = node.name.replace(".csv", "");
        opened.push(node.name);
        return { ok: true };
      }),
    });
    panel.tabManager.getDatasetIds = () => [];
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: [b.id, a.id], activeDataNodeId: a.id });
    expect(opened).toEqual(["b.csv"]);
    expect(panel.tabManager.addDataset).toHaveBeenCalledTimes(1);
    expect(panel.tabManager.switchToDataset).toHaveBeenLastCalledWith("a");
    expect(panel.onShowMessageCallback).not.toHaveBeenCalled();
  });

  it("waits for the folder auto-import before opening anything", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv");
    let resolveBatch!: () => void;
    const order: string[] = [];
    const panel = makePanel({
      fileTree: [a],
      pendingAutoImport: new Promise<void>((r) => { resolveBatch = () => { order.push("batch"); r(); }; }),
      importNode: vi.fn(async () => { order.push("open"); return { ok: true }; }),
    });
    const run = panel.restoreWorkspaceTabs(envId, { openDataNodeIds: [a.id] });
    resolveBatch();
    await run;
    expect(order).toEqual(["batch", "open"]);
  });

  it("enumerates a workbook's sheets before opening a saved sheet tab", async () => {
    const wb = file("ipc/C:/data/book.xlsx", "book.xlsx", { fileType: "xlsx" });
    const importNode = vi.fn(async (_node: FileTreeNode) => ({ ok: true }));
    const panel = makePanel({
      fileTree: [wb],
      importNode,
      handleTreeNodeExpand: vi.fn(async (node: FileTreeNode) => {
        node.children = [{ id: `${node.id}/Sheet1`, name: "Sheet1", kind: "sheet", sheetName: "Sheet1", fileType: "xlsx", isImported: false, isExpanded: false }];
      }),
    });
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: ["ipc/C:/data/book.xlsx/Sheet1"] });
    expect(panel.handleTreeNodeExpand).toHaveBeenCalledWith(wb);
    expect(importNode).toHaveBeenCalledTimes(1);
    expect(importNode.mock.calls[0][0].sheetName).toBe("Sheet1");
  });

  it("skips missing and failing files and reports them once", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv");
    const bad = file("ipc/C:/data/bad.csv", "bad.csv");
    const panel = makePanel({
      fileTree: [a, bad],
      importNode: vi.fn(async (node: FileTreeNode) =>
        node === bad ? { ok: false, error: { message: "boom" } } : { ok: true },
      ),
    });
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: ["ipc/C:/data/gone.csv", bad.id, a.id] });
    expect(bad.isUnavailable).toBe(true);
    expect(panel.onShowMessageCallback).toHaveBeenCalledTimes(1);
    expect(panel.onShowMessageCallback.mock.calls[0][0]).toBe("Restored 1 of 3 tabs. Missing: gone.csv, bad.csv");
    expect(panel.onShowMessageCallback.mock.calls[0][1]).toBe("warning");
  });

  it("ignores an active id that was not opened", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv");
    const panel = makePanel({ fileTree: [a], importNode: vi.fn(async () => ({ ok: true })) });
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: [a.id], activeDataNodeId: "ipc/C:/data/other.csv" });
    expect(panel.tabManager.switchToDataset).not.toHaveBeenCalled();
  });

  it("stops when the user switches environments mid-restore", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv");
    const b = file("ipc/C:/data/b.csv", "b.csv");
    const other = environmentService.create({ name: "other", kind: "folder", folderHandleId: "ipc:C:/other" });
    const panel = makePanel({
      fileTree: [a, b],
      importNode: vi.fn(async () => {
        environmentService.setActive(other.id);
        return { ok: true };
      }),
    });
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: [a.id, b.id] });
    expect(panel.importNode).toHaveBeenCalledTimes(1);
  });

  it("does nothing with an empty list", async () => {
    const panel = makePanel({ importNode: vi.fn() });
    await panel.restoreWorkspaceTabs(envId, { openDataNodeIds: [] });
    expect(panel.importNode).not.toHaveBeenCalled();
  });
});

describe("restorePickedFiles", () => {
  it("recreates tree nodes for picked single files on a host file source", () => {
    const env = environmentService.get(envId)!;
    environmentService.addDataset(envId, { nodeId: "ipc/file/C:/d/a.csv", name: "a.csv", relativePath: "a.csv" });
    environmentService.addDataset(envId, { nodeId: "ipc/C:/data/b.csv", name: "b.csv", relativePath: "b.csv" });
    const panel = makePanel({ fileSource: { id: "ipc" } });
    panel.restorePickedFiles(environmentService.get(env.id)!);
    expect(panel.fileTree.map((n: FileTreeNode) => [n.id, n.filePath, n.fileType])).toEqual([["ipc/file/C:/d/a.csv", "C:/d/a.csv", "csv"]]);
  });

  it("does nothing on the web file source", () => {
    environmentService.addDataset(envId, { nodeId: "ipc/file/C:/d/a.csv", name: "a.csv", relativePath: "a.csv" });
    const panel = makePanel({ fileSource: { id: "fsa" } });
    panel.restorePickedFiles(environmentService.get(envId)!);
    expect(panel.fileTree).toEqual([]);
  });
});

describe("applyActiveEnvironment guard", () => {
  function folderRoot(): FileTreeNode {
    return { id: "ipc/C:/data", name: "data", kind: "folder", children: [], isImported: false, isExpanded: true };
  }

  it("does not let the tab teardown overwrite the incoming environment's saved tabs", async () => {
    environmentService.setWorkspace(envId, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [], activeDataNodeId: "ipc/C:/data/a.csv" });
    const seen: string[][] = [];
    const panel = makePanel({
      tabManager: {
        getDatasetIds: () => ["old"],
        getActiveTabId: () => null,
        getBackend: () => undefined,
        closeDataset: () => { seen.push(environmentService.get(envId)!.workspace.openDataNodeIds); },
      },
      renderSavedQueries: () => {},
      restorePickedFiles: vi.fn(),
      restoreWorkspaceTabs: vi.fn(async (_id: string, saved: { openDataNodeIds: string[] }) => { seen.push(saved.openDataNodeIds); }),
    });
    // The folder re-acquire succeeds: it attaches the root node.
    panel.restoreIpcFolder = vi.fn(async () => { panel.fileTree.push(folderRoot()); });
    await panel.applyActiveEnvironment(envId);
    expect(seen).toEqual([["ipc/C:/data/a.csv"], ["ipc/C:/data/a.csv"]]);
    expect(panel.workspaceSaveSuspended).toBe(false);
  });

  it("leaves the saved list untouched when the folder could not be re-acquired", async () => {
    environmentService.setWorkspace(envId, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [], activeDataNodeId: "ipc/C:/data/a.csv" });
    const panel = makePanel({
      tabManager: { getDatasetIds: () => [], getActiveTabId: () => null, getBackend: () => undefined, closeDataset: () => {} },
      renderSavedQueries: () => {},
      restoreIpcFolder: vi.fn(async () => {}), // folder gone: nothing attached
      restorePickedFiles: vi.fn(),
      restoreWorkspaceTabs: vi.fn(async () => {}),
    });
    await panel.applyActiveEnvironment(envId);
    expect(panel.restoreWorkspaceTabs).not.toHaveBeenCalled();
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual(["ipc/C:/data/a.csv"]);
    expect(ws.activeDataNodeId).toBe("ipc/C:/data/a.csv");
    expect(panel.workspaceSaveSuspended).toBe(false);
  });
});
