// Six resolved theme variants: Paper (light/dark), Tokyonight (classic-*),
// GitHub (github-*, the pre-restyle defaults kept selectable). This module
// keeps its own literal palette mirror rather than importing
// BedevereApp's `ResolvedTheme` — documented sync with `_tokens.scss`.
export type SpreadsheetTheme =
  | "light"
  | "classic-light"
  | "dark"
  | "classic-dark"
  | "github-light"
  | "github-dark";

export interface ThemeColors {
  // Header colors
  headerBackgroundColor: string;
  headerTextColor: string;

  // Cell colors
  cellBackgroundColor: string;
  cellTextColor: string;
  // Subtle alternate-row stripe colour. Layered over the cellBackgroundColor
  // on every other body row to reduce eye-tracking fatigue.
  stripeBackgroundColor: string;

  // Border and UI colors
  borderColor: string;
  selectionColor: string;
  selectionBorderColor: string;
  hoverColor: string;
  hoverBorderColor: string;

  // Scrollbar colors
  scrollbarColor: string;
  scrollbarThumbColor: string;
  scrollbarHoverColor: string;

  // Data type specific colors
  booleanStyle: { backgroundColor: string; textColor: string };
  numericStyle: { backgroundColor: string; textColor: string };
  stringStyle: { backgroundColor: string; textColor: string };
  dateStyle: { backgroundColor: string; textColor: string };
  datetimeStyle: { backgroundColor: string; textColor: string };
  nullStyle: { backgroundColor: string; textColor: string };

  // Booktabs rule colors — optional. Only the Paper/Night palettes set
  // these; github/classic palettes leave them undefined, which the
  // renderer (SpreadsheetVisualizerBase) reads as "old behavior, no rule
  // painted" — zero regression risk for the four pre-existing palettes.
  headerTopRuleColor?: string; // 2px, above the header (grid's top edge)
  headerBottomRuleColor?: string; // 1px, under the header row
  frameBottomRuleColor?: string; // 2px, grid's bottom edge (last row)
  verticalGridColor?: string; // column separators; "transparent" hides them
}

// Module-level cache for theme colors. Invalidated whenever the theme changes
// (body class mutation or system media query). Avoids recomputing colors and
// re-running DOM queries on every cell render.
let cachedTheme: SpreadsheetTheme | null = null;
let cachedColors: ThemeColors | null = null;
let cacheObserverInstalled = false;

function installCacheInvalidation(): void {
  if (cacheObserverInstalled || typeof document === "undefined") return;
  cacheObserverInstalled = true;

  const invalidate = () => {
    cachedTheme = null;
    cachedColors = null;
  };

  const observer = new MutationObserver(invalidate);
  observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", invalidate);
  }
}

export function detectCurrentTheme(): SpreadsheetTheme {
  installCacheInvalidation();
  if (cachedTheme !== null) return cachedTheme;

  // Check body class first (set by BedevereApp). Every explicit theme class
  // is checked before the generic prefers-color-scheme fallback below —
  // github-* sit alongside their light/dark siblings (light family first,
  // dark family last) so a stale/unrecognized combination can't shadow them.
  if (document.body.classList.contains("theme-light")) {
    cachedTheme = "light";
    return cachedTheme;
  }
  if (document.body.classList.contains("theme-classic-light")) {
    cachedTheme = "classic-light";
    return cachedTheme;
  }
  if (document.body.classList.contains("theme-github-light")) {
    cachedTheme = "github-light";
    return cachedTheme;
  }
  if (document.body.classList.contains("theme-classic-dark")) {
    cachedTheme = "classic-dark";
    return cachedTheme;
  }
  if (document.body.classList.contains("theme-github-dark")) {
    cachedTheme = "github-dark";
    return cachedTheme;
  }
  if (document.body.classList.contains("theme-dark")) {
    cachedTheme = "dark";
    return cachedTheme;
  }

  // Fallback to system preference
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    cachedTheme = "dark";
    return cachedTheme;
  }

  cachedTheme = "light";
  return cachedTheme;
}

export function getThemeColors(theme?: SpreadsheetTheme): ThemeColors {
  // Fast path: cached colors (only valid when no theme override is requested)
  if (!theme && cachedColors !== null) return cachedColors;

  const currentTheme = theme || detectCurrentTheme();

  // Palette — keep these in sync with src/styles/_tokens.scss. The canvas
  // can't read CSS custom properties from JS without an extra
  // getComputedStyle call per cell, so the palette is mirrored here as
  // literals. Updating one place requires updating the other.
  let colors: ThemeColors;
  if (currentTheme === "dark") {
    colors = {
      // Night — Paper's dark mode. Booktabs: rules carry the structure.
      headerBackgroundColor: "#171511", // no header fill — rules instead
      headerTextColor: "#ece7da",
      cellBackgroundColor: "#171511",
      cellTextColor: "#ece7da",
      stripeBackgroundColor: "#1c1913",
      borderColor: "#35322a", // hairline row separators
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
  } else if (currentTheme === "github-dark") {
    colors = {
      // GitHub Dark — pre-restyle default dark, kept selectable. Text + accents
      // match the blog's github-dark code blocks; surfaces are neutral dark
      // greys (the #1f1f1f bg the editor asked for, cleaner than GitHub's
      // blue-tinted #24292e).
      headerBackgroundColor: "#181818",
      headerTextColor: "#e1e4e8",

      cellBackgroundColor: "#1f1f1f",
      cellTextColor: "#e1e4e8",
      stripeBackgroundColor: "#262626",

      borderColor: "#3a3a3a",
      selectionColor: "rgba(121, 184, 255, 0.20)",
      selectionBorderColor: "#79b8ff",
      hoverColor: "rgba(121, 184, 255, 0.10)",
      hoverBorderColor: "rgba(121, 184, 255, 0.5)",

      scrollbarColor: "#181818",
      scrollbarThumbColor: "#3a3a3a",
      scrollbarHoverColor: "#4d4d4d",

      // Type-coloured cells — soft tinted backgrounds with fg accents.
      booleanStyle:  { backgroundColor: "#1f1f1f", textColor: "#79b8ff" },
      numericStyle:  { backgroundColor: "#1f1f1f", textColor: "#85e89d" },
      stringStyle:   { backgroundColor: "#1f1f1f", textColor: "#e1e4e8" },
      dateStyle:     { backgroundColor: "#1f1f1f", textColor: "#ffea7f" },
      datetimeStyle: { backgroundColor: "#1f1f1f", textColor: "#ffab70" },
      nullStyle:     { backgroundColor: "#1f1f1f", textColor: "#6a737d" },
    };
  } else if (currentTheme === "classic-dark") {
    colors = {
      // Storm — classic dark variant (the original dark palette)
      headerBackgroundColor: "#1f2335",
      headerTextColor: "#c0caf5",

      cellBackgroundColor: "#1a1b26",
      cellTextColor: "#c0caf5",
      stripeBackgroundColor: "#1d1f2c",

      borderColor: "#292e42",
      selectionColor: "rgba(122, 162, 247, 0.22)",
      selectionBorderColor: "#7aa2f7",
      hoverColor: "rgba(122, 162, 247, 0.10)",
      hoverBorderColor: "rgba(122, 162, 247, 0.5)",

      scrollbarColor: "#16161e",
      scrollbarThumbColor: "#3b4261",
      scrollbarHoverColor: "#565f89",

      // Type-coloured cells — soft tinted backgrounds with fg accents.
      booleanStyle:  { backgroundColor: "#1a1b26", textColor: "#7aa2f7" },
      numericStyle:  { backgroundColor: "#1a1b26", textColor: "#9ece6a" },
      stringStyle:   { backgroundColor: "#1a1b26", textColor: "#c0caf5" },
      dateStyle:     { backgroundColor: "#1a1b26", textColor: "#e0af68" },
      datetimeStyle: { backgroundColor: "#1a1b26", textColor: "#ff9e64" },
      nullStyle:     { backgroundColor: "#1a1b26", textColor: "#565f89" },
    };
  } else if (currentTheme === "classic-light") {
    colors = {
      // Day — classic light variant (the original light palette)
      headerBackgroundColor: "#d6d8e0",
      headerTextColor: "#3760bf",

      cellBackgroundColor: "#e1e2e7",
      cellTextColor: "#3760bf",
      stripeBackgroundColor: "#dadce4",

      borderColor: "#b4b5b9",
      selectionColor: "rgba(46, 125, 233, 0.18)",
      selectionBorderColor: "#2e7de9",
      hoverColor: "rgba(46, 125, 233, 0.10)",
      hoverBorderColor: "rgba(46, 125, 233, 0.45)",

      scrollbarColor: "#d6d8e0",
      scrollbarThumbColor: "#a8aecb",
      scrollbarHoverColor: "#848cb5",

      booleanStyle:  { backgroundColor: "#e1e2e7", textColor: "#2e7de9" },
      numericStyle:  { backgroundColor: "#e1e2e7", textColor: "#587539" },
      stringStyle:   { backgroundColor: "#e1e2e7", textColor: "#3760bf" },
      dateStyle:     { backgroundColor: "#e1e2e7", textColor: "#8c6c3e" },
      datetimeStyle: { backgroundColor: "#e1e2e7", textColor: "#b15c00" },
      nullStyle:     { backgroundColor: "#e1e2e7", textColor: "#848cb5" },
    };
  } else if (currentTheme === "github-light") {
    colors = {
      // GitHub Light — pre-restyle default light, kept selectable (warm neutral surfaces)
      headerBackgroundColor: "#e8e8e4",
      headerTextColor: "#3760bf",

      cellBackgroundColor: "#f5f5f3",
      cellTextColor: "#3760bf",
      stripeBackgroundColor: "#efefec",

      borderColor: "#d6d6cf",
      selectionColor: "rgba(46, 125, 233, 0.18)",
      selectionBorderColor: "#2e7de9",
      hoverColor: "rgba(46, 125, 233, 0.10)",
      hoverBorderColor: "rgba(46, 125, 233, 0.45)",

      scrollbarColor: "#e8e8e4",
      scrollbarThumbColor: "#cfcfc7",
      scrollbarHoverColor: "#aaaaa0",

      booleanStyle:  { backgroundColor: "#f5f5f3", textColor: "#2e7de9" },
      numericStyle:  { backgroundColor: "#f5f5f3", textColor: "#587539" },
      stringStyle:   { backgroundColor: "#f5f5f3", textColor: "#3760bf" },
      dateStyle:     { backgroundColor: "#f5f5f3", textColor: "#8c6c3e" },
      datetimeStyle: { backgroundColor: "#f5f5f3", textColor: "#b15c00" },
      nullStyle:     { backgroundColor: "#f5f5f3", textColor: "#848cb5" },
    };
  } else {
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

  // Cache only the default (no-override) result
  if (!theme) cachedColors = colors;
  return colors;
}

export function listenForThemeChanges(callback: (theme: SpreadsheetTheme) => void): () => void {
  let currentTheme = detectCurrentTheme();

  // Force a recompute on every event. The module-level cache invalidator
  // (installed by `installCacheInvalidation`) and this listener both watch
  // the same body-class mutation, but MutationObserver delivery order isn't
  // specified — if THIS observer fires first, `detectCurrentTheme` and
  // `getThemeColors` would still return the old cached values, which then
  // get baked into the visualizer's options and persist until the next
  // render. Nulling the caches here makes the freshness guarantee local
  // and order-independent.
  const recompute = () => {
    cachedTheme = null;
    cachedColors = null;
    const newTheme = detectCurrentTheme();
    if (newTheme !== currentTheme) {
      currentTheme = newTheme;
      callback(newTheme);
    }
  };

  const observer = new MutationObserver(recompute);

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });

  // Watch for system theme changes
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", recompute);

  return () => {
    observer.disconnect();
    mediaQuery.removeEventListener("change", recompute);
  };
}
