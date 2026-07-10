import { afterEach, describe, expect, it } from "vitest";
import { KeymapService } from "../KeymapService";
import { persistenceService } from "../PersistenceService";
import { LocalStoragePersistenceBackend } from "../persistence/LocalStoragePersistenceBackend";
import { FakeKvPersistenceBackend } from "../../test/FakeKvPersistenceBackend";

/**
 * Same desktop boot-order concern as EnvironmentService: the
 * `keymapService` module singleton is constructed at import time, but the
 * desktop host installs its persistence backend afterwards. Custom
 * keybindings must be read through the backend in force at FIRST USE,
 * not whichever one happened to be installed at construction.
 */

afterEach(() => {
  persistenceService.setBackend(new LocalStoragePersistenceBackend());
  localStorage.clear();
});

describe("KeymapService hydration vs. setBackend ordering", () => {
  it("reads keymap overrides through the backend installed at first use", () => {
    const svc = new KeymapService(); // import time

    const fake = new FakeKvPersistenceBackend();
    fake.setItem(
      "bedevere_keymap",
      JSON.stringify({ "app.togglePanel": { key: "k", ctrl: true } }),
    );
    persistenceService.setBackend(fake); // boot time

    expect(svc.getBinding("app.togglePanel")).toEqual({ key: "k", ctrl: true });
  });
});
