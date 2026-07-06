export type ThemeFamily = "paper" | "tokyonight" | "github";
export type ThemeMode = "light" | "dark" | "auto";

/**
 * The concrete theme variants the app renders. {@link BedevereAppTheme}'s
 * `"auto"` is resolved to one of these (via `prefers-color-scheme`) before
 * any class is applied — see {@link BedevereApp.setupTheme}.
 */
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

/**
 * Apply `theme` *exclusively* to the document body and the app container:
 * every other theme class is stripped first, so exactly one `theme-*` (body)
 * and one `bedevere-app--*` (container) class is ever present.
 *
 * Additive-only application was the cause of the desktop "everything stays
 * dark except the spreadsheet" bug. The desktop renderer hardcodes
 * `<body class="theme-dark">` for first-paint FOUC prevention; when the
 * resolved theme wasn't dark, the original add-only setupTheme/setTheme left
 * that class in place. The SCSS cascade then kept every CSS-driven component
 * dark (theme-dark is last in _tokens.scss, so it wins on equal specificity)
 * while the spreadsheet's own JS detector — which checks theme-light first —
 * flipped to the resolved palette, and the two halves disagreed. Clearing all
 * variants first makes application idempotent and host-state-independent.
 * Mirrors embed/embedTheme.applyTheme.
 */
export function applyThemeClasses(container: HTMLElement, theme: ResolvedTheme): void {
  for (const variant of THEME_VARIANTS) {
    document.body.classList.remove(`theme-${variant}`);
    container.classList.remove(`bedevere-app--${variant}`);
  }
  document.body.classList.add(`theme-${theme}`);
  container.classList.add(`bedevere-app--${theme}`);
}
