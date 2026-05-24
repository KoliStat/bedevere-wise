import { EditorView, keymap, placeholder, lineNumbers } from "@codemirror/view";
import { EditorState, Extension, Prec } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { autocompletion } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, insertTab, indentLess } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { FocusableComponent } from "../BedevereApp/types";
import { DuckDBService } from "../../data/DuckDBService";
import { keymapService } from "../../data/KeymapService";
import { commandRegistry } from "../../data/CommandRegistry";
import { persistenceService } from "../../data/PersistenceService";
import { environmentService } from "../../data/environments/EnvironmentService";
import type { Environment } from "../../data/environments/types";
import { SqlAutoComplete } from "./SqlAutoComplete";
import { BedevereSqlDialect } from "./sqlDialect";
import { listenForThemeChanges } from "../SpreadsheetVisualizer/utils/theme";
import { SaveQueryDialog } from "../SaveQueryDialog/SaveQueryDialog";
import { EditorTabBar } from "./EditorTabBar";

/**
 * Idle delay between the user's last keystroke and the autosave write.
 * Short enough that a browser crash / refresh loses essentially nothing,
 * long enough that we're not pummelling localStorage on every character.
 */
const AUTOSAVE_DEBOUNCE_MS = 750;

// Syntax highlighting that matches the tokyonight palette via CSS variables,
// so the editor follows light/dark theme switches without a rebuild. Token
// classes are emitted by `@codemirror/lang-sql`'s parser; we just bind colors
// to the lezer tags.
const tokyonightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--magenta)", fontWeight: "600" },
  { tag: [t.string, t.special(t.string)], color: "var(--green)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--orange)" },
  { tag: t.null, color: "var(--red)" },
  { tag: [t.lineComment, t.blockComment], color: "var(--fg-muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.variableName)], color: "var(--blue)" },
  { tag: [t.typeName, t.className], color: "var(--yellow)" },
  { tag: t.operator, color: "var(--cyan)" },
  { tag: [t.bracket, t.punctuation, t.separator], color: "var(--fg-dark)" },
  { tag: t.variableName, color: "var(--fg)" },
]);

/**
 * One open editor tab. The `state` is the CodeMirror `EditorState`
 * snapshot for this tab — when the user switches away, we save the
 * live `view.state` here so swapping back via `view.setState(state)`
 * restores cursor, selection, undo history, the lot.
 */
interface EditorTabRecord {
  queryId: string;
  state: EditorState;
}

/**
 * Multi-tab SQL editor. Each tab is backed by an `EnvironmentQuery`
 * stored in the active environment; autosave writes the live text
 * back through `environmentService.updateQuery` on a debounced timer.
 * Switching environments swaps the entire tab set (the previous env's
 * tabs flush + close, the new env's `workspace.openQueryIds` are
 * opened in order, the active tab is restored).
 *
 * One persistent CodeMirror `EditorView` is shared across all tabs;
 * we hold a per-tab `EditorState` and call `view.setState(...)` on
 * switch. That's the CM6-idiomatic way to do "multiple documents in
 * one editor" and is dramatically cheaper than tearing the view down
 * and recreating it.
 */
export class SqlEditor implements FocusableComponent {
  public readonly componentId: string;
  public readonly canReceiveFocus: boolean = true;
  public readonly focusableElement: HTMLElement;

  private container: HTMLElement;
  private tabBarContainer: HTMLElement;
  private editorContainer: HTMLElement;
  private editorView: EditorView | null = null;
  private autoComplete: SqlAutoComplete;
  private _isFocused: boolean = false;
  private _isExpanded: boolean = false;
  private themeCleanup: (() => void) | null = null;

  // Tab state
  private tabBar: EditorTabBar | null = null;
  private tabs: EditorTabRecord[] = [];
  private activeQueryId: string | null = null;
  /** The env whose tabs we last loaded. Compared against
   *  `environmentService.getActiveId()` in the onChange listener to
   *  decide between "rebuild tabs for new env" vs "same env, just
   *  refresh labels for a rename/delete". */
  private boundEnvId: string | null = null;
  private envUnsubscribe?: () => void;

  // Autosave
  private autoSaveTimer: number | null = null;
  // The last text we wrote to the active query's sql. Lets us skip
  // a write when nothing actually changed (e.g. selection-only updates
  // still fire updateListener).
  private lastAutoSavedText: string = "";

  private onExecuteCallback?: (query: string) => void;
  private onToggleCallback?: (isExpanded: boolean) => void;

  constructor(parent: HTMLElement, duckDBService: DuckDBService, componentId?: string) {
    this.componentId = componentId ?? "sql-editor";
    this.autoComplete = new SqlAutoComplete(duckDBService);

    this.container = document.createElement("div");
    this.container.className = "sql-editor";
    this.focusableElement = this.container;

    // Tab strip sits above the CodeMirror view — same vertical order
    // as a browser's tab bar above page content.
    this.tabBarContainer = document.createElement("div");
    this.tabBarContainer.className = "sql-editor__tab-bar-mount";
    this.container.appendChild(this.tabBarContainer);

    this.tabBar = new EditorTabBar(this.tabBarContainer, {
      onSelect: (id) => this.selectTab(id),
      onClose: (id) => this.closeTab(id),
      onRename: (id, name) => this.renameTab(id, name),
      onNew: () => this.openNewQuery(),
    });

    // Editor wrapper (CodeMirror mount)
    this.editorContainer = document.createElement("div");
    this.editorContainer.className = "sql-editor__editor";
    this.container.appendChild(this.editorContainer);

    // Toolbar (Run / Clear). Sits below the editor; layout unchanged
    // from v0.11.
    const toolbar = document.createElement("div");
    toolbar.className = "sql-editor__toolbar";

    const runButton = document.createElement("button");
    runButton.className = "sql-editor__run-button";
    runButton.textContent = "Run";
    runButton.title = "Execute query (Ctrl+Enter)";
    runButton.addEventListener("click", () => this.execute());

    const clearButton = document.createElement("button");
    clearButton.className = "sql-editor__clear-button";
    clearButton.textContent = "Clear";
    clearButton.title = "Clear editor";
    clearButton.addEventListener("click", () => this.clear());

    toolbar.appendChild(runButton);
    toolbar.appendChild(clearButton);
    this.container.appendChild(toolbar);

    parent.appendChild(this.container);

    // Initialise the editor view with a placeholder empty state. The
    // real tabs land via `restoreActiveEnvironment()` which the caller
    // (TabManager.initSqlEditor) invokes after wiring callbacks. We
    // don't apply tabs in the constructor because the `onToggleCallback`
    // isn't set yet — auto-expanding here would skip syncing the
    // CommandBar's SQL-toggle chip.
    this.initializeEditor("");

    // Theme listener — rebuilds the view (and re-applies the active
    // tab's state) when the user flips light/dark.
    this.themeCleanup = listenForThemeChanges(() => {
      this.rebuildEditor();
    });

    // Refresh schema for autocompletion (runs against the current
    // DuckDB connection; safe at construction since the connection
    // exists by the time SqlEditor is built).
    this.autoComplete.refreshSchema();

    // Subscribe to environment changes:
    //   - Active env changed → rebuild tab set from the new env's
    //     workspace.openQueryIds.
    //   - Same env but a query was renamed / deleted → just refresh
    //     the tab bar labels.
    this.envUnsubscribe = environmentService.onChange(() => this.handleEnvServiceChange());

    // Keymap-scope commands. Registered here because `execute`,
    // `collapse`, and `openSaveDialog` are private and need this
    // editor instance's closure.
    commandRegistry.register({
      id: "sqlEditor.execute",
      title: "Execute SQL Query",
      description: "Run the query currently in the SQL editor",
      category: "SQL",
      scope: "sqlEditor",
      execute: async () => { await this.execute(); },
    });
    commandRegistry.register({
      id: "sqlEditor.collapse",
      title: "Collapse SQL Editor",
      description: "Close the SQL editor panel",
      category: "SQL",
      scope: "sqlEditor",
      execute: () => this.collapse(),
    });
    commandRegistry.register({
      id: "sqlEditor.saveQuery",
      title: "Save query as…",
      description: "Save the editor's current query as a named bookmark",
      category: "SQL",
      scope: "sqlEditor",
      execute: () => this.openSaveDialog(),
    });
  }

  // ---- Public API ----------------------------------------------------

  /**
   * Restore the tab set from the active environment. Called once by
   * the consumer (TabManager.initSqlEditor) right after all callbacks
   * have been wired, so the expand-on-restore can fire its toggle
   * callback to keep the CommandBar's SQL-toggle chip in sync.
   * Future env switches go through the onChange subscription.
   */
  public async restoreActiveEnvironment(): Promise<void> {
    const activeId = environmentService.getActiveId();
    if (!activeId) return;
    await this.applyEnvironment(activeId);
    // If the user had an active query last session, surface the editor
    // so they see their tabs immediately. Defer one tick so the toggle
    // callback (which the CommandBar listens to) has the freshly-wired
    // listener in place.
    const env = environmentService.get(activeId);
    if (env?.workspace.activeTab?.kind === "query" && !this._isExpanded) {
      setTimeout(() => this.expand(), 0);
    }
  }

  public getQuery(): string {
    return this.editorView?.state.doc.toString() ?? "";
  }

  /**
   * Replace the active tab's text. Used by callers that don't know
   * about tabs (saved-queries click, programmatic injections). For a
   * "open this saved query as a NEW tab" UX, use `openQueryAsTab`
   * once Phase D wires it.
   */
  public setQuery(query: string): void {
    if (!this.editorView) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: query },
    });
    // setState writes don't fire updateListener; setText changes do.
    // The updateListener already calls scheduleAutoSave; this is just
    // belt-and-braces for any future caller that bypasses dispatch.
    this.scheduleAutoSave();
  }

  public async execute(): Promise<void> {
    const query = this.getQuery().trim();
    if (!query) return;
    if (this.onExecuteCallback) {
      this.onExecuteCallback(query);
    }
  }

  /** Empty the active tab's content. Doesn't close the tab — closing
   *  requires the explicit × button or `closeTab(id)`. */
  public clear(): void {
    this.setQuery("");
    this.editorView?.focus();
  }

  public toggle(): void {
    if (this._isExpanded) this.collapse();
    else this.expand();
  }

  public expand(): void {
    if (this._isExpanded) return;
    this._isExpanded = true;
    this.container.classList.add("sql-editor--expanded");
    requestAnimationFrame(() => this.editorView?.focus());
    this.onToggleCallback?.(true);
  }

  public collapse(): void {
    if (!this._isExpanded) return;
    this._isExpanded = false;
    this.container.classList.remove("sql-editor--expanded");
    this.onToggleCallback?.(false);
  }

  public isExpanded(): boolean {
    return this._isExpanded;
  }

  public setOnExecuteCallback(callback: (query: string) => void): void {
    this.onExecuteCallback = callback;
  }

  public setOnToggleCallback(callback: (isExpanded: boolean) => void): void {
    this.onToggleCallback = callback;
  }

  public refreshSchema(): void {
    this.autoComplete.refreshSchema();
  }

  // ---- FocusableComponent --------------------------------------------

  public focus(): void {
    this._isFocused = true;
    this.editorView?.focus();
  }

  public blur(): void {
    this._isFocused = false;
    this.editorView?.contentDOM.blur();
  }

  public isFocused(): boolean {
    return this._isFocused;
  }

  public async handleKeyDown(event: KeyboardEvent): Promise<boolean> {
    // Mod-Enter / Mod-s are owned by the CM keymap (Prec.high) — they
    // fire even when the SqlEditor isn't the FocusManager's tracked
    // component (which it never actually is — nothing calls setFocus
    // on it). Escape is routed here as a belt-and-braces fallback;
    // today effectively dead code, but harmless.
    const action = keymapService.matchEvent(event, "sqlEditor");
    if (action !== "sqlEditor.collapse") return false;
    event.preventDefault();
    if (commandRegistry.has(action)) {
      try { await commandRegistry.run(action); }
      catch (err) { console.error(`command ${action} failed:`, err); }
    }
    return true;
  }

  public destroy(): void {
    this.flushAutoSave();
    if (this.autoSaveTimer !== null) {
      window.clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    this.envUnsubscribe?.();
    this.envUnsubscribe = undefined;
    this.tabBar?.destroy();
    this.tabBar = null;
    if (this.themeCleanup) {
      this.themeCleanup();
      this.themeCleanup = null;
    }
    this.editorView?.destroy();
    this.editorView = null;
    this.container.remove();
  }

  // ---- Environment ↔ tabs ------------------------------------------

  /**
   * Replace the tab set with the active env's workspace state. Idempotent:
   * called once at construction (via `restoreActiveEnvironment`) and on
   * every active-env change thereafter.
   *
   * Handles the v0.11 → v0.12 migration of the singleton
   * `editorAutoSaveDraft` — on first run, if the active env has no open
   * query tabs and the draft is non-empty, the draft becomes an
   * `untitled-1.sql` query and the draft slot is cleared.
   */
  private async applyEnvironment(envId: string): Promise<void> {
    // Flush whatever the user was just typing into the old env's query
    // before we swap the editor's state out from under them.
    this.flushAutoSave();

    const env = environmentService.get(envId);
    if (!env) {
      this.tabs = [];
      this.activeQueryId = null;
      this.boundEnvId = null;
      this.renderTabBar();
      return;
    }

    this.maybeMigrateLegacyDraft(env);

    // Re-read in case migration mutated env.
    const fresh = environmentService.get(envId)!;
    const queryById = new Map(fresh.queries.map((q) => [q.id, q]));

    // Build tab records from workspace.openQueryIds, skipping any
    // stale ids (deleted queries the workspace never cleaned up).
    this.tabs = [];
    for (const qid of fresh.workspace.openQueryIds) {
      const q = queryById.get(qid);
      if (!q) continue;
      this.tabs.push({ queryId: q.id, state: this.buildEditorState(q.sql) });
    }

    // If the env had no open queries (fresh env, all closed last
    // session, or the draft-migration above was a no-op), open a
    // single untitled tab so the editor never sits empty-without-a-tab.
    if (this.tabs.length === 0) {
      const q = environmentService.addQuery(fresh.id, {
        name: this.nextUntitledName(fresh),
        sql: "",
      });
      if (q) {
        this.tabs.push({ queryId: q.id, state: this.buildEditorState("") });
      }
    }

    // Pick the active tab: workspace.activeTab (if it's a query),
    // else the first tab in the list.
    let targetId = this.tabs[0]?.queryId ?? null;
    const wsActive = fresh.workspace.activeTab;
    if (wsActive?.kind === "query") {
      const found = this.tabs.find((t) => t.queryId === wsActive.id);
      if (found) targetId = found.queryId;
    }

    this.boundEnvId = envId;
    if (targetId) {
      this.activateInternal(targetId);
    }
    this.persistWorkspace(envId);
    this.renderTabBar();
  }

  /**
   * v0.11 → v0.12 one-shot draft migration. Runs only when the env
   * has no open tabs AND the legacy slot is non-empty AND we're
   * looking at the default env (which is where Phase A migrated the
   * legacy saved queries — putting the legacy draft anywhere else
   * would be surprising).
   */
  private maybeMigrateLegacyDraft(env: Environment): void {
    if (env.workspace.openQueryIds.length > 0) return;
    if (env.kind !== "default") return;
    const draft = persistenceService.loadEditorAutoSaveDraft();
    if (!draft || !draft.trim()) return;
    const q = environmentService.addQuery(env.id, {
      name: this.nextUntitledName(env),
      sql: draft,
    });
    if (!q) return;
    environmentService.setWorkspace(env.id, {
      openDataNodeIds: env.workspace.openDataNodeIds,
      openQueryIds: [q.id],
      activeTab: { kind: "query", id: q.id },
    });
    // Clear the legacy slot so the migration is one-shot.
    const settings = persistenceService.loadAppSettings();
    settings.editorAutoSaveDraft = "";
    persistenceService.saveAppSettings(settings);
  }

  private handleEnvServiceChange(): void {
    const nextId = environmentService.getActiveId();
    if (nextId !== this.boundEnvId) {
      // Active env changed — rebuild tabs from the new env.
      if (nextId) {
        this.applyEnvironment(nextId).catch((err) => {
          console.error("SqlEditor: applyEnvironment failed", err);
        });
      }
      return;
    }
    // Same env: a query was renamed / added / deleted. Refresh tab
    // labels; the tab set itself only changes through editor-driven
    // openNewQuery / closeTab paths.
    this.renderTabBar();
  }

  // ---- Tab actions ---------------------------------------------------

  private openNewQuery(): void {
    const env = environmentService.getActive();
    if (!env) return;
    const q = environmentService.addQuery(env.id, {
      name: this.nextUntitledName(env),
      sql: "",
    });
    if (!q) return;
    this.tabs.push({ queryId: q.id, state: this.buildEditorState("") });
    this.activateInternal(q.id);
    this.persistWorkspace(env.id);
    this.renderTabBar();
    if (!this._isExpanded) this.expand();
    this.editorView?.focus();
  }

  private selectTab(queryId: string): void {
    if (queryId === this.activeQueryId) return;
    this.flushAutoSave();
    this.activateInternal(queryId);
    const env = environmentService.getActive();
    if (env) this.persistWorkspace(env.id);
    this.renderTabBar();
    this.editorView?.focus();
  }

  private closeTab(queryId: string): void {
    if (queryId === this.activeQueryId) this.flushAutoSave();
    const idx = this.tabs.findIndex((t) => t.queryId === queryId);
    if (idx < 0) return;
    this.tabs.splice(idx, 1);

    const env = environmentService.getActive();
    if (this.tabs.length === 0 && env) {
      // Don't leave the editor in a tab-less state. Open a fresh
      // untitled — same shape as a new env activation.
      const q = environmentService.addQuery(env.id, {
        name: this.nextUntitledName(env),
        sql: "",
      });
      if (q) {
        this.tabs.push({ queryId: q.id, state: this.buildEditorState("") });
        this.activateInternal(q.id);
      }
    } else if (queryId === this.activeQueryId) {
      // Activate the tab that took our slot (or the new last tab if
      // we closed the last one).
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.activateInternal(this.tabs[newIdx].queryId);
    }

    if (env) this.persistWorkspace(env.id);
    this.renderTabBar();
  }

  private renameTab(queryId: string, newName: string): void {
    const env = environmentService.getActive();
    if (!env) return;
    environmentService.updateQuery(env.id, queryId, { name: newName });
    // The service emits onChange; `handleEnvServiceChange` re-renders
    // the tab bar with the new label.
  }

  /**
   * Internal tab-switch: snapshot the live view state into the
   * outgoing tab record, then `view.setState` the incoming tab's
   * stored state. Resets `lastAutoSavedText` so the autosave
   * comparator doesn't see the new tab's existing text as "unsaved".
   */
  private activateInternal(queryId: string): void {
    if (!this.editorView) return;
    if (this.activeQueryId && this.activeQueryId !== queryId) {
      const idx = this.tabs.findIndex((t) => t.queryId === this.activeQueryId);
      if (idx >= 0) this.tabs[idx].state = this.editorView.state;
    }
    const target = this.tabs.find((t) => t.queryId === queryId);
    if (!target) return;
    this.editorView.setState(target.state);
    this.activeQueryId = queryId;
    this.lastAutoSavedText = target.state.doc.toString();
  }

  private persistWorkspace(envId: string): void {
    const env = environmentService.get(envId);
    if (!env) return;
    environmentService.setWorkspace(envId, {
      openDataNodeIds: env.workspace.openDataNodeIds,
      openQueryIds: this.tabs.map((t) => t.queryId),
      activeTab: this.activeQueryId
        ? { kind: "query", id: this.activeQueryId }
        : env.workspace.activeTab,
    });
  }

  private renderTabBar(): void {
    if (!this.tabBar) return;
    const env = environmentService.getActive();
    if (!env) {
      this.tabBar.setTabs([], null);
      return;
    }
    const queryById = new Map(env.queries.map((q) => [q.id, q]));
    const descriptors = this.tabs.map((t) => {
      const q = queryById.get(t.queryId);
      return { id: t.queryId, name: q?.name ?? "(missing)" };
    });
    this.tabBar.setTabs(descriptors, this.activeQueryId);
  }

  /** Picks the smallest `untitled-N.sql` not in use by the env. */
  private nextUntitledName(env: Environment): string {
    const used = new Set(env.queries.map((q) => q.name.toLowerCase()));
    let i = 1;
    let candidate = `untitled-${i}.sql`;
    while (used.has(candidate.toLowerCase())) {
      i += 1;
      candidate = `untitled-${i}.sql`;
    }
    return candidate;
  }

  // ---- Save dialog --------------------------------------------------

  private openSaveDialog(): void {
    const query = this.getQuery().trim();
    if (!query) return;
    const existing = persistenceService.loadQueryBookmarks().map((q) => q.name);
    SaveQueryDialog.show({
      title: "Save query as…",
      existingNames: existing,
      onSave: (name) => {
        persistenceService.saveQueryBookmark(name, query);
      },
    });
  }

  // ---- Autosave -----------------------------------------------------

  private scheduleAutoSave(): void {
    if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      this.flushAutoSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private flushAutoSave(): void {
    if (!this.editorView || !this.activeQueryId) return;
    const current = this.editorView.state.doc.toString();
    if (current === this.lastAutoSavedText) return;
    const env = environmentService.getActive();
    if (!env) return;
    try {
      environmentService.updateQuery(env.id, this.activeQueryId, { sql: current });
      this.lastAutoSavedText = current;
    } catch (err) {
      console.warn("SqlEditor: autosave write failed", err);
    }
  }

  // ---- Editor setup -------------------------------------------------

  /**
   * The full extension list used for every editor state in the editor
   * (initial blank + per-tab). Re-built each time `EditorState.create`
   * is called so each state has its own history / autocomplete /
   * listener instances. Sharing extensions across states is fine
   * functionally but creating fresh ones avoids any cross-state
   * surprises.
   */
  private buildExtensions(): Extension[] {
    return [
      lineNumbers(),
      history(),
      sql({ dialect: BedevereSqlDialect }),
      syntaxHighlighting(tokyonightHighlight),
      autocompletion({
        override: [this.autoComplete.getCompletionSource()],
      }),
      // `searchKeymap` adds Ctrl+F find, F3 / Shift+F3 step. See the
      // Prec.high block below for save / execute and the note about
      // multi-cursor that didn't survive 0.11.
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      placeholder("Enter SQL query... (Ctrl+Enter to execute)"),
      EditorView.lineWrapping,
      // Doc-changed → schedule autosave. Selection-only updates fire
      // too; the flush itself bails on no-op via lastAutoSavedText.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.scheduleAutoSave();
      }),
      Prec.high(
        keymap.of([
          { key: "Tab", run: insertTab, shift: indentLess },
          {
            key: "Mod-Enter",
            run: () => { this.execute(); return true; },
          },
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => { this.openSaveDialog(); return true; },
          },
        ])
      ),
    ];
  }

  private buildEditorState(doc: string): EditorState {
    return EditorState.create({ doc, extensions: this.buildExtensions() });
  }

  /**
   * Initialise the single `EditorView`. Called once at construction
   * with an empty document; `applyEnvironment` swaps in the active
   * tab's real state via `view.setState`.
   */
  private initializeEditor(initialDoc: string): void {
    this.editorView = new EditorView({
      state: this.buildEditorState(initialDoc),
      parent: this.editorContainer,
    });
  }

  /**
   * Theme-change handler: tear down the view (extensions reference
   * `var(--...)` CSS variables, which CodeMirror reads at extension-
   * load time, so they don't update live) and rebuild it. Re-applies
   * the active tab's state from the live view *before* destroy so we
   * don't drop pending edits.
   */
  private rebuildEditor(): void {
    if (!this.editorView) return;
    const liveState = this.editorView.state;
    if (this.activeQueryId) {
      const idx = this.tabs.findIndex((t) => t.queryId === this.activeQueryId);
      if (idx >= 0) this.tabs[idx].state = liveState;
    }
    const doc = liveState.doc.toString();
    this.editorView.destroy();
    this.editorContainer.innerHTML = "";
    this.initializeEditor(doc);
    // The freshly-created state replaces what we had stored. Re-snap
    // the active tab record to the new fresh state so future tab
    // switches use the rebuilt extensions.
    if (this.activeQueryId && this.editorView) {
      const idx = this.tabs.findIndex((t) => t.queryId === this.activeQueryId);
      if (idx >= 0) this.tabs[idx].state = this.editorView.state;
    }
  }
}
