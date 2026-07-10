import type { PersistenceBackend } from "../data/persistence/PersistenceBackend";

/**
 * In-memory PersistenceBackend for tests. Mirrors the desktop's
 * IpcFilesystemPersistence read/write surface (synchronous kv over an
 * in-memory map) without any IPC, so hydration-ordering tests can model
 * "the host swapped the backend in at boot".
 */
export class FakeKvPersistenceBackend implements PersistenceBackend {
  public readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}
