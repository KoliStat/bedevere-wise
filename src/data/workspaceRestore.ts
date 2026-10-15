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
