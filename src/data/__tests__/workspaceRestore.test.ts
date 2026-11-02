import { describe, expect, it } from "vitest";
import type { FileTreeNode } from "../FileTreeTypes";
import {
  deriveDataWorkspace,
  findNodeById,
  isRestorableNodeId,
  pickedFileNodeId,
  pickedFilePath,
  planRestore,
} from "../workspaceRestore";

function file(id: string, name: string, extra: Partial<FileTreeNode> = {}): FileTreeNode {
  return { id, name, kind: "file", fileType: "csv", isImported: false, isExpanded: false, ...extra };
}

function folder(id: string, name: string, children: FileTreeNode[]): FileTreeNode {
  return { id, name, kind: "folder", children, isImported: false, isExpanded: true };
}

const TREE: FileTreeNode[] = [
  folder("ipc/C:/data", "data", [
    file("ipc/C:/data/a.csv", "a.csv", { tableName: "a" }),
    file("ipc/C:/data/b.csv", "b.csv", { tableName: "b" }),
    file("ipc/C:/data/book.xlsx", "book.xlsx", { fileType: "xlsx" }),
    file("ipc/C:/data/sub/notes.xlsx", "notes.xlsx", { fileType: "xlsx" }),
  ]),
  file("drop/x.csv/1/abc", "x.csv", { tableName: "x" }),
  file("dataset/result_1", "result_1", { tableName: "result_1", fileType: undefined }),
];

describe("picked-file ids", () => {
  it("round-trips a path", () => {
    expect(pickedFileNodeId("C:/d/a.csv")).toBe("ipc/file/C:/d/a.csv");
    expect(pickedFilePath("ipc/file/C:/d/a.csv")).toBe("C:/d/a.csv");
  });

  it("returns null for other ids and for an empty path", () => {
    expect(pickedFilePath("ipc/C:/data/a.csv")).toBeNull();
    expect(pickedFilePath("ipc/file/")).toBeNull();
  });
});

describe("isRestorableNodeId", () => {
  it("rejects dropped files and catalog tables, accepts tree nodes", () => {
    expect(isRestorableNodeId("drop/x.csv/1/abc")).toBe(false);
    expect(isRestorableNodeId("dataset/result_1")).toBe(false);
    expect(isRestorableNodeId("ipc/C:/data/a.csv")).toBe(true);
    expect(isRestorableNodeId("ipc/file/C:/d/a.csv")).toBe(true);
    expect(isRestorableNodeId("folder-1/sub/a.csv")).toBe(true);
  });
});

describe("findNodeById", () => {
  it("searches nested children", () => {
    expect(findNodeById(TREE, "ipc/C:/data/b.csv")?.name).toBe("b.csv");
    expect(findNodeById(TREE, "nope")).toBeUndefined();
  });
});

describe("deriveDataWorkspace", () => {
  it("keeps tab order and the active tab, mapped to node ids", () => {
    const ws = deriveDataWorkspace(["b", "a"], "a", TREE);
    expect(ws).toEqual({ openDataNodeIds: ["ipc/C:/data/b.csv", "ipc/C:/data/a.csv"], activeDataNodeId: "ipc/C:/data/a.csv" });
  });

  it("leaves out dropped files, catalog tables and tabs with no tree node", () => {
    const ws = deriveDataWorkspace(["x", "result_1", "chart_1", "a"], "x", TREE);
    expect(ws).toEqual({ openDataNodeIds: ["ipc/C:/data/a.csv"] });
  });

  it("returns an empty list with no active id when nothing is open", () => {
    expect(deriveDataWorkspace([], null, TREE)).toEqual({ openDataNodeIds: [] });
  });
});

describe("planRestore", () => {
  it("opens existing nodes in the saved order", () => {
    const plan = planRestore(["ipc/C:/data/b.csv", "ipc/C:/data/a.csv"], TREE);
    expect(plan.missing).toEqual([]);
    expect(plan.steps.map((s) => (s.kind === "node" ? s.node.name : "?"))).toEqual(["b.csv", "a.csv"]);
  });

  it("turns a sheet id of a not-yet-enumerated workbook into a sheet step", () => {
    const plan = planRestore(["ipc/C:/data/book.xlsx/Sheet1"], TREE);
    expect(plan.steps).toHaveLength(1);
    const step = plan.steps[0];
    expect(step.kind).toBe("sheet");
    if (step.kind === "sheet") {
      expect(step.workbook.name).toBe("book.xlsx");
      expect(step.sheetName).toBe("Sheet1");
      expect(step.id).toBe("ipc/C:/data/book.xlsx/Sheet1");
    }
  });

  it("finds an already-enumerated sheet node directly", () => {
    const wb = file("ipc/C:/data/book.xlsx", "book.xlsx", {
      fileType: "xlsx",
      children: [{ id: "ipc/C:/data/book.xlsx/S", name: "S", kind: "sheet", sheetName: "S", fileType: "xlsx", isImported: false, isExpanded: false }],
    });
    const plan = planRestore(["ipc/C:/data/book.xlsx/S"], [wb]);
    expect(plan.steps[0].kind).toBe("node");
  });

  it("matches the longest workbook prefix when a sheet name contains a slash", () => {
    const outer = file("ipc/C:/x.xlsx", "x.xlsx", { fileType: "xlsx" });
    const inner = file("ipc/C:/x.xlsx/deep.xlsx", "deep.xlsx", { fileType: "xlsx" });
    const plan = planRestore(["ipc/C:/x.xlsx/deep.xlsx/Q1/2026"], [outer, inner]);
    const step = plan.steps[0];
    expect(step.kind).toBe("sheet");
    if (step.kind === "sheet") {
      expect(step.workbook.name).toBe("deep.xlsx");
      expect(step.sheetName).toBe("Q1/2026");
    }
  });

  it("reports ids with no node and no workbook as missing by display name", () => {
    const plan = planRestore(["ipc/C:/data/gone.csv", "ipc/C:/data/a.csv"], TREE);
    expect(plan.missing).toEqual(["gone.csv"]);
    expect(plan.steps).toHaveLength(1);
  });

  it("ignores malformed ids without throwing", () => {
    const plan = planRestore(["", "///", "drop/x.csv/1/abc"], TREE);
    expect(plan.steps.map((s) => s.kind)).toEqual(["node"]);
    expect(plan.missing).toEqual(["", "///"]);
  });
});
