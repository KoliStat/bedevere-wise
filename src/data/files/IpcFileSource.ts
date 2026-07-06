/**
 * IpcFileSource — FileSource that proxies file/folder picking to a
 * host process via the IPC sidecar.
 *
 * The host owns the native picker (Win32 IFileOpenDialog, NSOpenPanel,
 * GTK chooser) and returns absolute filesystem paths the host can
 * read directly. The renderer doesn't fetch bytes — it hands paths to
 * `backend.registerFileURL` which routes through `registerFile` on
 * the same RPC channel, so the host opens + reads the file without
 * the bytes ever crossing the WebSocket.
 *
 * Host-side responsibility (bedevere-desktop's C++ shell, etc.):
 *   - On `pickFolder`: open a folder dialog, return
 *     `{ folder: { id: <path>, name: <leaf>, displayPath: <path> } }`
 *     or `null` if cancelled.
 *   - On `pickFiles`: open a file dialog (multi-select if
 *     `params.multiple`), return `{ files: [{ name, path }, ...] }` or
 *     `null` if cancelled.
 *   - On `listFolderFiles`: walk `folderId` (the path), return regular
 *     files as `{ name, path }`. Hidden / symlinked / unreadable entries
 *     are filtered host-side.
 */

import type { FileSource, FileSourceFile, FileSourceFolder } from "./FileSource";
import { IpcRpcError, type Bridge } from "../ipc/bridge";

export interface IpcFileSourceOptions {
  bridge: Bridge;
}

/**
 * Memoised per-method "host doesn't know this RPC" flag. Once we've
 * seen `UNKNOWN_METHOD` for a given method we skip future calls and
 * surface the cancelled-equivalent return value, so a UI that calls
 * `pickFolder` on every button click doesn't generate a console-warn
 * spray.
 */
type IpcFilePickerMethod = "pickFolder" | "pickFiles" | "listFolderFiles";

export class IpcFileSource implements FileSource {
  public readonly id = "ipc";
  private readonly bridge: Bridge;
  private readonly unsupported: Set<IpcFilePickerMethod> = new Set();

  constructor(opts: IpcFileSourceOptions) {
    this.bridge = opts.bridge;
  }

  canPickFolder(): boolean {
    return this.bridge.isConnected() && !this.unsupported.has("pickFolder");
  }

  canPickFile(): boolean {
    return this.bridge.isConnected() && !this.unsupported.has("pickFiles");
  }

  async pickFolder(): Promise<FileSourceFolder | null> {
    if (this.unsupported.has("pickFolder")) return null;
    try {
      const { folder } = await this.bridge.call("pickFolder", {});
      return folder ?? null;
    } catch (err) {
      if (this.handleUnknownMethod(err, "pickFolder")) return null;
      throw err;
    }
  }

  async pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<FileSourceFile[] | null> {
    if (this.unsupported.has("pickFiles")) return null;
    try {
      const { files } = await this.bridge.call("pickFiles", {
        multiple: opts.multiple,
        accept: opts.accept,
      });
      if (!files) return null;
      return files.map((f) => ({ kind: "path", name: f.name, path: f.path } as FileSourceFile));
    } catch (err) {
      if (this.handleUnknownMethod(err, "pickFiles")) return null;
      throw err;
    }
  }

  async openFolder(id: string): Promise<FileSourceFolder | null> {
    // The host can re-open a folder by its path id without a picker —
    // we just verify it's still readable by asking for its file list.
    // If the list throws (path deleted, permission denied, or the host
    // simply doesn't implement listFolderFiles yet), we treat the
    // folder as unavailable.
    if (this.unsupported.has("listFolderFiles")) return null;
    try {
      await this.bridge.call("listFolderFiles", { folderId: id });
    } catch (err) {
      this.handleUnknownMethod(err, "listFolderFiles");
      return null;
    }
    // Surface the leaf as the display name; the host doesn't currently
    // round-trip a separate metadata RPC.
    const leaf = id.split(/[\\/]/).filter(Boolean).pop() ?? id;
    return { id, name: leaf, displayPath: id };
  }

  async listFolderFiles(folder: FileSourceFolder): Promise<FileSourceFile[]> {
    if (this.unsupported.has("listFolderFiles")) return [];
    try {
      const { files } = await this.bridge.call("listFolderFiles", { folderId: folder.id });
      return files.map((f) => ({ kind: "path", name: f.name, path: f.path } as FileSourceFile));
    } catch (err) {
      if (this.handleUnknownMethod(err, "listFolderFiles")) return [];
      throw err;
    }
  }

  /**
   * Pull a host file's bytes across the IPC channel via the `readFile`
   * RPC (host returns base64; we decode). Used by ControlPanel to feed
   * `getSheetNames` for desktop xlsx nodes, which have a `filePath` but
   * no browser `File`. Rejects (rather than returning empty) on failure
   * so the caller can surface a real error to the user.
   */
  async readFile(path: string): Promise<Uint8Array> {
    const { data } = await this.bridge.call("readFile", { path });
    return base64ToBytes(data);
  }

  /**
   * Returns `true` if `err` was a recoverable UNKNOWN_METHOD response
   * — caller should surface the empty / null fallback. Returns `false`
   * for any other error so the caller can rethrow. Marks the method
   * as unsupported on the first hit; subsequent calls short-circuit
   * before the RPC fires.
   */
  private handleUnknownMethod(err: unknown, method: IpcFilePickerMethod): boolean {
    if (err instanceof IpcRpcError && err.code === "UNKNOWN_METHOD") {
      if (!this.unsupported.has(method)) {
        console.warn(
          `IpcFileSource: host doesn't implement ${method} (UNKNOWN_METHOD). ` +
            "File-picker affordances tied to it will be no-ops until the host's " +
            "stubs land (see kolistat/bedevere-desktop/shell/ipc/rpc.cpp).",
        );
        this.unsupported.add(method);
      }
      return true;
    }
    return false;
  }
}

/** base64 (ORIGINAL alphabet) → Uint8Array. Inverse of IpcBackend's
 *  `bytesToBase64`; matches the host's libsodium ORIGINAL-variant output. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
