import { EditorView, keymap, placeholder, lineNumbers } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { sql } from "@codemirror/lang-sql";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { BedevereSqlDialect } from "../components/SqlEditor/sqlDialect";

/**
 * Mirrors the syntax highlight palette used by the main app's SqlEditor.
 * The token classes resolve to CSS variables so light/dark switches
 * follow the existing tokyonight tokens without a rebuild.
 */
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

export interface EmbedSqlEditorOptions {
  initialQuery: string;
  onExecute: (sql: string) => void;
}

/**
 * Slim SQL editor for the /embed route. CodeMirror only — no autosave,
 * no environment-backed tab strip, no autocomplete schema refresh.
 * The full SqlEditor in the main app is wired to EnvironmentService
 * and a per-query tab model that doesn't apply to a single-shot
 * iframable view, so the embed mounts its own minimal wrapper that
 * shares the highlight palette and SQL dialect.
 */
export class EmbedSqlEditor {
  private container: HTMLElement;
  private editorContainer: HTMLElement;
  private view: EditorView;
  private onExecute: (sql: string) => void;

  constructor(parent: HTMLElement, options: EmbedSqlEditorOptions) {
    this.onExecute = options.onExecute;

    this.container = document.createElement("div");
    this.container.className = "embed-editor";
    parent.appendChild(this.container);

    this.editorContainer = document.createElement("div");
    this.editorContainer.className = "embed-editor__cm";
    this.container.appendChild(this.editorContainer);

    const toolbar = document.createElement("div");
    toolbar.className = "embed-editor__toolbar";
    const runButton = document.createElement("button");
    runButton.className = "embed-editor__run";
    runButton.type = "button";
    runButton.textContent = "Run";
    runButton.title = "Execute query (Ctrl+Enter)";
    runButton.addEventListener("click", () => this.execute());
    toolbar.appendChild(runButton);
    this.container.appendChild(toolbar);

    this.view = new EditorView({
      state: this.buildState(options.initialQuery),
      parent: this.editorContainer,
    });
  }

  public getQuery(): string {
    return this.view.state.doc.toString();
  }

  public setQuery(query: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: query },
    });
  }

  public execute(): void {
    const query = this.getQuery().trim();
    if (!query) return;
    this.onExecute(query);
  }

  public focus(): void {
    this.view.focus();
  }

  public destroy(): void {
    this.view.destroy();
    this.container.remove();
  }

  private buildState(doc: string): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        sql({ dialect: BedevereSqlDialect }),
        syntaxHighlighting(tokyonightHighlight),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        placeholder("Enter SQL query... (Ctrl+Enter to execute)"),
        EditorView.lineWrapping,
        Prec.high(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => { this.execute(); return true; },
            },
          ]),
        ),
      ],
    });
  }
}
