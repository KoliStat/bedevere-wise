/**
 * The concrete theme variants the app renders. {@link BedevereAppTheme}'s
 * `"auto"` is resolved to one of these (via `prefers-color-scheme`) before
 * any class is applied — see {@link BedevereApp.setupTheme}.
 */
export type ResolvedTheme = "light" | "classic-light" | "dark" | "classic-dark";

const THEME_VARIANTS: readonly ResolvedTheme[] = [
  "light",
  "classic-light",
  "dark",
  "classic-dark",
];

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
