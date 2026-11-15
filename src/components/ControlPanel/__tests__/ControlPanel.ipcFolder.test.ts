import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPanel } from "../ControlPanel";
import { environmentService } from "../../../data/environments/EnvironmentService";
import { IpcFileSource } from "../../../data/files/IpcFileSource";
import { IpcRpcError, type Bridge } from "../../../data/ipc/bridge";

/**
 * Folders on the desktop: the host lists them over IPC. Each
 * `listFolderFiles` call makes the host walk the whole folder, which is slow
 * on a network share, so these tests count the calls.
 *
 * The panel is hand-built on the prototype, as in the other ControlPanel
 * tests. The file source is the real IpcFileSource. Only the bridge is a
 * stand-in: it records each RPC and answers the way the host does.
 */

const FOLDER = { id: "C:\\data", name: "data", displayPath: "C:\\data" };
const FILES = [{ name: "ae.csv", path: "C:\\data\\ae.csv" }];

interface FakeHost {
  bridge: Bridge;
  /** The RPC methods the panel called, in order. */
  calls: string[];
  /** Replace how the host answers `listFolderFiles`. */
  listing: () => Promise<{ files: typeof FILES }>;
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    calls: [],
    listing: async () => ({ files: FILES }),
    bridge: undefined as unknown as Bridge,
  };
  host.bridge = {
    isConnected: () => true,
    call: async (method: string) => {
      host.calls.push(method);
      if (method === "pickFolder") return { folder: FOLDER };
      if (method === "listFolderFiles") return host.listing();
      throw new IpcRpcError("UNKNOWN_METHOD", method);
    },
  } as unknown as Bridge;
  return host;
}

let unsubscribe: () => void = () => {};

function makePanel(host: FakeHost): any {
  const panel: any = Object.create(ControlPanel.prototype);
  panel.fileTree = [];
  panel.datasets = [];
  panel.workspaceSaveSuspended = false;
  panel.pendingAutoImport = null;
  panel.renderTree = () => {};
  panel.renderSavedQueries = () => {};
  panel.expandSection = () => {};
  panel.treeRenderer = undefined;
  panel.onShowMessageCallback = vi.fn();
  panel.tabManager = {
    getDatasetIds: () => [],
    getActiveTabId: () => null,
    getBackend: () => undefined,
    closeDataset: () => {},
    addDataset: vi.fn(async () => {}),
    switchToDataset: vi.fn(async () => {}),
  };
  panel.fileSource = new IpcFileSource({ bridge: host.bridge });
  // The constructor subscribes the same way.
  panel.lastActiveEnvId = environmentService.getActiveId();
  unsubscribe = environmentService.onChange(() => panel.onEnvironmentChange());
  return panel;
}

/** Wait until the panel has applied the active environment and shows the folder. */
async function folderIsShown(panel: any): Promise<void> {
  await vi.waitFor(() => {
    expect(panel.workspaceSaveSuspended).toBe(false);
    expect(panel.fileTree.map((n: { name: string }) => n.name)).toEqual(["data"]);
  });
}

function messages(panel: any): Array<[string, string]> {
  return panel.onShowMessageCallback.mock.calls.map((c: unknown[]) => [c[0], c[1]]);
}

/** The environment service is one object for the whole file. Leave only its default environment. */
function removeFolderEnvironments(): void {
  const keep = environmentService.getDefault().id;
  environmentService.setActive(keep);
  for (const env of environmentService.list()) {
    if (env.id !== keep) environmentService.delete(env.id);
  }
}

beforeEach(() => {
  localStorage.clear();
  removeFolderEnvironments();
});
afterEach(() => {
  unsubscribe();
  unsubscribe = () => {};
  vi.restoreAllMocks();
  removeFolderEnvironments();
  localStorage.clear();
});

describe("a folder picked on the desktop", () => {
  it("is listed once, although the pick switches to a new environment", async () => {
    const host = fakeHost();
    const panel = makePanel(host);

    await panel.openFolderPicker();
    await folderIsShown(panel);

    expect(host.calls).toEqual(["pickFolder", "listFolderFiles"]);
    expect(environmentService.getActive()?.folderHandleId).toBe("ipc:C:\\data");
    expect(panel.fileTree[0].children.map((n: { name: string }) => n.name)).toEqual(["ae.csv"]);
  });

  it("says in the status bar that a listing runs, and then how many files it found", async () => {
    const host = fakeHost();
    let finishListing!: () => void;
    host.listing = () => new Promise((resolve) => (finishListing = () => resolve({ files: FILES })));
    const panel = makePanel(host);

    const picking = panel.openFolderPicker();
    await vi.waitFor(() => expect(host.calls).toContain("listFolderFiles"));

    // The host is still walking the folder. The line stays until replaced.
    expect(panel.onShowMessageCallback.mock.calls).toEqual([
      ['Listing folder "data"…', "info", { duration: 0 }],
    ]);

    finishListing();
    await picking;
    await folderIsShown(panel);
    expect(messages(panel)).toContainEqual(['Folder "data": 1 file', "info"]);
  });

  it("reports a listing that fails, and leaves no progress line behind", async () => {
    const host = fakeHost();
    host.listing = () => Promise.reject(new IpcRpcError("INTERNAL", "unhandled exception: boom"));
    const panel = makePanel(host);

    await expect(panel.openFolderPicker()).rejects.toThrow("unhandled exception: boom");

    // The last message replaces the progress line in the status bar.
    expect(messages(panel).at(-1)).toEqual([
      "Failed to open folder: [INTERNAL] unhandled exception: boom",
      "error",
    ]);
    expect(panel.fileTree).toEqual([]);
  });
});

describe("a desktop folder restored at start", () => {
  beforeEach(() => {
    const env = environmentService.create({ name: "data", kind: "folder", folderHandleId: "ipc:C:\\data" });
    environmentService.setActive(env.id);
  });

  it("is listed once", async () => {
    const host = fakeHost();
    const panel = makePanel(host);

    await panel.restoreActiveEnvironment();

    expect(host.calls).toEqual(["listFolderFiles"]);
    expect(panel.fileTree.map((n: { name: string }) => n.name)).toEqual(["data"]);
  });

  it("warns when the host cannot list the folder any more", async () => {
    const host = fakeHost();
    host.listing = () => Promise.reject(new IpcRpcError("NOT_FOUND", "folder is not one the user opened"));
    const panel = makePanel(host);

    await panel.restoreActiveEnvironment();

    expect(messages(panel).at(-1)).toEqual([
      'Couldn\'t re-open "C:\\data" — folder may have moved or been deleted.',
      "warning",
    ]);
    expect(panel.fileTree).toEqual([]);
  });
});
