import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPanel } from "../ControlPanel";
import { environmentService } from "../../../data/environments/EnvironmentService";
import type { FileTreeNode } from "../../../data/FileTreeTypes";

/** Prototype-driven panel, same approach as ControlPanel.import.test.ts. */
function makePanel(overrides: Record<string, unknown> = {}): any {
  const panel: any = Object.create(ControlPanel.prototype);
  panel.fileTree = [];
  panel.datasets = [];
  panel.workspaceSaveSuspended = false;
  panel.renderTree = () => {};
  panel.expandSection = () => {};
  panel.treeRenderer = undefined;
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

describe("persistDataWorkspace", () => {
  it("writes the open tabs in order and the active one into the active environment", () => {
    const panel = makePanel({
      fileTree: [file("ipc/C:/data/a.csv", "a.csv", { tableName: "a" }), file("ipc/C:/data/b.csv", "b.csv", { tableName: "b" })],
      tabManager: { getDatasetIds: () => ["b", "a"], getActiveTabId: () => "a" },
    });
    panel.persistDataWorkspace();
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual(["ipc/C:/data/b.csv", "ipc/C:/data/a.csv"]);
    expect(ws.activeDataNodeId).toBe("ipc/C:/data/a.csv");
  });

  it("keeps the query side of the workspace untouched", () => {
    environmentService.setWorkspace(envId, { openDataNodeIds: [], openQueryIds: ["q1"], activeTab: { kind: "query", id: "q1" } });
    const panel = makePanel({ fileTree: [file("ipc/C:/data/a.csv", "a.csv", { tableName: "a" })], tabManager: { getDatasetIds: () => ["a"], getActiveTabId: () => "a" } });
    panel.persistDataWorkspace();
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openQueryIds).toEqual(["q1"]);
    expect(ws.activeTab).toEqual({ kind: "query", id: "q1" });
  });

  it("clears a stale active id when the active tab is not restorable", () => {
    environmentService.setWorkspace(envId, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [], activeDataNodeId: "ipc/C:/data/a.csv" });
    const panel = makePanel({ fileTree: [file("drop/x.csv/1/ab", "x.csv", { tableName: "x" })], tabManager: { getDatasetIds: () => ["x"], getActiveTabId: () => "x" } });
    panel.persistDataWorkspace();
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([]);
    expect(ws.activeDataNodeId).toBeUndefined();
  });

  it("writes nothing while suspended", () => {
    environmentService.setWorkspace(envId, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [] });
    const panel = makePanel({ workspaceSaveSuspended: true, tabManager: { getDatasetIds: () => [], getActiveTabId: () => null } });
    panel.persistDataWorkspace();
    expect(environmentService.get(envId)!.workspace.openDataNodeIds).toEqual(["ipc/C:/data/a.csv"]);
  });

  it("records a tab closed through markDatasetAsUnloaded", () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isOpenAsTab: true });
    const panel = makePanel({ fileTree: [a], datasets: [{ metadata: { name: "a" }, dataset: {}, isLoaded: true }], tabManager: { getDatasetIds: () => [], getActiveTabId: () => null } });
    panel.markDatasetAsUnloaded("a");
    expect(a.isOpenAsTab).toBe(false);
    expect(environmentService.get(envId)!.workspace.openDataNodeIds).toEqual([]);
  });
});

describe("openNodeAsTab", () => {
  it("reuses the cached table of an imported node and records the open tab", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isImported: true });
    const dataset = {};
    const tabManager = {
      getDatasetIds: vi.fn(() => []),
      getActiveTabId: () => "a",
      addDataset: vi.fn(async () => {}),
      switchToDataset: vi.fn(async () => {}),
    };
    const panel = makePanel({ fileTree: [a], datasets: [{ metadata: { name: "a" }, dataset, isLoaded: true }], tabManager, importNode: vi.fn() });
    const result = await panel.openNodeAsTab(a);
    expect(result.ok).toBe(true);
    expect(tabManager.addDataset).toHaveBeenCalledTimes(1);
    expect(tabManager.switchToDataset).toHaveBeenCalledWith("a");
    expect(panel.importNode).not.toHaveBeenCalled();
    expect(a.isOpenAsTab).toBe(true);
  });

  it("imports a node that has no cached table", async () => {
    const b = file("ipc/C:/data/b.csv", "b.csv");
    const importNode = vi.fn(async () => ({ ok: true }));
    const panel = makePanel({ fileTree: [b], importNode });
    await panel.openNodeAsTab(b);
    expect(importNode).toHaveBeenCalledWith(b);
  });
});

describe("openFilePicker ids", () => {
  it("mints a stable id per path and reuses the node when the same file is picked again", async () => {
    const importNode = vi.fn(async () => ({ ok: true }));
    const panel = makePanel({
      fileImportService: { getSupportedExtensions: () => [".csv"] },
      fileSource: { id: "ipc", pickFiles: async () => [{ kind: "path", path: "C:/d/a.csv", name: "a.csv" }] },
      importNode,
    });
    await panel.openFilePicker();
    await panel.openFilePicker();
    expect(panel.fileTree.map((n: FileTreeNode) => n.id)).toEqual(["ipc/file/C:/d/a.csv"]);
    expect(importNode).toHaveBeenCalledTimes(2);
    expect(environmentService.get(envId)!.datasets.map((d) => d.nodeId)).toEqual(["ipc/file/C:/d/a.csv"]);
  });
});
