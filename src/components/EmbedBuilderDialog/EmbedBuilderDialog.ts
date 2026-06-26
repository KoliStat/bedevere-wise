import { Dialog } from "../Dialog/Dialog";
import { buildEmbedUrl, buildEmbedIframe } from "../../embed/embedUrl";
import type { EmbedTheme } from "../../embed/embedTheme";

export interface EmbedBuilderDialogArgs {
  /** Prefilled query (the active editor tab's SQL). */
  query: string;
  /** Default Theme select value; null/undefined = Auto. */
  theme?: EmbedTheme | null;
}

const THEME_OPTIONS: { value: "" | EmbedTheme; label: string }[] = [
  { value: "", label: "Auto (follow the reader's system)" },
  { value: "light", label: "Light" },
  { value: "classic-light", label: "Classic Light" },
  { value: "dark", label: "Dark" },
  { value: "classic-dark", label: "Classic Dark" },
];

const NOTE =
  "Embeds load a public https dataset URL — local files can't be embedded, " +
  "so host the file and paste its URL. The query must reference the table " +
  "name the embed derives from the URL's filename.";

/**
 * "Create embed" modal: composes an /embed URL + `<iframe>` snippet from a
 * dataset URL, the current query, a theme, and an autorun toggle. Pure
 * URL work lives in {@link buildEmbedUrl}; this class only owns the form
 * and the live recompute. Inherits overlay / Escape / backdrop-dismiss
 * from {@link Dialog}.
 */
export class EmbedBuilderDialog extends Dialog {
  private datasetInput!: HTMLInputElement;
  private queryInput!: HTMLTextAreaElement;
  private themeSelect!: HTMLSelectElement;
  private autorunInput!: HTMLInputElement;
  private urlOutput!: HTMLTextAreaElement;
  private iframeOutput!: HTMLTextAreaElement;

  public static show(args: EmbedBuilderDialogArgs): EmbedBuilderDialog {
    return new EmbedBuilderDialog(args);
  }

  private constructor(args: EmbedBuilderDialogArgs) {
    super({ title: "Create embed", classPrefix: "embed-builder" });
    this.buildBody(args);
    this.buildFooter();
    this.mount();
    this.refresh();
    setTimeout(() => this.datasetInput.focus(), 0);
  }

  private buildBody(args: EmbedBuilderDialogArgs): void {
    const body = document.createElement("div");
    body.className = "embed-builder__body";

    this.datasetInput = document.createElement("input");
    this.datasetInput.type = "url";
    this.datasetInput.className = "embed-builder__input";
    this.datasetInput.placeholder = "https://example.org/data.parquet";
    body.appendChild(this.labelled("Dataset URL", this.datasetInput));

    const note = document.createElement("p");
    note.className = "embed-builder__note";
    note.textContent = NOTE;
    body.appendChild(note);

    this.queryInput = document.createElement("textarea");
    this.queryInput.className = "embed-builder__input embed-builder__textarea";
    this.queryInput.rows = 6;
    this.queryInput.value = args.query;
    body.appendChild(this.labelled("Query", this.queryInput));

    const row = document.createElement("div");
    row.className = "embed-builder__row";

    this.themeSelect = document.createElement("select");
    this.themeSelect.className = "embed-builder__select";
    for (const opt of THEME_OPTIONS) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      this.themeSelect.appendChild(o);
    }
    this.themeSelect.value = args.theme ?? "";
    row.appendChild(this.labelled("Theme", this.themeSelect));

    const autorunLabel = document.createElement("label");
    autorunLabel.className = "embed-builder__checkbox";
    this.autorunInput = document.createElement("input");
    this.autorunInput.type = "checkbox";
    this.autorunInput.checked = true;
    autorunLabel.appendChild(this.autorunInput);
    autorunLabel.appendChild(document.createTextNode(" Autorun on load"));
    row.appendChild(autorunLabel);
    body.appendChild(row);

    this.urlOutput = this.buildOutput(body, "Embed URL");
    this.iframeOutput = this.buildOutput(body, "Embed <iframe>");

    for (const el of [this.datasetInput, this.queryInput, this.themeSelect, this.autorunInput]) {
      el.addEventListener("input", () => this.refresh());
      el.addEventListener("change", () => this.refresh());
    }

    this.panel.appendChild(body);
  }

  private labelled(text: string, control: HTMLElement): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "embed-builder__label";
    label.textContent = text;
    label.appendChild(control);
    return label;
  }

  private buildOutput(parent: HTMLElement, labelText: string): HTMLTextAreaElement {
    const wrap = document.createElement("div");
    wrap.className = "embed-builder__output";
    const label = document.createElement("span");
    label.className = "embed-builder__output-label";
    label.textContent = labelText;
    const ta = document.createElement("textarea");
    ta.className = "embed-builder__output-text";
    ta.readOnly = true;
    ta.rows = 3;
    const copy = document.createElement("button");
    copy.className = "embed-builder__btn embed-builder__btn--secondary";
    copy.textContent = "Copy";
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(ta.value);
      copy.textContent = "Copied";
      window.setTimeout(() => (copy.textContent = "Copy"), 1000);
    });
    wrap.append(label, ta, copy);
    parent.appendChild(wrap);
    return ta;
  }

  private currentUrl(): string {
    const dataset = this.datasetInput.value.trim();
    const themeVal = this.themeSelect.value;
    return buildEmbedUrl({
      datasets: dataset ? [dataset] : [],
      query: this.queryInput.value,
      theme: themeVal ? (themeVal as EmbedTheme) : null,
      autorun: this.autorunInput.checked,
    });
  }

  private refresh(): void {
    const url = this.currentUrl();
    this.urlOutput.value = url;
    this.iframeOutput.value = buildEmbedIframe(url);
  }

  private buildFooter(): void {
    const footer = document.createElement("div");
    footer.className = "embed-builder__footer";

    const preview = document.createElement("button");
    preview.className = "embed-builder__btn embed-builder__btn--secondary";
    preview.textContent = "Preview in new tab";
    preview.addEventListener("click", () => window.open(this.currentUrl(), "_blank", "noopener"));
    footer.appendChild(preview);

    const close = document.createElement("button");
    close.className = "embed-builder__btn embed-builder__btn--primary";
    close.textContent = "Close";
    close.addEventListener("click", () => this.dismiss());
    footer.appendChild(close);

    this.panel.appendChild(footer);
  }
}
