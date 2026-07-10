import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { persistenceService } from "../../../data/PersistenceService";
import { FakeKvPersistenceBackend } from "../../../test/FakeKvPersistenceBackend";
import { environmentService } from "../../../data/environments/EnvironmentService";
import { SqlEditor } from "../SqlEditor";
import type { Backend } from "../../../data/Backend";

/**
 * Query-lifecycle regression tests around the live CodeMirror view.
 *
 * Bug 1: clicking the ACTIVE query in the Saved Queries panel routed
 * through openSavedQuery → activateInternal(sameId), which skipped the
 * outgoing-state snapshot and then setState()d the tab's STALE stored
 * EditorState — visually replacing what the user just typed (and resetting
 * lastAutoSavedText so a later autosave could overwrite the good copy).
 *
 * Bug 2: the autosave debounce had no unload hook — text typed within the
 * debounce window was lost when the page/webview closed.
 */

// ── CodeMirror-in-jsdom shims ──────────────────────────────────────────
// jsdom implements neither Range measurement nor ResizeObserver/rAF; CM6
// only needs them for pixel measurement, which these tests never assert.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// Deterministic timer queue: autosave debounces must stay PENDING until a
// test decides otherwise (the global setup's setTimeout mock runs callbacks
// synchronously, which would flush the debounce at schedule time and hide
// the unload-loss bug).
const timerQueue = new Map<number, () => void>();
let nextTimerId = 1;

const backendStub = {
  listTables: async () => [],
  getTableInfo: async () => [],
  listFunctions: async () => [],
} as unknown as Backend;

let editor: SqlEditor;

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("setTimeout", ((cb: () => void) => {
    const id = nextTimerId++;
    timerQueue.set(id, cb);
    return id;
  }) as unknown as typeof setTimeout);
  vi.stubGlobal("clearTimeout", ((id: number) => {
    timerQueue.delete(id);
  }) as unknown as typeof clearTimeout);
  (Range.prototype as unknown as { getClientRects: () => unknown }).getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Element.prototype.scrollIntoView = () => {};
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;

  persistenceService.setBackend(new FakeKvPersistenceBackend());

  const host = document.createElement("div");
  document.body.appendChild(host);
  editor = new SqlEditor(host, backendStub, "lifecycle-test-editor");
  await editor.restoreActiveEnvironment();
});

afterAll(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SqlEditor query lifecycle", () => {
  it("keeps the live text when the active query is re-opened from the panel", () => {
    editor.setQuery("SELECT 42 AS answer");
    const id = editor.getActiveQueryId();
    expect(id).not.toBeNull();

    // Saved-Queries-panel click on the row of the ALREADY-ACTIVE tab.
    const reopened = editor.openSavedQuery(id!);
    expect(reopened).toBe(true);

    // The editor must still show what the user typed…
    expect(editor.getQuery()).toBe("SELECT 42 AS answer");
    // …and the env store must hold the same text (flushed, not clobbered).
    const q = environmentService.getActive()!.queries.find((qq) => qq.id === id);
    expect(q?.sql).toBe("SELECT 42 AS answer");
  });

  it("flushes the pending autosave debounce when the page hides", () => {
    const id = editor.getActiveQueryId();
    expect(id).not.toBeNull();

    editor.setQuery("SELECT 99 AS bye"); // autosave scheduled, still pending
    window.dispatchEvent(new Event("pagehide"));

    const q = environmentService.getActive()!.queries.find((qq) => qq.id === id);
    expect(q?.sql).toBe("SELECT 99 AS bye");
  });
});
