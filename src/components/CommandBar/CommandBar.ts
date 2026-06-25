import { Column } from "../../data/types";
import { persistenceService } from "../../data/PersistenceService";
import { Command, commandRegistry } from "../../data/CommandRegistry";

const HISTORY_MAX = 200;
// Generous cap: the dropdown is scrollable (max-height: 260px in CSS) so
// rendering 50 items is fine, and shrinking the list to 8 was hiding ~half
// of the registered shell commands behind a wall the user couldn't navigate
// past with arrow keys.
const SUGGESTIONS_MAX = 50;

export interface CommandBarOptions {
  container: HTMLElement;
}

export interface CellInfo {
  value: any;
  column: Column;
  position: { row: number; col: number };
}

/**
 * The always-visible strip above the spreadsheet. Hosts the shell input (a
 * single-line text field; Enter submits, Up/Down walk a session history) and
 * the SQL-editor toggle on the right. Dispatch of dot-commands vs SQL lives
 * in the caller (TabManager wires the submit callback).
 */
export class CommandBar {
  private container: HTMLElement;
  private element: HTMLDivElement;
  private prompt!: HTMLSpanElement;
  private input!: HTMLInputElement;
  private toggleButton!: HTMLButtonElement;
  private onToggleSqlEditorCallback?: () => void;
  private onSubmitCallback?: (input: string) => void | Promise<void>;
  private sqlEditorExpanded: boolean = false;

  // Persistent history ring. Loaded from localStorage via PersistenceService
  // on construction and written back on every push. Cap is HISTORY_MAX.
  private history: string[] = [];
  private historyIndex: number = -1; // -1 = editing new line, otherwise points into history
  private pendingDraft: string = ""; // stores the unsubmitted line when user starts walking history

  // Autocomplete dropdown for dot-commands. Visible only while the input
  // starts with '.' and has matching suggestions. Two modes:
  //   "command"  — typing the command name itself, list is Command objects
  //   "argument" — past the first space, list is param.options() strings
  private suggestionsEl!: HTMLDivElement;
  private suggestionMode: "command" | "argument" = "command";
  private commandSuggestions: Command[] = [];
  private argumentSuggestions: string[] = [];
  private suggestionIndex: number = -1; // -1 = no item highlighted
  private suggestionsVisible: boolean = false;

  constructor(options: CommandBarOptions) {
    this.container = options.container;
    this.element = document.createElement("div");
    this.element.className = "command-bar";
    this.setupHTML();
    this.container.appendChild(this.element);
    this.loadHistory();
  }

  private loadHistory(): void {
    const stored = persistenceService.loadAppSettings().shellHistory;
    if (Array.isArray(stored)) {
      this.history = stored.slice(-HISTORY_MAX);
    }
  }

  private persistHistory(): void {
    const settings = persistenceService.loadAppSettings();
    settings.shellHistory = this.history.slice(-HISTORY_MAX);
    persistenceService.saveAppSettings(settings);
  }

  private setupHTML(): void {
    // Shell prompt marker
    this.prompt = document.createElement("span");
    this.prompt.className = "command-bar__shell-prompt";
    this.prompt.textContent = ":";
    this.element.appendChild(this.prompt);

    // Shell input — accepts dot-commands and single-line SQL.
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "command-bar__shell-input";
    this.input.placeholder = "type .help or SQL\u2026";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.addEventListener("keydown", (e) => this.onInputKeyDown(e));
    this.input.addEventListener("input", () => this.updateSuggestions());
    this.input.addEventListener("blur", () => {
      // Defer hide so a click on a suggestion lands before the dropdown unmounts.
      window.setTimeout(() => this.hideSuggestions(), 150);
    });

    // Wrap input + suggestions so the dropdown anchors to the input's exact
    // horizontal footprint (left:0 / right:0 inside the wrap) instead of
    // relying on hardcoded offsets to dodge the prompt and SQL button.
    const inputWrap = document.createElement("div");
    inputWrap.className = "command-bar__input-wrap";
    inputWrap.appendChild(this.input);

    // Autocomplete dropdown. Positioned absolutely against `inputWrap`.
    this.suggestionsEl = document.createElement("div");
    this.suggestionsEl.className = "command-bar__suggestions command-bar__suggestions--hidden";
    inputWrap.appendChild(this.suggestionsEl);

    this.element.appendChild(inputWrap);

    this.toggleButton = document.createElement("button");
    this.toggleButton.className = "command-bar__sql-toggle";
    this.toggleButton.title = "Toggle SQL Editor (Ctrl+E)";
    this.toggleButton.textContent = "SQL";
    this.toggleButton.addEventListener("click", () => {
      this.sqlEditorExpanded = !this.sqlEditorExpanded;
      this.toggleButton.classList.toggle("command-bar__sql-toggle--active", this.sqlEditorExpanded);
      this.onToggleSqlEditorCallback?.();
    });
    this.element.appendChild(this.toggleButton);
  }

  private async onInputKeyDown(e: KeyboardEvent): Promise<void> {
    // Autocomplete takes priority over history when visible. Enter and Tab
    // both accept the highlighted suggestion (Enter is the canonical accept
    // key, matched by the SQL editor's autocompletion; Tab is kept as a
    // bash-style alternate). Up/Down navigate the dropdown; Esc closes it.
    if (this.suggestionsVisible) {
      switch (e.key) {
        case "Enter":
        case "Tab": {
          e.preventDefault();
          e.stopPropagation();
          this.completeFromSuggestions();
          return;
        }
        case "Escape": {
          e.preventDefault();
          e.stopPropagation();
          this.hideSuggestions();
          return;
        }
        case "ArrowDown": {
          e.preventDefault();
          e.stopPropagation();
          this.moveSuggestion(1);
          return;
        }
        case "ArrowUp": {
          e.preventDefault();
          e.stopPropagation();
          this.moveSuggestion(-1);
          return;
        }
      }
    }

    switch (e.key) {
      case "Enter": {
        e.preventDefault();
        e.stopPropagation();
        const value = this.input.value;
        if (value.trim().length === 0) return;
        this.hideSuggestions();
        this.pushHistory(value);
        this.input.value = "";
        this.historyIndex = -1;
        this.pendingDraft = "";
        await this.onSubmitCallback?.(value);
        break;
      }
      case "ArrowUp": {
        if (this.history.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (this.historyIndex === -1) {
          this.pendingDraft = this.input.value;
          this.historyIndex = this.history.length - 1;
        } else if (this.historyIndex > 0) {
          this.historyIndex--;
        }
        this.input.value = this.history[this.historyIndex];
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        break;
      }
      case "ArrowDown": {
        if (this.historyIndex === -1) return;
        e.preventDefault();
        e.stopPropagation();
        if (this.historyIndex < this.history.length - 1) {
          this.historyIndex++;
          this.input.value = this.history[this.historyIndex];
        } else {
          this.historyIndex = -1;
          this.input.value = this.pendingDraft;
          this.pendingDraft = "";
        }
        this.input.setSelectionRange(this.input.value.length, this.input.value.length);
        break;
      }
      // Other keys: let the input handle them normally.
    }
  }

  // ---- autocomplete ------------------------------------------------------

  /**
   * Recompute the suggestion list based on the current input. Dispatches to
   * either command-name or argument completion depending on whether the user
   * has typed past the first space.
   */
  private updateSuggestions(): void {
    const value = this.input.value;
    if (!value.startsWith(".")) {
      this.hideSuggestions();
      return;
    }
    const afterDot = value.slice(1);
    const firstSpace = afterDot.indexOf(" ");
    if (firstSpace === -1) {
      this.updateCommandSuggestions(afterDot);
      return;
    }
    this.updateArgumentSuggestions(afterDot.slice(0, firstSpace), afterDot.slice(firstSpace + 1));
  }

  /** Match shell commands whose `.<shellName>` starts with the typed prefix. */
  private updateCommandSuggestions(needleRaw: string): void {
    const needle = needleRaw.toLowerCase();
    const matches = commandRegistry
      .list({ shellOnly: true })
      .filter((cmd) => {
        const name = cmd.shellName ?? "";
        if (name.toLowerCase().startsWith(needle)) return true;
        if (cmd.aliases?.some((a) => a.toLowerCase().startsWith(needle))) return true;
        return false;
      })
      .sort((a, b) => (a.shellName ?? "").localeCompare(b.shellName ?? ""))
      .slice(0, SUGGESTIONS_MAX);

    if (matches.length === 0) {
      this.hideSuggestions();
      return;
    }

    this.suggestionMode = "command";
    this.commandSuggestions = matches;
    this.argumentSuggestions = [];
    this.suggestionIndex = 0;
    this.renderSuggestions();
    this.suggestionsVisible = true;
    this.suggestionsEl.classList.remove("command-bar__suggestions--hidden");
  }

  /**
   * Suggest values for the current positional argument of `cmdName`, drawn
   * from that parameter's `options()` thunk. Skips flags / named-args
   * (-x / key=val) — those aren't backed by `parameters[].options` today.
   */
  private updateArgumentSuggestions(cmdName: string, argString: string): void {
    const cmd = commandRegistry.getByShellName(cmdName);
    if (!cmd?.parameters?.length) {
      this.hideSuggestions();
      return;
    }

    const trailingSpace = /\s$/.test(this.input.value);
    const tokens = argString.split(/\s+/).filter((t) => t.length > 0);
    const currentToken = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");

    if (currentToken.startsWith("-") || currentToken.includes("=")) {
      this.hideSuggestions();
      return;
    }

    const completedPositionals = (trailingSpace ? tokens : tokens.slice(0, -1))
      .filter((t) => !t.startsWith("-") && !t.includes("="));
    const positionalIndex = completedPositionals.length;

    const param = cmd.parameters[positionalIndex];
    if (!param?.options) {
      this.hideSuggestions();
      return;
    }

    const matches = param.options()
      .filter((o) => o.toLowerCase().startsWith(currentToken.toLowerCase()))
      .slice(0, SUGGESTIONS_MAX);
    if (matches.length === 0) {
      this.hideSuggestions();
      return;
    }

    this.suggestionMode = "argument";
    this.argumentSuggestions = matches;
    this.commandSuggestions = [];
    this.suggestionIndex = 0;
    this.renderSuggestions();
    this.suggestionsVisible = true;
    this.suggestionsEl.classList.remove("command-bar__suggestions--hidden");
  }

  private renderSuggestions(): void {
    this.suggestionsEl.innerHTML = "";
    if (this.suggestionMode === "command") {
      for (let i = 0; i < this.commandSuggestions.length; i++) {
        const cmd = this.commandSuggestions[i];
        const row = this.createSuggestionRow(i);

        const name = document.createElement("span");
        name.className = "command-bar__suggestion-name";
        name.textContent = `.${cmd.shellName}`;
        row.appendChild(name);

        const desc = document.createElement("span");
        desc.className = "command-bar__suggestion-desc";
        desc.textContent = cmd.description || cmd.title;
        row.appendChild(desc);

        this.suggestionsEl.appendChild(row);
      }
    } else {
      for (let i = 0; i < this.argumentSuggestions.length; i++) {
        const value = this.argumentSuggestions[i];
        const row = this.createSuggestionRow(i);

        const name = document.createElement("span");
        name.className = "command-bar__suggestion-name";
        name.textContent = value;
        row.appendChild(name);

        this.suggestionsEl.appendChild(row);
      }
    }
  }

  private createSuggestionRow(i: number): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "command-bar__suggestion";
    if (i === this.suggestionIndex) row.classList.add("command-bar__suggestion--active");
    row.addEventListener("mousedown", (e) => {
      // mousedown (not click) so we beat the input's blur handler.
      e.preventDefault();
      this.suggestionIndex = i;
      this.completeFromSuggestions();
    });
    return row;
  }

  private getActiveSuggestionsLength(): number {
    return this.suggestionMode === "command"
      ? this.commandSuggestions.length
      : this.argumentSuggestions.length;
  }

  private moveSuggestion(delta: number): void {
    const len = this.getActiveSuggestionsLength();
    if (len === 0) return;
    this.suggestionIndex = (this.suggestionIndex + delta + len) % len;
    this.renderSuggestions();
    // Keep the active row inside the dropdown's scroll viewport — without
    // this the highlight can drift below the fold once the list is taller
    // than the CSS max-height.
    const active = this.suggestionsEl.querySelector<HTMLElement>(".command-bar__suggestion--active");
    active?.scrollIntoView({ block: "nearest" });
  }

  private completeFromSuggestions(): void {
    const len = this.getActiveSuggestionsLength();
    if (this.suggestionIndex < 0 || this.suggestionIndex >= len) return;

    if (this.suggestionMode === "command") {
      const cmd = this.commandSuggestions[this.suggestionIndex];
      this.input.value = `.${cmd.shellName} `;
    } else {
      const value = this.argumentSuggestions[this.suggestionIndex];
      const current = this.input.value;
      const trailingSpace = /\s$/.test(current);
      if (trailingSpace) {
        this.input.value = current + value + " ";
      } else {
        const lastSpace = current.lastIndexOf(" ");
        this.input.value = current.slice(0, lastSpace + 1) + value + " ";
      }
    }
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.hideSuggestions();
    // Re-trigger so the next argument's options pop without an extra keystroke.
    this.updateSuggestions();
  }

  private hideSuggestions(): void {
    if (!this.suggestionsVisible) return;
    this.suggestionsVisible = false;
    this.commandSuggestions = [];
    this.argumentSuggestions = [];
    this.suggestionIndex = -1;
    this.suggestionsEl.classList.add("command-bar__suggestions--hidden");
    this.suggestionsEl.innerHTML = "";
  }

  private pushHistory(value: string): void {
    // De-dup consecutive identical lines; cap to HISTORY_MAX entries.
    if (this.history.length > 0 && this.history[this.history.length - 1] === value) return;
    this.history.push(value);
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.persistHistory();
  }

  /**
   * Focus the shell input. Exposed so other components (e.g. a `.focus` or
   * `shell.focus` keybinding later) can grab it programmatically.
   */
  public focusInput(): void {
    this.input.focus();
  }

  public setValue(value: string): void {
    this.input.value = value;
  }

  public setOnSubmitCallback(callback: (input: string) => void | Promise<void>): void {
    this.onSubmitCallback = callback;
  }

  public setOnToggleSqlEditorCallback(callback: () => void): void {
    this.onToggleSqlEditorCallback = callback;
  }

  public setSqlEditorExpanded(expanded: boolean): void {
    this.sqlEditorExpanded = expanded;
    this.toggleButton.classList.toggle("command-bar__sql-toggle--active", expanded);
  }

  public destroy(): void {
    if (this.element && this.element.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
