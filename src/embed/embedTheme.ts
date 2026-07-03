/**
 * Theme application for the /embed route. Sets the same body class
 * BedevereApp uses (`theme-light` / `theme-dark`) so the SCSS tokens
 * resolve and the existing canvas / CodeMirror theming pick it up,
 * and mirrors a `data-theme` attribute on `<html>` for the parent
 * blog's contract (see the embed spec).
 */
export type EmbedTheme = "light" | "classic-light" | "dark" | "classic-dark" | "github-light" | "github-dark";

export function resolveTheme(explicit: EmbedTheme | null): EmbedTheme {
  if (explicit) return explicit;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: EmbedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  // Remove every theme class before adding the chosen one so switching
  // between any of the three palettes is clean.
  document.body.classList.remove("theme-light", "theme-classic-light", "theme-dark", "theme-classic-dark", "theme-github-light", "theme-github-dark");
  document.body.classList.add(`theme-${theme}`);
}
