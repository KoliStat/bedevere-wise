import { EditorView, keymap, placeholder, lineNumbers } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
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
import { SqlAutoComplete } from "./SqlAutoComplete";
import { BedevereSqlDialect } from "./sqlDialect";
import { listenForThemeChanges } from "../SpreadsheetVisualizer/utils/theme";
import { SaveQueryDialog } from "../SaveQueryDialog/SaveQueryDialog";

/**
 * Idle delay between the user's last keystroke and the autosave write.
 * Short enough that a browser crash / refresh loses essentially nothing
 * (sub-second of pure typing), long enough that we're not pummelling
 * localStorage on every character. localStorage writes are sync but
 * cheap at this size — query texts are typically a few KB.
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

export class SqlEditor implements FocusableComponent {
  public readonly componentId: string;
  public readonly canReceiveFocus: boolean = true;
  public readonly focusableElement: HTMLElement;

  private container: HTMLElement;
  private editorContainer: HTMLElement;
  private editorView: EditorView | null = null;
  private autoComplete: SqlAutoComplete;
  private _isFocused: boolean = false;
  private _isExpanded: boolean = false;
  private themeCleanup: (() => void) | null = null;
  private autoSaveTimer: number | null = null;
  // The last text we wrote to the autosave slot. Lets us skip a flush
  // when nothing actually changed (e.g. selection-only updates from
  // CodeMirror still fire updateListener).
  private lastAutoSavedText: string = "";

  private onExecuteCallback?: (query: string) => void;
  private onToggleCallback?: (isExpanded: boolean) => void;

  constructor(parent: HTMLElement, duckDBService: DuckDBService, componentId?: string) {
    this.componentId = componentId ?? "sql-editor";
    this.autoComplete = new SqlAutoComplete(duckDBService);

    // Create the container
    this.container = document.createElement("div");
    this.container.className = "sql-editor";
    this.focusableElement = this.container;

    // Create editor wrapper
    this.editorContainer = document.createElement("div");
    this.editorContainer.className = "sql-editor__editor";
    this.container.appendChild(this.editorContainer);

    // Create toolbar
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

    // Initialize CodeMirror
    this.initializeEditor();

    // Restore the in-flight draft from the previous session, if any.
    // Done after initializeEditor so the EditorView exists and silently
    // so the user sees their text reappear without an "imported X" toast.
    // Also expand the editor so the restored text is visible immediately
    // — a draft that lives behind a collapsed panel is functionally
    // invisible. The expand is deferred so the parent's
    // `setOnToggleCallback` (TabManager wires it right after construction)
    // has a chance to land first; otherwise the CommandBar's SQL-toggle
    // chip wouldn't sync with the editor's actual state.
    const draft = persistenceService.loadEditorAutoSaveDraft();
    if (draft) {
      this.setQuery(draft);
      this.lastAutoSavedText = draft;
      setTimeout(() => this.expand(), 0);
    }

    // Refresh schema for autocompletion
    this.autoComplete.refreshSchema();

    // Listen for theme changes
    this.themeCleanup = listenForThemeChanges(() => {
      this.rebuildEditor();
    });

    // Keymap-scope commands. Registered here because `this.execute` and
    // `this.collapse` are private and need the editor instance's closure.
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

  /**
   * Open the "Save query as…" dialog for the editor's current text.
   * Wired to Ctrl+S via the keymap (`sqlEditor.saveQuery`) and reused
   * by any caller that wants the same UX (e.g. a future Save button).
   * No-op if the editor is empty.
   */
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

  // FocusableComponent interface
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
    // Mod-Enter (execute) and Mod-s (save) are wired through the
    // CodeMirror keymap directly so the editor owns those chords and
    // they fire even when the SqlEditor isn't the FocusManager's
    // tracked focused component (which it never actually is — nothing
    // calls setFocus("sql-editor")). Escape is routed here as a
    // belt-and-braces fallback in case the focused-component path ever
    // gets wired in the future; today it's effectively dead code, but
    // harmless.
    const action = keymapService.matchEvent(event, "sqlEditor");
    if (action !== "sqlEditor.collapse") return false;
    event.preventDefault();
    if (commandRegistry.has(action)) {
      try { await commandRegistry.run(action); }
      catch (err) { console.error(`command ${action} failed:`, err); }
    }
    return true;
  }

  // Public API
  public getQuery(): string {
    return this.editorView?.state.doc.toString() ?? "";
  }

  public setQuery(query: string): void {
    if (!this.editorView) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: query },
    });
  }

  public async execute(): Promise<void> {
    const query = this.getQuery().trim();
    if (!query) return;

    if (this.onExecuteCallback) {
      this.onExecuteCallback(query);
    }
  }

  public clear(): void {
    this.setQuery("");
    this.editorView?.focus();
  }

  public toggle(): void {
    if (this._isExpanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  public expand(): void {
    if (this._isExpanded) return;
    this._isExpanded = true;
    this.container.classList.add("sql-editor--expanded");

    // Focus the editor after expansion animation
    requestAnimationFrame(() => {
      this.editorView?.focus();
    });

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

  public destroy(): void {
    // Flush any pending autosave so a teardown mid-typing doesn't lose
    // the last few characters. Cheap (localStorage write) and matches
    // the debounce semantics — pending becomes "now".
    this.flushAutoSave();
    if (this.autoSaveTimer !== null) {
      window.clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.themeCleanup) {
      this.themeCleanup();
      this.themeCleanup = null;
    }
    this.editorView?.destroy();
    this.editorView = null;
    this.container.remove();
  }

  // ---- Autosave ---------------------------------------------------------

  private scheduleAutoSave(): void {
    if (this.autoSaveTimer !== null) window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      this.flushAutoSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  private flushAutoSave(): void {
    const current = this.getQuery();
    if (current === this.lastAutoSavedText) return;
    try {
      persistenceService.saveEditorAutoSaveDraft(current);
      this.lastAutoSavedText = current;
    } catch (err) {
      // Storage quota or private-mode rejection — log and back off so
      // the next change re-attempts. Persistence is best-effort here.
      console.warn("SqlEditor: autosave write failed", err);
    }
  }

  private initializeEditor(): void {
    const extensions = [
      lineNumbers(),
      history(),
      sql({ dialect: BedevereSqlDialect }),
      syntaxHighlighting(tokyonightHighlight),
      autocompletion({
        override: [this.autoComplete.getCompletionSource()],
      }),
      // Standard CodeMirror keymaps. `searchKeymap` adds Ctrl+F
      // (open find), F3 / Shift+F3 (next / previous match), and the
      // panel close-with-Escape behaviour. See the `Mod-s` block
      // below for the multi-cursor situation.
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      placeholder("Enter SQL query... (Ctrl+Enter to execute)"),
      EditorView.lineWrapping,
      // Listen for any doc change and schedule an autosave flush.
      // Selection-only updates also fire here; the flush itself
      // bails on no-op (lastAutoSavedText comparison) so this is
      // safe.
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.scheduleAutoSave();
      }),
      // The Prec.high block owns chords that would otherwise lose to
      // either the browser default (Ctrl+S → "Save Page As") or a
      // lower-precedence CodeMirror keymap (defaultKeymap's
      // `Mod-Enter -> insertBlankLine`). Routing through CM's keymap
      // here matters because the SqlEditor isn't tracked by the
      // FocusManager — the document-level `handleKeyDown` path is
      // effectively dead code; CM's own keydown handler runs
      // synchronously with `preventDefault: true` and stops the
      // browser shortcut cold.
      Prec.high(
        keymap.of([
          { key: "Tab", run: insertTab, shift: indentLess },
          {
            key: "Mod-Enter",
            run: () => {
              this.execute();
              return true;
            },
          },
          // Ctrl+S → open the "Save query as…" dialog. preventDefault
          // suppresses the browser's "Save Page As" dialog.
          // Note: multi-cursor bindings (`Mod-d`, `Alt-ArrowUp/Down`,
          // `Mod-Alt-ArrowUp/Down`) were tried at both `Prec.high` and
          // `Prec.highest` during 0.11 and refused to fire — they're
          // intentionally absent rather than dead-code-pretending-to-work.
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              this.openSaveDialog();
              return true;
            },
          },
        ])
      ),
    ];

    const state = EditorState.create({
      doc: "",
      extensions,
    });

    this.editorView = new EditorView({
      state,
      parent: this.editorContainer,
    });
  }

  private rebuildEditor(): void {
    const currentDoc = this.getQuery();
    this.editorView?.destroy();
    this.editorContainer.innerHTML = "";
    this.initializeEditor();
    if (currentDoc) {
      this.setQuery(currentDoc);
    }
  }
}
