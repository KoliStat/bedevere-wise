import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPanel } from "../ControlPanel";
import { environmentService } from "../../../data/environments/EnvironmentService";
import type { FileTreeNode } from "../../../data/FileTreeTypes";

/**
 * These tests drive two private ControlPanel methods on a hand-built
 * `this` (via the prototype) instead of a fully constructed panel —
 * the constructor needs a live TabManager and a DOM tree that would
 * dwarf the behavior under test. Stubbed members are the ones the
 * methods actually touch; everything else stays real, including
 * `environmentService` (backed by jsdom localStorage).
 */

function makePanel(overrides: Record<string, unknown> = {}): any {
  const panel: any = Object.create(ControlPanel.prototype);
  panel.fileTree = [];
  panel.datasets = [];
  panel.renderTree = () => {};
  panel.expandSection = () => {};
  panel.tabManager = { getBackend: () => undefined };
  Object.assign(panel, overrides);
  return panel;
}

function fileNode(name: string, overrides: Partial<FileTreeNode> = {}): FileTreeNode {
  return {
    id: `test/${name}/${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind: "file",
    fileType: "csv",
    fileHandle: new File(["a,b\n1,2"], name, { type: "text/csv" }),
    isImported: false,
    isExpanded: false,
    size: 10,
    ...overrides,
  } as FileTreeNode;
}

function folderTree(id: string, name: string, children: FileTreeNode[]): FileTreeNode {
  return {
    id,
    name,
    kind: "folder",
    children,
    isImported: false,
    isExpanded: true,
  } as FileTreeNode;
}

/** fileImportService stub whose provider echoes the requested table name. */
function importServiceStub() {
  const importFile = vi.fn(async (_file: File, tableName: string) => ({
    getMetadata: async () => ({ name: tableName }),
  }));
  return { importFile, service: { importFile } };
}

describe("importNode table-name resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("suffixes the name when a different dataset already owns it", async () => {
    const { importFile, service } = importServiceStub();
    const panel = makePanel({
      fileImportService: service,
      datasets: [{ metadata: { name: "AE" }, dataset: {}, isLoaded: true }],
    });

    const node = fileNode("AE.csv");
    const result = await panel.importNode(node, { silent: true });

    expect(result.ok).toBe(true);
    expect(importFile).toHaveBeenCalledWith(expect.anything(), "AE_2", undefined);
    expect(node.tableName).toBe("AE_2");
  });

  it("avoids names already present in the engine catalog", async () => {
    const { importFile, service } = importServiceStub();
    const panel = makePanel({
      fileImportService: service,
      tabManager: { getBackend: () => ({ listTables: async () => ["ae"] }) },
    });

    const node = fileNode("AE.csv");
    await panel.importNode(node, { silent: true });

    expect(importFile).toHaveBeenCalledWith(expect.anything(), "AE_2", undefined);
  });

  it("keeps a previously assigned name so a re-import replaces the same table", async () => {
    const { importFile, service } = importServiceStub();
    const panel = makePanel({
      fileImportService: service,
      tabManager: { getBackend: () => ({ listTables: async () => ["AE"] }) },
    });

    const node = fileNode("AE.csv", { tableName: "AE", isImported: true });
    await panel.importNode(node, { silent: true });

    expect(importFile).toHaveBeenCalledWith(expect.anything(), "AE", undefined);
  });

  it("falls back to the tracked datasets when listTables fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { importFile, service } = importServiceStub();
    const panel = makePanel({
      fileImportService: service,
      tabManager: {
        getBackend: () => ({
          listTables: async () => {
            throw new Error("engine offline");
          },
        }),
      },
    });

    const node = fileNode("AE.csv");
    const result = await panel.importNode(node, { silent: true });

    expect(result.ok).toBe(true);
    expect(importFile).toHaveBeenCalledWith(expect.anything(), "AE", undefined);
  });
});

describe("attachFolderTree import batching", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips the local batch when binding activates another environment (re-scan imports instead)", () => {
    const autoImportBatch = vi.fn().mockResolvedValue(undefined);
    const panel = makePanel({ autoImportBatch });

    const handleId = `fh_${Math.random().toString(36).slice(2, 10)}`;
    const tree = folderTree(`folder-a-${handleId}`, `study-${handleId}`, [fileNode("AE.csv")]);
    panel.attachFolderTree(tree, handleId);

    // Binding created + activated a fresh environment for this folder.
    expect(environmentService.getActiveId()).not.toBeNull();
    // The activation path re-enters attachFolderTree after its re-scan;
    // importing here as well ran the same batch twice (the bug where a
    // folder open failed every CSV with "Table already exists").
    expect(autoImportBatch).not.toHaveBeenCalled();
  });

  it("runs the local batch when the folder's environment is already active", () => {
    const autoImportBatch = vi.fn().mockResolvedValue(undefined);
    const panel = makePanel({ autoImportBatch });

    const handleId = `fh_${Math.random().toString(36).slice(2, 10)}`;
    const first = folderTree(`folder-b-${handleId}`, `study-${handleId}`, [fileNode("DM.csv")]);
    panel.attachFolderTree(first, handleId);
    autoImportBatch.mockClear();

    // Same folder again: the environment is already active, so no
    // re-entry is coming and the batch must run here.
    const second = folderTree(`folder-b-${handleId}`, `study-${handleId}`, [fileNode("DM.csv")]);
    panel.attachFolderTree(second, handleId);

    expect(autoImportBatch).toHaveBeenCalledTimes(1);
  });

  it("runs the local batch when there is no stored folder handle", () => {
    const autoImportBatch = vi.fn().mockResolvedValue(undefined);
    const panel = makePanel({ autoImportBatch });

    // webkitdirectory fallback: no handle id, so applyActiveEnvironment
    // cannot re-scan. The import must happen here even though binding
    // just activated a new environment.
    const suffix = Math.random().toString(36).slice(2, 10);
    const tree = folderTree(`folder-c-${suffix}`, `plain-${suffix}`, [fileNode("CM.csv")]);
    panel.attachFolderTree(tree, undefined);

    expect(autoImportBatch).toHaveBeenCalledTimes(1);
  });
});
