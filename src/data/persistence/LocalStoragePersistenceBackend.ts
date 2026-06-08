import type { PersistenceBackend } from "./PersistenceBackend";

/**
 * Default PersistenceBackend for the standalone web app: a thin
 * adapter over `window.localStorage`.
 *
 * Synchronous in/out; no hydration; no flush — the browser already
 * persists every `setItem` call synchronously. The class exists so
 * PersistenceService can take a PersistenceBackend in its
 * constructor (or via `setBackend`) and the desktop renderer can
 * substitute an IPC-backed implementation without PersistenceService
 * having to know which storage substrate is in play.
 */
export class LocalStoragePersistenceBackend implements PersistenceBackend {
  getItem(key: string): string | null {
    return localStorage.getItem(key);
  }

  setItem(key: string, value: string): void {
    localStorage.setItem(key, value);
  }

  removeItem(key: string): void {
    localStorage.removeItem(key);
  }

  keys(): string[] {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== null) out.push(key);
    }
    return out;
  }
}
