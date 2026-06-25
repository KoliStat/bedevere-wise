import { afterEach, describe, expect, it } from "vitest";
import { applyThemeClasses } from "../themeClasses";

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
