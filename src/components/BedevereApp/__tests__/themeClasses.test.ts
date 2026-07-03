import { afterEach, describe, expect, it } from "vitest";
import {
  applyThemeClasses,
  resolveThemeVariant,
  splitResolvedTheme,
  themeSelectionFromLegacy,
  themeSelectionFromSettings,
  type ResolvedTheme,
} from "../themeClasses";

/**
 * Regression coverage for the desktop "everything stays dark except the
 * spreadsheet" theme bug.
 *
 * The desktop renderer hardcodes `<body class="theme-dark">` for first-paint
 * FOUC prevention. The original BedevereApp.setupTheme/setTheme only *added*
 * the active `theme-*` class, so that hardcoded class lingered: the SCSS
 * cascade (theme-dark is last in _tokens.scss, so it wins ties) kept every
 * CSS-driven component dark, while the spreadsheet's own JS detector (checks
 * theme-light first) followed the real selection — the two halves of the UI
 * visibly disagreed.
 *
 * applyThemeClasses must therefore be *exclusive*: exactly one theme class on
 * the body and one on the app container after every call.
 */
describe("applyThemeClasses", () => {
  afterEach(() => {
    document.body.className = "";
  });

  const container = (): HTMLElement => {
    const el = document.createElement("div");
    el.className = "bedevere-app";
    return el;
  };

  const bodyThemeClasses = (): string[] =>
    [...document.body.classList].filter((c) => c.startsWith("theme-"));
  const appThemeClasses = (el: HTMLElement): string[] =>
    [...el.classList].filter((c) => c.startsWith("bedevere-app--"));

  it("clears a foreign hardcoded body theme class (the desktop bug)", () => {
    document.body.className = "theme-dark"; // renderer/index.html FOUC class
    const el = container();

    applyThemeClasses(el, "light");

    expect(bodyThemeClasses()).toEqual(["theme-light"]);
    expect(appThemeClasses(el)).toEqual(["bedevere-app--light"]);
  });

  it("leaves exactly one theme class after switching", () => {
    const el = container();

    applyThemeClasses(el, "dark");
    applyThemeClasses(el, "classic-light");

    expect(bodyThemeClasses()).toEqual(["theme-classic-light"]);
    expect(appThemeClasses(el)).toEqual(["bedevere-app--classic-light"]);
  });

  it("preserves non-theme classes on body and container", () => {
    document.body.className = "theme-dark host-class";
    const el = container();

    applyThemeClasses(el, "light");

    expect(document.body.classList.contains("host-class")).toBe(true);
    expect(el.classList.contains("bedevere-app")).toBe(true);
  });
});

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
