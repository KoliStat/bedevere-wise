# KoliStat "Statistical Report" Restyle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle bedevere-wise to kolistat.com's "statistical report" identity — paper/ink surfaces, booktabs rules, IBM Plex Mono chrome, Source Serif 4 seasoning, duck yellow `#ffd939` as sole accent — behind a two-axis theme model (family × mode) with Paper as the default family.

**Architecture:** Six resolved palettes behind flat body classes (`theme-light`/`theme-dark` = Paper, `theme-classic-*` = Tokyonight, `theme-github-*` = new); new *structural* tokens (`--rule`, `--duck`, `--duck-ink`, `--sel-tint`, `--accent`, `--accent-hover`, `--accent-text`) defined in all six palettes so component CSS is restyled once and every family keeps its own colors. Spec: `docs/superpowers/specs/2026-07-03-kolistat-restyle-design.md`.

**Tech Stack:** Vite + TypeScript + SCSS (CSS custom properties), vitest (jsdom), canvas-rendered spreadsheet, Vega-Lite via vega-embed, @fontsource static font packages, bun.

## Global Constraints

- **Restyle only.** No functional changes; `/embed` URL params + postMessage contracts frozen (additive `github-light`/`github-dark` theme values only); npm component API unchanged (`setTheme(theme: ResolvedTheme)` keeps its signature); nothing web-only (desktop renders the same bundle in WebView2 — fonts must be bundled, no runtime fetches to kolistat.com).
- Branch: `feature/kolistat-restyle`. Commit after every task (messages below). All work in `C:\Users\massi\source\repos\kolistat\bedevere-wise`.
- Test runner: `bun run test:run` (vitest). Typecheck+build: `bun run build` (runs `tsc` first). There is no lint script.
- Use `bun` for everything (never npm/npx).
- Paper palette values are canonical from the spec §2 — copy them exactly; do not "improve" colors.
- Yellow discipline: `--duck` fills only small elements (active tab chip, Run button, badges, selection tints). Never large areas, never body text.
- Radius 0 and no soft drop-shadows anywhere. Exceptions: loading spinners stay round; the Run button hover may use the hard offset `2px 2px 0 var(--rule)` (print-style, matches the website's `.btn-run`).

---

### Task 1: Theme model — types, resolution, legacy mapping (TDD)

**Files:**
- Modify: `src/components/BedevereApp/themeClasses.ts`
- Test: `src/components/BedevereApp/__tests__/themeClasses.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks import these from `./themeClasses` / `@/components/BedevereApp/themeClasses`):
  - `type ThemeFamily = "paper" | "tokyonight" | "github"`
  - `type ThemeMode = "light" | "dark" | "auto"`
  - `type ResolvedTheme = "light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark"`
  - `interface ThemeSelection { family: ThemeFamily; mode: ThemeMode }`
  - `resolveThemeVariant(selection: ThemeSelection, systemPrefersDark: boolean): ResolvedTheme`
  - `splitResolvedTheme(theme: ResolvedTheme): { family: ThemeFamily; mode: "light" | "dark" }`
  - `themeSelectionFromLegacy(value: string | undefined): ThemeSelection`
  - `themeSelectionFromSettings(s: { themeFamily?: ThemeFamily; themeMode?: ThemeMode; theme?: string }): ThemeSelection`
  - `applyThemeClasses(container: HTMLElement, theme: ResolvedTheme): void` (unchanged signature, now clears 6 variants)

- [ ] **Step 1: Write the failing tests** — append to `themeClasses.test.ts` (keep the three existing tests; they must stay green):

```ts
import {
  applyThemeClasses,
  resolveThemeVariant,
  splitResolvedTheme,
  themeSelectionFromLegacy,
  themeSelectionFromSettings,
  type ResolvedTheme,
} from "../themeClasses";

describe("resolveThemeVariant", () => {
  it("resolves every family × concrete mode", () => {
    expect(resolveThemeVariant({ family: "paper", mode: "light" }, false)).toBe("light");
    expect(resolveThemeVariant({ family: "paper", mode: "dark" }, false)).toBe("dark");
    expect(resolveThemeVariant({ family: "tokyonight", mode: "light" }, false)).toBe("classic-light");
    expect(resolveThemeVariant({ family: "tokyonight", mode: "dark" }, false)).toBe("classic-dark");
    expect(resolveThemeVariant({ family: "github", mode: "light" }, false)).toBe("github-light");
    expect(resolveThemeVariant({ family: "github", mode: "dark" }, false)).toBe("github-dark");
  });

  it("auto follows the system flag", () => {
    expect(resolveThemeVariant({ family: "paper", mode: "auto" }, true)).toBe("dark");
    expect(resolveThemeVariant({ family: "paper", mode: "auto" }, false)).toBe("light");
    expect(resolveThemeVariant({ family: "github", mode: "auto" }, true)).toBe("github-dark");
  });
});

describe("splitResolvedTheme", () => {
  it("round-trips every resolved variant", () => {
    const all: ResolvedTheme[] = ["light", "dark", "classic-light", "classic-dark", "github-light", "github-dark"];
    for (const t of all) {
      const { family, mode } = splitResolvedTheme(t);
      expect(resolveThemeVariant({ family, mode }, false)).toBe(t);
    }
  });
});

describe("legacy migration", () => {
  it("maps legacy persisted values (light/dark ride the restyle; classics stay Tokyonight)", () => {
    expect(themeSelectionFromLegacy("light")).toEqual({ family: "paper", mode: "light" });
    expect(themeSelectionFromLegacy("dark")).toEqual({ family: "paper", mode: "dark" });
    expect(themeSelectionFromLegacy("auto")).toEqual({ family: "paper", mode: "auto" });
    expect(themeSelectionFromLegacy("classic-light")).toEqual({ family: "tokyonight", mode: "light" });
    expect(themeSelectionFromLegacy("classic-dark")).toEqual({ family: "tokyonight", mode: "dark" });
    expect(themeSelectionFromLegacy(undefined)).toEqual({ family: "paper", mode: "auto" });
    expect(themeSelectionFromLegacy("garbage")).toEqual({ family: "paper", mode: "auto" });
  });

  it("prefers the new settings keys over the legacy one", () => {
    expect(themeSelectionFromSettings({ themeFamily: "github", themeMode: "dark", theme: "classic-light" }))
      .toEqual({ family: "github", mode: "dark" });
    expect(themeSelectionFromSettings({ theme: "classic-dark" }))
      .toEqual({ family: "tokyonight", mode: "dark" });
    expect(themeSelectionFromSettings({})).toEqual({ family: "paper", mode: "auto" });
  });
});

describe("applyThemeClasses — github variants", () => {
  it("clears github classes when switching away", () => {
    const container = document.createElement("div");
    document.body.className = "theme-github-dark";
    container.className = "bedevere-app bedevere-app--github-dark";
    applyThemeClasses(container, "light");
    expect(document.body.classList.contains("theme-github-dark")).toBe(false);
    expect(document.body.classList.contains("theme-light")).toBe(true);
    expect(container.classList.contains("bedevere-app--github-dark")).toBe(false);
    expect(container.classList.contains("bedevere-app--light")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `bun run test:run` → new tests FAIL (`resolveThemeVariant is not exported`), existing 3 pass.

- [ ] **Step 3: Implement** — extend `themeClasses.ts` (keep the existing doc comments; `ResolvedTheme` gains two values):

```ts
export type ThemeFamily = "paper" | "tokyonight" | "github";
export type ThemeMode = "light" | "dark" | "auto";
export type ResolvedTheme =
  | "light" | "classic-light" | "dark" | "classic-dark"
  | "github-light" | "github-dark";

const THEME_VARIANTS: readonly ResolvedTheme[] = [
  "light", "classic-light", "dark", "classic-dark", "github-light", "github-dark",
];

const FAMILY_VARIANT: Record<ThemeFamily, { light: ResolvedTheme; dark: ResolvedTheme }> = {
  paper: { light: "light", dark: "dark" },
  tokyonight: { light: "classic-light", dark: "classic-dark" },
  github: { light: "github-light", dark: "github-dark" },
};

export interface ThemeSelection {
  family: ThemeFamily;
  mode: ThemeMode;
}

/** Resolve a family+mode selection to the concrete body-class variant. */
export function resolveThemeVariant(selection: ThemeSelection, systemPrefersDark: boolean): ResolvedTheme {
  const concrete = selection.mode === "auto" ? (systemPrefersDark ? "dark" : "light") : selection.mode;
  return FAMILY_VARIANT[selection.family][concrete];
}

/** Inverse of resolveThemeVariant for concrete (non-auto) variants. */
export function splitResolvedTheme(theme: ResolvedTheme): { family: ThemeFamily; mode: "light" | "dark" } {
  for (const family of Object.keys(FAMILY_VARIANT) as ThemeFamily[]) {
    if (FAMILY_VARIANT[family].light === theme) return { family, mode: "light" };
    if (FAMILY_VARIANT[family].dark === theme) return { family, mode: "dark" };
  }
  return { family: "paper", mode: "light" }; // unreachable for valid input
}

/**
 * Map a legacy persisted `theme` value (or an explicit resolved value) to a
 * selection. Plain light/dark/auto ride the restyle → Paper; classic-* users
 * chose Tokyonight explicitly, so that choice is honored. Unknown → default.
 */
export function themeSelectionFromLegacy(value: string | undefined): ThemeSelection {
  switch (value) {
    case "light": return { family: "paper", mode: "light" };
    case "dark": return { family: "paper", mode: "dark" };
    case "classic-light": return { family: "tokyonight", mode: "light" };
    case "classic-dark": return { family: "tokyonight", mode: "dark" };
    case "github-light": return { family: "github", mode: "light" };
    case "github-dark": return { family: "github", mode: "dark" };
    case "auto":
    default:
      return { family: "paper", mode: "auto" };
  }
}

/** Selection from persisted AppSettings: new keys win; legacy `theme` migrates. */
export function themeSelectionFromSettings(s: {
  themeFamily?: ThemeFamily;
  themeMode?: ThemeMode;
  theme?: string;
}): ThemeSelection {
  if (s.themeFamily || s.themeMode) {
    return { family: s.themeFamily ?? "paper", mode: s.themeMode ?? "auto" };
  }
  return themeSelectionFromLegacy(s.theme);
}
```

`applyThemeClasses` body is unchanged — the widened `THEME_VARIANTS` array does the work.

- [ ] **Step 4: Run to verify pass** — `bun run test:run` → all green.
- [ ] **Step 5: Commit** — `git add src/components/BedevereApp/themeClasses.ts src/components/BedevereApp/__tests__/themeClasses.test.ts && git commit -m "Theme model: family x mode selection, 6-way ResolvedTheme, legacy migration"`

---

### Task 2: Paper palettes + structural tokens in `_tokens.scss`

**Files:**
- Modify: `src/styles/_tokens.scss` (whole palette section)

**Interfaces:**
- Produces CSS custom properties consumed by every later task: existing names (`--bg`, `--bg-dark`, `--bg-highlight`, `--bg-float`, `--fg`, `--fg-dark`, `--fg-muted`, `--border`, `--border-strong`, `--gutter`, `--blue`…`--purple`, `--version-bg/fg`, `--selection`, `--selection-bg`, `--selection-fg`, `--hover`, `--error-bg`, `--warning-bg`, `--success-bg`, `--info-bg`) **plus new structural tokens in all six blocks**: `--rule`, `--duck`, `--duck-ink`, `--sel-tint`, `--accent`, `--accent-hover`, `--accent-text`.

- [ ] **Step 1: Re-slot the existing blocks.** In `_tokens.scss`:
  - The current `body, body.theme-light { … }` block (warm neutral, `--bg:#f5f5f3`): change its selector to `body.theme-github-light` and its heading comment to `// Github Light — the pre-0.15 default light, kept selectable`.
  - The current `body.theme-dark { … }` GitHub-Dark block: change its selector to `body.theme-github-dark`, heading `// Github Dark — the pre-0.15 default dark, kept selectable`.
  - `body.theme-classic-light` / `body.theme-classic-dark` (Tokyonight Day/Storm) stay as they are.
  - Update the file's top comment: the token system now spans three families (Paper default, Tokyonight classic, Github), body-class switched, dark-most block last for cascade ties.

- [ ] **Step 2: Add the two Paper blocks.** Paper light goes FIRST (it is the `body` default); Night goes LAST in the file (dark wins cascade ties for the desktop's FOUC-prevention class):

```scss
// ----------------------------------------------------------------------
// Paper — default light ("The Statistical Report", matches kolistat.com)
// ----------------------------------------------------------------------
body,
body.theme-light {
  // Surfaces
  --bg:              #f7f5ef;   // warm paper
  --bg-dark:         #efece1;   // raised/recessed apparatus (headers, tracks)
  --bg-highlight:    #e9e5d8;
  --bg-float:        #fffef9;   // dialogs / popovers

  // Text
  --fg:              #1a1917;   // ink
  --fg-dark:         #3d3a33;
  --fg-muted:        #5f5c54;

  // Structural
  --border:          #d9d5c9;   // hairline rule
  --border-strong:   #b8b3a3;
  --gutter:          #b8b3a3;

  // Accents — restrained, ink-adjacent (yellow never colors text)
  --blue:            #1a1917;   // interactive accent IS ink in Paper
  --cyan:            #275e6e;
  --green:           #1e6b46;
  --yellow:          #8a6d1f;
  --orange:          #a05c2c;
  --red:             #9e2b25;
  --magenta:         #7c5f80;
  --purple:          #6b5a8e;

  // Version chip = the duck badge
  --version-bg:      #ffd939;
  --version-fg:      #1a1917;

  // Semantic
  --selection:       rgba(255, 217, 57, 0.4);
  --selection-bg:    rgba(255, 217, 57, 0.4);
  --selection-fg:    var(--fg);
  --hover:           rgba(255, 217, 57, 0.18);
  --error-bg:        rgba(158, 43, 37, 0.12);
  --warning-bg:      rgba(160, 92, 44, 0.15);
  --success-bg:      rgba(30, 107, 70, 0.14);
  --info-bg:         rgba(26, 25, 23, 0.07);

  // Statistical-Report structural tokens
  --rule:            #1a1917;   // booktabs heavy rule = ink
  --duck:            #ffd939;   // the one accent
  --duck-ink:        #1a1917;   // text on a duck fill (both modes)
  --sel-tint:        rgba(255, 217, 57, 0.4);
  --accent:          #1a1917;   // primary button fill (ink)
  --accent-hover:    #000000;
  --accent-text:     #f7f5ef;   // paper text on ink
}
```

and at the END of the palette section:

```scss
// ----------------------------------------------------------------------
// Night — Paper's dark mode ("night reading": warm, not pure black).
// LAST block on purpose: theme-dark wins cascade ties, which keeps the
// desktop's hardcoded FOUC-prevention class rendering dark-first.
// ----------------------------------------------------------------------
body.theme-dark {
  // Surfaces
  --bg:              #171511;
  --bg-dark:         #110f0c;
  --bg-highlight:    #29251c;
  --bg-float:        #201d16;

  // Text
  --fg:              #ece7da;   // warm off-white ink
  --fg-dark:         #c9c2b1;
  --fg-muted:        #a49e8e;

  // Structural
  --border:          #35322a;
  --border-strong:   #4d483c;
  --gutter:          #4d483c;

  // Accents
  --blue:            #ece7da;
  --cyan:            #8fb8c4;
  --green:           #7cc8a0;
  --yellow:          #d9bd66;
  --orange:          #cf9a62;
  --red:             #e08573;
  --magenta:         #b99cbd;
  --purple:          #a493c9;

  // Version chip
  --version-bg:      #ffd939;
  --version-fg:      #1a1917;

  // Semantic
  --selection:       rgba(255, 217, 57, 0.22);
  --selection-bg:    rgba(255, 217, 57, 0.22);
  --selection-fg:    var(--fg);
  --hover:           rgba(255, 217, 57, 0.10);
  --error-bg:        rgba(224, 133, 115, 0.14);
  --warning-bg:      rgba(207, 154, 98, 0.15);
  --success-bg:      rgba(124, 200, 160, 0.14);
  --info-bg:         rgba(236, 231, 218, 0.08);

  // Statistical-Report structural tokens
  --rule:            #ece7da;
  --duck:            #ffd939;
  --duck-ink:        #1a1917;
  --sel-tint:        rgba(255, 217, 57, 0.22);
  --accent:          #ece7da;
  --accent-hover:    #fff8e8;
  --accent-text:     #171511;
}
```

- [ ] **Step 3: Append structural tokens to the four non-Paper blocks** (inside each block, at the end). Aliased to the family's own accent so restyled components keep the family identity; only the on-fill text colors are literals:

```scss
  // Statistical-Report structural tokens — aliased to this family's accent.
  --rule:            var(--fg);
  --duck:            var(--blue);
  --sel-tint:        var(--selection-bg);
  --accent:          var(--blue);
  --accent-hover:    var(--cyan);
```
plus per block:
  - `body.theme-classic-light`: `--duck-ink: #ffffff; --accent-text: #ffffff;`
  - `body.theme-classic-dark`: `--duck-ink: #16161e; --accent-text: #16161e;`
  - `body.theme-github-light`: `--duck-ink: #ffffff; --accent-text: #ffffff;`
  - `body.theme-github-dark`: `--duck-ink: #1f1f1f; --accent-text: #1f1f1f;`

- [ ] **Step 4: Verify** — `bun run build` compiles; `bun run dev`, open the app: default render is now warm paper (`#f7f5ef` background, ink text) with the old structure. `.theme classic-dark` in the command bar still switches to Storm.
- [ ] **Step 5: Commit** — `git commit -am "Tokens: Paper/Night palettes as default light/dark; github-* slots; structural tokens in all six"`

---

### Task 3: Selection plumbing — PersistenceService, BedevereApp, HelpPanel settings UI

**Files:**
- Modify: `src/data/PersistenceService.ts:13` (AppSettings)
- Modify: `src/components/BedevereApp/BedevereApp.ts` (theme option/state, `setupTheme`, `setTheme`, auto-listener, init restore ~line 264, HelpPanel wiring ~line 424, `.theme` command ~line 898)
- Modify: `src/components/HelpPanel/HelpPanel.ts` (options interface + Theme settings section ~line 831)

**Interfaces:**
- Consumes from Task 1: `ThemeFamily`, `ThemeMode`, `ThemeSelection`, `ResolvedTheme`, `resolveThemeVariant`, `splitResolvedTheme`, `themeSelectionFromLegacy`, `themeSelectionFromSettings`, `applyThemeClasses`.
- Produces:
  - `AppSettings.themeFamily?: ThemeFamily`, `AppSettings.themeMode?: ThemeMode` (legacy `theme?` stays, read-only, type widened to include `"github-light" | "github-dark"`).
  - `BedevereApp.setThemeSelection(selection: ThemeSelection): void` (new public method; persists family+mode, applies resolved variant).
  - `BedevereApp.setTheme(theme: ResolvedTheme): void` — signature unchanged (npm compat); now delegates: `this.setThemeSelection({ ...splitResolvedTheme(theme) })`.
  - HelpPanel options: `initialThemeSelection: ThemeSelection` and `onThemeSelectionChange?: (selection: ThemeSelection) => void` REPLACE `initialTheme` / `onThemeChange` (internal interface — HelpPanel is only constructed by BedevereApp).

- [ ] **Step 1: AppSettings.** In `PersistenceService.ts` replace the theme line:

```ts
  /** Legacy single-value theme (pre-0.15). Read for migration only; the
   *  family/mode pair below is the source of truth now. */
  theme?: "light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark" | "auto";
  themeFamily?: "paper" | "tokyonight" | "github";
  themeMode?: "light" | "dark" | "auto";
```

- [ ] **Step 2: BedevereApp state + setup.** Replace the theme plumbing:

```ts
// imports
import {
  applyThemeClasses, resolveThemeVariant, splitResolvedTheme,
  themeSelectionFromLegacy, themeSelectionFromSettings,
  type ResolvedTheme, type ThemeSelection,
} from "./themeClasses";

// fields (replace `private theme: ResolvedTheme = "dark";`)
private themeSelection: ThemeSelection = { family: "paper", mode: "auto" };
private theme: ResolvedTheme = "light";
```

`BedevereAppTheme` (public option type) widens to
`"light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark" | "auto"`;
the constructor default `theme: "dark"` is REMOVED from the options spread (no default —
absence means "use persisted/auto").

```ts
private setupTheme(): void {
  // Explicit option wins (legacy single-value contract); otherwise Paper+Auto.
  this.themeSelection = this.options.theme
    ? themeSelectionFromLegacy(this.options.theme)
    : { family: "paper", mode: "auto" };
  this.theme = resolveThemeVariant(this.themeSelection, this.systemPrefersDark());
  applyThemeClasses(this.container, this.theme);
}

private systemPrefersDark(): boolean {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

public setThemeSelection(selection: ThemeSelection): void {
  this.themeSelection = selection;
  this.theme = resolveThemeVariant(selection, this.systemPrefersDark());
  applyThemeClasses(this.container, this.theme);
  const settings = this.persistenceService.loadAppSettings();
  settings.themeFamily = selection.family;
  settings.themeMode = selection.mode;
  this.persistenceService.saveAppSettings(settings);
}

public setTheme(theme: ResolvedTheme): void {
  this.setThemeSelection(splitResolvedTheme(theme));
}
```

Delete `detectTheme()` (replaced by `systemPrefersDark`). Keep a search for other `detectTheme` call sites (`.theme` command, HelpPanel wiring) — they change below.

- [ ] **Step 3: init restore (~line 264).** Replace the `if (settings.theme && settings.theme !== "auto") { this.setTheme(settings.theme); }` block with:

```ts
// Theme: new family/mode keys win; a legacy single `theme` value migrates
// (light/dark/auto → Paper; classic-* → Tokyonight). Only apply when it
// differs from what the constructor already resolved, and only persist via
// setThemeSelection (which writes the new keys).
const persisted = themeSelectionFromSettings(settings);
if (!this.options.theme) {
  this.setThemeSelection(persisted);
}
```

- [ ] **Step 4: auto-mode reactivity (setupEventSystem ~line 646).** Replace the `if (this.options.theme === "auto") { … }` listener with an unconditional one that acts only when the CURRENT mode is auto:

```ts
// Follow OS light/dark while mode is "auto" (any family).
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (this.themeSelection.mode === "auto") {
    this.theme = resolveThemeVariant(this.themeSelection, this.systemPrefersDark());
    applyThemeClasses(this.container, this.theme);
  }
});
```

- [ ] **Step 5: `.theme` command (~line 898).** Update options + execute:

```ts
description: "Set the theme: a family (paper / tokyonight / github), a mode (light / dark / auto), or a full variant",
parameters: [{
  name: "theme",
  // …existing parameter plumbing…
  options: () => ["paper", "tokyonight", "github", "light", "dark", "auto",
                  "classic-light", "classic-dark", "github-light", "github-dark"],
}],
execute: (params) => {
  const choice = params?.theme as string | undefined;
  const FAMILIES = ["paper", "tokyonight", "github"] as const;
  const MODES = ["light", "dark", "auto"] as const;
  const VARIANTS = ["classic-light", "classic-dark", "github-light", "github-dark"] as const;
  if (!choice) throw new Error(".theme requires a family (paper/tokyonight/github), a mode (light/dark/auto), or a variant");
  if ((FAMILIES as readonly string[]).includes(choice)) {
    this.setThemeSelection({ family: choice as ThemeFamily, mode: this.themeSelection.mode });
  } else if ((MODES as readonly string[]).includes(choice)) {
    this.setThemeSelection({ family: this.themeSelection.family, mode: choice as ThemeMode });
  } else if ((VARIANTS as readonly string[]).includes(choice)) {
    this.setThemeSelection(themeSelectionFromLegacy(choice));
  } else {
    throw new Error(`.theme: unknown value '${choice}'`);
  }
  return `theme: ${this.themeSelection.family} / ${this.themeSelection.mode}`;
},
```
(Note: `light`/`dark`/`auto` now set the MODE keeping the family — the natural reading. Import `ThemeFamily`/`ThemeMode` types.)

- [ ] **Step 6: HelpPanel options + wiring.** In `HelpPanel.ts` replace `initialTheme?: BedevereAppTheme` and `onThemeChange?: (theme: BedevereAppTheme) => void` with:

```ts
initialThemeSelection?: { family: "paper" | "tokyonight" | "github"; mode: "light" | "dark" | "auto" };
onThemeSelectionChange?: (selection: { family: "paper" | "tokyonight" | "github"; mode: "light" | "dark" | "auto" }) => void;
```

Replace the single Theme segmented control (~line 831-860) with two rows inside the same "Theme" section (reuse the existing `help-panel__settings-row` / `help-panel__segmented` markup pattern used by the Delimiter row at ~line 869):

```ts
body.appendChild(this.buildSettingsSection("Theme", (section) => {
  const current = this.options.initialThemeSelection ?? { family: "paper", mode: "auto" };
  let selection = { ...current };

  const mkRow = <T extends string>(
    label: string,
    opts: Array<{ value: T; label: string; title: string }>,
    active: T,
    onPick: (v: T) => void,
  ) => {
    const row = document.createElement("div");
    row.className = "help-panel__settings-row";
    const lab = document.createElement("span");
    lab.className = "help-panel__settings-label";
    lab.textContent = label;
    row.appendChild(lab);
    const seg = document.createElement("div");
    seg.className = "help-panel__segmented";
    for (const opt of opts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "help-panel__segmented-btn";
      btn.textContent = opt.label;
      btn.title = opt.title;
      if (opt.value === active) btn.classList.add("help-panel__segmented-btn--active");
      btn.addEventListener("click", () => {
        for (const sibling of seg.querySelectorAll("button")) {
          sibling.classList.remove("help-panel__segmented-btn--active");
        }
        btn.classList.add("help-panel__segmented-btn--active");
        onPick(opt.value);
      });
      seg.appendChild(btn);
    }
    row.appendChild(seg);
    section.appendChild(row);
  };

  mkRow("Family", [
    { value: "paper", label: "Paper", title: "The Statistical Report — matches kolistat.com (default)" },
    { value: "tokyonight", label: "Tokyonight", title: "Day / Storm — the classic Bedevere palettes" },
    { value: "github", label: "Github", title: "The pre-0.15 default look" },
  ] as const, selection.family, (v) => { selection = { ...selection, family: v }; this.options.onThemeSelectionChange?.(selection); });

  mkRow("Mode", [
    { value: "light", label: "Light", title: "Always light" },
    { value: "dark", label: "Dark", title: "Always dark" },
    { value: "auto", label: "Auto", title: "Follow your system setting" },
  ] as const, selection.mode, (v) => { selection = { ...selection, mode: v }; this.options.onThemeSelectionChange?.(selection); });
}));
```

And in `BedevereApp.ts` HelpPanel construction (~line 424) replace `initialTheme` / `onThemeChange` with:

```ts
initialThemeSelection: themeSelectionFromSettings(this.persistenceService.loadAppSettings()),
onThemeSelectionChange: (selection) => this.setThemeSelection(selection),
```

- [ ] **Step 7: Sweep leftover references** — `bun x tsc --noEmit` (or `bun run build`) and fix any remaining `initialTheme` / `onThemeChange` / `detectTheme` references it flags (e.g. `EmbedBuilderDialog.show({ …, theme: this.theme })` still compiles — `this.theme` is still `ResolvedTheme`).
- [ ] **Step 8: Tests + manual** — `bun run test:run` green. `bun run dev`: fresh profile defaults to Paper+Auto; Settings shows Family/Mode rows; `.theme github` flips family only; `.theme dark` flips mode only; reload persists.
- [ ] **Step 9: Commit** — `git commit -am "Theme plumbing: family/mode selection through settings, BedevereApp, HelpPanel, .theme command"`

---

### Task 4: Embed theme surface — config, applier, builder dialog

**Files:**
- Modify: `src/embed/embedConfig.ts:13,23-27`
- Modify: `src/embed/embedTheme.ts`
- Modify: `src/components/EmbedBuilderDialog/EmbedBuilderDialog.ts` (theme `<select>` options)
- Test: existing `src/embed/__tests__/embedUrl.test.ts`, `src/components/EmbedBuilderDialog/__tests__/EmbedBuilderDialog.test.ts` must stay green; extend embedConfig coverage if a test file exists, else add `src/embed/__tests__/embedConfig.test.ts`

**Interfaces:**
- Consumes: `ResolvedTheme` shape (keep embed self-contained: duplicate the literal union, embed modules deliberately avoid app imports).
- Produces: `EmbedTheme = "light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark"`; `EmbedConfig.theme: EmbedTheme | null`.

- [ ] **Step 1: Failing test** (new or extended `embedConfig.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { parseEmbedConfig } from "../embedConfig";

describe("parseEmbedConfig theme", () => {
  it("accepts all six variants", () => {
    for (const t of ["light", "classic-light", "dark", "classic-dark", "github-light", "github-dark"]) {
      expect(parseEmbedConfig(`?theme=${t}`).theme).toBe(t);
    }
  });
  it("rejects unknown values to null (prefers-color-scheme fallback)", () => {
    expect(parseEmbedConfig("?theme=paper").theme).toBeNull();
    expect(parseEmbedConfig("?theme=").theme).toBeNull();
  });
});
```
Run: FAILS (github-* rejected).

- [ ] **Step 2: Implement.**
  - `embedConfig.ts`: widen the `theme` union to the six values; replace the literal-comparison chain with a set:
    ```ts
    const EMBED_THEMES = ["light", "classic-light", "dark", "classic-dark", "github-light", "github-dark"] as const;
    const theme = (EMBED_THEMES as readonly string[]).includes(themeRaw ?? "")
      ? (themeRaw as EmbedConfig["theme"])
      : null;
    ```
  - `embedTheme.ts`: `EmbedTheme` gains the two github values; `applyTheme` removes all six classes (use a `const EMBED_THEME_VARIANTS` array rather than the inline list). `resolveTheme` unchanged (auto → paper light/dark — intended).
  - `EmbedBuilderDialog.ts`: theme `<select>` options become: Auto (follow system), Paper light (`light`), Paper dark (`dark`), Tokyonight light (`classic-light`), Tokyonight dark (`classic-dark`), Github light (`github-light`), Github dark (`github-dark`) — values are the wire values, labels human.
- [ ] **Step 3: Tests pass** — `bun run test:run` all green (fix EmbedBuilderDialog test if it asserts option count).
- [ ] **Step 4: Commit** — `git commit -am "Embed: accept github-* theme variants; builder dialog lists all six"`

---

### Task 5: Spreadsheet palettes + booktabs treatment (`utils/theme.ts` + renderer hook)

**Files:**
- Modify: `src/components/SpreadsheetVisualizer/utils/theme.ts`
- Modify: `src/components/SpreadsheetVisualizer/SpreadsheetVisualizerBase.ts` (line-drawing color hooks only)

**Interfaces:**
- Consumes: nothing new (keeps its own literal palette mirror — documented sync with `_tokens.scss`).
- Produces: `ThemeColors` gains four optional fields consumed by the renderer:
  - `headerTopRuleColor?: string` (2px, above header)
  - `headerBottomRuleColor?: string` (1px, under header)
  - `frameBottomRuleColor?: string` (2px, grid's bottom edge)
  - `verticalGridColor?: string` (column separators; `"transparent"` hides them)
  - `detectCurrentTheme()` / `getThemeColors()` / `listenForThemeChanges()` signatures widen from the 4-literal union to the 6-value union (define `export type SpreadsheetTheme = "light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark";` and use it in all three signatures).

- [ ] **Step 1: Widen detection.** In `detectCurrentTheme()` add the two class checks BEFORE the `theme-dark` check (`theme-github-light`, `theme-github-dark` → cache and return); update `cachedTheme` type and the exported unions to `SpreadsheetTheme`.
- [ ] **Step 2: Re-slot palettes.** In `getThemeColors`:
  - current `"dark"` branch (GitHub literals) → becomes the `"github-dark"` branch, unchanged values;
  - current final `else` (warm-neutral light) → becomes `"github-light"` branch, unchanged values;
  - `"classic-dark"` / `"classic-light"` branches unchanged;
  - NEW `"dark"` branch (Night) and NEW final `else` (Paper light):

```ts
if (currentTheme === "dark") {
  colors = {
    // Night — Paper's dark mode. Booktabs: rules carry the structure.
    headerBackgroundColor: "#171511",       // no header fill — rules instead
    headerTextColor: "#ece7da",
    cellBackgroundColor: "#171511",
    cellTextColor: "#ece7da",
    stripeBackgroundColor: "#1c1913",
    borderColor: "#35322a",                  // hairline row separators
    selectionColor: "rgba(255, 217, 57, 0.22)",
    selectionBorderColor: "#ffd939",
    hoverColor: "rgba(255, 217, 57, 0.10)",
    hoverBorderColor: "rgba(255, 217, 57, 0.45)",
    scrollbarColor: "#29251c",
    scrollbarThumbColor: "#4d483c",
    scrollbarHoverColor: "#a49e8e",
    booleanStyle:  { backgroundColor: "#171511", textColor: "#8fb8c4" },
    numericStyle:  { backgroundColor: "#171511", textColor: "#ece7da" },
    stringStyle:   { backgroundColor: "#171511", textColor: "#ece7da" },
    dateStyle:     { backgroundColor: "#171511", textColor: "#d9bd66" },
    datetimeStyle: { backgroundColor: "#171511", textColor: "#cf9a62" },
    nullStyle:     { backgroundColor: "#171511", textColor: "#a49e8e" },
    headerTopRuleColor: "#ece7da",
    headerBottomRuleColor: "#ece7da",
    frameBottomRuleColor: "#ece7da",
    verticalGridColor: "transparent",
  };
} // …
else {
  colors = {
    // Paper — default light. Booktabs report grid.
    headerBackgroundColor: "#f7f5ef",
    headerTextColor: "#1a1917",
    cellBackgroundColor: "#f7f5ef",
    cellTextColor: "#1a1917",
    stripeBackgroundColor: "#f2efe6",
    borderColor: "#d9d5c9",
    selectionColor: "rgba(255, 217, 57, 0.4)",
    selectionBorderColor: "#1a1917",
    hoverColor: "rgba(255, 217, 57, 0.18)",
    hoverBorderColor: "rgba(26, 25, 23, 0.35)",
    scrollbarColor: "#efece1",
    scrollbarThumbColor: "#b8b3a3",
    scrollbarHoverColor: "#5f5c54",
    booleanStyle:  { backgroundColor: "#f7f5ef", textColor: "#275e6e" },
    numericStyle:  { backgroundColor: "#f7f5ef", textColor: "#1a1917" },
    stringStyle:   { backgroundColor: "#f7f5ef", textColor: "#1a1917" },
    dateStyle:     { backgroundColor: "#f7f5ef", textColor: "#8a6d1f" },
    datetimeStyle: { backgroundColor: "#f7f5ef", textColor: "#a05c2c" },
    nullStyle:     { backgroundColor: "#f7f5ef", textColor: "#5f5c54" },
    headerTopRuleColor: "#1a1917",
    headerBottomRuleColor: "#1a1917",
    frameBottomRuleColor: "#1a1917",
    verticalGridColor: "transparent",
  };
}
```
(The four github/classic branches get NO new fields — `undefined` means "old behavior", zero regression risk.)

- [ ] **Step 3: Renderer hook.** In `SpreadsheetVisualizerBase.ts` locate where the header row and cell borders are stroked (search `borderColor` / `strokeStyle`):
  - Where vertical column-separator lines are drawn: if `colors.verticalGridColor === "transparent"`, skip the stroke; if the field is set, use it; else current `borderColor` behavior.
  - After the header row is painted: if `headerTopRuleColor` is set, stroke a 2px line across the grid's top edge and (with `headerBottomRuleColor`) a 1px line under the header row.
  - If `frameBottomRuleColor` is set, stroke a 2px line along the last visible row's bottom edge when the final row is in view.
  Keep this change minimal and color-driven — no layout shifts; horizontal row separators keep using `borderColor`.
- [ ] **Step 4: Verify** — `bun run test:run` (SpreadsheetCache tests stay green — they don't assert colors); `bun run dev` → Paper grid reads booktabs: heavy top/bottom + light under-header, no vertical rules; `.theme github` → old grid unchanged.
- [ ] **Step 5: Commit** — `git commit -am "Spreadsheet: Paper/Night palettes + booktabs rules; github palettes keep the old look"`

---

### Task 6: Chart theming — Ramp A + mono apparatus

**Files:**
- Modify: `src/components/ChartVisualizer/ChartVisualizer.ts:144-170` (`applyTheme`)

**Interfaces:**
- Consumes: CSS custom properties from Task 2 (`--duck`, `--rule`, `--bg`, `--border`, `--fg`, `--fg-dark`, `--font-mono`).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Implement** — replace the `themeConfig` block:

```ts
const themeConfig = {
  background: v("--bg") || (isLight ? "#f7f5ef" : "#171511"),
  // Ramp A "Field Notes": duck first (the report's marker), ink second
  // (theme-resolved via --rule), then four fixed mid-tone hues that hold
  // ≥3:1 on both paper and night. Danger/success are semantic-only.
  range: {
    category: [
      v("--duck") || "#ffd939",
      v("--rule") || (isLight ? "#1a1917" : "#ece7da"),
      "#c65d3b", "#4e7f71", "#6b7fb3", "#9a6d9e",
    ],
  },
  font: v("--font-mono") || "monospace",
  view: { stroke: v("--border") || "#d9d5c9" },
  axis: {
    domainColor: v("--rule") || "#1a1917",
    gridColor:   v("--border") || "#d9d5c9",
    labelColor:  v("--fg-dark") || "#3d3a33",
    titleColor:  v("--fg") || "#1a1917",
    tickColor:   v("--rule") || "#1a1917",
    labelFont:   v("--font-mono") || "monospace",
    titleFont:   v("--font-mono") || "monospace",
  },
  legend: {
    labelColor: v("--fg-dark") || "#3d3a33",
    titleColor: v("--fg") || "#1a1917",
    labelFont:  v("--font-mono") || "monospace",
    titleFont:  v("--font-mono") || "monospace",
  },
  title: { color: v("--fg") || "#1a1917", font: v("--font-mono") || "monospace" },
};
```
and update `isLight` to `ct === "light" || ct === "classic-light" || ct === "github-light"`. Update the method's doc comment ("Tokyonight-flavoured" → "Statistical-Report"). User-provided `spec.config` still wins (existing merge — unchanged).
- [ ] **Step 2: Verify** — `bun run dev` → run the tutorial VISUALIZE query: bars start duck-yellow then ink; axes ink + hairline grid; mono labels; theme switch re-embeds correctly (existing `listenForThemeChanges` wiring).
- [ ] **Step 3: Commit** — `git commit -am "Charts: Ramp A categorical palette + mono report apparatus"`

---

### Task 7: Structure sweep A — shadows→rules, radius stragglers, focus/selection/scrollbars

**Files (all under `src/styles/`):**
- Modify: `main.scss`, `components/help-panel.scss`, `components/hide-columns-dialog.scss`, `components/html-paste-dialog.scss`, `components/save-query-dialog.scss`, `components/embed-builder-dialog.scss`, `components/context-menu.scss`, `components/message-popover.scss`, `components/desktop-hint.scss`, `components/command-bar.scss`, `components/chart-visualizer.scss`, `components/environment-switcher.scss`, `components/spreadsheet-visualizer.scss`

**Interfaces:** consumes `--rule`, `--sel-tint`, `--bg-float`, `--fg-muted` from Task 2.

- [ ] **Step 1: Global focus/selection** — append to `main.scss` (after the body block):

```scss
// Statistical-Report interaction affordances.
:focus-visible {
  outline: 2px solid var(--rule);
  outline-offset: 2px;
}

::selection {
  background: var(--sel-tint);
  color: var(--fg);
}
```

- [ ] **Step 2: Scrollbar hover** — in `main.scss` change the thumb hover from `var(--border-strong)` to `var(--fg-muted)` (in Paper, thumb is already border-strong via `--gutter`; hover needs to go darker, not sideways).
- [ ] **Step 3: Shadows → rules.** Replace every dialog/popover/menu `box-shadow` with a flat rule border (delete the box-shadow line; ensure the element has `border: 1px solid var(--rule);` — replace an existing `border: … var(--border…)` on the same element rather than doubling):
  - `help-panel.scss:20`, `hide-columns-dialog.scss:22`, `html-paste-dialog.scss:22`, `save-query-dialog.scss:21`, `embed-builder-dialog.scss:20` (all `0 8px 32px rgba(0,0,0,.4)`)
  - `context-menu.scss:14` (`0 4px 18px`), `message-popover.scss:16,177` (double layer), `desktop-hint.scss:18` (`0 4px 16px`), `command-bar.scss:73` (`0 8px 20px`), `chart-visualizer.scss:81` (vega action menu), `environment-switcher.scss:69` (`0 6px 24px`)
  - `spreadsheet-visualizer.scss:137` (`0 2px 6px`) → delete; `:154` (`0 0 4px var(--blue)` drop-indicator glow) → replace with `box-shadow: none;` + `outline: 2px solid var(--duck);` (the indicator must stay visible — it becomes a hard duck line).
- [ ] **Step 4: Radius stragglers** — `help-panel.scss:797` (`2px`), `spreadsheet-visualizer.scss:136` (`2px`), `environment-switcher.scss:106` (`50%` → `0`; it's a colored env dot — square chip now). Leave `index.html`/`embed.html` spinner `50%` alone (motion exception). Grep check: `rg -n "border-radius" src/styles | rg -v ": 0"` returns nothing.
- [ ] **Step 5: Verify** — `bun run build`; `bun run dev`: open Help panel, context menu, command bar, a dialog — flat surfaces with 1px ink rules, no shadows, square env dot; focus ring is a 2px ink outline; text selection is yellow-tinted.
- [ ] **Step 6: Commit** — `git commit -am "Structure sweep: rules replace shadows, radius 0, ink focus ring, duck selection"`

---

### Task 8: Structure sweep B — duck tab chips, buttons, heavy rules, apparatus type

**Files:**
- Modify: `src/styles/components/tab-manager.scss:56-65`, `components/editor-tab-bar.scss` (active tab ~line 54), `components/sql-editor.scss:59-92`, `components/control-panel.scss` (section heads), `components/status-bar.scss` (top seam), `src/styles/embed.scss` (run button ~line 87-100, `border-radius: 3px` at ~94)

**Interfaces:** consumes `--duck`, `--duck-ink`, `--rule`, `--accent`, `--accent-hover`, `--accent-text` from Task 2.

- [ ] **Step 1: Tabs = duck chips.** In `tab-manager.scss` `&--active` replace the inset box-shadow treatment:

```scss
    &--active {
      background-color: var(--duck);
      color: var(--duck-ink);

      &:hover { background-color: var(--duck); }

      .tab-manager__tab-title { font-weight: 600; }
      .tab-manager__tab-close { color: var(--duck-ink); }
    }
```
Do the equivalent in `editor-tab-bar.scss` (its active tab uses the same `inset 0 2px 0 0 var(--blue)` pattern — same replacement, class names per that file).
- [ ] **Step 2: Buttons.** In `sql-editor.scss`:

```scss
  &__run-button {
    background: var(--duck);
    color: var(--duck-ink);
    border: 1.5px solid var(--rule);

    &:hover {
      background: var(--duck);
      transform: translate(-1px, -1px);
      box-shadow: 2px 2px 0 var(--rule);   // sanctioned hard offset (site .btn-run)
    }
  }

  &__clear-button {
    background: transparent;
    color: var(--fg);
    border-color: var(--rule);

    &:hover { background: var(--sel-tint); }
  }
```
Shared block (lines 59-71) keeps mono/uppercase; bump `letter-spacing` to `0.08em`. In `embed.scss` the run button (~87-100): drop `border-radius: 3px`, same duck treatment as above (it currently uses the blue token).
- [ ] **Step 3: Heavy rules + eyebrows.** In `control-panel.scss`: panel title/section heads get `border-bottom: 2px solid var(--rule);` and eyebrow type: `font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--fg-muted);` (apply to the existing header class — find the panel-title / accordion-header selectors; adjust nearby paddings only if text now overflows). In `status-bar.scss`: the bar's top border becomes `border-top: 1px solid var(--border);` if not already; the version chip already picks up duck via `--version-bg`. In `help-panel.scss`: the panel header/title bottom border → `2px solid var(--rule)`.
- [ ] **Step 4: Verify** — `bun run dev` both Paper modes + `.theme tokyonight` (chips go family-blue, structure identical). Screenshot-worthy: tabs, run button hover, control panel heads.
- [ ] **Step 5: Commit** — `git commit -am "Structure sweep: duck tab chips, report buttons, heavy rules + eyebrow labels"`

---

### Task 9: Fonts — IBM Plex Mono + Source Serif 4, self-hosted

**Files:**
- Modify: `package.json` (deps), `src/main.ts`, `src/embed/main.ts` (font imports), `src/styles/_tokens.scss:199-209` (stacks), `src/styles/components/context-menu.scss:16`, `src/styles/embed.scss:48`

**Interfaces:** produces `--font-mono` (Plex-first) and `--font-sans` (serif stack — the website's rename-nothing trick) for all component scss.

- [ ] **Step 1: Install** — `bun add @fontsource/ibm-plex-mono @fontsource/source-serif-4`
- [ ] **Step 2: Import** — top of `src/main.ts` AND `src/embed/main.ts` (both entries bundle independently):

```ts
// Self-hosted fonts (Statistical-Report identity). Static weights only:
// mono 400/600 for chrome+data+editor, serif 400/400i/600 for prose accents.
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/600.css";
```

- [ ] **Step 3: Stacks** — in `_tokens.scss` `:root`:

```scss
  // Apparatus face: chrome, data, editor. Plex Mono ships bundled; the
  // rest of the stack is the no-download fallback.
  --font-mono: "IBM Plex Mono", "JetBrains Mono", "Cascadia Code",
               "SF Mono", "Consolas", "Menlo", monospace;

  // Prose face. NOTE: the NAME stays --font-sans (every consumer keeps
  // working) but the FACE is now a serif — the website pulls the same
  // trick. Serif is seasoning: dialog titles, empty states, help prose.
  --font-sans: "Source Serif 4", "Iowan Old Style", Georgia,
               "Times New Roman", serif;
```

- [ ] **Step 4: Consumers** — `context-menu.scss:16`: `font-family: var(--font-sans)` → `var(--font-mono)` (menus are apparatus, not prose). `embed.scss:48`: hardcoded `Consolas, "Courier New", monospace` → `var(--font-mono)`.
- [ ] **Step 5: Verify** — `bun run build` (verify-build passes; woff2 assets emitted); `bun run dev`: chrome renders Plex Mono, help-panel prose + sidebar empty-state render Source Serif; DevTools network shows fonts served same-origin.
- [ ] **Step 6: Commit** — `git commit -am "Fonts: self-hosted IBM Plex Mono + Source Serif 4; --font-sans becomes the serif stack"`

---

### Task 10: Loading screens + HTML export header

**Files:**
- Modify: `index.html` (inline `<style>` ~46-114), `embed.html` (inline `<style>` ~9-42), `src/components/BedevereApp/ExportHub.ts:103`

- [ ] **Step 1: `index.html` loader** — the loading screen's hardcoded `#1e1e1e`/`#cccccc`/`#007acc` become paper-aware:

```css
body { background-color: #f7f5ef; color: #1a1917; }
@media (prefers-color-scheme: dark) {
  body { background-color: #171511; color: #ece7da; }
}
.loading { /* inherit body colors; spinner: */ }
.loading::after {
  border: 2px solid #d9d5c9;
  border-top: 2px solid #ffd939;
}
@media (prefers-color-scheme: dark) {
  .loading::after { border-color: #35322a; border-top-color: #ffd939; }
}
```
(Adapt to the existing selectors — replace colors in place; spinner stays round.)
- [ ] **Step 2: `embed.html` loader** — same treatment: default paper (`#f7f5ef`/`#1a1917`), `html[data-theme="dark"]`-style dark override → night (`#171511`/`#ece7da`), any classic-dark literals (`#1a1b26`, `#e1e2e7`) replaced. Keep the existing selector structure (`html[data-theme="light"] body` etc.).
- [ ] **Step 3: ExportHub** — line ~103: `#f2f2f2` → `#efece1` with a comment: `// paper-raised; exported HTML is standalone, so a literal (not a var)`.
- [ ] **Step 4: Verify** — `bun run dev` hard-reload: paper flash (not VS-Code grey) before the app paints; `.export html` of a small table shows the warm header.
- [ ] **Step 5: Commit** — `git commit -am "Paper-aware loading screens + export header"`

---

### Task 11: Embed kinship harness

**Files:**
- Create: `testfiles/embed-kinship.html`
- Modify: `.gitignore` (add `!testfiles/embed-kinship.html` next to the existing embed-harness exceptions)

- [ ] **Step 1: Write the page** — a static page that mimics a kolistat.com article: `background:#f7f5ef; color:#1a1917; font-family: Georgia/serif prose`, an `.eyebrow`-style mono label, a booktabs-styled HTML `<table>` (2.5px/1px/2.5px rules, no verticals, right-aligned numerics), then an `<iframe>` (`width:100%; height:440px; border:1px solid #1a1917;`) pointing at `http://localhost:5173/embed?dataset=/testfiles/embed-demo.parquet&autorun=1#query=SELECT%20*%20FROM%20'embed-demo'%20LIMIT%2015` — mirror how `testfiles/embed-harness.html` builds its URL (fragment params) and reuse its dataset fixture. Include both a default (paper) iframe and a `theme=dark` one.
- [ ] **Step 2: Verify** — `bun run dev`, open `http://localhost:5173/testfiles/embed-kinship.html`: the framed embed reads as kin to the static booktabs table (same rules weight, same paper, same mono data face).
- [ ] **Step 3: Commit** — `git add testfiles/embed-kinship.html .gitignore && git commit -m "Embed kinship harness: booktabs article page framing /embed"`

---

### Task 12: Verify battery + changelog

**Files:**
- Modify: `CHANGELOG.md` (new Unreleased section), any test/copy fixups the battery surfaces

- [ ] **Step 1: Full suite** — `bun run test:run` → all green; `bun run build` → tsc + vite + verify-build green.
- [ ] **Step 2: Hex sweep** — `rg -in "#(1e1e1e|007acc|cccccc|f2f2f2|24292e)" src index.html embed.html` → no hits outside documented literals; `rg -n "#[0-9a-fA-F]{3,8}" src/styles/components | rg -v "var\("` → review every hit is intentional (should be ~none).
- [ ] **Step 3: Both-theme walkthrough** — `bun run dev`: for Paper light + Night: shell, grid (booktabs), chart (Ramp A), a dialog, command bar, context menu, status bar, focus ring, text selection. Then `.theme tokyonight` and `.theme github`: old colors, new structure, nothing broken. Screenshot shell/grid/chart/dialog in both Paper modes (drop into the brainstorm session dir or share however preferred).
- [ ] **Step 4: Embed checks** — `/embed` directly in both themes; the kinship harness page; confirm embed URL params behave identically to pre-restyle for the old five values.
- [ ] **Step 5: Contract audit** — `git diff dev-0.14 --stat`: confirm the diff is styles/theme/font/loading-screen files + the planned TS surfaces only; `src/embed/embedMessages.ts` untouched; no changes to `buildEmbedUrl` semantics.
- [ ] **Step 6: CHANGELOG** — add at the top:

```markdown
## Unreleased

- [Feature] **KoliStat "Statistical Report" restyle.** New default **Paper** theme family (warm paper/ink, booktabs result grid, IBM Plex Mono chrome, Source Serif 4 accents, duck-yellow highlights) matching kolistat.com; themes are now a family (Paper / Tokyonight / Github) × mode (Light / Dark / Auto) selection. Existing light/dark users move to Paper; classic-* users stay on Tokyonight; the 0.14 look lives on as the Github family. `/embed` accepts additive `github-light` / `github-dark` theme values; all previous values keep working. Fonts are self-hosted (@fontsource) — no runtime dependency on kolistat.com.
```

- [ ] **Step 7: Commit** — `git commit -am "Restyle verify battery: changelog + fixups"`

---

## Self-review (spec coverage)

- Spec §1 theme model → Tasks 1, 3, 4 ✓ · §2 tokens → Task 2 ✓ · §3 structure laws → Tasks 5 (grid), 7, 8 ✓ · §4 fonts → Task 9 ✓ · §5 charts → Task 6 ✓ · §6 JS/HTML surfaces → Tasks 5, 6, 10 ✓ · §7 contracts → Global Constraints + Task 12 step 5 ✓ · §8 verify → Tasks 11, 12 ✓ · §9 phases → task order ✓
- Type consistency: `ThemeSelection`/`resolveThemeVariant`/`splitResolvedTheme`/`themeSelectionFromLegacy`/`themeSelectionFromSettings` named identically in Tasks 1, 3; `SpreadsheetTheme` local to Task 5; `EmbedTheme` local to Task 4 ✓
