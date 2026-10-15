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
    environmentService.setWorkspace(envId, { openDataNodeIds: [a.id], openQueryIds: [], activeDataNodeId: a.id });
    const panel = makePanel({ fileTree: [a], datasets: [{ metadata: { name: "a" }, dataset: {}, isLoaded: true }], tabManager: { getDatasetIds: () => [], getActiveTabId: () => null } });
    panel.markDatasetAsUnloaded("a");
    expect(a.isOpenAsTab).toBe(false);
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([]);
    expect(ws.activeDataNodeId).toBeUndefined();
  });

  it("records a tab loaded through markDatasetAsLoaded", () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a" });
    const panel = makePanel({ fileTree: [a], tabManager: { getDatasetIds: () => ["a"], getActiveTabId: () => "a" } });
    panel.markDatasetAsLoaded("a");
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([a.id]);
    expect(ws.activeDataNodeId).toBe(a.id);
  });

  it("records a tab dropped through markDatasetAsDropped", () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isImported: true, isOpenAsTab: true });
    environmentService.setWorkspace(envId, { openDataNodeIds: [a.id], openQueryIds: [] });
    const panel = makePanel({ fileTree: [a], tabManager: { getDatasetIds: () => [], getActiveTabId: () => null } });
    panel.markDatasetAsDropped("a");
    // The node's tableName is cleared as part of the drop, so it no
    // longer maps to a restorable id — the stale [a.id] must be gone.
    expect(environmentService.get(envId)!.workspace.openDataNodeIds).toEqual([]);
  });

  it("clears the workspace when markAllAsUnloaded runs", () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isImported: true, isOpenAsTab: true });
    environmentService.setWorkspace(envId, { openDataNodeIds: [a.id], openQueryIds: [] });
    const panel = makePanel({ fileTree: [a], tabManager: { getDatasetIds: () => [], getActiveTabId: () => null } });
    panel.markAllAsUnloaded();
    expect(environmentService.get(envId)!.workspace.openDataNodeIds).toEqual([]);
  });

  it("runs persist after addDataset synthesizes a tree node", async () => {
    // The synthesized node gets a `dataset/`-prefixed id, which
    // deriveDataWorkspace never treats as restorable — so the only way
    // to tell persist ran is to seed a stale id first and see it wiped.
    environmentService.setWorkspace(envId, { openDataNodeIds: ["ipc/C:/data/old.csv"], openQueryIds: [] });
    const panel = makePanel({ tabManager: { getDatasetIds: () => ["t1"], getActiveTabId: () => "t1" } });
    const provider = { getMetadata: async () => ({ name: "t1", columns: [] }) };
    await panel.addDataset(provider);
    expect(environmentService.get(envId)!.workspace.openDataNodeIds).toEqual([]);
  });
});

describe("isDatasetRestorable", () => {
  it("is true for a folder node and false for a dropped file or an unknown name", () => {
    const panel = makePanel({
      fileTree: [
        file("ipc/C:/data/a.csv", "a.csv", { tableName: "a" }),
        file("drop/x.csv/1/ab", "x.csv", { tableName: "x" }),
      ],
    });
    expect(panel.isDatasetRestorable("a")).toBe(true);
    expect(panel.isDatasetRestorable("x")).toBe(false);
    expect(panel.isDatasetRestorable("result_1")).toBe(false);
  });
});

describe("openNodeAsTab", () => {
  it("reuses the cached table of an imported node and records the open tab", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", { tableName: "a", isImported: true });
    const dataset = {};
    // getDatasetIds must reflect the add once it happens, otherwise the
    // persistDataWorkspace call at the end of the reuse path can't be
    // told apart from a no-op: both would leave the tab out of the
    // derived workspace.
    const open: string[] = [];
    const tabManager = {
      getDatasetIds: vi.fn(() => open.slice()),
      getActiveTabId: () => "a",
      addDataset: vi.fn(async (metadata: { name: string }) => {
        open.push(metadata.name);
      }),
      switchToDataset: vi.fn(async () => {}),
    };
    const panel = makePanel({ fileTree: [a], datasets: [{ metadata: { name: "a" }, dataset, isLoaded: true }], tabManager, importNode: vi.fn() });
    const result = await panel.openNodeAsTab(a);
    expect(result.ok).toBe(true);
    expect(tabManager.addDataset).toHaveBeenCalledTimes(1);
    expect(tabManager.switchToDataset).toHaveBeenCalledWith("a");
    expect(panel.importNode).not.toHaveBeenCalled();
    expect(a.isOpenAsTab).toBe(true);
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([a.id]);
    expect(ws.activeDataNodeId).toBe(a.id);
  });

  it("imports a node that has no cached table", async () => {
    const b = file("ipc/C:/data/b.csv", "b.csv");
    const importNode = vi.fn(async () => ({ ok: true }));
    const panel = makePanel({ fileTree: [b], importNode });
    await panel.openNodeAsTab(b);
    expect(importNode).toHaveBeenCalledWith(b);
  });
});

describe("importNode persists the workspace", () => {
  it("records the newly opened tab (File branch)", async () => {
    const a = file("ipc/C:/data/a.csv", "a.csv", {
      fileHandle: new File(["a,b\n1,2"], "a.csv", { type: "text/csv" }),
    });
    const open: string[] = [];
    const tabManager = {
      getDatasetIds: () => open.slice(),
      getActiveTabId: () => "a",
      getBackend: () => undefined,
      addDataset: vi.fn(async (metadata: { name: string }) => {
        open.push(metadata.name);
      }),
      switchToDataset: vi.fn(async () => {}),
    };
    const panel = makePanel({
      fileTree: [a],
      tabManager,
      fileImportService: {
        importFile: async (_file: File, name: string) => ({ getMetadata: async () => ({ name }) }),
      },
    });
    const result = await panel.importNode(a);
    expect(result.ok).toBe(true);
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([a.id]);
    expect(ws.activeDataNodeId).toBe(a.id);
  });

  it("records the newly opened tab (host path)", async () => {
    const b = file("ipc/C:/data/b.csv", "b.csv", { filePath: "C:/data/b.csv", fileType: "csv" });
    const open: string[] = [];
    const tabManager = {
      getDatasetIds: () => open.slice(),
      getActiveTabId: () => "b",
      getBackend: () => undefined,
      addDataset: vi.fn(async (metadata: { name: string }) => {
        open.push(metadata.name);
      }),
      switchToDataset: vi.fn(async () => {}),
    };
    const panel = makePanel({
      fileTree: [b],
      tabManager,
      fileImportService: {
        importPath: async (_path: string, name: string) => ({ getMetadata: async () => ({ name }) }),
      },
    });
    const result = await panel.importNode(b);
    expect(result.ok).toBe(true);
    const ws = environmentService.get(envId)!.workspace;
    expect(ws.openDataNodeIds).toEqual([b.id]);
    expect(ws.activeDataNodeId).toBe(b.id);
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
