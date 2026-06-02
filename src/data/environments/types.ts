/**
 * Environment data model — see ~/.claude/plans/logical-finding-hejlsberg.md
 * for the design rationale.
 *
 * An environment is a named, switchable workspace container that holds:
 *   - the user's files (referenced by stable FileTreeNode id, not by
 *     DuckDB table name — DuckDB state is ephemeral and gets rebuilt
 *     on env activation),
 *   - the user's saved/open SQL queries,
 *   - which data tabs and query tabs were last open + which was active.
 *
 * Folder imports create a "folder" env automatically. Drops without a
 * folder context go into the singleton "default" env. The reserved
 * `"single-file"` kind isn't used yet but is left in the type so future
 * "every drop gets its own env" UX can land without a schema bump.
 *
 * Every persisted object carries a `schemaVersion` so future shape
 * changes can migrate cleanly without flag-day breakage. References
 * between entities (env → query, env → dataset, workspace → tab) use
 * opaque, stable ids so user-visible names can change freely.
 */

export type EnvironmentKind = "folder" | "default" | "single-file";

export interface EnvironmentQuery {
  /** Stable uuid-ish identifier, survives renames. */
  id: string;
  /** User-facing filename (e.g. "untitled-1.sql", "join_demo.sql"). */
  name: string;
  sql: string;
  createdAt: number;
  updatedAt: number;
}

export interface EnvironmentDataset {
  /**
   * Reference to a FileTreeNode by its stable `id`. The env owns the
   * "this file belongs to my workspace" fact; the DuckDB table name
   * is derived on import and lives only in the FileTreeNode while the
   * page is loaded.
   */
  nodeId: string;
  /** Last-known display name; persisted so the env can describe its
   *  contents even before the tree is loaded (e.g. in a switcher
   *  tooltip). */
  name: string;
  /** Tree-relative path (`subfolder/file.csv`) so a folder env re-
   *  opened on a fresh page can re-acquire the file under the picked
   *  directory handle without relying on absolute paths. */
  relativePath: string;
}

export interface EnvironmentWorkspaceState {
  /** Open data tabs in display order. References `EnvironmentDataset.nodeId`. */
  openDataNodeIds: string[];
  /** Open query tabs in display order. References `EnvironmentQuery.id`. */
  openQueryIds: string[];
  /** Last-active tab when the env was last left. */
  activeTab?: { kind: "data" | "query"; id: string };
}

export interface Environment {
  /** Per-environment schema version — bump when this shape changes. */
  schemaVersion: 1;
  id: string;
  /** User-editable label. Defaults to the folder basename. */
  name: string;
  kind: EnvironmentKind;
  createdAt: number;
  lastUsedAt: number;
  /**
   * IDB key into the `folder_handles` store when `kind === "folder"`.
   * We store the key, not the handle itself, so the env stays
   * JSON-serializable for future sync.
   */
  folderHandleId?: string;
  datasets: EnvironmentDataset[];
  queries: EnvironmentQuery[];
  workspace: EnvironmentWorkspaceState;
}

/**
 * On-disk envelope around the environment list. Top-level schema
 * version is independent of the per-environment one — they may bump
 * at different cadences.
 */
export interface EnvironmentsFile {
  schemaVersion: 1;
  environments: Environment[];
}

/** Empty workspace state — used when bootstrapping a fresh env. */
export function emptyWorkspaceState(): EnvironmentWorkspaceState {
  return { openDataNodeIds: [], openQueryIds: [] };
}
