import { ParsedHtmlTable, parseHtmlTables, tableToCsv } from "../../data/formats/htmlTables";

export interface HtmlPasteDialogArgs {
  /** Title shown in the dialog header. */
  title?: string;
  /**
   * If provided, the dialog opens in "picker" mode: the textarea is
   * hidden and the user just picks one of these pre-parsed tables.
   * Used by the file-drop / URL paths when the source yields more than
   * one table — they catch `MultipleHtmlTablesError`, then open this
   * dialog with the tables already parsed.
   */
  initialTables?: ParsedHtmlTable[];
  /** Default name suggested for the imported dataset. */
  defaultName?: string;
  /** Fired when the user confirms an import. CSV content + name. */
  onImport: (csvText: string, suggestedName: string) => void | Promise<void>;
  /**
   * Fired when the dialog is dismissed without a successful import
   * (Escape, Cancel button, backdrop click). Optional — most callers
   * only care about the success path. The async wrapper below uses it
   * to resolve the promise with `null`.
   */
  onCancel?: () => void;
}

/**
 * Modal dialog for ingesting HTML tables from the clipboard or from a
 * multi-table source. Mounts under `document.body`, dismisses on
 * backdrop click / Escape / Cancel, applies via the Import button.
 *
 * Two modes:
 *   - **paste mode** (no `initialTables`): textarea + "paste from
 *     clipboard" button. On every textarea change we re-parse and
 *     render a radio picker below.
 *   - **picker mode** (`initialTables` provided): textarea hidden;
 *     just the picker, name field, and Import button. Used when the
 *     drop/URL paths already have parsed tables to disambiguate.
 *
 * Single-use: `show()` instantiates and returns; dismissal destroys.
 * Result is delivered through `onImport(csvText, name)`; the caller
 * owns the final FileImportService / TabManager wiring.
 */
export class HtmlPasteDialog {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  private textarea!: HTMLTextAreaElement;
  private clipboardBtn!: HTMLButtonElement;
  private pickerEl!: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private importBtn!: HTMLButtonElement;
  private summary!: HTMLSpanElement;
  private status!: HTMLDivElement;

  private tables: ParsedHtmlTable[] = [];
  private selectedIndex = -1;
  private parseDebounce: number | null = null;
  private importedSuccessfully = false;
  private readonly defaultName: string;
  private readonly onImportCallback: HtmlPasteDialogArgs["onImport"];
  private readonly onCancelCallback?: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly isPickerMode: boolean;

  public static show(args: HtmlPasteDialogArgs): HtmlPasteDialog {
    return new HtmlPasteDialog(args);
  }

  /**
   * Promise-flavoured wrapper for callers that want to `await` the
   * picker (e.g. the file-drop multi-table path). Resolves with
   * `{ csvText, name }` on Import, or `null` if the user dismissed.
   */
  public static showAsync(
    args: Omit<HtmlPasteDialogArgs, "onImport" | "onCancel">,
  ): Promise<{ csvText: string; name: string } | null> {
    return new Promise((resolve) => {
      new HtmlPasteDialog({
        ...args,
        onImport: (csvText, name) => resolve({ csvText, name }),
        onCancel: () => resolve(null),
      });
    });
  }

  private constructor(args: HtmlPasteDialogArgs) {
    this.defaultName = args.defaultName ?? "pasted_table";
    this.onImportCallback = args.onImport;
    this.onCancelCallback = args.onCancel;
    this.isPickerMode = !!(args.initialTables && args.initialTables.length > 0);

    this.overlay = document.createElement("div");
    this.overlay.className = "html-paste-overlay";
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.dismiss();
    });

    this.dialog = document.createElement("div");
    this.dialog.className = "html-paste";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.overlay.appendChild(this.dialog);

    this.buildHeader(args.title ?? (this.isPickerMode ? "Pick a table" : "Paste HTML table"));
    if (!this.isPickerMode) this.buildTextarea();
    this.buildPicker();
    this.buildNameAndFooter();

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss();
      } else if (
        e.key === "Enter" &&
        document.activeElement !== this.textarea &&
        document.activeElement !== this.nameInput
      ) {
        e.preventDefault();
        if (!this.importBtn.disabled) this.tryImport();
      }
    };
    document.addEventListener("keydown", this.onKeyDown, true);

    document.body.appendChild(this.overlay);

    if (this.isPickerMode) {
      this.tables = args.initialTables!;
      this.selectedIndex = 0;
      this.renderPicker();
      this.refreshImportEnabled();
      setTimeout(() => this.nameInput.focus(), 0);
    } else {
      setTimeout(() => this.textarea.focus(), 0);
    }
  }

  // ---------- DOM construction ------------------------------------------

  private buildHeader(title: string): void {
    const header = document.createElement("div");
    header.className = "html-paste__header";

    const titleEl = document.createElement("h2");
    titleEl.className = "html-paste__title";
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const close = document.createElement("button");
    close.className = "html-paste__close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close (Esc)";
    close.textContent = "✕";
    close.addEventListener("click", () => this.dismiss());
    header.appendChild(close);

    this.dialog.appendChild(header);
  }

  private buildTextarea(): void {
    const section = document.createElement("div");
    section.className = "html-paste__textarea-section";

    this.textarea = document.createElement("textarea");
    this.textarea.className = "html-paste__textarea";
    this.textarea.placeholder = "Paste HTML here, or click \"Paste from clipboard\" below.";
    this.textarea.spellcheck = false;
    this.textarea.rows = 8;
    this.textarea.addEventListener("paste", (e: ClipboardEvent) => this.onPaste(e));
    this.textarea.addEventListener("input", () => this.schedulePaste(this.textarea.value));
    section.appendChild(this.textarea);

    const actions = document.createElement("div");
    actions.className = "html-paste__textarea-actions";

    this.clipboardBtn = document.createElement("button");
    this.clipboardBtn.className = "html-paste__btn html-paste__btn--secondary";
    this.clipboardBtn.textContent = "Paste from clipboard";
    this.clipboardBtn.title = "Read text/html from the system clipboard";
    this.clipboardBtn.addEventListener("click", () => this.pasteFromClipboard());
    actions.appendChild(this.clipboardBtn);

    this.status = document.createElement("div");
    this.status.className = "html-paste__status";
    actions.appendChild(this.status);

    section.appendChild(actions);
    this.dialog.appendChild(section);
  }

  private buildPicker(): void {
    this.pickerEl = document.createElement("div");
    this.pickerEl.className = "html-paste__picker";
    this.dialog.appendChild(this.pickerEl);
  }

  private buildNameAndFooter(): void {
    const nameRow = document.createElement("label");
    nameRow.className = "html-paste__name-row";
    const nameLabel = document.createElement("span");
    nameLabel.className = "html-paste__name-label";
    nameLabel.textContent = "Name:";
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.className = "html-paste__name-input";
    this.nameInput.value = this.defaultName;
    this.nameInput.addEventListener("input", () => this.refreshImportEnabled());
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(this.nameInput);
    this.dialog.appendChild(nameRow);

    const footer = document.createElement("div");
    footer.className = "html-paste__footer";

    this.summary = document.createElement("span");
    this.summary.className = "html-paste__summary";
    footer.appendChild(this.summary);

    const cancel = document.createElement("button");
    cancel.className = "html-paste__btn html-paste__btn--secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.dismiss());
    footer.appendChild(cancel);

    this.importBtn = document.createElement("button");
    this.importBtn.className = "html-paste__btn html-paste__btn--primary";
    this.importBtn.textContent = "Import";
    this.importBtn.disabled = true;
    this.importBtn.addEventListener("click", () => this.tryImport());
    footer.appendChild(this.importBtn);

    this.dialog.appendChild(footer);
  }

  // ---------- Paste / parse flow ----------------------------------------

  private onPaste(e: ClipboardEvent): void {
    // The clipboard usually carries both `text/html` (with structure)
    // and `text/plain` (a TSV approximation). We prefer HTML; if HTML
    // exists, we replace the textarea content with it directly so the
    // user sees the markup they're about to import.
    const html = e.clipboardData?.getData("text/html") ?? "";
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (html.length > 0) {
      e.preventDefault();
      this.textarea.value = html;
      this.setStatus("");
      this.schedulePaste(html);
    } else if (text.length > 0) {
      // Let the default paste handler put plain text in the textarea,
      // then re-parse. Even if it's not HTML, the user may follow up
      // with manual edits.
      setTimeout(() => this.schedulePaste(this.textarea.value), 0);
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    this.setStatus("Reading clipboard…");
    try {
      // Prefer the structured clipboard API for HTML mime; fall back to
      // plain text. Older / insecure browsers reject these calls — let
      // the user paste manually instead of throwing.
      const anyClip = (navigator.clipboard as unknown) as {
        read?: () => Promise<Array<{ types: string[]; getType: (t: string) => Promise<Blob> }>>;
        readText?: () => Promise<string>;
      };
      if (anyClip.read) {
        const items = await anyClip.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            const blob = await item.getType("text/html");
            const html = await blob.text();
            this.textarea.value = html;
            this.setStatus("");
            this.schedulePaste(html);
            return;
          }
        }
        // No HTML representation — try plain text.
        for (const item of items) {
          if (item.types.includes("text/plain")) {
            const blob = await item.getType("text/plain");
            const text = await blob.text();
            this.textarea.value = text;
            this.setStatus("");
            this.schedulePaste(text);
            return;
          }
        }
        this.setStatus("Clipboard had no HTML or text content.", true);
      } else if (anyClip.readText) {
        const text = await anyClip.readText();
        this.textarea.value = text;
        this.setStatus("");
        this.schedulePaste(text);
      } else {
        this.setStatus("Clipboard API unavailable; paste with Ctrl+V into the textarea.", true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Couldn't read clipboard (${msg}). Paste with Ctrl+V instead.`, true);
    }
  }

  private schedulePaste(content: string): void {
    if (this.parseDebounce !== null) window.clearTimeout(this.parseDebounce);
    this.parseDebounce = window.setTimeout(() => this.reparse(content), 120);
  }

  private reparse(content: string): void {
    const tables = content.trim() ? parseHtmlTables(content) : [];
    this.tables = tables;
    this.selectedIndex = tables.length > 0 ? 0 : -1;
    this.renderPicker();
    this.refreshImportEnabled();
    if (content.trim() === "") {
      this.setStatus("");
    } else if (tables.length === 0) {
      // Tab-separated text on the clipboard is the most common "looks
      // like a table but isn't HTML" case — point the user at the
      // right workaround instead of a generic error.
      const looksTsv = /\t/.test(content) && /\r?\n/.test(content);
      if (looksTsv) {
        this.setStatus("No <table> found. This looks like tab-separated text — save it as a .tsv file and drop it in.", true);
      } else {
        this.setStatus("No <table> found in the pasted content.", true);
      }
    } else {
      this.setStatus("");
    }
  }

  private renderPicker(): void {
    this.pickerEl.innerHTML = "";
    if (this.tables.length === 0) {
      if (this.isPickerMode) {
        const empty = document.createElement("div");
        empty.className = "html-paste__empty";
        empty.textContent = "No tables to choose from.";
        this.pickerEl.appendChild(empty);
      }
      return;
    }

    const heading = document.createElement("div");
    heading.className = "html-paste__picker-heading";
    heading.textContent = this.tables.length === 1
      ? "Found 1 table:"
      : `Found ${this.tables.length} tables. Pick one:`;
    this.pickerEl.appendChild(heading);

    for (let i = 0; i < this.tables.length; i++) {
      const t = this.tables[i];
      const row = document.createElement("label");
      row.className = "html-paste__picker-row";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "html-paste-pick";
      radio.className = "html-paste__radio";
      radio.checked = i === this.selectedIndex;
      radio.addEventListener("change", () => {
        if (radio.checked) {
          this.selectedIndex = i;
          this.refreshImportEnabled();
        }
      });
      row.appendChild(radio);

      const meta = document.createElement("div");
      meta.className = "html-paste__picker-meta";

      const dims = document.createElement("div");
      dims.className = "html-paste__picker-dims";
      const captionPart = t.caption ? ` · ${truncate(t.caption, 40)}` : "";
      dims.textContent = `Table ${i + 1} — ${t.rowCount} × ${t.colCount}${captionPart}`;
      meta.appendChild(dims);

      const preview = document.createElement("div");
      preview.className = "html-paste__picker-preview";
      const firstRow = t.rows[0] ?? [];
      preview.textContent = `first row: ${firstRow.length === 0 ? "(empty)" : truncate(firstRow.join(" · "), 80)}`;
      meta.appendChild(preview);

      row.appendChild(meta);
      this.pickerEl.appendChild(row);
    }
  }

  private refreshImportEnabled(): void {
    const hasSelection = this.selectedIndex >= 0 && this.selectedIndex < this.tables.length;
    const hasName = this.nameInput.value.trim().length > 0;
    this.importBtn.disabled = !hasSelection || !hasName;

    if (hasSelection) {
      const t = this.tables[this.selectedIndex];
      this.summary.textContent = `${t.rowCount} rows × ${t.colCount} cols selected`;
    } else {
      this.summary.textContent = "";
    }
  }

  // ---------- Apply / dismiss -------------------------------------------

  private async tryImport(): Promise<void> {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.tables.length) return;
    const t = this.tables[this.selectedIndex];
    const csv = tableToCsv(t);
    const name = this.nameInput.value.trim() || this.defaultName;
    this.importBtn.disabled = true;
    try {
      await this.onImportCallback(csv, name);
      this.importedSuccessfully = true;
      this.dismiss();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus(`Import failed: ${msg}`, true);
      this.importBtn.disabled = false;
    }
  }

  private setStatus(message: string, isError = false): void {
    if (!this.status) return; // picker-mode has no textarea section
    this.status.textContent = message;
    this.status.classList.toggle("html-paste__status--error", isError);
  }

  private dismiss(): void {
    if (this.parseDebounce !== null) window.clearTimeout(this.parseDebounce);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.overlay.remove();
    if (!this.importedSuccessfully && this.onCancelCallback) {
      // Fire `onCancel` for the promise-flavoured wrapper to resolve
      // with null. Only the success path skips this (the import callback
      // already resolved the promise).
      try {
        this.onCancelCallback();
      } catch {
        // best-effort; cancel callbacks shouldn't throw
      }
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
