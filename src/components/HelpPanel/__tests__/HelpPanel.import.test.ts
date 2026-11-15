import { describe, it, expect, afterEach } from "vitest";
import { HelpPanel } from "../HelpPanel";

type Message = [text: string, type: string];

function clickBrowseFolder(): void {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".help-panel__import-btn")).find(
    (b) => b.textContent === "Browse Folder",
  );
  if (!button) throw new Error("Browse Folder button not found");
  button.click();
}

/** Let the promise chain behind a click settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function panelIsOpen(): boolean {
  return document.querySelector(".help-panel__import-btn") !== null;
}

describe("HelpPanel Import tab: Browse Folder", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports a failed folder pick in the status bar", async () => {
    const messages: Message[] = [];
    new HelpPanel(document.body, {
      version: "0.17",
      onLoadSampleDataset: () => {},
      onBrowseFolder: () => Promise.reject(new Error("INTERNAL unhandled exception: invalid UTF-8 byte")),
      onShowMessage: (text, type) => messages.push([text, type]),
    }).show("import");

    clickBrowseFolder();
    await settle();

    expect(messages).toEqual([
      ["Failed to open folder: INTERNAL unhandled exception: invalid UTF-8 byte", "error"],
    ]);
  });

  it("reports nothing when the folder pick succeeds", async () => {
    const messages: Message[] = [];
    let picks = 0;
    new HelpPanel(document.body, {
      version: "0.17",
      onLoadSampleDataset: () => {},
      onBrowseFolder: async () => {
        picks += 1;
      },
      onShowMessage: (text, type) => messages.push([text, type]),
    }).show("import");

    clickBrowseFolder();
    await settle();

    expect(picks).toBe(1);
    expect(messages).toEqual([]);
  });

  it("closes the panel at once, while the folder dialog is still open", () => {
    new HelpPanel(document.body, {
      version: "0.17",
      onLoadSampleDataset: () => {},
      // A pick that never settles: the native dialog stays open.
      onBrowseFolder: () => new Promise<void>(() => {}),
    }).show("import");
    expect(panelIsOpen()).toBe(true);

    clickBrowseFolder();

    expect(panelIsOpen()).toBe(false);
  });
});

describe("HelpPanel Import tab: recent folders", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("reports a recent folder that fails to open in the status bar", async () => {
    const messages: Message[] = [];
    new HelpPanel(document.body, {
      version: "0.17",
      onLoadSampleDataset: () => {},
      getRecentFolders: () => [{ id: "folder_1", name: "study" }],
      onRecentFolderClick: () => Promise.reject(new Error("The database connection is closing.")),
      onShowMessage: (text, type) => messages.push([text, type]),
    }).show("import");

    document.querySelector<HTMLButtonElement>(".help-panel__import-recents-item")!.click();
    await settle();

    expect(messages).toEqual([["Failed to open folder: The database connection is closing.", "error"]]);
  });
});
