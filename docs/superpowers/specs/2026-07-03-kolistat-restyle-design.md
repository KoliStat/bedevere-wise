# KoliStat "Statistical Report" restyle — design

**Date**: 2026-07-03
**Branch**: `feature/kolistat-restyle` (off `dev-0.14`; targets the post-0.14 cycle)
**Status**: approved (direction mockup + chart ramp validated in visual-companion session; theme model and design sections approved in terminal)
**Reference**: kolistat.com redesign — `~/source/repos/kolistat/website/src/styles/{tokens,typography,components}.css` (uncommitted; token values copied verbatim below so this spec stands alone)

## Goal

Move Bedevere visually into kolistat.com's "statistical report" identity —
warm paper surfaces, ink text, booktabs rules instead of boxes, IBM Plex
Mono apparatus, Source Serif 4 seasoning, duck yellow `#ffd939` as the only
accent — so embeds framed inside kolistat.com (homepage Table 1 swap-in,
blog figures) read as kin to the page around them.

**This is a restyle only.** No functional changes; `/embed` URL-param and
postMessage contracts frozen (additive theme values excepted); npm
component API unchanged; nothing web-only that would break the WebView2
desktop host (desktop renders the same bundle and inherits everything).
Bedevere's own brand (name, knight, logo) stays.

## 1. Theme architecture (approved)

Two-axis model replacing the flat 4-theme list:

- **Palette family**: `paper` (default) | `tokyonight` | `github`
- **Mode**: `light` | `dark` | `auto` (auto follows OS, as today)

Six concrete palettes:

| family | light | dark |
|---|---|---|
| paper *(new, default)* | Paper (kolistat light) | Night (kolistat dark) |
| tokyonight | Day (today's `classic-light`) | Storm (today's `classic-dark`) |
| github | today's warm-neutral `light` | today's GitHub-Dark `dark` |

**Resolved body classes stay flat** (exactly one applied, exclusive):
`theme-light` / `theme-dark` = the *default family* → now Paper/Night;
`theme-classic-light` / `theme-classic-dark` = Tokyonight;
`theme-github-light` / `theme-github-dark` = new. `ResolvedTheme` grows to
six values; `applyThemeClasses` clears all six variants.

**Back-compat:**
- `/embed` `theme` param: all old values (`light|dark|classic-light|classic-dark|auto`)
  stay valid — `light`/`dark` now *render* Paper/Night (intended: blog
  embeds get the kolistat look with zero URL changes). `github-light` /
  `github-dark` are additive new values.
- Persisted settings: legacy `theme: light|dark|auto` → Paper family, mode
  preserved (users ride the restyle). Legacy `classic-*` → Tokyonight
  (explicit opt-out honored). Github look = explicit reselect in Settings.
- Settings UI: the Theme row becomes two segmented controls — Family
  (`Paper · Tokyonight · Github`) and Mode (`Light · Dark · Auto`).
- `.theme` command: keeps accepting all old values; adds the three family
  names (family switch preserves mode; old resolved values set both).

## 2. Token system — one structure, three families

`src/styles/_tokens.scss` keeps its existing ~40 token *names* (every
component keeps consuming the same `var()`s — the website used the same
trick). Changes:

1. **Two new palette blocks** (Paper light + Night) with the kolistat
   values, mapped into Bedevere's token vocabulary:

   Paper (light): bg `#f7f5ef` · surface `#fffef9` · raised `#efece1` ·
   text `#1a1917` · muted `#5f5c54` · hairline `#d9d5c9` · border-strong
   `#b8b3a3` · rule `#1a1917` · duck `#ffd939` · duck-ink `#1a1917` ·
   selection tint `rgba(255,217,57,.4)` · danger `#9e2b25` · success `#1e6b46`

   Night (dark): bg `#171511` · surface `#201d16` · raised `#29251c` ·
   text `#ece7da` · muted `#a49e8e` · hairline `#35322a` · border-strong
   `#4d483c` · rule `#ece7da` · duck `#ffd939` · duck-ink `#1a1917` ·
   selection tint `rgba(255,217,57,.22)` · danger `#e08573` · success `#7cc8a0`

2. **New structural tokens defined in ALL SIX palettes** — `--rule`
   (booktabs heavy), `--duck`, `--duck-ink`, `--sel-tint`, `--accent`,
   `--accent-text`. Paper binds them to ink/yellow; Tokyonight and Github
   alias them to their existing blues/accents. Component CSS is restyled
   *once* against these tokens and every family gets the new structure in
   its own colors — no per-family CSS forks.

3. WCAG AA holds for text pairs (muted-on-paper ≈ 4.6:1, ink-on-duck ≈ 12:1);
   chart marks ≥ 3:1 non-text contrast on both grounds.

## 3. Structure sweep (the laws)

- **Radius 0 everywhere.** Stragglers from the inventory: `help-panel.scss:797`
  (2px), `spreadsheet-visualizer.scss:136` (2px), `embed.scss:94` (3px run
  button), `environment-switcher.scss:106` (50% dot → square). Exception:
  loading *spinners* stay round (motion, not chrome).
- **No drop shadows.** Every dialog/menu/popover `box-shadow` (help-panel,
  hide-columns, html-paste, save-query, embed-builder dialogs; context-menu;
  message-popover; desktop-hint; command-bar; chart action menu;
  environment-switcher) → flat `1px solid var(--rule)` border on
  `--surface`. The spreadsheet column-drop glow/indicator loses its blur.
- **Rules carry hierarchy**: 3px heavy rule under the toolbar / panel heads;
  hairlines between rows/panels.
- **Tabs**: active tab (both tab bars) = duck chip with ink text, replacing
  the blue inset box-shadow. Inactive = muted text + hairline separators.
- **Buttons**: mono, small, uppercase, letterspaced (`.08em`-ish). Primary =
  ink fill with paper text (`--accent`/`--accent-text`); the Run/execute
  action = the one duck-yellow fill with ink text and 1.5px rule border.
- **Scrollbars**: square (already), no buttons (already); thumb
  `--border-strong` on `--surface-raised` track — matches the website's
  code-block scrollbars so embeds read seamless.
- **Focus**: `outline: 2px solid var(--rule); outline-offset: 2px` on
  `:focus-visible`. **Selection**: `::selection` = `--sel-tint`.
- **Spreadsheet grid goes booktabs** (canvas-rendered → lands in
  `SpreadsheetVisualizer/utils/theme.ts` palette values): heavy rule above
  the header row, light rule under it, hairline row separators, heavy rule
  at the grid's bottom edge, **vertical gridlines transparent** in the Paper
  family. If the canvas renderer hardcodes vertical lines without a color
  hook, it gets a minimal color-plumbing tweak (visual-only). Hover = faint
  yellow wash; selected row/cell = `--sel-tint`. Numeric columns already
  right-aligned; keep density as-is.

## 4. Fonts

- Add `@fontsource/ibm-plex-mono` (400, 600) and `@fontsource/source-serif-4`
  (400, 400-italic, 600). Imported in the app entry and the embed entry —
  self-hosted, bundled by Vite, WebView2-safe, no runtime dependency on
  kolistat.com.
- `--font-mono`: IBM Plex Mono first, current stack behind it. Chrome, data,
  and the editor are mono-first (largely true today).
- `--font-sans` **becomes the serif stack** (`'Source Serif 4', Iowan Old
  Style, Georgia, serif`) — the website's rename-nothing trick. Chrome that
  wrongly consumes it (context menu) switches to `--font-mono` explicitly,
  so serif lands only where prose lives: dialog titles, empty states,
  onboarding copy, help-panel body. Serif is seasoning, not the base.
- `embed.scss:48` hardcoded `Consolas` fallback → `var(--font-mono)`.

## 5. Charts (ggsql → Vega-Lite) — Ramp A "Field Notes" (approved)

`ChartVisualizer.applyTheme` additions:

- `range.category` = `[#ffd939, <ink>, #c65d3b, #4e7f71, #6b7fb3, #9a6d9e]`
  where `<ink>` is theme-resolved (`#1a1917` paper / `#ece7da` night —
  read from computed `--fg` like the rest of the config). Series 1 = duck
  (the report's marker), series 2 = ink.
- Axis/legend/title text → Plex Mono (`--font-mono`), labels ink, grid
  hairline (`--border`), domain/ticks ink, background transparent (inherits
  paper/night). Ordinal/sequential ranges derive duck→ink.
- The 7 hardcoded fallback hexes update to Paper values.
- Danger/success stay reserved for semantic UI — never data series.

## 6. Remaining JS/HTML surfaces (from the inventory)

- `SpreadsheetVisualizer/utils/theme.ts`: two new palette blocks (paper,
  night) + booktabs line treatment (§3); keep the existing four in their
  slots per §1 naming.
- `index.html` + `embed.html` inline loading screens → paper-aware (paper
  default, night via `prefers-color-scheme` / `data-theme`), spinner accent
  → duck.
- `ExportHub.ts:103` HTML-export header `#f2f2f2` → the paper-raised
  literal `#efece1` (exported HTML is standalone — it can't consume app
  `var()`s, so a literal is correct; documented as a deliberate hardcode).
- `/embed`: run button → duck fill; toolbar/error state on tokens
  (`--danger`); highest-priority surface — must read native framed on a
  `#f7f5ef` page next to a booktabs table.
- `embedTheme.ts` + `themeClasses.ts`: six-variant exclusive application.

## 7. Contracts frozen

No functional changes. `/embed` params + postMessage untouched (additive
`github-*` theme values only). npm component API unchanged. No web-only
additions. Light/dark/auto switching mechanism stays. Brand stays.

## 8. Verify battery

- Run app + `/embed` in both Paper modes (plus spot-check Tokyonight/Github
  inherit structure sanely); screenshots: shell, results grid, chart, dialog.
- `/embed` with a live penguins query framed on a `#f7f5ef` test page beside
  a booktabs-styled HTML table (extend `testfiles/embed-harness.html`) —
  the kinship check.
- Grep for orphaned old-palette hexes; grep confirms no new hardcoded colors
  outside `_tokens.scss` / `theme.ts` / documented fallbacks.
- `tsc --noEmit`, lint, `bun run build`, `bun run test:run` clean; tests
  updated: `themeClasses.test.ts` (6 variants), HelpPanel settings options,
  embed theme param parsing.
- Diff audit: styling/theme/font files + the minimal canvas color plumbing
  only.

## 9. Execution phases (each leaves the app working)

1. **Theme model**: two-axis settings + 6-way `ResolvedTheme` +
   `applyThemeClasses`/`embedTheme` + Settings UI + `.theme` command +
   migration + Paper palettes in `_tokens.scss` (values only, structure
   untouched). App runs Paper-by-default with old structure.
2. **Structure sweep**: radius/shadows/rules/tabs/buttons/scrollbars/
   focus/selection across the ~20 component scss files, on the new
   structural tokens.
3. **Fonts**: @fontsource packages + stack swaps + serif seasoning.
4. **JS surfaces**: spreadsheet `theme.ts` palettes + booktabs, chart config
   + Ramp A, loading screens, ExportHub.
5. **Verify battery** (§8) + screenshots.
