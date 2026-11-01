import { describe, expect, it } from "vitest";
import { compile } from "sass";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chartThemeConfig } from "../chartTheme";

// WCAG 2.1 success criterion 1.4.11: graphical objects need 3:1 against
// the colours next to them. Here that is the chart background.
const MIN_CONTRAST = 3;

// Vega-Lite draws these marks at 0.7 opacity unless the config says
// otherwise, so an unset opacity is checked at 0.7, not 1.
const POINT_LIKE_MARKS = ["point", "circle", "square", "tick"] as const;
const VEGA_LITE_DEFAULT_OPACITY = 0.7;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

// Browsers composite a translucent mark over the background in sRGB.
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c8) => {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Theme tokens as the browser resolves them. The `body` rule applies to
// every theme, and a theme's own rule overrides it. The file is read from
// disk: a `?raw` import of a stylesheet comes back empty under vitest.
const tokensPath = join(dirname(fileURLToPath(import.meta.url)), "../../../styles/_tokens.scss");
const tokensCss = compile(tokensPath).css;
const rules = [...tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(",").map((s) => s.trim()),
  decls: Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()])),
}));

function tokenReader(themeClass: string): (name: string) => string {
  const tokens: Record<string, string> = {};
  for (const rule of rules) if (rule.selectors.includes("body")) Object.assign(tokens, rule.decls);
  for (const rule of rules) if (rule.selectors.includes(`body.${themeClass}`)) Object.assign(tokens, rule.decls);
  const read = (name: string): string => {
    const value = tokens[name] ?? "";
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    return alias ? read(alias[1]) : value;
  };
  return read;
}

describe("contrast helper", () => {
  it("rates black on white at 21:1", () => {
    expect(contrast(parseHex("#000000"), parseHex("#ffffff"))).toBeCloseTo(21, 5);
  });
});

describe("chart category colours", () => {
  it.each([
    ["Paper", "light", "theme-light"],
    ["Night", "dark", "theme-dark"],
  ] as const)("hold 3:1 against the %s background as drawn", (_label, theme, themeClass) => {
    const read = tokenReader(themeClass);
    // Without these the config falls back to built-in colours, and the
    // check would pass without ever looking at the theme.
    for (const token of ["--bg", "--chart-duck", "--rule"]) expect(read(token), token).toMatch(/^#[0-9a-f]{6}$/i);
    const config = chartThemeConfig(theme, read) as Record<string, any>;
    const bg = parseHex(config.background);
    const failures: string[] = [];
    for (const mark of POINT_LIKE_MARKS) {
      const opacity: number = config[mark]?.opacity ?? VEGA_LITE_DEFAULT_OPACITY;
      for (const colour of config.range.category as string[]) {
        const ratio = contrast(blend(parseHex(colour), bg, opacity), bg);
        if (ratio < MIN_CONTRAST) failures.push(`${mark} ${colour} at ${opacity}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });
});
