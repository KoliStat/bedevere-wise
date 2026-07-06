import { BedevereAppMessageType } from "../BedevereApp/BedevereApp";
import { escapeHtml } from "../../utils/html";
import { MESSAGE_ICONS, ICON_X } from "../icons";

const LABELS: Record<BedevereAppMessageType, string> = {
  error: "ERROR",
  warning: "WARNING",
  success: "SUCCESS",
  info: "INFO",
};

export interface MessagePopoverArgs {
  type: BedevereAppMessageType;
  title?: string;
  message: string;
  details?: string;
  timestamp: Date;
}

/**
 * A popover anchored above the status bar that shows the full text of a
 * status message, with optional details (e.g. stack trace) and a Copy button.
 *
 * Dismissed by: outside click, Escape key, or close button.
 */
export class MessagePopover {
  private container: HTMLElement;
  private element: HTMLDivElement;
  private isVisible = false;
  private currentArgs: MessagePopoverArgs | null = null;

  // Bound so we can add/remove them
  private readonly onDocumentClick: (e: MouseEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(parent: HTMLElement) {
    this.container = parent;
    this.element = document.createElement("div");
    this.element.className = "message-popover";
    this.element.style.display = "none";
    // Prevent inside-clicks from bubbling up to the document listener
    this.element.addEventListener("mousedown", (e) => e.stopPropagation());
    this.container.appendChild(this.element);

    this.onDocumentClick = (e: MouseEvent) => {
      if (!this.isVisible) return;
      // Ignore clicks that originated inside the popover itself
      if (this.element.contains(e.target as Node)) return;
      // Ignore clicks on the status bar item that opened us — the status bar
      // toggle logic will call hide() explicitly for that case.
      const target = e.target as HTMLElement;
      if (target.closest?.(".status-bar__item")) return;
      this.hide();
    };

    this.onKeyDown = (e: KeyboardEvent) => {
      if (this.isVisible && e.key === "Escape") {
        e.stopPropagation();
        this.hide();
      }
    };
  }

  public isOpen(): boolean {
    return this.isVisible;
  }

  public show(args: MessagePopoverArgs): void {
    this.currentArgs = args;
    this.element.innerHTML = this.renderHTML(args);
    this.element.classList.remove(
      "message-popover--error",
      "message-popover--warning",
      "message-popover--success",
      "message-popover--info",
    );
    this.element.classList.add(`message-popover--${args.type}`);
    this.element.style.display = "block";
    this.isVisible = true;

    // Wire event listeners *after* the element is visible so the click that
    // opened us doesn't immediately close it.
    setTimeout(() => {
      document.addEventListener("mousedown", this.onDocumentClick);
      document.addEventListener("keydown", this.onKeyDown);
    }, 0);

    // Close button
    const closeBtn = this.element.querySelector(".message-popover__close");
    closeBtn?.addEventListener("click", () => this.hide());

    // Copy button
    const copyBtn = this.element.querySelector<HTMLButtonElement>(".message-popover__copy-btn");
    copyBtn?.addEventListener("click", async () => {
      if (!this.currentArgs) return;
      const text = this.currentArgs.details
        ? `${this.currentArgs.message}\n\n${this.currentArgs.details}`
        : this.currentArgs.message;
      try {
        await navigator.clipboard.writeText(text);
        const original = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("message-popover__copy-btn--copied");
        setTimeout(() => {
          copyBtn.textContent = original;
          copyBtn.classList.remove("message-popover__copy-btn--copied");
        }, 1500);
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
      }
    });
  }

  public hide(): void {
    if (!this.isVisible) return;
    this.element.style.display = "none";
    this.isVisible = false;
    this.currentArgs = null;
    document.removeEventListener("mousedown", this.onDocumentClick);
    document.removeEventListener("keydown", this.onKeyDown);
  }

  public destroy(): void {
    this.hide();
    this.element.remove();
  }

  private renderHTML(args: MessagePopoverArgs): string {
    const icon = MESSAGE_ICONS[args.type] || "";
    const label = args.title || LABELS[args.type];
    const time = formatTime(args.timestamp);
    const message = escapeHtml(args.message);
    const details = args.details ? escapeHtml(args.details) : "";

    return `
      <div class="message-popover__header">
        <span class="message-popover__icon">${icon}</span>
        <span class="message-popover__label">${escapeHtml(label)}</span>
        <span class="message-popover__time">${escapeHtml(time)}</span>
        <button class="message-popover__close" title="Close (Esc)" aria-label="Close">${ICON_X}</button>
      </div>
      <div class="message-popover__body">
        <div class="message-popover__message">${message}</div>
        ${details ? `<pre class="message-popover__details">${details}</pre>` : ""}
      </div>
      <div class="message-popover__footer">
        <button class="message-popover__copy-btn" title="Copy message to clipboard">Copy</button>
      </div>
    `;
  }
}


function formatTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
