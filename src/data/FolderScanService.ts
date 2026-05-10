import { FileTreeNode, detectFileType, getAllSupportedExtensions } from "./FileTreeTypes";
import { FileImportService } from "./FileImportService";

export class FolderScanService {
  private fileImportService: FileImportService;

  constructor(fileImportService: FileImportService) {
    this.fileImportService = fileImportService;
  }

  /** Whether the modern File System Access API is available */
  public supportsDirectoryPicker(): boolean {
    return typeof window !== "undefined" && "showDirectoryPicker" in window;
  }

  /** Open a directory picker (File System Access API, Chrome/Edge).
   *  Returns the picked handle alongside the scanned tree so callers
   *  can persist the handle for the recent-folders list.
   */
  public async scanWithDirectoryPicker(): Promise<{ handle: FileSystemDirectoryHandle; tree: FileTreeNode } | null> {
    try {
      const dirHandle = await (window as any).showDirectoryPicker();
      const tree = await this.buildTreeFromHandle(dirHandle, "");
      return { handle: dirHandle, tree };
    } catch (error) {
      // User cancelled or API not available
      if ((error as Error).name !== "AbortError") {
        console.error("Directory picker failed:", error);
      }
      return null;
    }
  }

  /** Re-scan an existing directory handle (for recent-folders re-open).
   *  The caller is responsible for any required `requestPermission` call;
   *  this method assumes read access has already been granted.
   */
  public async scanFromHandle(handle: FileSystemDirectoryHandle): Promise<FileTreeNode | null> {
    try {
      return await this.buildTreeFromHandle(handle, "");
    } catch (error) {
      console.error("Re-scan from saved handle failed:", error);
      return null;
    }
  }

  /** Build tree from webkitdirectory input (wider browser support fallback) */
  public scanFromFileList(files: FileList): FileTreeNode | null {
    if (files.length === 0) return null;

    // Extract root folder name from the first file's relative path
    const firstPath = (files[0] as any).webkitRelativePath as string;
    if (!firstPath) return null;

    const rootName = firstPath.split("/")[0];
    const root: FileTreeNode = {
      id: rootName,
      name: rootName,
      kind: "folder",
      children: [],
      isImported: false,
      isExpanded: true,
    };

    for (const file of Array.from(files)) {
      const relativePath = (file as any).webkitRelativePath as string;
      if (!relativePath) continue;

      const parts = relativePath.split("/");
      // Skip the root folder name (already created)
      const pathParts = parts.slice(1);

      if (!this.isSupportedFile(file.name)) continue;

      this.insertIntoTree(root, pathParts, file);
    }

    this.pruneEmptyFolders(root);
    return root.children && root.children.length > 0 ? root : null;
  }

  private async buildTreeFromHandle(
    handle: FileSystemDirectoryHandle,
    path: string
  ): Promise<FileTreeNode> {
    const children: FileTreeNode[] = [];
    const fullPath = path ? `${path}/${handle.name}` : handle.name;

    for await (const [name, child] of (handle as any).entries()) {
      if (child.kind === "directory") {
        const subtree = await this.buildTreeFromHandle(child as FileSystemDirectoryHandle, fullPath);
        // Only include folders that contain supported files
        if (subtree.children && subtree.children.length > 0) {
          children.push(subtree);
        }
      } else if (this.isSupportedFile(name)) {
        const fileType = detectFileType(name);
        const isAvailable = fileType ? this.fileImportService.canImport(name) : false;

        children.push({
          id: `${fullPath}/${name}`,
          name,
          kind: "file",
          fileHandle: child as FileSystemFileHandle,
          fileType: fileType ?? undefined,
          isImported: false,
          isExpanded: false,
          isUnavailable: !isAvailable,
        });
      }
    }

    // Sort: folders first, then files alphabetically
    children.sort((a, b) => {
      if (a.kind === "folder" && b.kind !== "folder") return -1;
      if (a.kind !== "folder" && b.kind === "folder") return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      id: fullPath,
      name: handle.name,
      kind: "folder",
      children,
      isImported: false,
      isExpanded: true,
    };
  }

  private insertIntoTree(parent: FileTreeNode, pathParts: string[], file: File): void {
    if (pathParts.length === 1) {
      // Leaf file
      const fileName = pathParts[0];
      const fileType = detectFileType(fileName);
      const isAvailable = fileType ? this.fileImportService.canImport(fileName) : false;

      parent.children!.push({
        id: `${parent.id}/${fileName}`,
        name: fileName,
        kind: "file",
        fileHandle: file,
        fileType: fileType ?? undefined,
        isImported: false,
        isExpanded: false,
        isUnavailable: !isAvailable,
      });
    } else {
      // Intermediate folder
      const folderName = pathParts[0];
      let folder = parent.children!.find((c) => c.kind === "folder" && c.name === folderName);

      if (!folder) {
        folder = {
          id: `${parent.id}/${folderName}`,
          name: folderName,
          kind: "folder",
          children: [],
          isImported: false,
          isExpanded: false,
        };
        parent.children!.push(folder);
      }

      this.insertIntoTree(folder, pathParts.slice(1), file);
    }
  }

  private pruneEmptyFolders(node: FileTreeNode): void {
    if (!node.children) return;

    for (const child of node.children) {
      if (child.kind === "folder") {
        this.pruneEmptyFolders(child);
      }
    }

    node.children = node.children.filter(
      (c) => c.kind !== "folder" || (c.children && c.children.length > 0)
    );
  }

  private isSupportedFile(name: string): boolean {
    const ext = "." + (name.split(".").pop()?.toLowerCase() ?? "");
    return getAllSupportedExtensions().includes(ext);
  }
}
