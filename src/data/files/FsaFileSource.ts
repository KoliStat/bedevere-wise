/**
 * FsaFileSource — the default FileSource for the standalone web app.
 *
 * Wraps the File System Access API: `showDirectoryPicker`,
 * `showOpenFilePicker`, and the folder-handle IDB cache that lets the
 * user re-open recent folders without re-picking.
 *
 * The implementation is intentionally thin — FSA already gives us
 * everything we need; the wrapper exists so ControlPanel /
 * FolderScanService have one surface to call instead of branching on
 * "are we in the desktop renderer or the web app".
 */

import type { FileSource, FileSourceFile, FileSourceFolder } from "./FileSource";

const RECENT_FOLDER_DB = "bedevere_db";
const RECENT_FOLDER_STORE = "folder_handles";

/** Walk a directory handle and emit every regular file as a FileSourceFile. */
async function collectFolderFiles(
  handle: FileSystemDirectoryHandle,
  depth = 0,
  maxDepth = 8,
): Promise<FileSourceFile[]> {
  if (depth > maxDepth) return [];
  const out: FileSourceFile[] = [];
  // FSA iterators are async; values() yields {name, kind, ...} where
  // kind is "file" | "directory".
  for await (const entry of (handle as FileSystemDirectoryHandle & {
    values(): AsyncIterable<FileSystemHandle>;
  }).values()) {
    if (entry.kind === "file") {
      const file = await (entry as FileSystemFileHandle).getFile();
      out.push({ kind: "blob", file });
    } else if (entry.kind === "directory") {
      out.push(...(await collectFolderFiles(entry as FileSystemDirectoryHandle, depth + 1, maxDepth)));
    }
  }
  return out;
}

export class FsaFileSource implements FileSource {
  public readonly id = "fsa";

  canPickFolder(): boolean {
    return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
  }

  canPickFile(): boolean {
    return typeof (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker === "function";
  }

  async pickFolder(): Promise<FileSourceFolder | null> {
    if (!this.canPickFolder()) return null;
    try {
      const picker = (window as unknown as {
        showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      const handle = await picker({ mode: "read" });
      const id = await persistFolderHandle(handle);
      return { id, name: handle.name };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  async pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<FileSourceFile[] | null> {
    if (!this.canPickFile()) return null;
    try {
      const picker = (window as unknown as {
        showOpenFilePicker: (opts?: {
          multiple?: boolean;
          types?: Array<{ description?: string; accept: Record<string, string[]> }>;
        }) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker;
      const types = opts.accept
        ? [
            {
              description: "Data files",
              accept: { "application/octet-stream": opts.accept.split(",").map((e) => (e.startsWith(".") ? e : `.${e}`)) },
            },
          ]
        : undefined;
      const handles = await picker({ multiple: opts.multiple ?? false, types });
      const files: FileSourceFile[] = [];
      for (const h of handles) {
        const file = await h.getFile();
        files.push({ kind: "blob", file });
      }
      return files;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  async openFolder(id: string): Promise<FileSourceFolder | null> {
    const handle = await loadFolderHandle(id);
    if (!handle) return null;
    // FSA hands back a handle but we need permission again for the new
    // session (the cached handle's grant doesn't survive reloads).
    const requestPermission = (handle as FileSystemDirectoryHandle & {
      requestPermission: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
    }).requestPermission;
    const grant = await requestPermission.call(handle, { mode: "read" });
    if (grant !== "granted") return null;
    return { id, name: handle.name };
  }

  async listFolderFiles(folder: FileSourceFolder): Promise<FileSourceFile[]> {
    const handle = await loadFolderHandle(folder.id);
    if (!handle) return [];
    return collectFolderFiles(handle);
  }
}

// ----- IDB helpers (single-use storage for opaque FSA handles) --------------
//
// We deliberately don't share PersistenceService.idbHelpers here; the
// FSA handle store is FSA-specific (the bytes are opaque structured-
// clone payloads). PersistenceService's existing folder_handles store
// uses the same DB; we read it directly so FsaFileSource works without
// a circular dep on PersistenceService.

async function openHandleStore(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(RECENT_FOLDER_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECENT_FOLDER_STORE)) {
        db.createObjectStore(RECENT_FOLDER_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("FsaFileSource: IDB open failed"));
  });
}

async function persistFolderHandle(handle: FileSystemDirectoryHandle): Promise<string> {
  const id = `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const db = await openHandleStore();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECENT_FOLDER_STORE, "readwrite");
    tx.objectStore(RECENT_FOLDER_STORE).put(handle, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("persistFolderHandle: tx failed"));
  });
  db.close();
  return id;
}

async function loadFolderHandle(id: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleStore();
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(RECENT_FOLDER_STORE, "readonly");
    const req = tx.objectStore(RECENT_FOLDER_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("loadFolderHandle: get failed"));
  });
  db.close();
  return (value as FileSystemDirectoryHandle | undefined) ?? null;
}
