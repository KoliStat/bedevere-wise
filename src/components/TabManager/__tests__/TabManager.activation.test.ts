import { describe, expect, it, vi } from "vitest";
import { TabManager } from "../TabManager";

/**
 * Drives `activateTab` on a hand-built `this` (prototype pattern, like
 * ControlPanel.import.test.ts): the constructor needs a live
 * ColumnStatsVisualizer and CommandBar that dwarf the behaviour under
 * test. Text tabs are used because activating one touches no spreadsheet.
 */
function textTab(name: string) {
  return { kind: "text" as const, metadata: { name }, container: document.createElement("div"), isActive: false };
}

function makeManager(): any {
  const m: any = Object.create(TabManager.prototype);
  m.tabs = [textTab("a"), textTab("b")];
  m.activeTabId = null;
  m.tabsContainer = document.createElement("div");
  m.sharedStatsVisualizer = { hide: () => {} };
  return m;
}

describe("TabManager activation hooks", () => {
  it("exposes the active tab id and reports activations", async () => {
    const m = makeManager();
    const seen: string[] = [];
    m.setOnTabActivatedCallback((name: string) => seen.push(name));

    expect(m.getActiveTabId()).toBeNull();
    await m.activateTab("b");
    expect(m.getActiveTabId()).toBe("b");
    await m.activateTab("a");
    expect(seen).toEqual(["b", "a"]);
  });

  it("does not report an unknown tab", async () => {
    const m = makeManager();
    const cb = vi.fn();
    m.setOnTabActivatedCallback(cb);
    await m.activateTab("zzz");
    expect(cb).not.toHaveBeenCalled();
    expect(m.getActiveTabId()).toBeNull();
  });
});
