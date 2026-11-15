import { describe, it, expect, afterEach } from "vitest";
import { FolderScanService } from "../FolderScanService";
import type { FileImportService } from "../FileImportService";

/** The service only asks the import service whether a file type has a reader. */
const importService = { canImport: () => true } as unknown as FileImportService;

type Entry = [name: string, handle: { kind: "file" | "directory"; name: string }];

/** A directory handle as the File System Access API returns it, with fixed entries. */
function directoryHandle(name: string, entries: Entry[]) {
  return {
    kind: "directory" as const,
    name,
    async *entries() {
      for (const entry of entries) yield entry;
    },
  };
}

function fileHandle(name: string, size: number) {
  return { kind: "file" as const, name, getFile: async () => ({ size }) };
}

/** jsdom has no folder picker. Each test supplies what the browser's would do. */
function stubDirectoryPicker(pick: () => Promise<unknown>): void {
  (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = pick;
}

describe("FolderScanService.scanWithDirectoryPicker", () => {
  afterEach(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it("returns the tree of the picked folder", async () => {
    const picked = directoryHandle("study", [["ae.csv", fileHandle("ae.csv", 120)]]);
    stubDirectoryPicker(async () => picked);

    const result = await new FolderScanService(importService).scanWithDirectoryPicker();

    expect(result?.handle).toBe(picked);
    expect(result?.tree.name).toBe("study");
    expect(result?.tree.children?.map((c) => [c.name, c.size])).toEqual([["ae.csv", 120]]);
  });

  it("returns null when the user cancels the dialog", async () => {
    stubDirectoryPicker(() => Promise.reject(new DOMException("The user aborted a request.", "AbortError")));

    const result = await new FolderScanService(importService).scanWithDirectoryPicker();

    expect(result).toBeNull();
  });

  it("rejects when the picked folder cannot be read", async () => {
    const unreadable = {
      kind: "directory" as const,
      name: "study",
      // The folder went away between the pick and the listing.
      async *entries(): AsyncGenerator<Entry> {
        throw new DOMException("A requested file or directory could not be found.", "NotFoundError");
      },
    };
    stubDirectoryPicker(async () => unreadable);

    await expect(new FolderScanService(importService).scanWithDirectoryPicker()).rejects.toThrow(
      "A requested file or directory could not be found.",
    );
  });
});
