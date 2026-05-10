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
}

const STORAGE_KEYS = {
  queries: "bedevere_queries",
  settings: "bedevere_settings",
} as const;

const DB_NAME = "bedevere_db";
const DB_VERSION = 1;
const TABLE_STORE = "table_snapshots";

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
