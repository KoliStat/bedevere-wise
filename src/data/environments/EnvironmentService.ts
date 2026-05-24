import { persistenceService } from "../PersistenceService";
import {
  emptyWorkspaceState,
  Environment,
  EnvironmentDataset,
  EnvironmentKind,
  EnvironmentQuery,
  EnvironmentWorkspaceState,
} from "./types";

/**
 * Owner of the environment list, the active env, and the mutations
 * that change either. The single entry point for everything that
 * touches `bedevere_environments` storage — consistent with the rest
 * of the data layer (`AliasManager`, `KeymapService`, …) which all
 * route writes through `PersistenceService`.
 *
 * The service is a singleton (`environmentService`); it's instantiated
 * once at module load, runs the legacy-queries migration the first
 * time, and stays alive for the lifetime of the page. Consumers
 * subscribe via `onChange` and re-read state when fired.
 *
 * Design choices baked in here (see the planning doc for context):
 *   - Stable opaque ids for every entity. `id` survives renames;
 *     `name` is purely cosmetic.
 *   - JSON-serializable payloads — no DOM, no FSA handles. The
 *     `folderHandleId` indirection lets us look the live handle up
 *     from PersistenceService when we actually need to scan.
 *   - Per-mutation `onChange` fire; consumers re-read whichever
 *     getter they care about. No fine-grained diff events yet (would
 *     be premature given the small fan-out today).
 *   - Schema-versioning on the envelope and per-environment so future
 *     migrations key off a number rather than feature-sniffing the
 *     shape.
 */
export class EnvironmentService {
  private environments: Environment[] = [];
  private activeId: string | null = null;
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.load();
  }

  // ---- Read APIs ------------------------------------------------------

  /** Snapshot of the current list. Returns a fresh array; callers may
   *  iterate freely without mutating internal state. */
  public list(): Environment[] {
    return this.environments.slice();
  }

  public get(id: string): Environment | null {
    return this.environments.find((e) => e.id === id) ?? null;
  }

  public getActive(): Environment | null {
    return this.activeId ? this.get(this.activeId) : null;
  }

  public getActiveId(): string | null {
    return this.activeId;
  }

  /** Look up an env by its bound folder handle id. Used by the
   *  folder-import hook to reuse an existing env when the user
   *  re-opens the same folder. */
  public findByFolderHandleId(folderHandleId: string): Environment | null {
    return this.environments.find((e) => e.folderHandleId === folderHandleId) ?? null;
  }

  /** The reserved default env — always present, never deleted. */
  public getDefault(): Environment {
    const def = this.environments.find((e) => e.kind === "default");
    if (def) return def;
    // Defensive: re-create if somehow missing. Persists immediately
    // so subsequent loads see it. The plan invariant is "always at
    // least one env, and exactly one with kind === 'default'".
    const fresh = this.makeDefaultEnv();
    this.environments.unshift(fresh);
    this.persist();
    return fresh;
  }

  // ---- Active selection -----------------------------------------------

  public setActive(id: string): void {
    const env = this.get(id);
    if (!env) return;
    if (this.activeId === id) return;
    this.activeId = id;
    env.lastUsedAt = Date.now();
    this.persistActive();
    this.persist();
    this.emit();
  }

  // ---- Environment lifecycle ------------------------------------------

  public create(args: {
    name: string;
    kind: Exclude<EnvironmentKind, "default">;
    folderHandleId?: string;
  }): Environment {
    const env: Environment = {
      schemaVersion: 1,
      id: generateId("env"),
      name: args.name,
      kind: args.kind,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      folderHandleId: args.folderHandleId,
      datasets: [],
      queries: [],
      workspace: emptyWorkspaceState(),
    };
    this.environments.push(env);
    this.persist();
    this.emit();
    return env;
  }

  public rename(id: string, newName: string): void {
    const env = this.get(id);
    if (!env) return;
    const trimmed = newName.trim();
    if (!trimmed || env.name === trimmed) return;
    env.name = trimmed;
    this.persist();
    this.emit();
  }

  /** Delete an env. The default env is refused (it's the catch-all
   *  for single-file imports and the migration target). */
  public delete(id: string): void {
    const env = this.get(id);
    if (!env) return;
    if (env.kind === "default") {
      throw new Error("Cannot delete the default environment.");
    }
    this.environments = this.environments.filter((e) => e.id !== id);
    // If the deleted env was active, fall back to default.
    if (this.activeId === id) {
      this.activeId = this.getDefault().id;
      this.persistActive();
    }
    this.persist();
    this.emit();
  }

  // ---- Datasets -------------------------------------------------------

  public addDataset(envId: string, dataset: EnvironmentDataset): void {
    const env = this.get(envId);
    if (!env) return;
    // Deduplicate by nodeId — re-adding is idempotent so the
    // folder-import hook can safely re-run on every refresh.
    if (env.datasets.some((d) => d.nodeId === dataset.nodeId)) return;
    env.datasets.push(dataset);
    this.persist();
    this.emit();
  }

  public removeDataset(envId: string, nodeId: string): void {
    const env = this.get(envId);
    if (!env) return;
    const before = env.datasets.length;
    env.datasets = env.datasets.filter((d) => d.nodeId !== nodeId);
    if (env.datasets.length === before) return;
    this.persist();
    this.emit();
  }

  // ---- Queries --------------------------------------------------------

  public addQuery(envId: string, partial: { name: string; sql?: string }): EnvironmentQuery | null {
    const env = this.get(envId);
    if (!env) return null;
    const now = Date.now();
    const q: EnvironmentQuery = {
      id: generateId("q"),
      name: partial.name,
      sql: partial.sql ?? "",
      createdAt: now,
      updatedAt: now,
    };
    env.queries.push(q);
    this.persist();
    this.emit();
    return q;
  }

  public updateQuery(envId: string, queryId: string, patch: Partial<Pick<EnvironmentQuery, "name" | "sql">>): void {
    const env = this.get(envId);
    if (!env) return;
    const q = env.queries.find((x) => x.id === queryId);
    if (!q) return;
    let changed = false;
    if (patch.name !== undefined && patch.name.trim() !== q.name) {
      q.name = patch.name.trim();
      changed = true;
    }
    if (patch.sql !== undefined && patch.sql !== q.sql) {
      q.sql = patch.sql;
      changed = true;
    }
    if (!changed) return;
    q.updatedAt = Date.now();
    this.persist();
    this.emit();
  }

  /**
   * Remove all `untitled-N.sql` queries that are NOT in the current
   * `openQueryIds`. Recovery helper for the v0.12 recursive-apply bug
   * (see commit history for SqlEditor.applyEnvironment) which spawned
   * hundreds of orphan untitleds. Safe to call on a healthy env —
   * no-op when no orphans match.
   *
   * Named queries (joins.sql, my-query.sql, …) and untitleds the user
   * is actively editing are preserved.
   *
   * Returns the count removed so the caller can report it.
   */
  public cleanupOrphanUntitled(envId: string): number {
    const env = this.get(envId);
    if (!env) return 0;
    const openSet = new Set(env.workspace.openQueryIds);
    const orphanRe = /^untitled-\d+\.sql$/;
    const before = env.queries.length;
    env.queries = env.queries.filter(
      (q) => openSet.has(q.id) || !orphanRe.test(q.name),
    );
    const removed = before - env.queries.length;
    if (removed === 0) return 0;
    this.persist();
    this.emit();
    return removed;
  }

  public deleteQuery(envId: string, queryId: string): void {
    const env = this.get(envId);
    if (!env) return;
    const before = env.queries.length;
    env.queries = env.queries.filter((q) => q.id !== queryId);
    if (env.queries.length === before) return;
    // Also strip the id from the open-tab list if it was sitting there.
    env.workspace.openQueryIds = env.workspace.openQueryIds.filter((id) => id !== queryId);
    if (env.workspace.activeTab?.kind === "query" && env.workspace.activeTab.id === queryId) {
      env.workspace.activeTab = undefined;
    }
    this.persist();
    this.emit();
  }

  // ---- Workspace ------------------------------------------------------

  public setWorkspace(envId: string, state: EnvironmentWorkspaceState): void {
    const env = this.get(envId);
    if (!env) return;
    env.workspace = state;
    this.persist();
    // Workspace updates are noisy (every tab switch); the editor / panel
    // that just called us already knows about the change, so no emit
    // here — listeners would just churn.
  }

  // ---- Subscription ---------------------------------------------------

  public onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Internals ------------------------------------------------------

  private emit(): void {
    // Snapshot the listener set before iterating in case one of them
    // unsubscribes during dispatch (would otherwise mutate during for-of).
    const snapshot = Array.from(this.listeners);
    for (const fn of snapshot) {
      try { fn(); }
      catch (err) { console.error("EnvironmentService listener failed:", err); }
    }
  }

  private persist(): void {
    persistenceService.saveEnvironmentsFile({
      schemaVersion: 1,
      environments: this.environments,
    });
  }

  private persistActive(): void {
    const settings = persistenceService.loadAppSettings();
    settings.activeEnvironmentId = this.activeId ?? undefined;
    persistenceService.saveAppSettings(settings);
  }

  private load(): void {
    const stored = persistenceService.loadEnvironmentsFile();
    if (stored && stored.environments.length > 0) {
      this.environments = stored.environments;
    } else {
      // First load: bootstrap. Migration of legacy `bedevere_queries`
      // runs here too — only on the path where there are no envs yet.
      this.environments = [this.makeDefaultEnv()];
      const settings = persistenceService.loadAppSettings();
      if (!settings.queriesMigratedToEnv) {
        const legacy = persistenceService.loadQueryBookmarks();
        if (legacy.length > 0) {
          const def = this.environments[0];
          for (const lb of legacy) {
            def.queries.push({
              id: generateId("q"),
              name: lb.name,
              sql: lb.sql,
              createdAt: lb.createdAt,
              updatedAt: lb.createdAt,
            });
          }
        }
        settings.queriesMigratedToEnv = true;
        persistenceService.saveAppSettings(settings);
      }
      this.persist();
    }

    // Restore active env, falling back to default if the stored id
    // doesn't resolve (env was deleted on a previous session, etc.).
    const settings = persistenceService.loadAppSettings();
    const candidate = settings.activeEnvironmentId;
    const resolved = candidate ? this.get(candidate) : null;
    this.activeId = (resolved ?? this.getDefault()).id;

    // If the resolved active diverges from what was stored, keep
    // storage in sync so the next session opens to the same place.
    if (settings.activeEnvironmentId !== this.activeId) {
      settings.activeEnvironmentId = this.activeId;
      persistenceService.saveAppSettings(settings);
    }
  }

  private makeDefaultEnv(): Environment {
    const now = Date.now();
    return {
      schemaVersion: 1,
      id: generateId("env"),
      name: "default",
      kind: "default",
      createdAt: now,
      lastUsedAt: now,
      datasets: [],
      queries: [],
      workspace: emptyWorkspaceState(),
    };
  }
}

/**
 * Stable opaque id with a short prefix so logs / inspector views can
 * distinguish env vs query at a glance. `crypto.randomUUID()` is
 * available in every browser the app supports; the fallback covers
 * the test runner path (jsdom older than 22).
 */
function generateId(prefix: "env" | "q"): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export const environmentService = new EnvironmentService();
