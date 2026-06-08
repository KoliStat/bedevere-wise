/**
 * IpcFilesystemPersistence — PersistenceBackend that proxies the kv
 * store to a host process via the IPC sidecar.
 *
 * On {@link initialize} we fetch the full snapshot from the host
 * (`loadPersistence` RPC) and cache it in memory so every subsequent
 * read is synchronous. Writes mutate the cache immediately + schedule a
 * debounced `savePersistence` RPC. {@link flush} forces an immediate
 * write — useful when the renderer is about to unload.
 *
 * Why a full snapshot and not per-key RPCs? The persisted state is
 * small (a handful of bedevere_* keys, each kilobytes at most). One
 * round-trip at boot + one debounced round-trip per write batch is
 * cheaper than a chatty per-`setItem` RPC and keeps the host's storage
 * format trivially atomic.
 *
 * Host-side responsibility (bedevere-desktop's C++ shell, etc.):
 *   - On `loadPersistence`: read a `persistence.json` from the user
 *     data directory (e.g. `%LOCALAPPDATA%/Bedevere/persistence.json`).
 *     Return `{ data: {} }` if the file doesn't exist.
 *   - On `savePersistence`: atomically write the JSON to the same path
 *     (write to a temp file, then rename). Reject on disk-full / EACCES
 *     with `INTERNAL`.
 */

import type { PersistenceBackend } from "./PersistenceBackend";
import type { Bridge } from "../ipc/bridge";

export interface IpcFilesystemPersistenceOptions {
  bridge: Bridge;
  /**
   * Debounce window for `savePersistence` calls in ms. Default 750 ms
   * matches the SQL editor's autosave cadence so a typing flurry maps
   * to one disk write.
   */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 750;

export class IpcFilesystemPersistence implements PersistenceBackend {
  private readonly bridge: Bridge;
  private readonly debounceMs: number;
  private cache: Map<string, string> = new Map();
  private hydrated = false;
  private dirty = false;
  private pendingFlush: Promise<void> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: IpcFilesystemPersistenceOptions) {
    this.bridge = opts.bridge;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async initialize(): Promise<void> {
    if (this.hydrated) return;
    const { data } = await this.bridge.call("loadPersistence", {});
    this.cache = new Map(Object.entries(data ?? {}));
    this.hydrated = true;
  }

  getItem(key: string): string | null {
    if (!this.hydrated) {
      // Surface clearly rather than silently returning null — callers
      // would otherwise debug a "settings are blank" mystery.
      throw new Error("IpcFilesystemPersistence.getItem: call initialize() first");
    }
    return this.cache.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (!this.hydrated) {
      throw new Error("IpcFilesystemPersistence.setItem: call initialize() first");
    }
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    this.scheduleFlush();
  }

  removeItem(key: string): void {
    if (!this.hydrated) {
      throw new Error("IpcFilesystemPersistence.removeItem: call initialize() first");
    }
    if (!this.cache.has(key)) return;
    this.cache.delete(key);
    this.scheduleFlush();
  }

  keys(): string[] {
    if (!this.hydrated) {
      throw new Error("IpcFilesystemPersistence.keys: call initialize() first");
    }
    return [...this.cache.keys()];
  }

  /**
   * Cancel any pending debounce and flush immediately. Returns the
   * in-flight save's promise so callers can await durability before
   * triggering an action that depends on the bytes hitting disk.
   */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (!this.dirty && this.pendingFlush === null) return;
    if (this.pendingFlush) {
      await this.pendingFlush;
      // A write that landed during the await may have re-dirtied the
      // cache — fall through and write again if so.
      if (!this.dirty) return;
    }
    await this.doFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doFlush().catch((err) => {
        console.error("IpcFilesystemPersistence: savePersistence failed", err);
      });
    }, this.debounceMs);
  }

  private async doFlush(): Promise<void> {
    // Take a snapshot of the current cache; if a write lands while we're
    // mid-RPC we re-flush. `dirty` is cleared *before* the call so a
    // race that arrives during the await re-marks for a follow-up.
    this.dirty = false;
    const snapshot: Record<string, string> = {};
    for (const [k, v] of this.cache) snapshot[k] = v;
    this.pendingFlush = this.bridge.call("savePersistence", { data: snapshot }).then(() => undefined);
    try {
      await this.pendingFlush;
    } finally {
      this.pendingFlush = null;
    }
  }
}
