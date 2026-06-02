import duckPng from "@/assets/duck.png?url";
import {
  KeyBinding,
  KeymapEntry,
  formatBinding,
  keymapService,
  matchesBinding,
} from "@/data/KeymapService";
import {
  FeedbackCategory,
  isFeedbackConfigured,
  submitFeedback,
} from "@/data/FeedbackService";
import { Command, commandRegistry } from "@/data/CommandRegistry";
import { renderAboutBody } from "./aboutHtml";
import {
  AUTO_IMPORT_THRESHOLD_PRESETS,
  DATE_FORMAT_PRESETS,
  DATETIME_FORMAT_PRESETS,
  DECIMAL_PRESETS,
  FormatPrefs,
  formatThresholdLabel,
  MAX_STRING_LENGTH_PRESETS,
  MIN_CELL_WIDTH_PRESETS,
} from "./formatPresets";
import { PENGUINS_TUTORIAL, TutorialNode } from "./tutorial";

export type HelpPanelTab = "howto" | "import" | "shortcuts" | "commands" | "feedback" | "settings" | "about";

export interface HelpPanelOptions {
  version: string;
  onLoadSampleDataset: () => Promise<void> | void;
  onShowMessage?: (msg: string, type: "info" | "success" | "error") => void;
  onBrowseFolder?: () => void;
  onFilesReceived?: (files: File[]) => void | Promise<void>;
  supportedFormats?: string[];
  initialTheme?: "light" | "dark" | "auto";
  onThemeChange?: (theme: "light" | "dark" | "auto") => void;
  onResetKeymap?: () => void;
  onClearAllData?: () => Promise<void> | void;
  getCopyOptions?: () => { delimiter: "tab" | "comma"; includeHeader: boolean; quoteEscape: "double" | "backslash" };
  setCopyOptions?: (opts: { delimiter: "tab" | "comma"; includeHeader: boolean; quoteEscape: "double" | "backslash" }) => void;
  getFormatOptions?: () => FormatPrefs;
  setFormatOptions?: (opts: FormatPrefs) => void;
  /** Recent folders shortcut list (FSA-API-only browsers). Empty array
   *  hides the section in the Import tab. */
  getRecentFolders?: () => Array<{ id: string; name: string }>;
  onRecentFolderClick?: (id: string) => void;
}

const TAB_ORDER: HelpPanelTab[] = ["howto", "import", "shortcuts", "commands", "feedback", "settings", "about"];

const SCOPE_LABELS: Record<string, string> = {
  global: "App",
  spreadsheet: "Spreadsheet",
  sqlEditor: "SQL Editor",
  commandPalette: "Command Palette",
};

const SCOPE_ORDER: string[] = ["global", "spreadsheet", "sqlEditor", "commandPalette"];

export class HelpPanel {
  private parent: HTMLElement;
  private options: HelpPanelOptions;
  private overlay: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private tabButtons: Map<HelpPanelTab, HTMLButtonElement> = new Map();
  private tabBodies: Map<HelpPanelTab, HTMLElement> = new Map();
  private sampleButton: HTMLButtonElement | null = null;
  private currentTab: HelpPanelTab = "howto";
  private captureActive: boolean = false;

  // Capture-phase listener so we pre-empt EventDispatcher's keydown routing.
  // Runs before BedevereApp.handleKeyDown, lets us own Escape / tab-nav keys
  // while the panel is open.
  private onKeyDown = (e: KeyboardEvent) => {
    // Capture-mode (rebinding a shortcut) owns every key — don't steal events.
    if (this.captureActive) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.hide();
      return;
    }

    // Ctrl+Alt+←/→ cycles Help tabs; mirrors dataset-tab nav.
    if (e.ctrlKey && e.altKey && !e.shiftKey) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cycleTab(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cycleTab(-1);
        return;
      }
    }

    // Alt+1..N jumps directly to tab N while Help is open.
    if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      if (idx < TAB_ORDER.length) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.setTab(TAB_ORDER[idx]);
      }
    }
  };

  constructor(parent: HTMLElement, options: HelpPanelOptions) {
    this.parent = parent;
    this.options = options;
  }

  public show(tab: HelpPanelTab = "howto"): void {
    if (!this.overlay) {
      this.build();
    }
    this.setTab(tab);
    document.addEventListener("keydown", this.onKeyDown, { capture: true });
  }

  public hide(): void {
    document.removeEventListener("keydown", this.onKeyDown, { capture: true });
    this.captureActive = false;
    this.overlay?.remove();
    this.overlay = null;
    this.panel = null;
    this.tabButtons.clear();
    this.tabBodies.clear();
    this.sampleButton = null;
  }

  private cycleTab(delta: number): void {
    const idx = TAB_ORDER.indexOf(this.currentTab);
    const next = (idx + delta + TAB_ORDER.length) % TAB_ORDER.length;
    this.setTab(TAB_ORDER[next]);
  }

  public isOpen(): boolean {
    return this.overlay !== null;
  }

  public setTab(tab: HelpPanelTab): void {
    this.currentTab = tab;
    // The Commands listing is registry-driven; rebuild on each show so it
    // reflects whatever's been registered since the panel was last opened.
    if (tab === "commands") {
      const body = this.tabBodies.get("commands");
      if (body) this.renderCommandsBody(body);
    }
    for (const [id, btn] of this.tabButtons) {
      btn.classList.toggle("help-panel__tab--active", id === tab);
    }
    for (const [id, body] of this.tabBodies) {
      body.classList.toggle("help-panel__tab-body--active", id === tab);
    }
  }

  public destroy(): void {
    this.hide();
  }

  private build(): void {
    this.overlay = document.createElement("div");
    this.overlay.className = "help-panel-overlay";
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.hide();
    });

    this.panel = document.createElement("div");
    this.panel.className = "help-panel";

    this.panel.appendChild(this.buildHeader());
    this.panel.appendChild(this.buildTabs());

    const body = document.createElement("div");
    body.className = "help-panel__body";
    body.appendChild(this.buildHowToBody());
    body.appendChild(this.buildImportBody());
    body.appendChild(this.buildShortcutsBody());
    body.appendChild(this.buildCommandsBody());
    body.appendChild(this.buildFeedbackBody());
    body.appendChild(this.buildSettingsBody());
    body.appendChild(this.buildAboutBody());
    this.panel.appendChild(body);

    this.overlay.appendChild(this.panel);
    this.parent.appendChild(this.overlay);
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "help-panel__header";

    const title = document.createElement("h2");
    title.className = "help-panel__title";
    title.innerHTML = `<img class="help-panel__brand-icon" src="${duckPng}" alt="" /> Bedevere Wise`;

    const close = document.createElement("button");
    close.className = "help-panel__close";
    close.title = "Close";
    close.textContent = "\u00D7";
    close.addEventListener("click", () => this.hide());

    header.appendChild(title);
    header.appendChild(close);
    return header;
  }

  private buildTabs(): HTMLElement {
    const tabs = document.createElement("div");
    tabs.className = "help-panel__tabs";

    const labels: Record<HelpPanelTab, string> = {
      howto: "How To",
      import: "Import",
      shortcuts: "Shortcuts",
      commands: "Commands",
      feedback: "Feedback",
      settings: "Settings",
      about: "About",
    };
    for (const id of TAB_ORDER) {
      const btn = this.makeTabButton(id, labels[id]);
      this.tabButtons.set(id, btn);
      tabs.appendChild(btn);
    }
    return tabs;
  }

  private makeTabButton(id: HelpPanelTab, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "help-panel__tab";
    btn.textContent = label;
    btn.addEventListener("click", () => this.setTab(id));
    return btn;
  }

  private buildHowToBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--howto";
    this.tabBodies.set("howto", body);

    body.innerHTML = `
      <p class="help-panel__lead">
        \uD83D\uDC4B Welcome to <strong>Bedevere Wise</strong> &mdash; a local-first SQL data viewer.
      </p>

      <div class="help-panel__callout help-panel__callout--privacy">
        <div class="help-panel__callout-title">\uD83D\uDD12 Your data stays on your device</div>
        <p>
          All parsing and querying happens locally in your browser via <strong>DuckDB-WASM</strong>.
          No telemetry, no uploads, nothing crosses the network unless you explicitly fetch a remote file.
        </p>
      </div>

      <div class="help-panel__callout help-panel__callout--deps">
        <div class="help-panel__callout-title">\u2696\uFE0F Minimal dependencies</div>
        <p>
          Built on three libraries:
          <a href="https://duckdb.org/docs/api/wasm/overview" target="_blank" rel="noopener noreferrer">DuckDB-WASM</a>
          (SQL engine),
          <a href="https://codemirror.net/" target="_blank" rel="noopener noreferrer">CodeMirror 6</a>
          (editor), and
          <a href="https://vega.github.io/vega-lite/" target="_blank" rel="noopener noreferrer">Vega-Lite</a>
          (charts &mdash; lazy-loaded on first <code>VISUALIZE</code>).
          No frameworks, no analytics, no tracking. A small, well-known
          dependency set means a small <strong>attack surface</strong>
          &mdash; easier to audit, fewer transitive vulnerabilities, no
          mystery code shipping in your tab.
        </p>
      </div>

      <h3 class="help-panel__section-title">Get started</h3>
      <ol class="help-panel__steps">
        <li><strong>Drop a file</strong> &mdash; CSV, TSV, JSON, Parquet, Excel, SAS, Stata, SPSS &mdash; or use the <em>Browse</em> button.</li>
        <li><strong>Try a SQL query</strong> &mdash; press <kbd>Ctrl</kbd>+<kbd>E</kbd> for the editor; autocomplete knows your tables and columns.</li>
        <li><strong>Save views &amp; queries</strong> &mdash; build up a workspace from the left panel.</li>
      </ol>

      <h3 class="help-panel__section-title">Try it now</h3>
      <p class="help-panel__hint">
        Don't have a file handy? Load a small demo to play around.
      </p>
      <button type="button" class="help-panel__sample-btn" data-action="load-sample">
        Load sample dataset (Palmer Penguins)
      </button>

      <h3 class="help-panel__section-title">Working with SQL</h3>
      <div class="help-panel__tutorial" data-tutorial></div>
    `;

    this.sampleButton = body.querySelector<HTMLButtonElement>("[data-action='load-sample']");
    this.sampleButton?.addEventListener("click", () => this.handleLoadSample());

    const tutorialHost = body.querySelector("[data-tutorial]")!;
    for (const node of PENGUINS_TUTORIAL) {
      tutorialHost.appendChild(this.buildTutorialNode(node));
    }

    return body;
  }

  private buildTutorialNode(node: TutorialNode): HTMLElement {
    switch (node.kind) {
      case "heading": {
        const h = document.createElement("h4");
        h.className = "help-panel__tutorial-heading";
        h.textContent = node.text;
        return h;
      }
      case "prose": {
        const p = document.createElement("p");
        p.className = "help-panel__tutorial-prose";
        p.innerHTML = node.html;
        return p;
      }
      case "tip": {
        const p = document.createElement("p");
        p.className = "help-panel__tip";
        p.innerHTML = `<strong>Tip:</strong> ${node.html}`;
        return p;
      }
      case "snippet":
        return this.buildTutorialSnippet(node.sql);
    }
  }

  private buildTutorialSnippet(sql: string): HTMLElement {
    const card = document.createElement("div");
    card.className = "help-panel__snippet help-panel__snippet--titleless";

    const head = document.createElement("div");
    head.className = "help-panel__snippet-head help-panel__snippet-head--titleless";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "help-panel__copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => this.handleCopy(sql, copyBtn));
    head.appendChild(copyBtn);

    const pre = document.createElement("pre");
    pre.className = "help-panel__snippet-code";
    const code = document.createElement("code");
    code.textContent = sql;
    pre.appendChild(code);

    card.appendChild(head);
    card.appendChild(pre);
    return card;
  }

  private async handleCopy(text: string, btn: HTMLButtonElement): Promise<void> {
    const ok = await this.copyToClipboard(text);
    if (ok) {
      const original = btn.textContent ?? "Copy";
      btn.textContent = "Copied!";
      btn.classList.add("help-panel__copy-btn--copied");
      window.setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("help-panel__copy-btn--copied");
      }, 1500);
    } else {
      this.options.onShowMessage?.("Copy failed", "error");
    }
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // fall through to legacy path
      }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  private async handleLoadSample(): Promise<void> {
    if (!this.sampleButton) return;
    const original = this.sampleButton.textContent ?? "Load sample dataset";
    this.sampleButton.disabled = true;
    this.sampleButton.textContent = "Loading\u2026";
    try {
      await this.options.onLoadSampleDataset();
    } catch {
      // BedevereApp surfaces its own error; just restore button
      this.sampleButton.disabled = false;
      this.sampleButton.textContent = original;
    }
  }

  private buildImportBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--import";
    this.tabBodies.set("import", body);

    const formats = this.options.supportedFormats ?? [];

    // Drop zone area
    const dropzone = document.createElement("div");
    dropzone.className = "help-panel__import-dropzone";
    dropzone.innerHTML = `
      <svg class="help-panel__import-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7,10 12,15 17,10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <h3 class="help-panel__import-title">Import Data</h3>
      <p class="help-panel__import-description">
        Drag files here, or use the buttons below.
      </p>
      <p class="help-panel__import-formats">
        Supported: ${formats.join(", ") || "CSV, TSV, JSON, Parquet, Excel, SAS, SPSS, Stata"}
      </p>
    `;

    // Scoped drag-drop handlers on the dropzone div
    const prevent = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    dropzone.addEventListener("dragenter", (e) => { prevent(e); dropzone.classList.add("help-panel__import-dropzone--active"); });
    dropzone.addEventListener("dragover", (e) => { prevent(e); dropzone.classList.add("help-panel__import-dropzone--active"); });
    dropzone.addEventListener("dragleave", (e) => { prevent(e); dropzone.classList.remove("help-panel__import-dropzone--active"); });
    dropzone.addEventListener("drop", (e) => {
      prevent(e);
      dropzone.classList.remove("help-panel__import-dropzone--active");
      const files = Array.from((e as DragEvent).dataTransfer?.files || []);
      if (files.length > 0) this.handleImportFiles(files);
    });

    body.appendChild(dropzone);

    // Action buttons
    const actions = document.createElement("div");
    actions.className = "help-panel__import-actions";

    // Hidden file input
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = formats.join(",");
    fileInput.multiple = true;
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length > 0) {
        this.handleImportFiles(Array.from(fileInput.files));
        fileInput.value = "";
      }
    });
    body.appendChild(fileInput);

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "help-panel__import-btn";
    browseBtn.textContent = "Browse Files";
    browseBtn.addEventListener("click", () => fileInput.click());
    actions.appendChild(browseBtn);

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "help-panel__import-btn help-panel__import-btn--secondary";
    folderBtn.textContent = "Browse Folder";
    folderBtn.addEventListener("click", () => {
      this.options.onBrowseFolder?.();
      this.hide();
    });
    actions.appendChild(folderBtn);

    body.appendChild(actions);

    // Recent folders shortcuts (only on browsers where the directory
    // handle could be persisted — `getRecentFolders` returns []
    // otherwise, which hides the section).
    const recents = this.options.getRecentFolders?.() ?? [];
    if (recents.length > 0) {
      const recentsSection = document.createElement("div");
      recentsSection.className = "help-panel__import-recents";
      const heading = document.createElement("div");
      heading.className = "help-panel__import-recents-title";
      heading.textContent = "Recent folders";
      recentsSection.appendChild(heading);

      const list = document.createElement("div");
      list.className = "help-panel__import-recents-list";
      for (const entry of recents) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "help-panel__import-recents-item";
        btn.title = entry.name;
        btn.textContent = entry.name;
        btn.addEventListener("click", () => {
          this.options.onRecentFolderClick?.(entry.id);
          this.hide();
        });
        list.appendChild(btn);
      }
      recentsSection.appendChild(list);
      body.appendChild(recentsSection);
    }

    // Status area for inline feedback
    const status = document.createElement("div");
    status.className = "help-panel__import-status";
    status.dataset.importStatus = "";
    body.appendChild(status);

    return body;
  }

  private async handleImportFiles(files: File[]): Promise<void> {
    const statusEl = this.panel?.querySelector<HTMLElement>("[data-import-status]");
    if (statusEl) {
      statusEl.textContent = `Importing ${files.length} file${files.length > 1 ? "s" : ""}\u2026`;
      statusEl.className = "help-panel__import-status help-panel__import-status--loading";
    }
    try {
      await this.options.onFilesReceived?.(files);
      this.hide();
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = `Import failed: ${error instanceof Error ? error.message : "unknown error"}`;
        statusEl.className = "help-panel__import-status help-panel__import-status--error";
      }
    }
  }

  private buildShortcutsBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--shortcuts";
    this.tabBodies.set("shortcuts", body);
    this.renderShortcutsInto(body);
    return body;
  }

  /**
   * Re-render the shortcuts tab body in place. Used after rebind / reset so
   * the updated keymap is reflected without closing the panel.
   */
  private renderShortcutsInto(body: HTMLElement): void {
    const scrollTop = body.scrollTop;
    body.innerHTML = "";

    const intro = document.createElement("p");
    intro.className = "help-panel__hint";
    intro.textContent = "Click a shortcut to rebind it. Esc cancels capture.";
    body.appendChild(intro);

    const entries = keymapService.getEntries();
    const byScope = new Map<string, KeymapEntry[]>();
    for (const e of entries) {
      if (!byScope.has(e.scope)) byScope.set(e.scope, []);
      byScope.get(e.scope)!.push(e);
    }

    for (const scope of SCOPE_ORDER) {
      const scopeEntries = byScope.get(scope);
      if (!scopeEntries || scopeEntries.length === 0) continue;

      const section = document.createElement("div");
      section.className = "help-panel__shortcuts-section";

      const title = document.createElement("h3");
      title.className = "help-panel__section-title";
      title.textContent = SCOPE_LABELS[scope] ?? scope;
      section.appendChild(title);

      const list = document.createElement("dl");
      list.className = "help-panel__shortcuts-list";
      for (const entry of scopeEntries) {
        list.appendChild(this.buildShortcutRow(entry));
      }

      // After the global/"App" section, slot in the Alt+1..9 jump. Handled
      // outside the keymap so not rebindable — show it read-only.
      if (scope === "global") {
        list.appendChild(this.buildStaticShortcutRow("Jump to tab N", "Alt+1 \u2026 Alt+9"));
      }

      section.appendChild(list);
      body.appendChild(section);
    }

    body.scrollTop = scrollTop;
  }

  /** Build a rebindable shortcut row for a KeymapEntry. */
  private buildShortcutRow(entry: KeymapEntry): HTMLElement {
    const row = document.createElement("div");
    row.className = "help-panel__shortcut-row help-panel__shortcut-row--rebindable";
    row.tabIndex = 0;

    const dt = document.createElement("dt");
    dt.className = "help-panel__shortcut-desc";
    dt.textContent = entry.description;

    const dd = document.createElement("dd");
    dd.className = "help-panel__shortcut-keys";

    this.renderShortcutKeys(dd, entry);

    row.appendChild(dt);
    row.appendChild(dd);

    const startCapture = () => this.beginCapture(entry, row, dd);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".help-panel__reset-btn")) return;
      startCapture();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        startCapture();
      }
    });

    return row;
  }

  /** Build a read-only shortcut row (e.g. for shortcuts not in the keymap). */
  private buildStaticShortcutRow(description: string, keys: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "help-panel__shortcut-row help-panel__shortcut-row--static";

    const dt = document.createElement("dt");
    dt.className = "help-panel__shortcut-desc";
    dt.textContent = description;

    const dd = document.createElement("dd");
    dd.className = "help-panel__shortcut-keys";
    this.renderKeyTokens(dd, keys);

    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  /** Render the key area for a rebindable entry: tokens + optional reset btn. */
  private renderShortcutKeys(dd: HTMLElement, entry: KeymapEntry): void {
    dd.innerHTML = "";
    this.renderKeyTokens(dd, formatBinding(entry.binding));

    const def = keymapService.getDefaultBinding(entry.action);
    if (def && !bindingsEqual(def, entry.binding)) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "help-panel__reset-btn";
      reset.title = `Reset to default (${formatBinding(def)})`;
      reset.textContent = "\u21BA";
      reset.addEventListener("click", (e) => {
        e.stopPropagation();
        keymapService.setBinding(entry.action, def);
        const bodyEl = this.tabBodies.get("shortcuts");
        if (bodyEl) this.renderShortcutsInto(bodyEl);
      });
      dd.appendChild(reset);
    }
  }

  private renderKeyTokens(dd: HTMLElement, keys: string): void {
    const tokens = keys.split("+");
    tokens.forEach((token, i) => {
      const kbd = document.createElement("kbd");
      kbd.className = "help-panel__kbd";
      kbd.textContent = token;
      dd.appendChild(kbd);
      if (i < tokens.length - 1) {
        const sep = document.createElement("span");
        sep.className = "help-panel__kbd-sep";
        sep.textContent = "+";
        dd.appendChild(sep);
      }
    });
  }

  /**
   * Enter rebinding capture mode for a single shortcut. Swaps the row's key
   * display for a "Press keys\u2026" message, installs a capture-phase keydown
   * listener that records the next non-modifier combo, and either saves or
   * warns about a conflict.
   */
  private beginCapture(entry: KeymapEntry, row: HTMLElement, dd: HTMLElement): void {
    if (this.captureActive) return;
    this.captureActive = true;

    row.classList.add("help-panel__shortcut-row--capturing");
    dd.innerHTML = "";
    const prompt = document.createElement("span");
    prompt.className = "help-panel__capture";
    prompt.textContent = "Press keys\u2026 (Esc to cancel)";
    dd.appendChild(prompt);

    const restore = () => {
      row.classList.remove("help-panel__shortcut-row--capturing");
      this.renderShortcutKeys(dd, entry);
    };

    const cleanup = () => {
      document.removeEventListener("keydown", handler, { capture: true });
      this.captureActive = false;
    };

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      // Ignore pure modifier key presses; wait for the real key.
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") {
        return;
      }

      if (e.key === "Escape") {
        cleanup();
        restore();
        return;
      }

      const binding: KeyBinding = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };

      const conflict = keymapService
        .getEntries(entry.scope)
        .find((other) => other.action !== entry.action && matchesBinding(e, other.binding));

      if (conflict) {
        prompt.innerHTML = "";
        const txt = document.createElement("span");
        txt.textContent = `Conflicts with "${conflict.description}" \u2014 try another combo.`;
        prompt.appendChild(txt);
        prompt.classList.add("help-panel__capture--conflict");
        return;
      }

      keymapService.setBinding(entry.action, binding);
      cleanup();
      const bodyEl = this.tabBodies.get("shortcuts");
      if (bodyEl) this.renderShortcutsInto(bodyEl);
    };

    document.addEventListener("keydown", handler, { capture: true });
  }

  private buildCommandsBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--commands";
    this.tabBodies.set("commands", body);
    this.renderCommandsBody(body);
    return body;
  }

  private renderCommandsBody(body: HTMLElement): void {
    body.innerHTML = "";

    const lead = document.createElement("p");
    lead.className = "help-panel__lead";
    lead.innerHTML =
      "Type any of these into the shell (<kbd>Ctrl</kbd>+<kbd>`</kbd> to focus it). " +
      "Lines without a leading dot run as DuckDB SQL.";
    body.appendChild(lead);

    const all = commandRegistry
      .list({ shellOnly: true })
      .sort((a, b) =>
        (a.category || "").localeCompare(b.category || "") ||
        (a.shellName || "").localeCompare(b.shellName || "")
      );

    const grouped = new Map<string, Command[]>();
    for (const cmd of all) {
      const cat = cmd.category || "Other";
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat)!.push(cmd);
    }

    for (const [cat, cmds] of grouped) {
      const h = document.createElement("h3");
      h.className = "help-panel__section-title";
      h.textContent = cat;
      body.appendChild(h);

      const list = document.createElement("dl");
      list.className = "help-panel__commands-list";
      for (const cmd of cmds) {
        const dt = document.createElement("dt");
        dt.className = "help-panel__commands-name";
        const aliasSuffix = cmd.aliases?.length ? ` (.${cmd.aliases.join(", .")})` : "";
        dt.textContent = `.${cmd.shellName}${aliasSuffix}`;
        list.appendChild(dt);

        const dd = document.createElement("dd");
        dd.className = "help-panel__commands-desc";
        dd.textContent = cmd.description || cmd.title;
        list.appendChild(dd);
      }
      body.appendChild(list);
    }
  }

  private buildFeedbackBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--feedback";
    this.tabBodies.set("feedback", body);

    const configured = isFeedbackConfigured();

    body.innerHTML = `
      <p class="help-panel__lead">
        Found a bug? Wanted feature? Just here to say hi? \u2014 send a note via the form
        below, or email <a href="mailto:contact@bedeverewise.app">contact@bedeverewise.app</a>
        directly. The form's email field is optional; leave it blank to stay anonymous.
      </p>

      ${
        configured
          ? ""
          : `<div class="help-panel__callout help-panel__callout--deps">
               <div class="help-panel__callout-title">Endpoint not configured</div>
               <p>
                 The feedback service URL hasn\u2019t been wired into this build (set
                 <code>VITE_FEEDBACK_URL</code> at build time). Until it is, the form
                 below falls back to opening your email client.
               </p>
             </div>`
      }

      <form class="help-panel__feedback-form" id="help-feedback-form" novalidate>
        <label class="help-panel__feedback-row">
          <span class="help-panel__feedback-label">Category</span>
          <select class="help-panel__feedback-select" id="help-feedback-category">
            <option value="bug">Bug</option>
            <option value="feature">Feature request</option>
            <option value="question">Question</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label class="help-panel__feedback-row">
          <span class="help-panel__feedback-label">Email <span class="help-panel__feedback-optional">(optional)</span></span>
          <input class="help-panel__feedback-input" id="help-feedback-email" type="email"
                 placeholder="you@example.com" autocomplete="email" />
        </label>

        <label class="help-panel__feedback-row help-panel__feedback-row--stack">
          <span class="help-panel__feedback-label">Message</span>
          <textarea class="help-panel__feedback-textarea" id="help-feedback-message"
                    rows="6" maxlength="8000" required
                    placeholder="What\u2019s on your mind?"></textarea>
          <span class="help-panel__feedback-counter" id="help-feedback-counter">0 / 8000</span>
        </label>

        <!-- Honeypot — hidden from real users, bots fill it. -->
        <label class="help-panel__feedback-honeypot" aria-hidden="true">
          Don\u2019t fill this in:
          <input type="text" id="help-feedback-honeypot" tabindex="-1" autocomplete="off" />
        </label>

        <div class="help-panel__feedback-actions">
          <span class="help-panel__feedback-status" id="help-feedback-status"></span>
          <button class="help-panel__feedback-submit" id="help-feedback-submit" type="submit">
            Send
          </button>
        </div>
      </form>
    `;

    this.wireFeedbackForm(body);
    return body;
  }

  private wireFeedbackForm(body: HTMLElement): void {
    const form = body.querySelector<HTMLFormElement>("#help-feedback-form");
    const messageEl = body.querySelector<HTMLTextAreaElement>("#help-feedback-message");
    const counterEl = body.querySelector<HTMLSpanElement>("#help-feedback-counter");
    const statusEl = body.querySelector<HTMLSpanElement>("#help-feedback-status");
    const submitBtn = body.querySelector<HTMLButtonElement>("#help-feedback-submit");
    const categoryEl = body.querySelector<HTMLSelectElement>("#help-feedback-category");
    const emailEl = body.querySelector<HTMLInputElement>("#help-feedback-email");
    const honeypotEl = body.querySelector<HTMLInputElement>("#help-feedback-honeypot");
    if (!form || !messageEl || !counterEl || !statusEl || !submitBtn || !categoryEl || !emailEl || !honeypotEl) {
      return;
    }

    const updateCounter = (): void => {
      counterEl.textContent = `${messageEl.value.length} / 8000`;
    };
    messageEl.addEventListener("input", updateCounter);
    updateCounter();

    const setStatus = (text: string, kind: "ok" | "error" | "info" | ""): void => {
      statusEl.textContent = text;
      statusEl.className = "help-panel__feedback-status";
      if (kind) statusEl.classList.add(`help-panel__feedback-status--${kind}`);
    };

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const message = messageEl.value.trim();
      if (message.length === 0) {
        setStatus("Message can\u2019t be empty.", "error");
        messageEl.focus();
        return;
      }
      const email = emailEl.value.trim();
      const category = categoryEl.value as FeedbackCategory;

      submitBtn.disabled = true;
      setStatus("Sending\u2026", "info");

      const result = await submitFeedback(
        {
          category,
          message,
          email: email || undefined,
          honeypot: honeypotEl.value || undefined,
        },
        this.options.version,
      );

      submitBtn.disabled = false;

      switch (result.kind) {
        case "ok":
          setStatus("Thanks \u2014 sent.", "ok");
          form.reset();
          updateCounter();
          break;
        case "rate-limited":
          setStatus("Too many submissions in a row \u2014 wait a moment, then retry.", "error");
          break;
        case "validation-error":
          setStatus(`Rejected: ${result.message}`, "error");
          break;
        case "network-error":
          setStatus(`Network error: ${result.message}. Try again, or email me directly.`, "error");
          break;
        case "not-configured":
          // Fall back to mailto: so the user isn't stuck.
          this.openMailtoFallback(category, message, email);
          setStatus("Opened your email client (no submit endpoint configured).", "info");
          break;
      }
    });
  }

  private openMailtoFallback(category: FeedbackCategory, message: string, email: string): void {
    const subject = `[bedevere-wise] ${category}`;
    const lines = [
      `Category: ${category}`,
      `Version: ${this.options.version}`,
      email ? `From: ${email}` : "",
      "",
      message,
    ].filter(Boolean);
    const href = `mailto:contact@bedeverewise.app?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
    window.location.href = href;
  }

  private buildSettingsBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--settings";
    this.tabBodies.set("settings", body);

    // --- Theme ---
    body.appendChild(this.buildSettingsSection("Theme", (section) => {
      const seg = document.createElement("div");
      seg.className = "help-panel__segmented";
      const current = this.options.initialTheme ?? "auto";
      const opts: Array<{ value: "light" | "dark" | "auto"; label: string }> = [
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "auto", label: "Auto" },
      ];
      for (const opt of opts) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "help-panel__segmented-btn";
        btn.textContent = opt.label;
        if (opt.value === current) btn.classList.add("help-panel__segmented-btn--active");
        btn.addEventListener("click", () => {
          for (const sibling of seg.querySelectorAll("button")) {
            sibling.classList.remove("help-panel__segmented-btn--active");
          }
          btn.classList.add("help-panel__segmented-btn--active");
          this.options.onThemeChange?.(opt.value);
        });
        seg.appendChild(btn);
      }
      section.appendChild(seg);
    }));

    // --- Copy & export format ---
    body.appendChild(this.buildSettingsSection("Copy & export format", (section) => {
      const defaults = { delimiter: "tab" as const, includeHeader: true, quoteEscape: "double" as const };
      const current = this.options.getCopyOptions?.() ?? defaults;
      const getLatest = () => this.options.getCopyOptions?.() ?? defaults;

      // --- Delimiter
      const delimRow = document.createElement("div");
      delimRow.className = "help-panel__settings-row";
      const delimLabel = document.createElement("span");
      delimLabel.className = "help-panel__settings-label";
      delimLabel.textContent = "Delimiter";
      delimRow.appendChild(delimLabel);

      const delimSeg = document.createElement("div");
      delimSeg.className = "help-panel__segmented";
      const delims: Array<{ value: "tab" | "comma"; label: string }> = [
        { value: "tab", label: "Tab" },
        { value: "comma", label: "Comma" },
      ];
      for (const opt of delims) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "help-panel__segmented-btn";
        btn.textContent = opt.label;
        if (opt.value === current.delimiter) btn.classList.add("help-panel__segmented-btn--active");
        btn.addEventListener("click", () => {
          for (const sibling of delimSeg.querySelectorAll("button")) {
            sibling.classList.remove("help-panel__segmented-btn--active");
          }
          btn.classList.add("help-panel__segmented-btn--active");
          const latest = getLatest();
          this.options.setCopyOptions?.({ ...latest, delimiter: opt.value });
        });
        delimSeg.appendChild(btn);
      }
      delimRow.appendChild(delimSeg);
      section.appendChild(delimRow);

      // --- Quote escape (CSV / TSV with embedded quotes)
      const quoteRow = document.createElement("div");
      quoteRow.className = "help-panel__settings-row";
      const quoteLabel = document.createElement("span");
      quoteLabel.className = "help-panel__settings-label";
      quoteLabel.textContent = "Quote escape";
      quoteRow.appendChild(quoteLabel);

      const quoteSeg = document.createElement("div");
      quoteSeg.className = "help-panel__segmented";
      const quoteOpts: Array<{ value: "double" | "backslash"; label: string }> = [
        { value: "double", label: "\"\" (RFC 4180)" },
        { value: "backslash", label: "\\\" (JSON-style)" },
      ];
      for (const opt of quoteOpts) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "help-panel__segmented-btn";
        btn.textContent = opt.label;
        if (opt.value === current.quoteEscape) btn.classList.add("help-panel__segmented-btn--active");
        btn.addEventListener("click", () => {
          for (const sibling of quoteSeg.querySelectorAll("button")) {
            sibling.classList.remove("help-panel__segmented-btn--active");
          }
          btn.classList.add("help-panel__segmented-btn--active");
          const latest = getLatest();
          this.options.setCopyOptions?.({ ...latest, quoteEscape: opt.value });
        });
        quoteSeg.appendChild(btn);
      }
      quoteRow.appendChild(quoteSeg);
      section.appendChild(quoteRow);

      // --- Include header
      const headerRow = document.createElement("label");
      headerRow.className = "help-panel__settings-row help-panel__settings-row--checkbox";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = current.includeHeader;
      cb.addEventListener("change", () => {
        const latest = getLatest();
        this.options.setCopyOptions?.({ ...latest, includeHeader: cb.checked });
      });
      const cbLabel = document.createElement("span");
      cbLabel.textContent = "Include header row";
      headerRow.appendChild(cb);
      headerRow.appendChild(cbLabel);
      section.appendChild(headerRow);
    }));

    // Mutate a single field on the persisted FormatPrefs via the get/set pair.
    const updateFormat = <K extends keyof FormatPrefs>(key: K, value: FormatPrefs[K]) => {
      const latest = this.options.getFormatOptions?.();
      if (!latest) return;
      this.options.setFormatOptions?.({ ...latest, [key]: value });
    };

    // --- Date format ---
    body.appendChild(this.buildSettingsSection("Date format", (section) => {
      const active = this.options.getFormatOptions?.().dateFormat ?? DATE_FORMAT_PRESETS[0];
      section.appendChild(this.buildSegmented(DATE_FORMAT_PRESETS, active, (v) => v, (v) => updateFormat("dateFormat", v)));
    }));

    // --- Datetime format ---
    body.appendChild(this.buildSettingsSection("Datetime format", (section) => {
      const active = this.options.getFormatOptions?.().datetimeFormat ?? DATETIME_FORMAT_PRESETS[0];
      section.appendChild(this.buildSegmented(DATETIME_FORMAT_PRESETS, active, (v) => v, (v) => updateFormat("datetimeFormat", v)));
    }));

    // --- Numbers ---
    body.appendChild(this.buildSettingsSection("Numbers", (section) => {
      const current = this.options.getFormatOptions?.();
      const initialMax = current?.numberMaxDecimals ?? 2;
      const initialGrouping = current?.numberUseGrouping ?? true;

      section.appendChild(this.buildLabeledRow("Decimal places",
        this.buildSegmented(DECIMAL_PRESETS, initialMax, (n) => String(n), (n) => {
          const latest = this.options.getFormatOptions?.();
          if (!latest) return;
          this.options.setFormatOptions?.({ ...latest, numberMinDecimals: n, numberMaxDecimals: n });
        }),
      ));

      const groupingRow = document.createElement("label");
      groupingRow.className = "help-panel__settings-row help-panel__settings-row--checkbox";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = initialGrouping;
      cb.addEventListener("change", () => updateFormat("numberUseGrouping", cb.checked));
      const cbLabel = document.createElement("span");
      cbLabel.textContent = "Use thousands separators";
      groupingRow.appendChild(cb);
      groupingRow.appendChild(cbLabel);
      section.appendChild(groupingRow);
    }));

    // --- Display ---
    body.appendChild(this.buildSettingsSection("Display", (section) => {
      const current = this.options.getFormatOptions?.();
      const initialMinWidth = current?.minCellWidth ?? 100;
      const initialMaxLen = current?.maxStringLength ?? 100;

      section.appendChild(this.buildLabeledRow("Min column width (px)",
        this.buildSegmented(MIN_CELL_WIDTH_PRESETS, initialMinWidth, (n) => String(n), (n) => updateFormat("minCellWidth", n)),
      ));
      section.appendChild(this.buildLabeledRow("Max chars per cell",
        this.buildSegmented(MAX_STRING_LENGTH_PRESETS, initialMaxLen, (n) => (n === 0 ? "None" : String(n)), (n) => updateFormat("maxStringLength", n)),
      ));
    }));

    // --- Import ---
    body.appendChild(this.buildSettingsSection("Import", (section) => {
      const hint = document.createElement("p");
      hint.className = "help-panel__hint";
      hint.textContent =
        "Files at or below this size are auto-imported on drop. Larger files show a warning glyph in the tree and stay un-imported until clicked.";
      section.appendChild(hint);

      const initialThreshold = this.options.getFormatOptions?.().autoImportSizeThreshold
        ?? AUTO_IMPORT_THRESHOLD_PRESETS[1];
      section.appendChild(this.buildLabeledRow(
        "Auto-import threshold",
        this.buildSegmented(
          AUTO_IMPORT_THRESHOLD_PRESETS,
          initialThreshold,
          formatThresholdLabel,
          (n) => updateFormat("autoImportSizeThreshold", n),
        ),
      ));
    }));

    // --- Reset keymap ---
    body.appendChild(this.buildSettingsSection("Reset keymap", (section) => {
      const hint = document.createElement("p");
      hint.className = "help-panel__hint";
      hint.textContent = "Revert every keyboard shortcut to its default binding.";
      section.appendChild(hint);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "help-panel__settings-btn";
      btn.textContent = "Reset keymap";
      btn.addEventListener("click", () => {
        this.options.onResetKeymap?.();
        const bodyEl = this.tabBodies.get("shortcuts");
        if (bodyEl) this.renderShortcutsInto(bodyEl);
        btn.textContent = "Keymap reset";
        btn.disabled = true;
        window.setTimeout(() => { btn.textContent = "Reset keymap"; btn.disabled = false; }, 1500);
      });
      section.appendChild(btn);
    }));

    // --- Clear all data ---
    body.appendChild(this.buildSettingsSection("Clear all data", (section) => {
      const hint = document.createElement("p");
      hint.className = "help-panel__hint";
      hint.textContent = "Delete every persisted setting, saved view, query bookmark, and cached table. Not undoable.";
      section.appendChild(hint);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "help-panel__settings-btn help-panel__settings-btn--danger";
      btn.textContent = "Clear all data";
      let armed = false;
      let armTimer: number | null = null;
      btn.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          btn.textContent = "Click again to confirm";
          btn.classList.add("help-panel__settings-btn--armed");
          armTimer = window.setTimeout(() => {
            armed = false;
            btn.textContent = "Clear all data";
            btn.classList.remove("help-panel__settings-btn--armed");
          }, 3000);
          return;
        }
        if (armTimer !== null) window.clearTimeout(armTimer);
        btn.disabled = true;
        btn.textContent = "Clearing\u2026";
        try {
          await this.options.onClearAllData?.();
          btn.textContent = "Cleared \u2014 reload the page";
          btn.classList.remove("help-panel__settings-btn--armed");
        } catch (err) {
          btn.textContent = `Failed: ${err instanceof Error ? err.message : "unknown"}`;
          btn.disabled = false;
          armed = false;
        }
      });
      section.appendChild(btn);
    }));

    return body;
  }

  private buildSettingsSection(title: string, fill: (section: HTMLElement) => void): HTMLElement {
    const section = document.createElement("div");
    section.className = "help-panel__settings-section";

    const h = document.createElement("h3");
    h.className = "help-panel__section-title";
    h.textContent = title;
    section.appendChild(h);

    fill(section);
    return section;
  }

  /** Wrap a control in a settings row with a leading label. */
  private buildLabeledRow(label: string, control: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "help-panel__settings-row";
    const lbl = document.createElement("span");
    lbl.className = "help-panel__settings-label";
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(control);
    return row;
  }

  /**
   * Build a segmented-control row. The button whose value equals `active`
   * gets the --active class; clicking any other button updates the active
   * class in place and invokes `onChange` with the new value.
   */
  private buildSegmented<T>(values: T[], active: T, label: (v: T) => string, onChange: (value: T) => void): HTMLElement {
    const seg = document.createElement("div");
    seg.className = "help-panel__segmented";
    for (const value of values) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "help-panel__segmented-btn";
      btn.textContent = label(value);
      if (value === active) btn.classList.add("help-panel__segmented-btn--active");
      btn.addEventListener("click", () => {
        for (const sibling of seg.querySelectorAll("button")) {
          sibling.classList.remove("help-panel__segmented-btn--active");
        }
        btn.classList.add("help-panel__segmented-btn--active");
        onChange(value);
      });
      seg.appendChild(btn);
    }
    return seg;
  }

  private buildAboutBody(): HTMLElement {
    const body = document.createElement("div");
    body.className = "help-panel__tab-body help-panel__tab-body--about";
    this.tabBodies.set("about", body);

    body.innerHTML = renderAboutBody(this.options.version);

    return body;
  }
}

function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return (
    a.key === b.key &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.alt ?? false) === (b.alt ?? false)
  );
}
