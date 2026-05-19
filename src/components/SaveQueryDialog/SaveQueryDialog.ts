export interface SaveQueryDialogArgs {
  /** Dialog header text. */
  title?: string;
  /** Default value pre-filled in the name input. */
  defaultName?: string;
  /** Existing bookmark names — used to flag the warning row when typing
   *  a name that's already taken (the save still proceeds and overwrites,
   *  but the user knows). */
  existingNames?: string[];
  /** Fired when the user confirms. The save itself is the caller's job. */
  onSave: (name: string) => void | Promise<void>;
}

/**
 * Single-field modal: "Save query as…". Mirrors `HideColumnsDialog`'s
 * overlay pattern — mounts under `document.body`, dismisses on Escape /
 * backdrop click / Cancel, applies on Enter or the Save button.
 * Single-use: `show()` instantiates and the dismissal destroys.
 *
 * The dialog only collects the name; the caller wires the save itself
 * (so we don't have to import PersistenceService here and bloat the
 * dialog's surface).
 */
export class SaveQueryDialog {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  private input!: HTMLInputElement;
  private warn!: HTMLDivElement;
  private existing: Set<string>;
  private onSaveCallback: SaveQueryDialogArgs["onSave"];
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  public static show(args: SaveQueryDialogArgs): SaveQueryDialog {
    return new SaveQueryDialog(args);
  }

  private constructor(args: SaveQueryDialogArgs) {
    this.existing = new Set(args.existingNames ?? []);
    this.onSaveCallback = args.onSave;

    this.overlay = document.createElement("div");
    this.overlay.className = "save-query-overlay";
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.dismiss();
    });

    this.dialog = document.createElement("div");
    this.dialog.className = "save-query";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.overlay.appendChild(this.dialog);

    const header = document.createElement("div");
    header.className = "save-query__header";
    const titleEl = document.createElement("h2");
    titleEl.className = "save-query__title";
    titleEl.textContent = args.title ?? "Save query as…";
    header.appendChild(titleEl);
    const close = document.createElement("button");
    close.className = "save-query__close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close (Esc)";
    close.textContent = "✕";
    close.addEventListener("click", () => this.dismiss());
    header.appendChild(close);
    this.dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "save-query__body";

    const label = document.createElement("label");
    label.className = "save-query__label";
    label.textContent = "Name";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "save-query__input";
    this.input.value = args.defaultName ?? "";
    this.input.placeholder = "e.g. penguins_summary";
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.updateWarning());
    label.appendChild(this.input);
    body.appendChild(label);

    this.warn = document.createElement("div");
    this.warn.className = "save-query__warn";
    body.appendChild(this.warn);
    this.dialog.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "save-query__footer";

    const cancel = document.createElement("button");
    cancel.className = "save-query__btn save-query__btn--secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.dismiss());
    footer.appendChild(cancel);

    const save = document.createElement("button");
    save.className = "save-query__btn save-query__btn--primary";
    save.textContent = "Save";
    save.addEventListener("click", () => this.trySave());
    footer.appendChild(save);

    this.dialog.appendChild(footer);

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss();
      } else if (e.key === "Enter" && document.activeElement === this.input) {
        e.preventDefault();
        this.trySave();
      }
    };
    document.addEventListener("keydown", this.onKeyDown, true);

    document.body.appendChild(this.overlay);
    this.updateWarning();
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 0);
  }

  private updateWarning(): void {
    const name = this.input.value.trim();
    if (name && this.existing.has(name)) {
      this.warn.textContent = `"${name}" already exists — saving overwrites it.`;
      this.warn.classList.add("save-query__warn--shown");
    } else {
      this.warn.textContent = "";
      this.warn.classList.remove("save-query__warn--shown");
    }
  }

  private async trySave(): Promise<void> {
    const name = this.input.value.trim();
    if (!name) {
      this.warn.textContent = "Please enter a name.";
      this.warn.classList.add("save-query__warn--shown");
      this.input.focus();
      return;
    }
    try {
      await this.onSaveCallback(name);
      this.dismiss();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.warn.textContent = `Save failed: ${msg}`;
      this.warn.classList.add("save-query__warn--shown");
    }
  }

  private dismiss(): void {
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.overlay.remove();
  }
}
