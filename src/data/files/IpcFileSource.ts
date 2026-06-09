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
import type { Bridge } from "../ipc/bridge";

export interface IpcFileSourceOptions {
  bridge: Bridge;
}

export class IpcFileSource implements FileSource {
  public readonly id = "ipc";
  private readonly bridge: Bridge;

  constructor(opts: IpcFileSourceOptions) {
    this.bridge = opts.bridge;
  }

  canPickFolder(): boolean {
    return this.bridge.isConnected();
  }

  canPickFile(): boolean {
    return this.bridge.isConnected();
  }

  async pickFolder(): Promise<FileSourceFolder | null> {
    const { folder } = await this.bridge.call("pickFolder", {});
    if (!folder) return null;
    return folder;
  }

  async pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<FileSourceFile[] | null> {
    const { files } = await this.bridge.call("pickFiles", {
      multiple: opts.multiple,
      accept: opts.accept,
    });
    if (!files) return null;
    return files.map((f) => ({ kind: "path", name: f.name, path: f.path } as FileSourceFile));
  }

  async openFolder(id: string): Promise<FileSourceFolder | null> {
    // The host can re-open a folder by its path id without a picker —
    // we just verify it's still readable by asking for its file list.
    // If the list throws (path deleted, permission denied), we treat
    // the folder as unavailable.
    try {
      await this.bridge.call("listFolderFiles", { folderId: id });
    } catch {
      return null;
    }
    // Surface the leaf as the display name; the host doesn't currently
    // round-trip a separate metadata RPC.
    const leaf = id.split(/[\\/]/).filter(Boolean).pop() ?? id;
    return { id, name: leaf, displayPath: id };
  }

  async listFolderFiles(folder: FileSourceFolder): Promise<FileSourceFile[]> {
    const { files } = await this.bridge.call("listFolderFiles", { folderId: folder.id });
    return files.map((f) => ({ kind: "path", name: f.name, path: f.path } as FileSourceFile));
  }
}
