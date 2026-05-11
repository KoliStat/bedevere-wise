export interface HideColumnsDialogArgs {
  /** Title shown in the dialog header. */
  title: string;
  /** All column names in source order — used as the menu's row list. */
  allColumns: string[];
  /** Currently-hidden column names; the matching rows render unchecked. */
  hidden: Set<string>;
  /**
   * Fired when the user confirms. Receives the new hidden set (the
   * complement of the checked rows).
   */
  onApply: (hidden: Set<string>) => void;
}

/**
 * Modal dialog for toggling per-dataset column visibility. Mounts under
 * `document.body`, dismisses on backdrop click / Escape / Cancel, and
 * applies via the OK button. Drives Phase C item 5 (hide / show columns)
 * — the shell `.hide` command opens it scoped to the active dataset.
 *
 * Single-use: `show()` instantiates and returns; dismissal destroys.
 * The caller owns the persisted state, so the dialog only needs to
 * receive the current snapshot and call `onApply` with the next.
 */
export class HideColumnsDialog {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  private listEl: HTMLDivElement;
  private filterInput: HTMLInputElement;
  private summary: HTMLSpanElement;
  // `staged` shadows the user's edits across the dialog's lifetime; we
  // apply / discard it on close so the row checkboxes can stay live even
  // before the user clicks OK.
  private staged: Set<string>;
  private allColumns: string[];
  private filterText = "";
  private onApplyCallback: (hidden: Set<string>) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  public static show(args: HideColumnsDialogArgs): HideColumnsDialog {
    return new HideColumnsDialog(args);
  }

  private constructor(args: HideColumnsDialogArgs) {
    this.allColumns = [...args.allColumns];
    this.staged = new Set(args.hidden);
    this.onApplyCallback = args.onApply;

    this.overlay = document.createElement("div");
    this.overlay.className = "hide-columns-overlay";
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.dismiss();
    });

    this.dialog = document.createElement("div");
    this.dialog.className = "hide-columns";
    this.dialog.setAttribute("role", "dialog");
    this.dialog.setAttribute("aria-modal", "true");
    this.overlay.appendChild(this.dialog);

    const header = document.createElement("div");
    header.className = "hide-columns__header";
    const titleEl = document.createElement("h2");
    titleEl.className = "hide-columns__title";
    titleEl.textContent = args.title;
    header.appendChild(titleEl);
    const close = document.createElement("button");
    close.className = "hide-columns__close";
    close.setAttribute("aria-label", "Close");
    close.title = "Close (Esc)";
    close.textContent = "✕";
    close.addEventListener("click", () => this.dismiss());
    header.appendChild(close);
    this.dialog.appendChild(header);

    const toolbar = document.createElement("div");
    toolbar.className = "hide-columns__toolbar";
    this.filterInput = document.createElement("input");
    this.filterInput.type = "search";
    this.filterInput.placeholder = "Filter columns…";
    this.filterInput.className = "hide-columns__filter";
    this.filterInput.addEventListener("input", () => {
      this.filterText = this.filterInput.value.trim().toLowerCase();
      this.renderList();
    });
    toolbar.appendChild(this.filterInput);

    const bulkShow = document.createElement("button");
    bulkShow.className = "hide-columns__bulk";
    bulkShow.textContent = "Show all";
    bulkShow.title = "Uncheck nothing — show every column";
    bulkShow.addEventListener("click", () => {
      this.staged.clear();
      this.renderList();
      this.updateSummary();
    });
    toolbar.appendChild(bulkShow);

    const bulkHide = document.createElement("button");
    bulkHide.className = "hide-columns__bulk";
    bulkHide.textContent = "Hide all";
    bulkHide.title = "Hide every column. Last column can't be hidden in apply.";
    bulkHide.addEventListener("click", () => {
      // Hide-all is the obvious twin of show-all; the OK guard below
      // refuses to apply an empty visible set so this is recoverable.
      for (const c of this.allColumns) this.staged.add(c);
      this.renderList();
      this.updateSummary();
    });
    toolbar.appendChild(bulkHide);
    this.dialog.appendChild(toolbar);

    this.listEl = document.createElement("div");
    this.listEl.className = "hide-columns__list";
    this.dialog.appendChild(this.listEl);

    const footer = document.createElement("div");
    footer.className = "hide-columns__footer";

    this.summary = document.createElement("span");
    this.summary.className = "hide-columns__summary";
    footer.appendChild(this.summary);

    const cancel = document.createElement("button");
    cancel.className = "hide-columns__btn hide-columns__btn--secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.dismiss());
    footer.appendChild(cancel);

    const apply = document.createElement("button");
    apply.className = "hide-columns__btn hide-columns__btn--primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => this.apply());
    footer.appendChild(apply);

    this.dialog.appendChild(footer);

    this.onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.dismiss();
      } else if (e.key === "Enter" && document.activeElement !== this.filterInput) {
        e.preventDefault();
        this.apply();
      }
    };
    document.addEventListener("keydown", this.onKeyDown, true);

    document.body.appendChild(this.overlay);
    this.renderList();
    this.updateSummary();
    // Defer focus so the modal's open animation (if any) doesn't fight
    // the focus ring; the search field is the natural first stop.
    setTimeout(() => this.filterInput.focus(), 0);
  }

  private renderList(): void {
    this.listEl.innerHTML = "";
    const needle = this.filterText;
    const matches = needle
      ? this.allColumns.filter((c) => c.toLowerCase().includes(needle))
      : this.allColumns;

    if (matches.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hide-columns__empty";
      empty.textContent = "No columns match the filter.";
      this.listEl.appendChild(empty);
      return;
    }

    for (const name of matches) {
      const row = document.createElement("label");
      row.className = "hide-columns__row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "hide-columns__checkbox";
      cb.checked = !this.staged.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) this.staged.delete(name);
        else this.staged.add(name);
        this.updateSummary();
      });
      const text = document.createElement("span");
      text.className = "hide-columns__name";
      text.textContent = name;
      row.appendChild(cb);
      row.appendChild(text);
      this.listEl.appendChild(row);
    }
  }

  private updateSummary(): void {
    const total = this.allColumns.length;
    const hidden = this.staged.size;
    const visible = total - hidden;
    const allHidden = total > 0 && hidden >= total;
    if (allHidden) {
      this.summary.textContent = "At least one column must stay visible.";
      this.summary.classList.add("hide-columns__summary--warn");
    } else {
      this.summary.classList.remove("hide-columns__summary--warn");
      this.summary.textContent = hidden === 0
        ? `${total} columns visible`
        : `${visible} of ${total} columns visible (${hidden} hidden)`;
    }
  }

  private apply(): void {
    if (this.staged.size >= this.allColumns.length && this.allColumns.length > 0) {
      // Refuse to apply an all-hidden state — the spreadsheet has
      // nothing to render and the user would need shell access to
      // recover. The summary line is already showing the warning.
      return;
    }
    this.onApplyCallback(new Set(this.staged));
    this.dismiss();
  }

  private dismiss(): void {
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.overlay.remove();
  }
}
