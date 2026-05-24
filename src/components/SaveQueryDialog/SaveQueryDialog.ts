import { Dialog } from "../Dialog/Dialog";

export interface SaveQueryDialogArgs {
  /** Dialog header text. */
  title?: string;
  /** Default value pre-filled in the name input. */
  defaultName?: string;
  /** Existing query names — used to flag the warning row when typing
   *  a name that's already taken. The caller decides what "save" does
   *  on collision (overwrite, fork, or reject) by throwing from
   *  `onSave`; the dialog surfaces the thrown message. */
  existingNames?: string[];
  /** Fired when the user confirms. The save itself is the caller's job. */
  onSave: (name: string) => void | Promise<void>;
}

/**
 * Single-field modal: "Save query as…". Inherits the overlay /
 * backdrop-dismiss / Escape lifecycle from `Dialog`; this class only
 * owns the body (one text input + warning row) and the success path.
 *
 * The dialog only collects the name; the caller wires the save itself
 * (so we don't have to import PersistenceService here and bloat the
 * dialog's surface).
 */
export class SaveQueryDialog extends Dialog {
  private input!: HTMLInputElement;
  private warn!: HTMLDivElement;
  private existing: Set<string>;
  private onSaveCallback: SaveQueryDialogArgs["onSave"];

  public static show(args: SaveQueryDialogArgs): SaveQueryDialog {
    return new SaveQueryDialog(args);
  }

  private constructor(args: SaveQueryDialogArgs) {
    super({ title: args.title ?? "Save query as…", classPrefix: "save-query" });
    this.existing = new Set(args.existingNames ?? []);
    this.onSaveCallback = args.onSave;

    this.buildBody(args.defaultName ?? "");
    this.buildFooter();

    this.mount();
    this.updateWarning();
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 0);
  }

  protected handleKeyDown(e: KeyboardEvent): void {
    super.handleKeyDown(e);
    if (e.key === "Enter" && document.activeElement === this.input) {
      e.preventDefault();
      this.trySave();
    }
  }

  private buildBody(defaultName: string): void {
    const body = document.createElement("div");
    body.className = "save-query__body";

    const label = document.createElement("label");
    label.className = "save-query__label";
    label.textContent = "Name";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "save-query__input";
    this.input.value = defaultName;
    this.input.placeholder = "e.g. penguins_summary";
    this.input.spellcheck = false;
    this.input.addEventListener("input", () => this.updateWarning());
    label.appendChild(this.input);
    body.appendChild(label);

    this.warn = document.createElement("div");
    this.warn.className = "save-query__warn";
    body.appendChild(this.warn);
    this.panel.appendChild(body);
  }

  private buildFooter(): void {
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

    this.panel.appendChild(footer);
  }

  private updateWarning(): void {
    const name = this.input.value.trim();
    if (name && this.existing.has(name)) {
      this.warn.textContent = `"${name}" is already in use.`;
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
      this.markConfirmed();
      this.dismiss();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.warn.textContent = `Save failed: ${msg}`;
      this.warn.classList.add("save-query__warn--shown");
    }
  }
}
