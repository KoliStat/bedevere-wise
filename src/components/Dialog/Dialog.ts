/**
 * Base class for the app's modal dialogs (HideColumns, HtmlPaste,
 * SaveQuery, …). Owns the bits every modal needs and that previously
 * lived as duplicated boilerplate in each component:
 *
 *   - The fixed overlay (`<prefix>-overlay`) and the dialog panel
 *     (`<prefix>`), both attached to `document.body`.
 *   - A header containing a title and a close button (`✕`).
 *   - Backdrop mousedown → dismiss.
 *   - Document-level Escape → dismiss (with `capture: true` so the
 *     dialog wins over editor / spreadsheet keymaps).
 *   - Cleanup on dismiss: removes the keydown listener and the overlay
 *     element.
 *   - Optional `onCancel` callback fired when the dialog is closed
 *     without a successful confirm — subclasses call `markConfirmed()`
 *     before `dismiss()` on their success path to suppress it.
 *
 * Subclasses are expected to:
 *   1. Build their own body / footer DOM and append it to `this.panel`.
 *   2. Call `this.mount()` once the panel is fully populated.
 *   3. Optionally override `handleKeyDown(e)` for additional keys
 *      (Enter, Ctrl+S, …); call `super.handleKeyDown(e)` to keep the
 *      base Escape behaviour.
 *   4. Call `this.markConfirmed()` then `this.dismiss()` on success.
 *
 * The CSS-class prefix (e.g. `"hide-columns"`, `"save-query"`) drives
 * the BEM names used for every element the base creates, so styling
 * stays per-subclass.
 */
export interface DialogOptions {
  /** Title text shown in the header. */
  title: string;
  /** BEM prefix for `<prefix>-overlay`, `<prefix>`, `<prefix>__header`, etc. */
  classPrefix: string;
  /**
   * Fired when the dialog is dismissed without a successful confirm
   * (Escape, backdrop click, Cancel button). Subclasses call
   * `markConfirmed()` on their success path so this stays untriggered.
   */
  onCancel?: () => void;
}

export abstract class Dialog {
  protected readonly overlay: HTMLDivElement;
  protected readonly panel: HTMLDivElement;
  protected readonly classPrefix: string;
  private readonly onCancelCallback?: () => void;
  private readonly keydownListener: (e: KeyboardEvent) => void;
  private confirmed = false;
  private dismissed = false;

  protected constructor(options: DialogOptions) {
    this.classPrefix = options.classPrefix;
    this.onCancelCallback = options.onCancel;

    this.overlay = document.createElement("div");
    this.overlay.className = `${this.classPrefix}-overlay`;
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.dismiss();
    });

    this.panel = document.createElement("div");
    this.panel.className = this.classPrefix;
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.overlay.appendChild(this.panel);

    this.appendHeader(options.title);

    // Document-level capture so the dialog wins over editor / spreadsheet
    // keymaps when an Escape is fired with focus inside their components.
    this.keydownListener = (e) => this.handleKeyDown(e);
    document.addEventListener("keydown", this.keydownListener, true);
  }

  /**
   * Append the dialog's overlay to `document.body`. Subclasses call this
   * after they've populated `this.panel` so the dialog appears fully
   * rendered (rather than building in front of the user).
   */
  protected mount(): void {
    document.body.appendChild(this.overlay);
  }

  /**
   * Base Escape handling. Subclasses override to add Enter / Mod+S /
   * etc., usually calling `super.handleKeyDown(e)` first.
   */
  protected handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      this.dismiss();
    }
  }

  /**
   * Subclasses call this on the success path right before `dismiss()`
   * to suppress the `onCancel` callback — the dialog closed because
   * the user got what they came for, not because they bailed.
   */
  protected markConfirmed(): void {
    this.confirmed = true;
  }

  /**
   * Tear the dialog down. Idempotent: a second call is a no-op so
   * subclass success paths that call `dismiss()` plus a stray Escape
   * landing during teardown don't double-fire `onCancel`.
   */
  protected dismiss(): void {
    if (this.dismissed) return;
    this.dismissed = true;
    document.removeEventListener("keydown", this.keydownListener, true);
    this.overlay.remove();
    if (!this.confirmed && this.onCancelCallback) {
      try {
        this.onCancelCallback();
      } catch {
        // Best-effort: cancel-callback failures shouldn't keep the
        // dialog half-mounted. The DOM is already gone; just log out.
      }
    }
  }

  private appendHeader(title: string): void {
    const header = document.createElement("div");
    header.className = `${this.classPrefix}__header`;

    const titleEl = document.createElement("h2");
    titleEl.className = `${this.classPrefix}__title`;
    titleEl.textContent = title;
    header.appendChild(titleEl);

    const close = document.createElement("button");
    close.className = `${this.classPrefix}__close`;
    close.setAttribute("aria-label", "Close");
    close.title = "Close (Esc)";
    close.textContent = "✕";
    close.addEventListener("click", () => this.dismiss());
    header.appendChild(close);

    this.panel.appendChild(header);
  }
}
