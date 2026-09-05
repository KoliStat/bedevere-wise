import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentService } from "../EnvironmentService";
import { persistenceService } from "../../PersistenceService";
import { LocalStoragePersistenceBackend } from "../../persistence/LocalStoragePersistenceBackend";
import { FakeKvPersistenceBackend } from "../../../test/FakeKvPersistenceBackend";
import type { EnvironmentsFile } from "../types";

/**
 * Desktop boot order regression tests.
 *
 * On bedevere-desktop the renderer imports the app bundle FIRST (which
 * constructs the module-level `environmentService` singleton) and only
 * then swaps `persistenceService`'s backend to the IPC file store:
 *
 *   import { BedevereApp, persistenceService } from ".../app";  // ← import time
 *   ...
 *   persistenceService.setBackend(ipcPersistence);              // ← boot time
 *
 * If EnvironmentService hydrates at construction (import time), it reads
 * the wrong substrate (webview localStorage) and every environment/query
 * written during the session lands in a file the next launch never reads
 * — queries silently vanish across restarts. Hydration must be deferred
 * to first use.
 */

const NOW = 1_700_000_000_000;

function environmentsFileWithQuery(queryName: string): EnvironmentsFile {
  return {
    schemaVersion: 1,
    environments: [
      {
        schemaVersion: 1,
        id: "env_test",
        name: "default",
        kind: "default",
        createdAt: NOW,
        lastUsedAt: NOW,
        datasets: [],
        queries: [
          { id: "q_test", name: queryName, sql: "SELECT 1", createdAt: NOW, updatedAt: NOW },
        ],
        workspace: {
          openDataNodeIds: [],
          openQueryIds: ["q_test"],
          activeTab: { kind: "query", id: "q_test" },
        },
      },
    ],
  };
}

afterEach(() => {
  persistenceService.setBackend(new LocalStoragePersistenceBackend());
  localStorage.clear();
});

describe("EnvironmentService hydration vs. setBackend ordering", () => {
  it("reads through the backend installed at first use, not at construction", () => {
    // Constructed at import time (before the host installs its backend)…
    const svc = new EnvironmentService();

    // …then the desktop boot swaps in the real store.
    const fake = new FakeKvPersistenceBackend();
    fake.setItem(
      "bedevere_environments",
      JSON.stringify(environmentsFileWithQuery("from-disk.sql")),
    );
    persistenceService.setBackend(fake);

    const names = svc.list().flatMap((e) => e.queries.map((q) => q.name));
    expect(names).toContain("from-disk.sql");
  });

  it("persists query updates through the swapped-in backend so they survive a relaunch", () => {
    const svc = new EnvironmentService();
    const fake = new FakeKvPersistenceBackend();
    fake.setItem(
      "bedevere_environments",
      JSON.stringify(environmentsFileWithQuery("from-disk.sql")),
    );
    persistenceService.setBackend(fake);

    const active = svc.getActive();
    expect(active).not.toBeNull();
    svc.updateQuery(active!.id, "q_test", { sql: "SELECT 42" });

    // "Relaunch": a fresh service instance reading the same backend must
    // see the update.
    const next = new EnvironmentService();
    const q = next
      .list()
      .flatMap((e) => e.queries)
      .find((qq) => qq.id === "q_test");
    expect(q?.sql).toBe("SELECT 42");
  });
});
