import type { SpreadsheetTheme } from "../SpreadsheetVisualizer/utils/theme";

// Vega-Lite draws point, circle, square and tick marks at 0.7 opacity by
// default. At 0.7 the mid-tones fall under 3:1 on both Paper and Night.
// At 0.9 the faintest one, blue on Paper, is 3.11:1.
const POINT_MARK_OPACITY = 0.9;

// Fixed mid-tones after the two theme-driven slots. Paper and Night put
// blue third and rust fifth. Rust and Paper's dark duck are hard to tell
// apart with protanopia or deuteranopia, so they should not meet in a
// chart with three groups. The classic and github themes keep the
// original order. Their duck is already blue, so blue third would repeat it.
const PAPER_FAMILY_MID_TONES = ["#6b7fb3", "#4e7f71", "#c65d3b", "#9a6d9e"];
const NON_PAPER_MID_TONES = ["#c65d3b", "#4e7f71", "#6b7fb3", "#9a6d9e"];

/**
 * The Statistical-Report Vega-Lite `config` block (background, axis,
 * view…) for one theme. `read` returns a CSS custom property's value, or
 * "" when it is unset, so the values match what the spreadsheet uses.
 */
export function chartThemeConfig(theme: SpreadsheetTheme, read: (name: string) => string) {
  const isLight = theme === "light" || theme === "classic-light" || theme === "github-light";
  const isPaperFamily = theme === "light" || theme === "dark";

  return {
    background: read("--bg") || (isLight ? "#f7f5ef" : "#171511"),
    // Ramp A "Field Notes": the chart duck first (the report's marker), ink
    // second (theme-resolved via --rule), then four fixed mid-tones. On
    // Paper, --chart-duck is darker than the UI's --duck. Danger/success
    // are semantic-only.
    range: {
      category: [
        read("--chart-duck") || (theme === "light" ? "#8f6b00" : read("--duck") || "#ffd939"),
        read("--rule") || (isLight ? "#1a1917" : "#ece7da"),
        ...(isPaperFamily ? PAPER_FAMILY_MID_TONES : NON_PAPER_MID_TONES),
      ],
    },
    point: { opacity: POINT_MARK_OPACITY },
    circle: { opacity: POINT_MARK_OPACITY },
    square: { opacity: POINT_MARK_OPACITY },
    tick: { opacity: POINT_MARK_OPACITY },
    font: read("--font-mono") || "monospace",
    view: { stroke: read("--border") || "#d9d5c9" },
    axis: {
      domainColor: read("--rule") || "#1a1917",
      gridColor:   read("--border") || "#d9d5c9",
      labelColor:  read("--fg-dark") || "#3d3a33",
      titleColor:  read("--fg") || "#1a1917",
      tickColor:   read("--rule") || "#1a1917",
      labelFont:   read("--font-mono") || "monospace",
      titleFont:   read("--font-mono") || "monospace",
      // Vega-Lite's 10px default reads tiny next to the app's 11px mono
      // UI — most visibly on ordinal/nominal axes (bar / boxplot
      // category labels).
      labelFontSize: 11,
      titleFontSize: 12,
    },
    legend: {
      labelColor: read("--fg-dark") || "#3d3a33",
      titleColor: read("--fg") || "#1a1917",
      labelFont:  read("--font-mono") || "monospace",
      titleFont:  read("--font-mono") || "monospace",
      labelFontSize: 11,
      titleFontSize: 12,
    },
    // Facet headers (violin renders its categories as a `column` facet —
    // these ARE its visible x labels). Without this block Vega-Lite's
    // default near-black header text disappears on the dark themes.
    header: {
      labelColor: read("--fg-dark") || "#3d3a33",
      titleColor: read("--fg") || "#1a1917",
      labelFont:  read("--font-mono") || "monospace",
      titleFont:  read("--font-mono") || "monospace",
      labelFontSize: 11,
      titleFontSize: 12,
    },
    title: { color: read("--fg") || "#1a1917", font: read("--font-mono") || "monospace" },
  };
}
