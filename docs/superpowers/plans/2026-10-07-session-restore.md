# Session Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Bedevere opens, the workspace comes back as it was at close: the environment and its files, the open dataset tabs in order, the active dataset tab, and each dataset's column filters and sorts, on web and desktop.

**Architecture:** The renderer already persists settings, environments and query tabs; the desktop host currently throws that data away because its two persistence RPCs are stubs. Task 1 gives the host a real store. The remaining tasks fill in the missing producers and consumers in the renderer: pure helpers that derive and plan the dataset-tab workspace (`workspaceRestore.ts`), a `hydrate` method on the filter manager plus a small persistence module for filters and sorts, two hooks on `TabManager`, and the save and restore steps in `ControlPanel` around the existing `applyActiveEnvironment`.

**Tech Stack:** TypeScript (Vite, vitest with jsdom), C++17 with nlohmann/json in the desktop shell, bun for every script.

**Spec:** `docs/superpowers/specs/2026-10-07-session-restore-design.md`

## Global Constraints

- Two repos. Renderer work lands on `feature/session-restore` in bedevere-wise (already created off `dev-0.16`, holds the spec). Host work lands on a new branch `feature/persistence-store` in `../bedevere-desktop`, off its `dev-0.16`.
- Tooling: `bun x vitest run <file>` for tests, `bun x tsc --noEmit` for types, `bun run build:lib` to refresh the library the desktop renderer links. Never npm or npx.
- Writing style for comments, commit messages and the changelog: plain English, short linear sentences, no em-dashes, no buzzwords. Commit subjects follow the repo's `Area: imperative summary` form and every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Additive persisted shapes only. `EnvironmentWorkspaceState` gains `activeDataNodeId?: string`; `AppSettings` gains `columnFilters?` and `columnSorts?`. No schema version bump, no migration.
- Dropped files (`drop/…` ids), catalog tables (`dataset/<name>` ids), result, chart and text tabs are never restored.
- Every failure during restore is non-fatal: skip the item, report once in the status bar, never throw out of `applyActiveEnvironment`.
- Desktop store path: `config_dir()/persistence.json`, written to `persistence.json.tmp` then renamed. A missing or corrupt file loads as an empty object.

## Review Focus

1. A sheet name containing `/` (ids are `<workbook id>/<sheet name>`): `planRestore` must match the longest workbook id prefix, not the first. Pinned in Task 2.
2. A range filter whose column changed type since it was saved (numeric column now VARCHAR): `hydrate` must drop it instead of building a WHERE clause that fails. Pinned in Task 3.
3. Hydration order against the filter-change subscriber: restoring hidden columns fires `onChange`, and the subscriber writes the filter list; if filters are hydrated after that, the persisted filters are erased on every open. Pinned in Task 5.
4. The user switches environments while a restore is still opening tabs: the loop must stop and must not write the half-restored list into the other environment. Pinned in Task 7.
5. `activeDataNodeId` that is not among the opened tabs (stale or inconsistent data): no activation, no error. Pinned in Task 7.
6. A folder environment whose folder cannot be re-acquired (moved, drive unplugged, web permission denied): the saved tab list must survive for the next successful open instead of being overwritten with an empty list. Pinned in Task 7.

---

### Task 1: Desktop host persistence store

**Files:**
- Modify: `../bedevere-desktop/shell/ipc/rpc.h` (private members after `save_grants`, around line 125)
- Modify: `../bedevere-desktop/shell/ipc/rpc.cpp` (constructor at 938-949; helpers after `save_grants` at ~1003; the two RPC arms at 2336-2364)

**Interfaces:**
- Consumes: the existing wire contract. `loadPersistence` replies `{ data: Record<string, string> }`; `savePersistence` takes `{ data: Record<string, string> }` (bedevere-wise `src/data/ipc/types.ts:376-383`).
- Produces: `persistence.json` under `config_dir()` (`%LOCALAPPDATA%\bedevere` on Windows). No renderer change.

- [ ] **Step 1: Create the desktop branch**

```bash
cd ../bedevere-desktop
git fetch -q origin && git checkout -q dev-0.16 && git pull -q --ff-only origin dev-0.16
git checkout -b feature/persistence-store
```

- [ ] **Step 2: Declare the store on `RpcDispatcher`**

In `shell/ipc/rpc.h`, directly after the line `void save_grants() const;`, add:

```cpp
    // Renderer persistence snapshot (settings, environments, queries,
    // aliases, keymap). One JSON object whose values are the renderer's
    // JSON-stringified payloads, kept at config_dir/persistence.json
    // next to the grant ledger. Loaded whole on boot, rewritten whole on
    // every save (a few KB, at most once per 750 ms). save_persistence
    // writes to a .tmp sibling and renames over the file, so a crash
    // mid-write leaves the previous snapshot intact.
    // Declared after grants_path_ on purpose: the constructor derives it
    // from grants_path_'s parent directory.
    std::filesystem::path persistence_path_;
    nlohmann::json load_persistence() const;
    bool save_persistence(const nlohmann::json& data, std::string& error_out) const;
```

- [ ] **Step 3: Initialize the path in the constructor**

In `shell/ipc/rpc.cpp`, change the initializer list so the last two entries read:

```cpp
      grants_path_(std::move(config_dir) / "file_grants.json"),
      persistence_path_(grants_path_.parent_path() / "persistence.json") {
    load_grants();
}
```

- [ ] **Step 4: Implement load and save**

Directly after `RpcDispatcher::save_grants()` add:

```cpp
// ---- Renderer persistence store --------------------------------------------

nlohmann::json RpcDispatcher::load_persistence() const {
    std::ifstream in(persistence_path_, std::ios::binary);
    if (!in.is_open()) return json::object();
    const json j = json::parse(in, nullptr, /*allow_exceptions=*/false);
    if (!j.is_object()) return json::object();
    // Only string values cross the wire (one JSON-stringified payload per
    // key). Anything else means a hand-edited or damaged file; skip it
    // rather than hand the renderer a shape it does not expect.
    json out = json::object();
    for (const auto& [key, value] : j.items()) {
        if (value.is_string()) out[key] = value;
    }
    return out;
}

bool RpcDispatcher::save_persistence(const json& data, std::string& error_out) const {
    std::error_code ec;
    std::filesystem::create_directories(persistence_path_.parent_path(), ec);
    const std::filesystem::path tmp = persistence_path_.string() + ".tmp";
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        if (!out.is_open()) {
            error_out = "persistence: cannot open " + tmp.string();
            return false;
        }
        out << data.dump();
        if (!out.good()) {
            error_out = "persistence: write failed for " + tmp.string();
            return false;
        }
    }
    // rename replaces an existing target on every platform we build for
    // (MoveFileEx with REPLACE_EXISTING on Windows). This is the atomic step.
    std::filesystem::rename(tmp, persistence_path_, ec);
    if (ec) {
        error_out = "persistence: rename failed: " + ec.message();
        std::filesystem::remove(tmp, ec);
        return false;
    }
    return true;
}
```

- [ ] **Step 5: Wire the two RPC arms**

Replace the block from the comment `// TODO(kolistat-persistence): real implementation pending.` down to the end of the `savePersistence` arm (lines 2339-2364) with:

```cpp
    // Store: config_dir/persistence.json, see load_persistence /
    // save_persistence. The renderer's docs/backend-protocol.md §3.7
    // describes the contract.
    // -----------------------------------------------------------------
    if (method == "loadPersistence") {
        reply_ok(json{{"data", load_persistence()}});
        return;
    }
    if (method == "savePersistence") {
        if (!params.contains("data") || !params["data"].is_object()) {
            reply_err("INVALID_PARAMS", "savePersistence requires data: object");
            return;
        }
        std::string err;
        if (!save_persistence(params["data"], err)) {
            reply_err("INTERNAL", err);
            return;
        }
        reply_ok(json::object());
        return;
    }
```

Keep the explanatory comment above the TODO (the one that starts with "the web app writes to localStorage"); only the TODO paragraph and the stub bodies go.

- [ ] **Step 6: Build the shell**

From PowerShell (cygwin must be off PATH or CMake picks its `ld`; the VS cmake drives the already-configured build tree):

```powershell
Set-Location C:\Users\massi\source\repos\kolistat\bedevere-desktop
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'cygwin' }) -join ';'
$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\Installer;" + $env:PATH
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"" -arch=x64 -no_logo && ""C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"" --build build/build/Release --target bedevere-desktop"
```

Expected: `Linking CXX executable bedevere-desktop.exe` with no new warnings in `rpc.cpp`.

- [ ] **Step 7: Verify by hand**

1. Delete `%LOCALAPPDATA%\bedevere\persistence.json` if present.
2. Run `build\build\Release\bedevere-desktop.exe`, drag the left panel wider, close the app.
3. `Get-Content $env:LOCALAPPDATA\bedevere\persistence.json` shows a JSON object with a `bedevere_settings` key whose string value contains `panelWidth`.
4. Reopen the app: the panel keeps the width.
5. Overwrite the file with `not json`, reopen: the app starts clean, and after the next change the file is valid JSON again.

- [ ] **Step 8: Commit**

```bash
git add shell/ipc/rpc.h shell/ipc/rpc.cpp
git commit -m "$(printf 'Persistence: store the renderer snapshot in config_dir/persistence.json\n\nloadPersistence returned an empty object and savePersistence dropped the\npayload, so on desktop nothing the renderer persists (settings,\nenvironments, query tabs) survived a restart. The snapshot now lives next\nto file_grants.json, loaded whole on boot and written whole on every\nsave through a .tmp sibling plus rename. A missing or damaged file loads\nas an empty object; a failed write reports an INTERNAL error instead of\nclaiming success.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 2: Workspace derivation and restore planning helpers

**Files:**
- Create: `src/data/workspaceRestore.ts`
- Test: `src/data/__tests__/workspaceRestore.test.ts`

**Interfaces:**
- Consumes: `FileTreeNode` from `src/data/FileTreeTypes.ts` (`id`, `kind`, `children`, `fileType`, `tableName`, `name`).
- Produces (used by Tasks 6 and 7):
  - `pickedFileNodeId(path: string): string` and `pickedFilePath(nodeId: string): string | null`
  - `isRestorableNodeId(id: string): boolean`
  - `findNodeById(nodes: FileTreeNode[], id: string): FileTreeNode | undefined`
  - `findNodeByTableName(nodes: FileTreeNode[], tableName: string): FileTreeNode | undefined`
  - `deriveDataWorkspace(tabNamesInOrder: string[], activeTabName: string | null, nodes: FileTreeNode[]): DataWorkspace` where `DataWorkspace = { openDataNodeIds: string[]; activeDataNodeId?: string }`
  - `planRestore(openDataNodeIds: string[], nodes: FileTreeNode[]): RestorePlan` where `RestoreStep = { kind: "node"; node: FileTreeNode } | { kind: "sheet"; workbook: FileTreeNode; sheetName: string; id: string }` and `RestorePlan = { steps: RestoreStep[]; missing: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/data/__tests__/workspaceRestore.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun x vitest run src/data/__tests__/workspaceRestore.test.ts`
Expected: FAIL, cannot resolve `../workspaceRestore`.

- [ ] **Step 3: Implement the module**

Create `src/data/workspaceRestore.ts`:

```ts
/**
 * Pure helpers behind session restore: turn the TabManager's tab list
 * into the environment's persisted dataset workspace, and turn that
 * persisted workspace back into a list of tree nodes to reopen. No DOM,
 * no services, so ControlPanel stays thin and the rules are unit tested.
 *
 * Node ids are the stable identity of a file across restarts. Folder
 * trees mint `ipc/<folder>/<relative path>` (desktop) or
 * `<folder id>/<path>` (web). Picked single files use
 * `ipc/file/<path>`. Dropped files (`drop/…`) and catalog tables
 * (`dataset/<name>`) have no stable source and are never restored.
 */

import type { FileTreeNode } from "./FileTreeTypes";

export const PICKED_FILE_PREFIX = "ipc/file/";

export function pickedFileNodeId(path: string): string {
  return `${PICKED_FILE_PREFIX}${path}`;
}

/** The path inside a picked-file node id, or null for any other id. */
export function pickedFilePath(nodeId: string): string | null {
  if (!nodeId.startsWith(PICKED_FILE_PREFIX)) return null;
  const path = nodeId.slice(PICKED_FILE_PREFIX.length);
  return path.length > 0 ? path : null;
}

export function isRestorableNodeId(id: string): boolean {
  return !id.startsWith("drop/") && !id.startsWith("dataset/");
}

export function findNodeById(nodes: FileTreeNode[], id: string): FileTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const hit = findNodeById(n.children, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

export function findNodeByTableName(nodes: FileTreeNode[], tableName: string): FileTreeNode | undefined {
  for (const n of nodes) {
    if (n.tableName === tableName) return n;
    if (n.children) {
      const hit = findNodeByTableName(n.children, tableName);
      if (hit) return hit;
    }
  }
  return undefined;
}

export interface DataWorkspace {
  openDataNodeIds: string[];
  activeDataNodeId?: string;
}

/**
 * Map open tab names (display order) to restorable node ids. Tabs with
 * no tree node (result, chart, text tabs) and nodes without a stable
 * source are left out. The active id is set only when the active tab
 * made it into the list.
 */
export function deriveDataWorkspace(
  tabNamesInOrder: string[],
  activeTabName: string | null,
  nodes: FileTreeNode[],
): DataWorkspace {
  const openDataNodeIds: string[] = [];
  let activeDataNodeId: string | undefined;
  for (const name of tabNamesInOrder) {
    const node = findNodeByTableName(nodes, name);
    if (!node || !isRestorableNodeId(node.id)) continue;
    openDataNodeIds.push(node.id);
    if (name === activeTabName) activeDataNodeId = node.id;
  }
  return activeDataNodeId ? { openDataNodeIds, activeDataNodeId } : { openDataNodeIds };
}

export type RestoreStep =
  | { kind: "node"; node: FileTreeNode }
  | { kind: "sheet"; workbook: FileTreeNode; sheetName: string; id: string };

export interface RestorePlan {
  steps: RestoreStep[];
  /** Display names of saved ids that no longer resolve, for the status message. */
  missing: string[];
}

function isWorkbook(n: FileTreeNode): boolean {
  return n.kind === "file" && (n.fileType === "xlsx" || n.fileType === "xls");
}

function collectWorkbooks(nodes: FileTreeNode[], out: FileTreeNode[] = []): FileTreeNode[] {
  for (const n of nodes) {
    if (isWorkbook(n)) out.push(n);
    if (n.children) collectWorkbooks(n.children, out);
  }
  return out;
}

function displayName(id: string): string {
  const parts = id.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : id;
}

/**
 * Resolve saved ids against the rebuilt tree. A sheet id whose workbook
 * has not enumerated its sheets yet becomes a "sheet" step: the caller
 * enumerates, then opens the child. Workbooks are matched by the
 * longest id prefix, so a sheet name that contains "/" still resolves.
 */
export function planRestore(openDataNodeIds: string[], nodes: FileTreeNode[]): RestorePlan {
  const steps: RestoreStep[] = [];
  const missing: string[] = [];
  const workbooks = collectWorkbooks(nodes).sort((a, b) => b.id.length - a.id.length);
  for (const id of openDataNodeIds) {
    const node = id.length > 0 ? findNodeById(nodes, id) : undefined;
    if (node) {
      steps.push({ kind: "node", node });
      continue;
    }
    const workbook = workbooks.find((w) => id.startsWith(`${w.id}/`) && id.length > w.id.length + 1);
    if (workbook) {
      steps.push({ kind: "sheet", workbook, sheetName: id.slice(workbook.id.length + 1), id });
      continue;
    }
    missing.push(displayName(id));
  }
  return { steps, missing };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun x vitest run src/data/__tests__/workspaceRestore.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/data/workspaceRestore.ts src/data/__tests__/workspaceRestore.test.ts
git commit -m "$(printf 'Restore: pure helpers to derive and plan the dataset-tab workspace\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 3: Persisted shapes and filter-manager hydration

**Files:**
- Modify: `src/data/environments/types.ts:53-60` (`EnvironmentWorkspaceState`)
- Modify: `src/data/PersistenceService.ts:62-71` (after `columnOrder`)
- Modify: `src/data/ColumnFilterManager.ts` (new method after `hasAnyState`, line ~345)
- Test: `src/data/__tests__/columnStateHydrate.test.ts`

**Interfaces:**
- Produces:
  - `EnvironmentWorkspaceState.activeDataNodeId?: string`
  - `AppSettings.columnFilters?: Record<string, ColumnFilter[]>` and `AppSettings.columnSorts?: Record<string, SortConfig[]>`
  - `ColumnFilterManager.hydrate(datasetName: string, state: { filters?: ColumnFilter[]; sorts?: SortConfig[] }, existingColumns: ReadonlyArray<Pick<Column, "name" | "dataType">>): void` (silent: fires no `onChange`)

- [ ] **Step 1: Write the failing tests**

Create `src/data/__tests__/columnStateHydrate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnFilterManager } from "../ColumnFilterManager";
import { persistenceService } from "../PersistenceService";
import { EnvironmentService } from "../environments/EnvironmentService";

const COLS = [
  { name: "id", dataType: "INTEGER" },
  { name: "name", dataType: "VARCHAR" },
  { name: "when", dataType: "DATE" },
] as const;

describe("ColumnFilterManager.hydrate", () => {
  it("loads filters and sorts for columns that still exist", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      {
        filters: [{ columnName: "name", filterType: "include", values: ["a"] }],
        sorts: [{ columnName: "id", direction: "desc" }],
      },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([{ columnName: "name", filterType: "include", values: ["a"], dataType: "VARCHAR" }]);
    expect(fm.getSorts("t")).toEqual([{ columnName: "id", direction: "desc" }]);
    expect(fm.hasAnyState("t")).toBe(true);
  });

  it("drops entries whose column is gone", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      { filters: [{ columnName: "old", filterType: "include", values: ["x"] }], sorts: [{ columnName: "old", direction: "asc" }] },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([]);
    expect(fm.getSorts("t")).toEqual([]);
    expect(fm.hasAnyState("t")).toBe(false);
  });

  it("drops a numeric range filter when the column is no longer numeric", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate("t", { filters: [{ columnName: "name", filterType: "range", min: 1, max: 5 }] }, COLS);
    expect(fm.getFilters("t")).toEqual([]);
  });

  it("drops a temporal range filter when the column is no longer temporal", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate("t", { filters: [{ columnName: "id", filterType: "range", minStr: "2026-01-01", maxStr: "2026-02-01" }] }, COLS);
    expect(fm.getFilters("t")).toEqual([]);
  });

  it("keeps range filters that still match the column type and refreshes dataType", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      {
        filters: [
          { columnName: "id", filterType: "range", min: 1, max: 5, dataType: "BIGINT" },
          { columnName: "when", filterType: "range", minStr: "2026-01-01", maxStr: "2026-02-01" },
        ],
      },
      COLS,
    );
    expect(fm.getFilters("t").map((f) => [f.columnName, f.dataType])).toEqual([
      ["id", "INTEGER"],
      ["when", "DATE"],
    ]);
  });

  it("does not fire onChange", () => {
    const fm = new ColumnFilterManager();
    const spy = vi.fn();
    fm.onChange(spy);
    fm.hydrate("t", { filters: [{ columnName: "name", filterType: "include", values: ["a"] }] }, COLS);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tolerates malformed entries", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      { filters: [{ columnName: "name", filterType: "bogus" as never }, null as never, { columnName: 42 as never, filterType: "include" }] },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([]);
  });
});

describe("persisted shapes round-trip", () => {
  afterEach(() => localStorage.clear());

  it("keeps columnFilters and columnSorts in app settings", () => {
    const s = persistenceService.loadAppSettings();
    s.columnFilters = { t: [{ columnName: "name", filterType: "include", values: ["a"] }] };
    s.columnSorts = { t: [{ columnName: "id", direction: "asc" }] };
    persistenceService.saveAppSettings(s);
    const back = persistenceService.loadAppSettings();
    expect(back.columnFilters).toEqual(s.columnFilters);
    expect(back.columnSorts).toEqual(s.columnSorts);
  });

  it("keeps activeDataNodeId in the environment workspace", () => {
    const svc = new EnvironmentService();
    const env = svc.create({ name: "f", kind: "folder", folderHandleId: "ipc:C:/data" });
    svc.setWorkspace(env.id, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [], activeDataNodeId: "ipc/C:/data/a.csv" });
    expect(new EnvironmentService().get(env.id)?.workspace.activeDataNodeId).toBe("ipc/C:/data/a.csv");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun x vitest run src/data/__tests__/columnStateHydrate.test.ts`
Expected: FAIL, `fm.hydrate is not a function`, and type errors on the new settings fields.

- [ ] **Step 3: Add the two persisted fields**

In `src/data/environments/types.ts`, inside `EnvironmentWorkspaceState` after `activeTab`:

```ts
  /**
   * Dataset tab active in the bottom tab strip when the env was last
   * left. Separate from `activeTab`, which the SQL editor uses for its
   * own strip and its expanded state. References a FileTreeNode id.
   */
  activeDataNodeId?: string;
```

In `src/data/PersistenceService.ts`, after the `columnOrder` field:

```ts
  /**
   * Per-dataset column filters, keyed by dataset name like
   * `hiddenColumns`. Restored into the filter manager before the
   * dataset's tab is built, so the tab opens already filtered. Entries
   * whose column no longer exists are dropped on restore.
   */
  columnFilters?: Record<string, ColumnFilter[]>;
  /** Per-dataset sort chain, same keying and restore rules as `columnFilters`. */
  columnSorts?: Record<string, SortConfig[]>;
```

and add to the imports at the top of the file:

```ts
import type { ColumnFilter, SortConfig } from "./ColumnFilterManager";
```

- [ ] **Step 4: Implement `hydrate`**

In `src/data/ColumnFilterManager.ts`, add `Column` to the import from `./types` (it is `import { DataType, isBooleanType, … } from "./types";` so it becomes `import { Column, DataType, … }` with `Column` used as a type), then add after `hasAnyState`:

```ts
  /**
   * Load persisted filters and sorts for a dataset before its tab
   * exists. Entries whose column is not in `existingColumns` are
   * dropped. Range filters are kept only when the column's current
   * type still fits them (numeric for min/max, temporal for
   * minStr/maxStr), so a file whose schema changed cannot produce a
   * WHERE clause that fails. Each kept filter gets the column's current
   * dataType. Malformed entries are skipped.
   *
   * Fires no `onChange`: the hook that calls it runs before the tab is
   * registered, and the TabManager reads `hasAnyState` right after.
   * Firing would also make the persistence subscriber in BedevereApp
   * rewrite the list while it is being loaded.
   */
  public hydrate(
    datasetName: string,
    state: { filters?: ColumnFilter[]; sorts?: SortConfig[] },
    existingColumns: ReadonlyArray<Pick<Column, "name" | "dataType">>,
  ): void {
    const typeOf = new Map(existingColumns.map((c) => [c.name, c.dataType]));

    const filters: ColumnFilter[] = [];
    for (const f of state.filters ?? []) {
      if (!f || typeof f.columnName !== "string") continue;
      const dataType = typeOf.get(f.columnName);
      if (dataType === undefined) continue;
      if (f.filterType === "range") {
        const numeric = f.min !== undefined || f.max !== undefined;
        const temporal = f.minStr !== undefined || f.maxStr !== undefined;
        if (numeric && !isNumericType(dataType)) continue;
        if (temporal && !isTemporalType(dataType)) continue;
        if (!numeric && !temporal) continue;
      } else if (f.filterType !== "include" && f.filterType !== "exclude") {
        continue;
      }
      filters.push({ ...f, dataType });
    }
    if (filters.length > 0) this.filters.set(datasetName, filters);
    else this.filters.delete(datasetName);

    const sorts: SortConfig[] = [];
    for (const s of state.sorts ?? []) {
      if (!s || typeof s.columnName !== "string" || !typeOf.has(s.columnName)) continue;
      if (s.direction !== "asc" && s.direction !== "desc") continue;
      sorts.push({ columnName: s.columnName, direction: s.direction });
    }
    if (sorts.length > 0) this.sorts.set(datasetName, sorts);
    else this.sorts.delete(datasetName);
  }
```

- [ ] **Step 5: Run the tests to see them pass, then the type check**

Run: `bun x vitest run src/data/__tests__/columnStateHydrate.test.ts`
Expected: PASS, 9 tests.

Run: `bun x tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/data/environments/types.ts src/data/PersistenceService.ts src/data/ColumnFilterManager.ts src/data/__tests__/columnStateHydrate.test.ts
git commit -m "$(printf 'Restore: persisted shapes for active data tab, column filters and sorts\n\nAdds activeDataNodeId to the environment workspace and columnFilters /\ncolumnSorts to app settings (both additive), plus\nColumnFilterManager.hydrate, which loads a persisted entry while dropping\ncolumns that no longer exist and range filters whose column changed type.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 4: TabManager hooks

**Files:**
- Modify: `src/components/TabManager/TabManager.ts` (fields at 78-88, setters near the other `setOn…Callback` methods, `activateTab` at ~505-525, getters at ~337)
- Test: `src/components/TabManager/__tests__/TabManager.activation.test.ts`

**Interfaces:**
- Produces: `getActiveTabId(): string | null` and `setOnTabActivatedCallback(cb: (name: string) => void): void`. The callback fires inside `activateTab` right after the active id is updated, before the kind-specific work.

- [ ] **Step 1: Write the failing test**

Create `src/components/TabManager/__tests__/TabManager.activation.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TabManager } from "../TabManager";

/**
 * Drives `activateTab` on a hand-built `this` (prototype pattern, like
 * ControlPanel.import.test.ts): the constructor needs a live
 * ColumnStatsVisualizer and CommandBar that dwarf the behaviour under
 * test. Text tabs are used because activating one touches no spreadsheet.
 */
function textTab(name: string) {
  return { kind: "text" as const, metadata: { name }, container: document.createElement("div"), isActive: false };
}

function makeManager(): any {
  const m: any = Object.create(TabManager.prototype);
  m.tabs = [textTab("a"), textTab("b")];
  m.activeTabId = null;
  m.tabsContainer = document.createElement("div");
  m.sharedStatsVisualizer = { hide: () => {} };
  return m;
}

describe("TabManager activation hooks", () => {
  it("exposes the active tab id and reports activations", async () => {
    const m = makeManager();
    const seen: string[] = [];
    m.setOnTabActivatedCallback((name: string) => seen.push(name));

    expect(m.getActiveTabId()).toBeNull();
    await m.activateTab("b");
    expect(m.getActiveTabId()).toBe("b");
    await m.activateTab("a");
    expect(seen).toEqual(["b", "a"]);
  });

  it("does not report an unknown tab", async () => {
    const m = makeManager();
    const cb = vi.fn();
    m.setOnTabActivatedCallback(cb);
    await m.activateTab("zzz");
    expect(cb).not.toHaveBeenCalled();
    expect(m.getActiveTabId()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun x vitest run src/components/TabManager/__tests__/TabManager.activation.test.ts`
Expected: FAIL, `m.setOnTabActivatedCallback is not a function`.

- [ ] **Step 3: Implement**

In `TabManager.ts`, after the field `private onBeforeAddDatasetCallback?: …;` add:

```ts
  // Fires after a tab becomes active (any kind). ControlPanel records the
  // active dataset tab into the environment workspace from here.
  private onTabActivatedCallback?: (name: string) => void;
```

Next to the other `setOn…Callback` methods (for example right after `setOnBeforeAddDatasetCallback`), add:

```ts
  public setOnTabActivatedCallback(callback: (name: string) => void): void {
    this.onTabActivatedCallback = callback;
  }

  /** Name of the active tab (any kind), or null when no tab is open. */
  public getActiveTabId(): string | null {
    return this.activeTabId;
  }
```

In `activateTab`, right after `this.updateTabStyles(id, true);` add:

```ts
    this.onTabActivatedCallback?.(id);
```

- [ ] **Step 4: Run the test to see it pass**

Run: `bun x vitest run src/components/TabManager/__tests__/TabManager.activation.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabManager/TabManager.ts src/components/TabManager/__tests__/TabManager.activation.test.ts
git commit -m "$(printf 'TabManager: expose the active tab id and an activation callback\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 5: Persist and hydrate column filters and sorts

**Files:**
- Create: `src/data/columnStatePersistence.ts`
- Modify: `src/components/BedevereApp/BedevereApp.ts:536-560` (the `setOnBeforeAddDatasetCallback` block)
- Test: `src/data/__tests__/columnStatePersistence.test.ts`

**Interfaces:**
- Consumes: `ColumnFilterManager.hydrate` (Task 3), `AppSettings.columnFilters` / `columnSorts` (Task 3).
- Produces:
  - `hydrateColumnState(fm: ColumnFilterManager, settings: AppSettings, metadata: DatasetMetadata): void`
  - `withColumnFilters(settings: AppSettings, datasetName: string, filters: ColumnFilter[]): AppSettings`
  - `withColumnSorts(settings: AppSettings, datasetName: string, sorts: SortConfig[]): AppSettings`

- [ ] **Step 1: Write the failing tests**

Create `src/data/__tests__/columnStatePersistence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ColumnFilterManager } from "../ColumnFilterManager";
import type { AppSettings } from "../PersistenceService";
import type { DatasetMetadata } from "../types";
import { hydrateColumnState, withColumnFilters, withColumnSorts } from "../columnStatePersistence";

const META = {
  name: "t",
  totalRows: 0,
  totalColumns: 2,
  columns: [
    { name: "id", dataType: "INTEGER" },
    { name: "name", dataType: "VARCHAR" },
  ],
} as unknown as DatasetMetadata;

describe("withColumnFilters / withColumnSorts", () => {
  it("sets the dataset entry and leaves other datasets alone", () => {
    const next = withColumnFilters({ columnFilters: { u: [] } }, "t", [{ columnName: "id", filterType: "include", values: ["1"] }]);
    expect(next.columnFilters).toEqual({ u: [], t: [{ columnName: "id", filterType: "include", values: ["1"] }] });
  });

  it("removes the key when the list is empty", () => {
    const next = withColumnSorts({ columnSorts: { t: [{ columnName: "id", direction: "asc" }] } }, "t", []);
    expect(next.columnSorts).toEqual({});
  });

  it("does not mutate the input", () => {
    const input: AppSettings = { columnFilters: {} };
    withColumnFilters(input, "t", [{ columnName: "id", filterType: "include", values: ["1"] }]);
    expect(input.columnFilters).toEqual({});
  });
});

describe("hydrateColumnState", () => {
  it("loads hidden columns, order, filters and sorts for live columns", () => {
    const fm = new ColumnFilterManager();
    hydrateColumnState(
      fm,
      {
        hiddenColumns: { t: ["name", "gone"] },
        columnOrder: { t: ["name", "id", "gone"] },
        columnFilters: { t: [{ columnName: "id", filterType: "range", min: 1, max: 2 }] },
        columnSorts: { t: [{ columnName: "name", direction: "desc" }] },
      },
      META,
    );
    expect(fm.getHiddenColumns("t")).toEqual(["name"]);
    expect(fm.getColumnOrder("t")).toEqual(["name", "id"]);
    expect(fm.getFilters("t")).toHaveLength(1);
    expect(fm.getSorts("t")).toEqual([{ columnName: "name", direction: "desc" }]);
  });

  it("hydrates filters before hidden columns so an onChange subscriber never sees an empty list", () => {
    // Mirrors BedevereApp: a subscriber that writes the filter list on
    // every change. If hidden columns were applied first, that write would
    // happen while the filters were still empty and erase them.
    const fm = new ColumnFilterManager();
    let settings: AppSettings = {
      hiddenColumns: { t: ["name"] },
      columnFilters: { t: [{ columnName: "id", filterType: "include", values: ["1"] }] },
    };
    fm.onChange((name) => {
      settings = withColumnFilters(settings, name, fm.getFilters(name));
    });
    hydrateColumnState(fm, settings, META);
    expect(settings.columnFilters?.t).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun x vitest run src/data/__tests__/columnStatePersistence.test.ts`
Expected: FAIL, cannot resolve `../columnStatePersistence`.

- [ ] **Step 3: Implement the module**

Create `src/data/columnStatePersistence.ts`:

```ts
/**
 * Per-dataset column state (hidden columns, column order, filters,
 * sorts) in and out of AppSettings. Keyed by dataset name, which is the
 * DuckDB table name; two environments with a same-named table share an
 * entry. Known and accepted, see the design spec.
 */

import type { ColumnFilter, ColumnFilterManager, SortConfig } from "./ColumnFilterManager";
import type { AppSettings } from "./PersistenceService";
import type { DatasetMetadata } from "./types";

/**
 * Load everything persisted for `metadata.name` into the filter manager.
 * Runs before the dataset's tab is built (TabManager's before-add hook),
 * so the first render is already projected and filtered.
 *
 * Order matters: filters and sorts first, through the silent `hydrate`;
 * hidden columns and order after, because those setters fire `onChange`
 * and the subscriber in BedevereApp rewrites the persisted filter list
 * from the manager on every change. Doing it the other way round would
 * erase the persisted filters before they were loaded.
 */
export function hydrateColumnState(fm: ColumnFilterManager, settings: AppSettings, metadata: DatasetMetadata): void {
  const name = metadata.name;
  fm.hydrate(name, { filters: settings.columnFilters?.[name], sorts: settings.columnSorts?.[name] }, metadata.columns);

  const live = new Set(metadata.columns.map((c) => c.name));
  const hidden = (settings.hiddenColumns?.[name] ?? []).filter((c) => live.has(c));
  if (hidden.length > 0) fm.setHiddenColumns(name, hidden);
  const order = (settings.columnOrder?.[name] ?? []).filter((c) => live.has(c));
  if (order.length > 0) fm.setColumnOrder(name, order);
}

/** Settings with the dataset's filter list replaced; an empty list removes the key. */
export function withColumnFilters(settings: AppSettings, datasetName: string, filters: ColumnFilter[]): AppSettings {
  const next = { ...(settings.columnFilters ?? {}) };
  if (filters.length === 0) delete next[datasetName];
  else next[datasetName] = filters;
  return { ...settings, columnFilters: next };
}

/** Settings with the dataset's sort chain replaced; an empty list removes the key. */
export function withColumnSorts(settings: AppSettings, datasetName: string, sorts: SortConfig[]): AppSettings {
  const next = { ...(settings.columnSorts ?? {}) };
  if (sorts.length === 0) delete next[datasetName];
  else next[datasetName] = sorts;
  return { ...settings, columnSorts: next };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `bun x vitest run src/data/__tests__/columnStatePersistence.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire BedevereApp**

In `src/components/BedevereApp/BedevereApp.ts` add the import next to the other `../../data/…` imports:

```ts
import { hydrateColumnState, withColumnFilters, withColumnSorts } from "../../data/columnStatePersistence";
```

Replace the whole `this.tabManager.setOnBeforeAddDatasetCallback((metadata) => { … });` block (lines 542-560, the body that restores hidden columns and column order) with:

```ts
    this.tabManager.setOnBeforeAddDatasetCallback((metadata) => {
      hydrateColumnState(this.tabManager.getFilterManager(), this.persistenceService.loadAppSettings(), metadata);
    });

    // Filters and sorts persist on every change. Hidden columns and
    // column order keep their own persist calls in the callbacks below;
    // this subscriber writes only the two lists it owns.
    this.tabManager.getFilterManager().onChange((datasetName) => {
      const fm = this.tabManager.getFilterManager();
      let settings = this.persistenceService.loadAppSettings();
      settings = withColumnFilters(settings, datasetName, fm.getFilters(datasetName));
      settings = withColumnSorts(settings, datasetName, fm.getSorts(datasetName));
      this.persistenceService.saveAppSettings(settings);
    });
```

Keep the comment above the block that explains why the hook runs before the visualizer is constructed; it is still accurate.

- [ ] **Step 6: Type check and run the full suite**

Run: `bun x tsc --noEmit` then `bun x vitest run`
Expected: exit 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/data/columnStatePersistence.ts src/data/__tests__/columnStatePersistence.test.ts src/components/BedevereApp/BedevereApp.ts
git commit -m "$(printf 'Restore: persist column filters and sorts, hydrate them before the tab opens\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 6: ControlPanel records the dataset-tab workspace

**Files:**
- Modify: `src/components/ControlPanel/ControlPanel.ts`
  - imports (top of file)
  - fields near `lastActiveEnvId` (~line 130)
  - constructor, after the `environmentService.onChange` subscription (~line 234)
  - `openFilePicker` node minting (684-700)
  - `addDataset` end (~line 350), `markDatasetAsLoaded` (352-362), `markDatasetAsDropped` (370-383), `markAllAsUnloaded` (393-411), `markDatasetAsUnloaded` (413-424)
  - `handleTreeNodeClick` tracked-node block (1189-1203)
  - `importNode`, both `if (!options.silent)` tab-opening blocks (host path ~1258-1266 and File path ~1338-1343)
- Test: `src/components/ControlPanel/__tests__/ControlPanel.workspace.test.ts`

**Interfaces:**
- Consumes: `deriveDataWorkspace`, `pickedFileNodeId`, `findNodeById` (Task 2); `TabManager.getActiveTabId`, `setOnTabActivatedCallback` (Task 4); `activeDataNodeId` (Task 3).
- Produces (used by Task 7): `private workspaceSaveSuspended: boolean`, `private persistDataWorkspace(): void`, `private async openNodeAsTab(node: FileTreeNode): Promise<{ ok: true } | { ok: false; error: { message: string; details?: string } }>`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ControlPanel/__tests__/ControlPanel.workspace.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun x vitest run src/components/ControlPanel/__tests__/ControlPanel.workspace.test.ts`
Expected: FAIL, `panel.persistDataWorkspace is not a function`.

- [ ] **Step 3: Imports and fields**

Add to the imports in `ControlPanel.ts`:

```ts
import { deriveDataWorkspace, findNodeById, pickedFileNodeId } from "../../data/workspaceRestore";
```

After the field `private lastActiveEnvId: string | null = null;` add:

```ts
  /**
   * True while applyActiveEnvironment tears down and rebuilds tabs.
   * persistDataWorkspace is a no-op meanwhile: the teardown closes
   * every tab after the active environment has already switched, so
   * without the guard it would write a shrinking list into the incoming
   * environment and the restore would find nothing to reopen.
   */
  private workspaceSaveSuspended = false;
```

- [ ] **Step 4: The save method and the activation hook**

Add this method to the class (for example right after `markDatasetAsUnloaded`):

```ts
  /**
   * Record which dataset tabs are open (display order) and which one is
   * active into the active environment's workspace. Everything else in
   * the workspace (query tabs, the editor's active tab) is left as is.
   * Called on every open, close and activation; cheap, and the
   * persistence backend debounces the actual write.
   */
  private persistDataWorkspace(): void {
    if (this.workspaceSaveSuspended) return;
    const envId = environmentService.getActiveId();
    const env = envId ? environmentService.get(envId) : null;
    if (!env) return;
    const derived = deriveDataWorkspace(this.tabManager.getDatasetIds(), this.tabManager.getActiveTabId(), this.fileTree);
    environmentService.setWorkspace(env.id, {
      ...env.workspace,
      openDataNodeIds: derived.openDataNodeIds,
      activeDataNodeId: derived.activeDataNodeId,
    });
  }
```

In the constructor, right after the `this.envUnsubscribe = environmentService.onChange(() => { … });` statement, add:

```ts
    // Tab activation is the one transition that does not pass through a
    // panel method; hook it so the active dataset tab is recorded too.
    this.tabManager.setOnTabActivatedCallback(() => this.persistDataWorkspace());
```

- [ ] **Step 5: Save at every open and close**

Add `this.persistDataWorkspace();` as the last statement of each of these methods, before any `return`: `addDataset` (after the `if (!alreadyTracked) { … }` block), `markDatasetAsLoaded`, `markDatasetAsUnloaded`, `markDatasetAsDropped` (after `this.renderTree();`), `markAllAsUnloaded` (after `this.renderTree();`).

In `importNode`, both non-silent tab-opening blocks currently end with `this.onSelectCallback?.(provider);`. Add `this.persistDataWorkspace();` right after that line in both blocks (host path and File path).

- [ ] **Step 6: Extract `openNodeAsTab` and use it from the click handler**

Add the method (next to `importNode`):

```ts
  /**
   * Open a tab for `node`. A node that was imported before (silently by
   * the folder auto-import, or explicitly) reuses its cached table and
   * provider; anything else goes through importNode. Shared by the tree
   * click handler and the session restore.
   */
  private async openNodeAsTab(
    node: FileTreeNode,
  ): Promise<{ ok: true } | { ok: false; error: { message: string; details?: string } }> {
    if (node.isUnavailable) return { ok: false, error: { message: `${node.name} is unavailable` } };
    if (node.tableName) {
      const existing = this.datasets.find((d) => d.metadata.name === node.tableName);
      if (existing) {
        if (!this.tabManager.getDatasetIds().includes(existing.metadata.name)) {
          await this.tabManager.addDataset(existing.metadata, existing.dataset);
        }
        await this.tabManager.switchToDataset(existing.metadata.name);
        node.isOpenAsTab = true;
        this.treeRenderer?.updateNode(node.id, { isOpenAsTab: true });
        this.onSelectCallback?.(existing.dataset);
        this.persistDataWorkspace();
        return { ok: true };
      }
    }
    return this.importNode(node);
  }
```

In `handleTreeNodeClick`, replace the block that starts with the comment `// Already-tracked node (we've imported this file before)` and ends with the closing brace of `if (node.tableName) { … }` (lines 1185-1203) with:

```ts
    // Already-tracked node (imported before): reuse the cached table so
    // there is no duplicate import and no duplicate tab registration.
    if (node.tableName && this.datasets.some((d) => d.metadata.name === node.tableName)) {
      await this.openNodeAsTab(node);
      return;
    }
```

- [ ] **Step 7: Stable picked-file ids**

In `openFilePicker`, replace the `const newNodes: FileTreeNode[] = pathFiles.map((f) => ({ … }));` statement and the following `this.fileTree.push(...newNodes);` with:

```ts
      // One node per path, keyed by a stable id so the environment can
      // find the file again after a restart and so picking the same file
      // twice reuses the row instead of adding a twin.
      const nodes: FileTreeNode[] = [];
      const newNodes: FileTreeNode[] = [];
      for (const f of pathFiles) {
        const id = pickedFileNodeId(f.path);
        const existing = findNodeById(this.fileTree, id);
        if (existing) {
          nodes.push(existing);
          continue;
        }
        const node: FileTreeNode = {
          id,
          name: f.name,
          kind: "file",
          filePath: f.path,
          fileType: detectFileType(f.name) ?? undefined,
          isImported: false,
          isExpanded: false,
        };
        newNodes.push(node);
        nodes.push(node);
      }
      this.fileTree.push(...newNodes);
```

Keep the `environmentService.addDataset` loop over `newNodes` as it is. Change the import loop at the end of the method from `for (const node of newNodes)` to `for (const node of nodes)`.

- [ ] **Step 8: Run the tests, the type check and the whole suite**

Run: `bun x vitest run src/components/ControlPanel/__tests__/ControlPanel.workspace.test.ts`
Expected: PASS, 8 tests.

Run: `bun x tsc --noEmit` then `bun x vitest run`
Expected: exit 0; all tests pass (the existing `ControlPanel.import.test.ts` still passes: `importNode`'s new `persistDataWorkspace` call is a no-op there because no environment is active).

- [ ] **Step 9: Commit**

```bash
git add src/components/ControlPanel/ControlPanel.ts src/components/ControlPanel/__tests__/ControlPanel.workspace.test.ts
git commit -m "$(printf 'ControlPanel: record open dataset tabs and the active tab in the environment\n\nStable ids for picked single files (ipc/file/<path>), a shared\nopenNodeAsTab for the click handler and the upcoming restore, and a\npersistDataWorkspace call at every open, close and activation.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 7: ControlPanel restores the dataset tabs

**Files:**
- Modify: `src/components/ControlPanel/ControlPanel.ts`
  - imports
  - field next to `workspaceSaveSuspended`
  - `attachFolderTree` auto-import call (~836-841)
  - `applyActiveEnvironment` (925-974)
  - new methods `restorePickedFiles` and `restoreWorkspaceTabs`
- Test: `src/components/ControlPanel/__tests__/ControlPanel.restore.test.ts`

**Interfaces:**
- Consumes: `planRestore`, `pickedFilePath`, `findNodeById` (Task 2); `openNodeAsTab`, `persistDataWorkspace`, `workspaceSaveSuspended` (Task 6); `handleTreeNodeExpand` (existing, enumerates a workbook's sheets into `node.children`).
- Produces: `private pendingAutoImport: Promise<void> | null`, `private restorePickedFiles(env: Environment): void`, `private async restoreWorkspaceTabs(envId: string, saved: { openDataNodeIds: string[]; activeDataNodeId?: string }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ControlPanel/__tests__/ControlPanel.restore.test.ts`:

```ts
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
    panel.tabManager.getDatasetIds = () => ["a", "b"];
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
    const importNode = vi.fn(async () => ({ ok: true }));
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun x vitest run src/components/ControlPanel/__tests__/ControlPanel.restore.test.ts`
Expected: FAIL, `panel.restoreWorkspaceTabs is not a function`.

- [ ] **Step 3: Imports, field, and the auto-import handle**

Extend the import added in Task 6 to:

```ts
import { deriveDataWorkspace, findNodeById, pickedFileNodeId, pickedFilePath, planRestore } from "../../data/workspaceRestore";
```

and add this import (the file does not import the environment types yet):

```ts
import type { Environment } from "../../data/environments/types";
```

After the `workspaceSaveSuspended` field add:

```ts
  /**
   * The folder auto-import started by attachFolderTree, while it runs.
   * restoreWorkspaceTabs waits for it so a file that is both small
   * (auto-imported) and open reuses the cached table instead of being
   * imported twice at the same time.
   */
  private pendingAutoImport: Promise<void> | null = null;
```

In `attachFolderTree`, replace

```ts
    const leaves = this.collectFileLeaves(tree).filter((n) => !n.isImported);
    if (leaves.length > 0) {
      this.autoImportBatch(leaves).catch((err) => {
        console.error("Folder auto-import failed:", err);
      });
    }
```

with

```ts
    const leaves = this.collectFileLeaves(tree).filter((n) => !n.isImported);
    if (leaves.length > 0) {
      const batch = this.autoImportBatch(leaves)
        .catch((err) => {
          console.error("Folder auto-import failed:", err);
        })
        .finally(() => {
          if (this.pendingAutoImport === batch) this.pendingAutoImport = null;
        });
      this.pendingAutoImport = batch;
    }
```

- [ ] **Step 4: The restore methods**

Add after `persistDataWorkspace`:

```ts
  /**
   * Desktop only: files picked one at a time are not under any folder,
   * so the tree rebuild does not bring them back. Recreate their nodes
   * from the environment's dataset list; the host's grant for each path
   * survived the restart, so opening them needs no dialog. Files are
   * not imported here; restoreWorkspaceTabs opens the ones that were
   * open, the rest stay as rows to click.
   */
  private restorePickedFiles(env: Environment): void {
    if (!this.fileSource || this.fileSource.id === "fsa") return;
    let added = false;
    for (const ds of env.datasets) {
      const path = pickedFilePath(ds.nodeId);
      if (!path || findNodeById(this.fileTree, ds.nodeId)) continue;
      this.fileTree.push({
        id: ds.nodeId,
        name: ds.name,
        kind: "file",
        filePath: path,
        fileType: detectFileType(ds.name) ?? undefined,
        isImported: false,
        isExpanded: false,
      });
      added = true;
    }
    if (added) this.renderTree();
  }

  /**
   * Reopen the dataset tabs saved for `envId`, in order, then activate
   * the saved one. Every failure is skipped and reported once. Stops
   * early if the active environment changes underneath (the user
   * switched while tabs were still opening), leaving the other
   * environment's apply run in charge.
   */
  private async restoreWorkspaceTabs(
    envId: string,
    saved: { openDataNodeIds: string[]; activeDataNodeId?: string },
  ): Promise<void> {
    if (saved.openDataNodeIds.length === 0) return;
    if (this.pendingAutoImport) await this.pendingAutoImport;
    if (environmentService.getActiveId() !== envId) return;

    const plan = planRestore(saved.openDataNodeIds, this.fileTree);
    const missing = [...plan.missing];
    let opened = 0;
    for (const step of plan.steps) {
      if (environmentService.getActiveId() !== envId) return;
      let node: FileTreeNode | undefined;
      if (step.kind === "node") {
        node = step.node;
      } else {
        await this.handleTreeNodeExpand(step.workbook);
        node = step.workbook.children?.find((c) => c.id === step.id);
        if (!node) {
          missing.push(`${step.workbook.name} / ${step.sheetName}`);
          continue;
        }
      }
      const result = await this.openNodeAsTab(node);
      if (result.ok) {
        opened++;
      } else {
        node.isUnavailable = true;
        this.treeRenderer?.updateNode(node.id, { isUnavailable: true });
        missing.push(node.name);
      }
    }

    if (saved.activeDataNodeId && environmentService.getActiveId() === envId) {
      const active = findNodeById(this.fileTree, saved.activeDataNodeId);
      if (active?.tableName && this.tabManager.getDatasetIds().includes(active.tableName)) {
        await this.tabManager.switchToDataset(active.tableName);
      }
    }

    if (missing.length > 0) {
      this.onShowMessageCallback?.(
        `Restored ${opened} of ${saved.openDataNodeIds.length} tabs. Missing: ${missing.join(", ")}`,
        "warning",
      );
    }
  }
```

`FileTreeRenderer.updateNode` takes a `Partial<FileTreeNode>`; if `isUnavailable` is not among the fields it reads, the call is harmless and the full `renderTree()` on the next change picks the flag up.

- [ ] **Step 5: Restore inside `applyActiveEnvironment`**

Replace the body of `applyActiveEnvironment` (from `const openIds = this.tabManager.getDatasetIds();` to the closing brace of the `if (env.kind === "folder" && env.folderHandleId) { … }` block) with:

```ts
    // Saving is suspended for the whole apply: the active id has already
    // moved to `envId`, so the tab closes below would otherwise write a
    // shrinking list into the incoming environment.
    this.workspaceSaveSuspended = true;
    try {
      // Close every open dataset tab. The TabManager API works by name;
      // snapshot first so we don't mutate while iterating.
      const openIds = this.tabManager.getDatasetIds();
      for (const id of openIds) {
        this.tabManager.closeDataset(id);
      }

      // Wipe every user-created object in DuckDB's `main` schema. Without
      // this, switching from env A to env B leaves env A's tables, views,
      // macros and types visible in autocomplete + reachable by SQL —
      // confusing because the panel says they aren't part of B, but the
      // engine still knows them. The new env's datasets re-import below
      // through `openRecentFolder` / silent-import.
      const backend = this.tabManager.getBackend();
      if (backend && backend.wipeUserState) {
        try {
          await backend.wipeUserState();
        } catch (err) {
          console.warn("applyActiveEnvironment: wipeUserState failed", err);
        }
      }

      // Reset the panel's in-memory state.
      this.fileTree = [];
      this.datasets = [];
      this.renderTree();
      this.renderSavedQueries();

      const env = environmentService.get(envId);
      if (!env) return;
      // Snapshot the saved tab list before anything below can touch it.
      const saved = {
        openDataNodeIds: [...env.workspace.openDataNodeIds],
        activeDataNodeId: env.workspace.activeDataNodeId,
      };

      if (env.kind === "folder" && env.folderHandleId) {
        if (env.folderHandleId.startsWith("ipc:")) {
          // Desktop / IPC env: re-acquire by path via the host.
          await this.restoreIpcFolder(env.folderHandleId.slice("ipc:".length));
        } else if (this.fileSource && this.fileSource.id !== "fsa") {
          // Non-FSA runtime + an env saved before the "ipc:" prefix
          // landed. The id is a raw OS path; route it through the host.
          // (FSA envs viewed under a non-FSA fileSource will fail the
          // openFolder check inside restoreIpcFolder and surface the
          // standard "no longer accessible" toast — acceptable; the
          // user re-picks via Open Folder.)
          await this.restoreIpcFolder(env.folderHandleId);
        } else {
          // FSA env: re-scan via the recent-folder pathway. It already
          // handles permission prompts and stale-handle cleanup.
          await this.openRecentFolder(env.folderHandleId);
        }
      }

      // A folder env whose folder could not be re-acquired (moved, drive
      // unplugged, web permission denied) leaves an empty tree. Restore
      // nothing and, below, save nothing: the saved list stays as it is
      // so the next successful open brings the tabs back.
      const needsFolder = env.kind === "folder" && !!env.folderHandleId;
      if (needsFolder && this.fileTree.length === 0) return;

      this.restorePickedFiles(env);
      await this.restoreWorkspaceTabs(envId, saved);
      restoreRan = true;
    } finally {
      this.workspaceSaveSuspended = false;
    }
    // One save with what actually opened, so a file that disappeared
    // drops out of the list cleanly.
    if (restoreRan && environmentService.getActiveId() === envId) this.persistDataWorkspace();
```

and declare the flag as the first line of the method body, before `this.workspaceSaveSuspended = true;`:

```ts
    let restoreRan = false;
```

- [ ] **Step 6: Run the tests, the type check and the whole suite**

Run: `bun x vitest run src/components/ControlPanel/__tests__/ControlPanel.restore.test.ts`
Expected: PASS, 11 tests.

Run: `bun x tsc --noEmit` then `bun x vitest run`
Expected: exit 0; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/ControlPanel/ControlPanel.ts src/components/ControlPanel/__tests__/ControlPanel.restore.test.ts
git commit -m "$(printf 'ControlPanel: reopen the saved dataset tabs when an environment is applied\n\nAfter the folder tree is rebuilt (and the silent auto-import has\nfinished), the saved tabs reopen in order and the saved one is\nactivated. Picked single files get their tree rows back on desktop.\nMissing or failing files are skipped and reported once in the status\nbar. Saving is suspended during the apply so the tab teardown cannot\noverwrite the incoming environment, and the loop stops if the user\nswitches environments meanwhile.\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
```

---

### Task 8: Changelog, library build, end-to-end check

**Files:**
- Modify: `CHANGELOG.md` (the `## Unreleased` section)
- Modify: `../bedevere-desktop/renderer/dist/index.html` (build output, not committed)

- [ ] **Step 1: Changelog entries**

Add these bullets at the top of the `## Unreleased` list in `CHANGELOG.md`:

```markdown
- [Feature] **The workspace comes back on restart.** Open dataset tabs reopen in the same order, the tab you were on is active again, and each dataset's column filters and sorts are applied before its tab renders. Folder environments and picked files (desktop) restore without a dialog; dropped files cannot, since they have no stable path. A file that disappeared is skipped and reported once in the status bar ("Restored 2 of 3 tabs. Missing: …"). Internals: `openDataNodeIds` and a new `activeDataNodeId` in the environment workspace, `columnFilters` / `columnSorts` in app settings keyed by dataset name like hidden columns, `ColumnFilterManager.hydrate`, and the save/restore steps in `ControlPanel` around `applyActiveEnvironment`.
- [Bug-fix] **Desktop: settings, environments and query tabs survive a restart.** The host's persistence RPCs were stubs; bedevere-desktop now stores the renderer snapshot in `%LOCALAPPDATA%\bedevere\persistence.json` (see the desktop changelog).
- [Change] **Picked single files on desktop have stable tree ids** (`ipc/file/<path>`), and picking an already-listed file reuses its row.
```

- [ ] **Step 2: Rebuild the library the desktop renderer links**

Run: `bun run build:lib`
Expected: `✓ built` with no type errors.

- [ ] **Step 3: Build the desktop renderer and shell against both branches**

From PowerShell:

```powershell
Set-Location C:\Users\massi\source\repos\kolistat\bedevere-desktop
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notmatch 'cygwin' }) -join ';'
$env:PATH = "C:\Program Files (x86)\Microsoft Visual Studio\Installer;" + $env:PATH
Set-Location renderer; bun run build; Set-Location ..
(Get-Item "packaging\windows\app.rc").LastWriteTime = Get-Date
cmd /c "call ""C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"" -arch=x64 -no_logo && ""C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"" --build build/build/Release --target bedevere-desktop"
```

Expected: renderer typecheck and bundle succeed; the shell relinks.

- [ ] **Step 4: End-to-end script (web via `bun run dev`, desktop via the built exe)**

1. Open a folder with at least three files including a workbook. Open two file tabs and one sheet tab. Apply a value filter on one, a sort on another. Click the second tab. Widen the panel.
2. Close and reopen. Expect: the same three tabs in that order, the second active, the filter and sort badges present, the panel width kept, the query tabs as before.
3. Rename one of the opened files on disk, reopen. Expect: the other tabs back, one status line "Restored 2 of 3 tabs. Missing: <name>".
4. Desktop: confirm `%LOCALAPPDATA%\bedevere\persistence.json` exists; replace its content with garbage; the app starts clean. Web: deny the folder permission once; nothing opens; allow on the next start; the tabs come back.

- [ ] **Step 5: Commit and open the PRs**

```bash
git add CHANGELOG.md
git commit -m "$(printf 'Changelog: session restore\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>')"
git push -u origin feature/session-restore
gh pr create --base dev-0.16 --head feature/session-restore --title "Session restore: reopen dataset tabs, active tab, filters and sorts" --body "See docs/superpowers/specs/2026-10-07-session-restore-design.md and docs/superpowers/plans/2026-10-07-session-restore.md. Desktop host store: KoliStat/bedevere-desktop PR (feature/persistence-store)."
cd ../bedevere-desktop
git push -u origin feature/persistence-store
gh pr create --base dev-0.16 --head feature/persistence-store --title "Persistence: store the renderer snapshot in persistence.json" --body "Implements the host side of bedevere-wise docs/superpowers/specs/2026-10-07-session-restore-design.md (section 1). Independent of the renderer PR; ships alone."
```

Add the `🤖 Generated with [Claude Code](https://claude.com/claude-code)` line to both PR bodies.
