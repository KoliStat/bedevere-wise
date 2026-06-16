/**
 * PersistenceBackend — the low-level key/value substrate that
 * PersistenceService writes its JSON-serialized records into.
 *
 * Two implementations live in the tree today:
 *
 *   - {@link LocalStoragePersistenceBackend} — `window.localStorage`,
 *     the default for the standalone web app. Synchronous; no init.
 *   - IpcFilesystemPersistence (bedevere-desktop, Step 10) — JSON
 *     file on disk, mirrored into an in-memory cache at init so the
 *     renderer can keep using a synchronous `getItem`. Writes
 *     debounce-flush to the host over the IPC sidecar.
 *
 * Synchronous-by-design: the renderer reads settings during component
 * construction (`new BedevereApp(...)` calls `loadAppSettings()`
 * synchronously), so the backend MUST be hydrated before that point.
 * Async backends do the hydration in `initialize()`; callers await
 * once at boot and never again.
 */

export interface PersistenceBackend {
  /**
   * Read the value for `key`, or `null` if no value is set.
   * Synchronous — backends with async storage cache the snapshot
   * in memory after {@link initialize}.
   */
  getItem(key: string): string | null;

  /** Write `value` under `key`. Backends MAY buffer + debounce writes. */
  setItem(key: string, value: string): void;

  /** Remove the entry for `key`, if any. */
  removeItem(key: string): void;

  /**
   * Enumerate currently-set keys. Used by `clearAll` to find all
   * Bedevere-namespaced entries and migrations that need to scan for
   * legacy keys. Order is unspecified.
   */
  keys(): string[];

  /**
   * Async hook for backends that need to hydrate from a slow store
   * (a file on disk, a remote server). Called once at boot, before
   * any other method. Backends with no init work return immediately.
   */
  initialize?(): Promise<void>;

  /**
   * Optional async flush — useful for backends that buffer writes
   * (the IPC variant debounces dirty state). The web app's
   * `beforeunload` handler can `await flush()` to make sure the last
   * keystroke landed.
   */
  flush?(): Promise<void>;
}
