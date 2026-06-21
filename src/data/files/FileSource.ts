/**
 * FileSource — host-agnostic surface for picking and reading files
 * and folders.
 *
 * The standalone web app's file ingestion paths use the File System
 * Access API (`showDirectoryPicker`, `showOpenFilePicker`) directly
 * inside ControlPanel + FolderScanService. That's fine in the
 * browser, but a desktop host wants the OS native picker (Win32
 * IFileOpenDialog, NSOpenPanel, GTK chooser) and serves the bytes
 * through IPC.
 *
 * This interface lifts that distinction off the call sites so the
 * desktop renderer can substitute an IpcFileSource implementation
 * before BedevereApp constructs, just like {@link Backend} and
 * {@link PersistenceBackend}.
 *
 * Status: ControlPanel and the import paths route folder/file picking
 * through an injected FileSource when the host supplies a non-FSA one
 * (the desktop's IpcFileSource); the standalone web app keeps calling
 * the File System Access API directly. FsaFileSource wraps that FSA
 * surface for hosts that want a uniform abstraction.
 */

/**
 * A handle to a folder the user picked. Backend implementations carry
 * whatever they need to enumerate / re-acquire the folder later — an
 * FSA FileSystemDirectoryHandle on the web, a path string on the
 * desktop, etc. — behind a stable opaque id the renderer can keep in
 * `RecentFolderEntry`.
 */
export interface FileSourceFolder {
  /**
   * Stable id minted by the implementation. Persisted by the renderer
   * (e.g. as `RecentFolderEntry.id`) so the user can re-open the same
   * folder later via {@link FileSource.openFolder}.
   */
  id: string;
  /** User-visible folder name (the leaf). */
  name: string;
  /**
   * Path string for displays + log lines. May be a real filesystem
   * path (desktop), a `/`-separated virtual path (FSA, where there
   * isn't an absolute path), or empty when nothing meaningful can be
   * surfaced.
   */
  displayPath?: string;
}

/**
 * A picked file along with the bytes (web) or a host-accessible path
 * (desktop). Exactly one of `file` / `path` is populated; the
 * `kind` discriminator tells callers which to read.
 *
 * Why both shapes: the web app wraps `File` objects directly into
 * `FileImportService.importFile(file)` which knows how to decode
 * them. The desktop's host already has the file open and can
 * `registerFile(path)` straight against the engine without round-
 * tripping the bytes through the renderer.
 */
export type FileSourceFile =
  | { kind: "blob"; file: File }
  | { kind: "path"; name: string; path: string };

export interface FileSource {
  /**
   * Stable identifier for the source kind: `"fsa"` (web), `"ipc"`
   * (desktop), etc. Used for diagnostics.
   */
  readonly id: string;

  /** Whether the source can issue a folder picker on this host. */
  canPickFolder(): boolean;

  /** Whether the source can issue a file picker on this host. */
  canPickFile(): boolean;

  /**
   * Trigger the host's folder picker. Resolves to the picked folder,
   * or `null` if the user cancelled. Throws on permission denial /
   * picker-not-supported (the UI catches and surfaces).
   */
  pickFolder(): Promise<FileSourceFolder | null>;

  /**
   * Trigger the host's file picker. `accept` is a hint
   * (`"csv,json,parquet,..."` or MIME types); implementations may
   * ignore it if the underlying picker doesn't support filters.
   * Resolves to the picked files, or `null` if the user cancelled.
   */
  pickFiles(opts?: { accept?: string; multiple?: boolean }): Promise<FileSourceFile[] | null>;

  /**
   * Re-open a previously-picked folder by id. The implementation
   * decides what re-acquire means: FSA prompts for permission again,
   * IPC just hands back the cached path. Returns `null` if the id no
   * longer resolves (folder deleted, permission permanently denied,
   * recent-folders entry stale).
   */
  openFolder(id: string): Promise<FileSourceFolder | null>;

  /**
   * Enumerate the leaves of a folder as importable files. The
   * `MAX_DEPTH` recursion budget lives on the implementation since
   * recursive enumeration semantics (symlinks, permissions, hidden
   * files) are host-specific.
   */
  listFolderFiles(folder: FileSourceFolder): Promise<FileSourceFile[]>;

  /**
   * Read the raw bytes of a host file by its absolute path. Only the
   * IPC source needs this: its picker nodes carry a host `filePath`
   * (kind `"path"`) with no browser bytes, yet some JS-side readers must
   * parse the file themselves — notably `.xlsx` sheet enumeration, which
   * unzips `xl/workbook.xml` in the renderer. The FSA source can't read
   * arbitrary host paths (and never needs to — its nodes carry a `File`),
   * so it throws an "unsupported" error.
   *
   * Large data files do NOT come here; they import via
   * `backend.registerFileURL` by path so the host reads them directly.
   */
  readFile(path: string): Promise<Uint8Array>;
}
