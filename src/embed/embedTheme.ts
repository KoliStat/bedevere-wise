/**
 * Theme application for the /embed route. Sets the same body class
 * BedevereApp uses (`theme-light` / `theme-dark`) so the SCSS tokens
 * resolve and the existing canvas / CodeMirror theming pick it up,
 * and mirrors a `data-theme` attribute on `<html>` for the parent
 * blog's contract (see the embed spec).
 */
export type EmbedTheme = "light" | "dark";

export function resolveTheme(explicit: EmbedTheme | null): EmbedTheme {
  if (explicit) return explicit;
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: EmbedTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  const other = theme === "light" ? "dark" : "light";
  document.body.classList.remove(`theme-${other}`);
  document.body.classList.add(`theme-${theme}`);
}
