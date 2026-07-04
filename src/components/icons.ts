/**
 * Statistical-Report mono icon set — static literal SVG strings, all
 * `viewBox="0 0 16 16"`, sized via `width="1em" height="1em"` so every
 * call site keeps controlling the rendered size through its own
 * `font-size` (the usual icon-font trick, minus the font). Default
 * styling is `fill="none" stroke="currentColor" stroke-width="1.5"
 * stroke-linecap="round" stroke-linejoin="round"`, inherited by every
 * child shape; a couple of glyphs (the warning/info dot) override
 * `fill` locally where a solid shape reads better than an outline.
 *
 * Every export here is a static literal — never built from user data —
 * so assigning them via `.innerHTML` is safe.
 *
 * Internal to the component tree: not re-exported from any package
 * entry point (index.ts / app.ts / ui.ts).
 */

// ---- Chrome (chevrons, close) -----------------------------------------

/** Expand/collapse affordance (▶ replacement). Rotated 90deg via CSS
 *  when expanded — the chevron itself doesn't encode state. */
export const ICON_CHEVRON_RIGHT =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,4 10,8 6,12"/></svg>';

/** Dropdown-open affordance (▾ replacement). */
export const ICON_CHEVRON_DOWN =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,6 8,10 12,6"/></svg>';

/** Plain close/delete X (✕ replacement) — dialogs, tab close, popovers. */
export const ICON_X =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';

// ---- Status (message severities) --------------------------------------

/** Error — x-in-circle (✖ replacement). */
export const ICON_ERROR =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>';

/** Warning — alert triangle with a filled dot for the "!" (⚠ replacement). */
export const ICON_WARNING =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2 1.3 13.6h13.4z"/><path d="M8 6.6v3"/><circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none"/></svg>';

/** Success — check mark (✓ replacement). */
export const ICON_SUCCESS =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3.5,8.5 6.5,11.5 12.5,4.5"/></svg>';

/** Info — i-in-circle with a filled dot (ℹ replacement). */
export const ICON_INFO =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M8 7.2v4.1"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg>';

/** Elapsed-time clock face (⏱ replacement). */
export const ICON_CLOCK =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.8 1.7"/></svg>';

/** Map from message severity to its status icon. Shared by StatusBar's
 *  transient-message chip and MessagePopover's expanded header so the
 *  two don't carry duplicate glyph maps. */
export const MESSAGE_ICONS: Record<"error" | "warning" | "success" | "info", string> = {
  error: ICON_ERROR,
  warning: ICON_WARNING,
  success: ICON_SUCCESS,
  info: ICON_INFO,
};

// ---- Help panel callouts -----------------------------------------------

/** Padlock — "your data stays local" callout (replaces the old lock emoji). */
export const ICON_LOCK =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.25" y="7" width="9.5" height="7.25" rx="1"/><path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7"/></svg>';

/** Balance scale — "minimal dependencies" callout (replaces the old scales emoji). */
export const ICON_SCALE =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v11"/><path d="M4 13.5h8"/><path d="M2.5 4h11"/><path d="M2.5 4 0.5 7.2a2.3 2.3 0 0 0 4 0z"/><path d="M13.5 4 11.5 7.2a2.3 2.3 0 0 0 4 0z"/></svg>';

// ---- File tree (moved from ControlPanel/FileTreeRenderer.ts) ----------
// Monochrome file-type glyphs — the file tree colors them via
// `.file-tree__icon { color: var(--fg-muted) }`. The duck is the app's
// one splash of color; these stay line-art on purpose.

export const ICON_FOLDER =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5h4l1.2 1.5H14v7.5H2z"/></svg>';
export const ICON_FILE_LINES =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5l3 3v10h-8z"/><path d="M9 1.5v3h3"/><path d="M6 8.25h4"/><path d="M6 11h4"/></svg>';
export const ICON_TABLE_GRID =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10"/><path d="M2 8h12M8 3v10"/></svg>';
export const ICON_CHART =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.5h5l3 3v10h-8z"/><path d="M9 1.5v3h3"/><polyline points="6,11 8,9 10,10 12,6.5"/></svg>';

// ---- Environment switcher (moved from EnvironmentSwitcher/EnvironmentSwitcher.ts) ----

/** Monochrome globe glyph — currentColor, sized to the trigger's icon slot. */
export const ICON_GLOBE =
  '<svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><ellipse cx="8" cy="8" rx="6.5" ry="2.2"/><path d="M8 1.5v13"/></svg>';
