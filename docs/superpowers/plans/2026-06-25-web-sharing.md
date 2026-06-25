# Web app: sharing, distribution & analytics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add KoliStat/desktop links, an embed builder (dialog + `.embed` command), and cookieless analytics to the bedevere-wise web app.

**Architecture:** All changes are web-app-side. A shared constants module (`appLinks.ts`) feeds the About tab and a pure URL-builder (`embedUrl.ts`); the embed builder is a `Dialog` subclass wired to a `.embed` shell command; the desktop hint is a one-time gated banner; analytics is a beacon in the root HTML plus a CSP allowance.

**Tech Stack:** TypeScript, Vite, vitest (jsdom), bun for tooling. UI dialogs extend the existing `Dialog` base class.

## Global Constraints

- Tooling: use `bun` (`bun run …`, `bunx …`), never npm/npx.
- `tsc --noEmit` must stay clean; tests run with `bun run test:run`.
- Embed URLs: base is the constant `EMBED_BASE_URL` (never `window.location.origin`); all params live in the URL **fragment** (`#…`), matching `parseEmbedConfig`.
- Analytics: cookieless, **main app only** — never added to the `/embed` HTML or its CSP.
- `DESKTOP_DOWNLOAD_URL` is a placeholder (`https://kolistat.com/bedevere-wise`) until the real page is live.
- Commit after each task. Branch: `feature/web-sharing`.

---

### Task 1: URL constants module

**Files:**
- Create: `src/appLinks.ts`

**Interfaces:**
- Produces: `KOLISTAT_URL`, `DESKTOP_DOWNLOAD_URL`, `EMBED_BASE_URL` (all `string`).

- [ ] **Step 1: Create the module**

```ts
// src/appLinks.ts
/** External URLs used across the app — single source of truth. */

/** KoliStat umbrella site. */
export const KOLISTAT_URL = "https://kolistat.com";

/** bedevere-desktop download page. Placeholder until the page is live. */
export const DESKTOP_DOWNLOAD_URL = "https://kolistat.com/bedevere-wise";

/** Production /embed origin. Constant, not window.location.origin — the
 *  builder runs in the app (any origin / file:// on desktop) but the embed
 *  is always served from bedeverewise.app. */
export const EMBED_BASE_URL = "https://bedeverewise.app/embed";
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/appLinks.ts
git commit -m "feat: add appLinks URL constants module"
```

---

### Task 2: Embed URL + iframe builders (TDD)

**Files:**
- Create: `src/embed/embedUrl.ts`
- Test: `src/embed/__tests__/embedUrl.test.ts`

**Interfaces:**
- Consumes: `EMBED_BASE_URL` (Task 1); `parseEmbedConfig` (`src/embed/embedConfig.ts`); `EmbedTheme` (`src/embed/embedTheme.ts`).
- Produces:
  - `EmbedUrlConfig = { datasets: string[]; query: string; theme: EmbedTheme | null; autorun: boolean }`
  - `buildEmbedUrl(config: EmbedUrlConfig): string`
  - `buildEmbedIframe(url: string, opts?: { height?: number }): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/embed/__tests__/embedUrl.test.ts
import { describe, it, expect } from "vitest";
import { buildEmbedUrl, buildEmbedIframe } from "../embedUrl";
import { parseEmbedConfig } from "../embedConfig";

const frag = (url: string) => url.slice(url.indexOf("#") + 1);

describe("buildEmbedUrl", () => {
  it("round-trips through parseEmbedConfig, incl. reserved chars", () => {
    const url = buildEmbedUrl({
      datasets: ["https://x.org/a.parquet"],
      query: "SELECT * FROM a WHERE n & 1 = 0 -- #note",
      theme: "dark",
      autorun: true,
    });
    expect(url.startsWith("https://bedeverewise.app/embed#")).toBe(true);
    const cfg = parseEmbedConfig(frag(url));
    expect(cfg.datasets).toEqual(["https://x.org/a.parquet"]);
    expect(cfg.query).toBe("SELECT * FROM a WHERE n & 1 = 0 -- #note");
    expect(cfg.theme).toBe("dark");
    expect(cfg.autorun).toBe(true);
  });

  it("omits theme when Auto (null) and autorun when off", () => {
    const url = buildEmbedUrl({ datasets: [], query: "SELECT 1", theme: null, autorun: false });
    const cfg = parseEmbedConfig(frag(url));
    expect(cfg.theme).toBeNull();
    expect(cfg.autorun).toBe(false);
  });

  it("supports multiple datasets", () => {
    const url = buildEmbedUrl({ datasets: ["https://x/a.csv", "https://x/b.csv"], query: "", theme: null, autorun: false });
    expect(parseEmbedConfig(frag(url)).datasets).toEqual(["https://x/a.csv", "https://x/b.csv"]);
  });
});

describe("buildEmbedIframe", () => {
  it("wraps the url with a default height", () => {
    const html = buildEmbedIframe("https://bedeverewise.app/embed#x=1");
    expect(html).toContain('src="https://bedeverewise.app/embed#x=1"');
    expect(html).toContain('height="480"');
    expect(html).toContain("<iframe");
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun run test:run -- embedUrl`
Expected: FAIL (module `../embedUrl` not found).

- [ ] **Step 3: Implement**

```ts
// src/embed/embedUrl.ts
import { EMBED_BASE_URL } from "../appLinks";
import type { EmbedTheme } from "./embedTheme";

export interface EmbedUrlConfig {
  datasets: string[];
  query: string;
  theme: EmbedTheme | null;
  autorun: boolean;
}

/** Compose the /embed URL with all params in the fragment (#…). */
export function buildEmbedUrl(config: EmbedUrlConfig): string {
  const params = new URLSearchParams();
  for (const ds of config.datasets) {
    const trimmed = ds.trim();
    if (trimmed) params.append("dataset", trimmed);
  }
  if (config.query.trim()) params.set("query", config.query);
  if (config.theme) params.set("theme", config.theme);
  if (config.autorun) params.set("autorun", "1");
  const frag = params.toString();
  return frag ? `${EMBED_BASE_URL}#${frag}` : EMBED_BASE_URL;
}

/** Wrap an embed URL in a copy-paste <iframe> snippet. */
export function buildEmbedIframe(url: string, opts: { height?: number } = {}): string {
  const height = opts.height ?? 480;
  return `<iframe src="${url}" width="100%" height="${height}" style="border:0" loading="lazy" title="Bedevere Wise"></iframe>`;
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `bun run test:run -- embedUrl`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/embed/embedUrl.ts src/embed/__tests__/embedUrl.test.ts
git commit -m "feat: add embed URL + iframe builders"
```

---

### Task 3: EmbedBuilderDialog component

**Files:**
- Create: `src/components/EmbedBuilderDialog/EmbedBuilderDialog.ts`
- Create: `src/styles/components/embed-builder.scss` (import it where the other dialog styles are imported — follow `save-query`'s import site)
- Test: `src/components/EmbedBuilderDialog/__tests__/EmbedBuilderDialog.test.ts`

**Interfaces:**
- Consumes: `Dialog` (`src/components/Dialog/Dialog`); `buildEmbedUrl`/`buildEmbedIframe` (Task 2); `EmbedTheme`.
- Produces: `EmbedBuilderDialog.show({ query: string; theme?: EmbedTheme | null }): EmbedBuilderDialog`.

- [ ] **Step 1: Write the component**

```ts
// src/components/EmbedBuilderDialog/EmbedBuilderDialog.ts
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
    this.queryInput.rows = 4;
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
    ta.rows = 2;
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
```

- [ ] **Step 2: Write the jsdom test**

```ts
// src/components/EmbedBuilderDialog/__tests__/EmbedBuilderDialog.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { EmbedBuilderDialog } from "../EmbedBuilderDialog";

afterEach(() => { document.body.innerHTML = ""; });

describe("EmbedBuilderDialog", () => {
  it("prefills the query and recomputes outputs on dataset input", () => {
    EmbedBuilderDialog.show({ query: "SELECT * FROM penguins", theme: "dark" });

    const dataset = document.querySelector<HTMLInputElement>(".embed-builder__input")!;
    dataset.value = "https://x.org/penguins.parquet";
    dataset.dispatchEvent(new Event("input"));

    const outputs = document.querySelectorAll<HTMLTextAreaElement>(".embed-builder__output-text");
    const [urlOut, iframeOut] = outputs;
    expect(urlOut.value).toContain("https://bedeverewise.app/embed#");
    expect(urlOut.value).toContain("dataset=https"); // URLSearchParams keeps ':' '/' literal
    expect(urlOut.value).toContain("theme=dark");
    expect(iframeOut.value).toContain("<iframe");
  });
});
```

- [ ] **Step 3: Run the test, expect pass** (write the SCSS first if the import fails)

Run: `bun run test:run -- EmbedBuilderDialog`
Expected: PASS. If the component imports the SCSS and the test fails on the import, add the SCSS (Step 4) and re-run.

- [ ] **Step 4: Add the stylesheet**

Create `src/styles/components/embed-builder.scss` mirroring `save-query.scss`'s tokens (reuse the `--bg` / `--fg` / border CSS variables; `.embed-builder__body { display:flex; flex-direction:column; gap:10px; }`, inputs full-width, `.embed-builder__output-text { font-family: monospace; }`, footer right-aligned). Import it from the same place `save-query.scss` is imported (grep `save-query` under `src/styles`).

- [ ] **Step 5: Typecheck + commit**

Run: `bunx tsc --noEmit` → exit 0.
```bash
git add src/components/EmbedBuilderDialog/ src/styles/components/embed-builder.scss src/styles
git commit -m "feat: EmbedBuilderDialog (compose embed URL + iframe)"
```

---

### Task 4: `.embed` command + BedevereApp wiring

**Files:**
- Modify: `src/components/BedevereApp/BedevereApp.ts` (in `registerCommands()`, ~line 719)

**Interfaces:**
- Consumes: `EmbedBuilderDialog.show` (Task 3); the active editor query text.

- [ ] **Step 1: Import the dialog**

Add near the other component imports in `BedevereApp.ts`:
```ts
import { EmbedBuilderDialog } from "../EmbedBuilderDialog/EmbedBuilderDialog";
```

- [ ] **Step 2: Register the `.embed` command**

Inside `registerCommands()`, following the shape of the existing `view.setTheme` registration (read it first for the exact `commandRegistry.register({...})` signature — id, title, handler). Add:
```ts
commandRegistry.register({
  id: "view.createEmbed",
  // match the existing commands' field names (title / description / shellName / handler)
  title: "Create embed…",
  shellName: "embed",
  handler: () => {
    EmbedBuilderDialog.show({
      query: this.getActiveQueryText(),
      theme: this.theme,
    });
  },
});
```
Adapt the property names to the real `Command` shape (see a neighboring `commandRegistry.register` call). `this.theme` is the resolved app theme (a valid `EmbedTheme`).

- [ ] **Step 3: Add `getActiveQueryText()` helper**

Add a private method that returns the active SQL editor tab's text, reusing whatever accessor the existing Ctrl+S / save-query flow uses (grep `SaveQueryDialog` and `editorAutoSaveDraft` to find the editor-text getter; e.g. the editor exposes `getActiveQueryText()` / `getValue()`). If none exists, return the persisted draft as a fallback:
```ts
private getActiveQueryText(): string {
  // Prefer the live editor text; fall back to the persisted autosave draft.
  return this.sqlEditor?.getActiveText?.()
    ?? this.persistenceService.loadAppSettings().editorAutoSaveDraft
    ?? "";
}
```
Wire to the real editor reference + method name found in Step 3's grep.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit` → exit 0.

- [ ] **Step 5: Manual check**

Run `bun run dev`, open the app, type `.embed` in the command bar (or pick "Create embed…" from the palette). Verify the dialog opens with the current query prefilled, entering a dataset URL updates both outputs, Copy works, and "Preview in new tab" opens the composed URL.

- [ ] **Step 6: Commit**

```bash
git add src/components/BedevereApp/BedevereApp.ts
git commit -m "feat: wire the .embed command to EmbedBuilderDialog"
```

---

### Task 5: About-tab links (TDD)

**Files:**
- Modify: `src/components/HelpPanel/aboutHtml.ts`
- Test: `src/components/HelpPanel/__tests__/aboutHtml.test.ts`

**Interfaces:**
- Consumes: `KOLISTAT_URL`, `DESKTOP_DOWNLOAD_URL` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
// src/components/HelpPanel/__tests__/aboutHtml.test.ts
import { describe, it, expect } from "vitest";
import { renderAboutBody } from "../aboutHtml";
import { KOLISTAT_URL, DESKTOP_DOWNLOAD_URL } from "../../../appLinks";

describe("renderAboutBody", () => {
  const html = renderAboutBody("0.14-and-this");
  it("links the KoliStat umbrella site", () => {
    expect(html).toContain(`href="${KOLISTAT_URL}"`);
  });
  it("offers the desktop download", () => {
    expect(html).toContain(`href="${DESKTOP_DOWNLOAD_URL}"`);
    expect(html).toMatch(/desktop app/i);
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `bun run test:run -- aboutHtml`
Expected: FAIL (KoliStat link still points at github.com; no desktop link).

- [ ] **Step 3: Implement**

In `aboutHtml.ts`: add `import { KOLISTAT_URL, DESKTOP_DOWNLOAD_URL } from "../../appLinks";`. Repoint the "Made by KoliStat" anchor's `href` from `https://github.com/KoliStat` to `${KOLISTAT_URL}`. In the `help-panel__about-links` row, add a desktop-download anchor:
```ts
        <span class="help-panel__about-separator">·</span>
        <a href="${DESKTOP_DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">Download the desktop app</a>
```

- [ ] **Step 4: Run it, expect pass**

Run: `bun run test:run -- aboutHtml`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/HelpPanel/aboutHtml.ts src/components/HelpPanel/__tests__/aboutHtml.test.ts
git commit -m "feat: link kolistat.com + desktop download from the About tab"
```

---

### Task 6: One-time desktop hint

**Files:**
- Modify: `src/data/PersistenceService.ts` (add `hasSeenDesktopHint?: boolean` to `AppSettings`)
- Create: `src/components/BedevereApp/desktopHint.ts`
- Test: `src/components/BedevereApp/__tests__/desktopHint.test.ts`
- Modify: `src/components/BedevereApp/BedevereApp.ts` (call it in init, near the `hasSeenOnboarding` block ~line 281)

**Interfaces:**
- Produces:
  - `shouldShowDesktopHint(settings: AppSettings, backendId: string): boolean`
  - `renderDesktopHint(host: HTMLElement, downloadUrl: string, onDismiss: () => void): HTMLElement`

- [ ] **Step 1: Add the settings flag**

In `AppSettings` (PersistenceService.ts), after `hasSeenOnboarding?: boolean;`:
```ts
  /** Set once the one-time "get the desktop app" hint has been shown. */
  hasSeenDesktopHint?: boolean;
```

- [ ] **Step 2: Write the failing test**

```ts
// src/components/BedevereApp/__tests__/desktopHint.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldShowDesktopHint, renderDesktopHint } from "../desktopHint";

afterEach(() => { document.body.innerHTML = ""; });

describe("shouldShowDesktopHint", () => {
  it("shows once on the web after onboarding", () => {
    expect(shouldShowDesktopHint({ hasSeenOnboarding: true }, "duckdb-wasm")).toBe(true);
  });
  it("never shows on a non-web backend (already on desktop)", () => {
    expect(shouldShowDesktopHint({ hasSeenOnboarding: true }, "ipc")).toBe(false);
  });
  it("does not show before onboarding or once already seen", () => {
    expect(shouldShowDesktopHint({}, "duckdb-wasm")).toBe(false);
    expect(shouldShowDesktopHint({ hasSeenOnboarding: true, hasSeenDesktopHint: true }, "duckdb-wasm")).toBe(false);
  });
});

describe("renderDesktopHint", () => {
  it("renders a download link and fires onDismiss on close", () => {
    const onDismiss = vi.fn();
    renderDesktopHint(document.body, "https://kolistat.com/x", onDismiss);
    const link = document.querySelector<HTMLAnchorElement>("a.desktop-hint__link")!;
    expect(link.href).toContain("https://kolistat.com/x");
    document.querySelector<HTMLButtonElement>("button.desktop-hint__dismiss")!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".desktop-hint")).toBeNull();
  });
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `bun run test:run -- desktopHint`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/components/BedevereApp/desktopHint.ts
import type { AppSettings } from "../../data/PersistenceService";

/** Web-only, post-onboarding, shown at most once. */
export function shouldShowDesktopHint(settings: AppSettings, backendId: string): boolean {
  return (
    backendId === "duckdb-wasm" &&
    settings.hasSeenOnboarding === true &&
    !settings.hasSeenDesktopHint
  );
}

/** Render a dismissible hint banner into `host`. Returns the banner element. */
export function renderDesktopHint(
  host: HTMLElement,
  downloadUrl: string,
  onDismiss: () => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "desktop-hint";

  const text = document.createElement("span");
  text.className = "desktop-hint__text";
  text.textContent = "Bigger datasets & native speed — ";

  const link = document.createElement("a");
  link.className = "desktop-hint__link";
  link.href = downloadUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "get the desktop app";
  link.addEventListener("click", () => onDismiss());
  text.appendChild(link);

  const dismiss = document.createElement("button");
  dismiss.className = "desktop-hint__dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    bar.remove();
    onDismiss();
  });

  bar.append(text, dismiss);
  host.appendChild(bar);
  return bar;
}
```

- [ ] **Step 5: Run it, expect pass**

Run: `bun run test:run -- desktopHint`
Expected: PASS (5 assertions across the suites).

- [ ] **Step 6: Wire into BedevereApp init**

Near the `hasSeenOnboarding` handling (~line 281), after onboarding/help is resolved, add a one-time hint on the web:
```ts
import { shouldShowDesktopHint, renderDesktopHint } from "./desktopHint";
import { DESKTOP_DOWNLOAD_URL } from "../../appLinks";
// …
if (shouldShowDesktopHint(settings, this.backend.id)) {
  const markSeen = () => {
    const s = this.persistenceService.loadAppSettings();
    s.hasSeenDesktopHint = true;
    this.persistenceService.saveAppSettings(s);
  };
  renderDesktopHint(this.container, DESKTOP_DOWNLOAD_URL, markSeen);
}
```
Add `.desktop-hint` styles (small bar, dismiss button) to the app stylesheet, themed via the existing CSS variables.

- [ ] **Step 7: Typecheck + commit**

Run: `bunx tsc --noEmit` → exit 0; `bun run test:run` → all pass.
```bash
git add src/data/PersistenceService.ts src/components/BedevereApp/desktopHint.ts src/components/BedevereApp/__tests__/desktopHint.test.ts src/components/BedevereApp/BedevereApp.ts src/styles
git commit -m "feat: one-time get-the-desktop-app hint (web-only)"
```

---

### Task 7: Cookieless analytics

**Files:**
- Modify: `index.html` (root — the main-app entry, NOT the embed HTML)
- Modify: `public/_headers` (the main-app CSP rule only)

**Interfaces:** none (config/markup).

- [ ] **Step 1: Add the beacon to the root index.html**

Just before `</body>` in the root `index.html` (verify it's the main app entry, not `embed.html`):
```html
    <!-- Cloudflare Web Analytics — cookieless, main app only (never /embed). -->
    <script defer src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon='{"token": "REPLACE_WITH_CF_WEB_ANALYTICS_TOKEN"}'></script>
```
Leave the embed HTML entry untouched.

- [ ] **Step 2: Allow the beacon in the main-app CSP**

In `public/_headers`, on the main-app rule only (NOT the `/embed` rule): add `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src`. Example:
```
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'
```
(Preserve every existing directive; only extend `script-src` and `connect-src`. Read the current `_headers` to copy the rest verbatim.)

- [ ] **Step 3: Build + verify**

Run: `bun run build`
Expected: exit 0 (verify-build passes). Confirm the built root `dist/index.html` contains the beacon and the built embed HTML does NOT.

- [ ] **Step 4: Commit**

```bash
git add index.html public/_headers
git commit -m "feat: cookieless Cloudflare Web Analytics on the main app"
```
Note: provision the real token in the Cloudflare dashboard (Web Analytics → add site) and replace the placeholder; smoke-test the CSP on a preview deploy.

---

## Self-Review

- **Spec coverage:** §1 links → Tasks 1+5; §1 hint → Task 6; §2 embed builder → Tasks 1+2+3+4; §3 analytics → Task 7. All sections covered.
- **Type consistency:** `EmbedUrlConfig`/`buildEmbedUrl`/`buildEmbedIframe` defined in Task 2 and consumed identically in Task 3; `shouldShowDesktopHint`/`renderDesktopHint` defined and consumed in Task 6; `AppSettings.hasSeenDesktopHint` added in Task 6 before use. Constants from Task 1 used in 2/5/6/7.
- **Placeholders:** the only literal placeholders are the deliberate, flagged external values — `DESKTOP_DOWNLOAD_URL` and the CF analytics token. Two task steps point at neighboring code to copy exact shapes (the `Command` registration fields in Task 4, the `_headers` rule in Task 7) rather than guess private signatures; both name the grep/file to read.

## Notes / verify-at-build

- Task 4: the exact `Command` registry field names and the active-editor-text accessor must be copied from existing call sites (named in the steps). This is the one task without a unit test — covered by the manual check.
- Dataset-URL prefill and local-vs-URL detection are intentionally **not** in v1 (the field starts blank with a static note); revisit if dataset provenance becomes easy to recover.
