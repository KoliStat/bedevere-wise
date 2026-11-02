import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTutorialNode, buildTutorialNodes } from "../tutorialDom";

/** Let the async click handler's awaits settle (fake timers leave microtasks real). */
async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("buildTutorialNode", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a heading node", () => {
    const el = buildTutorialNode({ kind: "heading", text: "Plot it" });
    expect(el.tagName).toBe("H4");
    expect(el.className).toBe("help-panel__tutorial-heading");
    expect(el.textContent).toBe("Plot it");
  });

  it("renders a prose node with its HTML", () => {
    const el = buildTutorialNode({ kind: "prose", html: "use <code>AVG</code>" });
    expect(el.className).toBe("help-panel__tutorial-prose");
    expect(el.querySelector("code")?.textContent).toBe("AVG");
  });

  it("renders a tip node with the Tip: prefix", () => {
    const el = buildTutorialNode({ kind: "tip", html: "drop the argument" });
    expect(el.className).toBe("help-panel__tip");
    expect(el.textContent).toMatch(/^Tip:/);
  });

  it("renders a snippet with the SQL and a copy button", () => {
    const el = buildTutorialNode({ kind: "snippet", sql: "SELECT 1" });
    expect(el.querySelector("pre.help-panel__snippet-code code")?.textContent).toBe("SELECT 1");
    expect(el.querySelector("button.help-panel__copy-btn")?.textContent).toBe("Copy");
  });

  it("copies the SQL and flashes the button on success", async () => {
    vi.useFakeTimers();
    const copyText = vi.fn().mockResolvedValue(true);
    const el = buildTutorialNode({ kind: "snippet", sql: "SELECT 42" }, { copyText });
    const btn = el.querySelector<HTMLButtonElement>("button.help-panel__copy-btn")!;

    btn.click();
    await drainMicrotasks();

    expect(copyText).toHaveBeenCalledWith("SELECT 42");
    expect(btn.textContent).toBe("Copied!");

    vi.advanceTimersByTime(1500);
    expect(btn.textContent).toBe("Copy");
  });

  it("reports a failed copy and leaves the button unchanged", async () => {
    const copyText = vi.fn().mockResolvedValue(false);
    const onCopyFailed = vi.fn();
    const el = buildTutorialNode({ kind: "snippet", sql: "SELECT 1" }, { copyText, onCopyFailed });
    const btn = el.querySelector<HTMLButtonElement>("button.help-panel__copy-btn")!;

    btn.click();
    await drainMicrotasks();

    expect(onCopyFailed).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Copy");
  });
});

describe("buildTutorialNodes", () => {
  it("builds one element per tutorial entry", () => {
    const els = buildTutorialNodes([
      { kind: "heading", text: "A" },
      { kind: "snippet", sql: "SELECT 1" },
    ]);
    expect(els).toHaveLength(2);
    expect(els[0].tagName).toBe("H4");
  });
});
