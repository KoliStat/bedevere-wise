export interface QueryBookmark {
  name: string;
  sql: string;
  createdAt: number;
}

export interface AppSettings {
  theme?: "light" | "dark" | "auto";
  panelMinimized?: boolean;
  panelWidth?: number;
  hasSeenOnboarding?: boolean;
  copyDelimiter?: "tab" | "comma";
  copyIncludeHeader?: boolean;
  /**
   * Quote-escape mode for copy + `.export csv|tsv`.
   * - "double" (default, RFC 4180): an embedded `"` is doubled to `""`.
   * - "backslash": an embedded `"` becomes `\"` (non-RFC, but some tools
   *   prefer it — matches JSON-like escaping). Useful when the data is
   *   nested-JSON-heavy and the consumer reads `\"`-style escapes.
   */
  csvQuoteEscape?: "double" | "backslash";
  dateFormat?: string;
  datetimeFormat?: string;
  numberMinDecimals?: number;
  numberMaxDecimals?: number;
  numberUseGrouping?: boolean;
  minCellWidth?: number;
  maxStringLength?: number;
  /** Most-recent-last ring of command-bar lines. Capped at ~200 entries. */
  shellHistory?: string[];
  /**
   * Recently-opened folders (most-recent-first), capped at 5. Each entry's
   * `id` is also the IDB key under `folder_handles` where the actual
   * `FileSystemDirectoryHandle` lives. Only populated on browsers with the
   * File System Access API; the webkitdirectory fallback can't persist
   * handles.
   */
  recentFolders?: RecentFolderEntry[];
  /**
   * Per-dataset list of column names hidden from the spreadsheet view.
   * Filtering / sorting still operates on the underlying column even
   * when hidden (the SQL clause references it by name regardless of
   * whether the projection includes it); unhiding restores the column
   * with whatever filter / sort state was active.
   */
  hiddenColumns?: Record<string, string[]>;
}

export interface RecentFolderEntry {
  id: string;
  name: string;
  lastUsed: number;
}

const STORAGE_KEYS = {
  queries: "bedevere_queries",
  settings: "bedevere_settings",
} as const;

const DB_NAME = "bedevere_db";
const DB_VERSION = 2;
const TABLE_STORE = "table_snapshots";
const FOLDER_HANDLE_STORE = "folder_handles";
const RECENT_FOLDERS_CAP = 5;

export class PersistenceService {
  // --- Query Bookmarks (localStorage) ---

  public saveQueryBookmark(name: string, sqlStr: string): void {
    const queries = this.loadQueryBookmarks();
    const existing = queries.findIndex((q) => q.name === name);
    const bookmark: QueryBookmark = { name, sql: sqlStr, createdAt: Date.now() };

    if (existing >= 0) {
      queries[existing] = bookmark;
    } else {
      queries.push(bookmark);
    }

    localStorage.setItem(STORAGE_KEYS.queries, JSON.stringify(queries));
  }

  public loadQueryBookmarks(): QueryBookmark[] {
    const raw = localStorage.getItem(STORAGE_KEYS.queries);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  public deleteQueryBookmark(name: string): void {
    const queries = this.loadQueryBookmarks().filter((q) => q.name !== name);
    localStorage.setItem(STORAGE_KEYS.queries, JSON.stringify(queries));
  }

  // --- App Settings (localStorage) ---

  public saveAppSettings(settings: AppSettings): void {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }

  public loadAppSettings(): AppSettings {
    const raw = localStorage.getItem(STORAGE_KEYS.settings);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  // --- Table Snapshots (IndexedDB) ---

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TABLE_STORE)) {
          db.createObjectStore(TABLE_STORE);
        }
        if (!db.objectStoreNames.contains(FOLDER_HANDLE_STORE)) {
          db.createObjectStore(FOLDER_HANDLE_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  public async saveTableSnapshot(name: string, buffer: ArrayBuffer): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE_STORE, "readwrite");
      tx.objectStore(TABLE_STORE).put(buffer, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async loadTableSnapshot(name: string): Promise<ArrayBuffer | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE_STORE, "readonly");
      const request = tx.objectStore(TABLE_STORE).get(name);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  public async deleteTableSnapshot(name: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE_STORE, "readwrite");
      tx.objectStore(TABLE_STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async listTableSnapshots(): Promise<string[]> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(TABLE_STORE, "readonly");
      const request = tx.objectStore(TABLE_STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result as string[]);
      request.onerror = () => reject(request.error);
    });
  }

  // --- Recent folder handles (IndexedDB + AppSettings) -----------------

  /**
   * Persist a directory handle and stamp it on the recent-folders MRU.
   * Existing entries with the same `name` are dropped (newer wins) so
   * the list never shows the same folder twice. Returns the persisted
   * entry — useful for UI updates.
   *
   * Silently no-ops on failure (storage quota, browser refusing to
   * structured-clone the handle); callers shouldn't have their import
   * flow blocked by a recents-list write.
   */
  public async pushRecentFolder(handle: FileSystemDirectoryHandle): Promise<RecentFolderEntry | null> {
    try {
      const id = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FOLDER_HANDLE_STORE, "readwrite");
        tx.objectStore(FOLDER_HANDLE_STORE).put(handle, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      const settings = this.loadAppSettings();
      const existing = settings.recentFolders ?? [];
      // Dedupe by name and drop any pruned ids from IDB at the same time.
      const purged: string[] = [];
      const remaining = existing.filter((e) => {
        if (e.name === handle.name) {
          purged.push(e.id);
          return false;
        }
        return true;
      });
      const entry: RecentFolderEntry = { id, name: handle.name, lastUsed: Date.now() };
      const next = [entry, ...remaining].slice(0, RECENT_FOLDERS_CAP);
      // Anything beyond the cap also gets its handle deleted.
      const trimmed = [entry, ...remaining].slice(RECENT_FOLDERS_CAP);
      for (const t of trimmed) purged.push(t.id);
      settings.recentFolders = next;
      this.saveAppSettings(settings);

      if (purged.length > 0) {
        await new Promise<void>((resolve) => {
          const tx = db.transaction(FOLDER_HANDLE_STORE, "readwrite");
          for (const id of purged) tx.objectStore(FOLDER_HANDLE_STORE).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve(); // best-effort cleanup
        });
      }

      return entry;
    } catch (err) {
      console.warn("pushRecentFolder: persistence failed; recents list will not include this folder", err);
      return null;
    }
  }

  public async loadRecentFolderHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(FOLDER_HANDLE_STORE, "readonly");
        const req = tx.objectStore(FOLDER_HANDLE_STORE).get(id);
        req.onsuccess = () => resolve((req.result ?? null) as FileSystemDirectoryHandle | null);
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn("loadRecentFolderHandle: read failed", err);
      return null;
    }
  }

  /** Drop a folder from both the AppSettings list and the IDB store. */
  public async removeRecentFolder(id: string): Promise<void> {
    const settings = this.loadAppSettings();
    settings.recentFolders = (settings.recentFolders ?? []).filter((e) => e.id !== id);
    this.saveAppSettings(settings);
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(FOLDER_HANDLE_STORE, "readwrite");
        tx.objectStore(FOLDER_HANDLE_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // best effort
    }
  }

  public getRecentFolders(): RecentFolderEntry[] {
    return this.loadAppSettings().recentFolders ?? [];
  }

  /**
   * Wipe every piece of persisted state: all localStorage keys under the
   * `bedevere_` prefix (views, queries, settings, keymap overrides) and the
   * IndexedDB snapshot database. A partial failure on one side still allows
   * the other to proceed.
   */
  public async clearAll(): Promise<void> {
    // localStorage
    try {
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("bedevere_")) toRemove.push(key);
      }
      for (const key of toRemove) localStorage.removeItem(key);
    } catch (err) {
      console.error("clearAll: failed to clear localStorage", err);
    }

    // IndexedDB
    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => {
          console.error("clearAll: failed to delete IndexedDB", req.error);
          resolve();
        };
        req.onblocked = () => {
          console.warn("clearAll: IndexedDB delete blocked (open connection elsewhere)");
          resolve();
        };
      } catch (err) {
        console.error("clearAll: threw while deleting IndexedDB", err);
        resolve();
      }
    });
  }
}

export const persistenceService = new PersistenceService();
