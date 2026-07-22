import { KOLISTAT_URL, DESKTOP_DOWNLOAD_URL, CONTACT_URL } from "../../appLinks";

/**
 * Static HTML template for the About tab — version chip, "What's new"
 * highlights for the current release, shell intro, dependency list,
 * external links, lore. Pure data with a single
 * `${version}` interpolation; kept here so the HelpPanel component
 * stays focused on lifecycle / tab switching and so release-day
 * "refresh About tab" edits don't churn the larger component file.
 *
 * The release-day checklist memory references this file: bump the
 * "What's new in 0.X" heading + bullet list each release.
 */
export function renderAboutBody(version: string): string {
  return `
      <p class="help-panel__about-version">v${version}</p>
      <p class="help-panel__about-description">Open SAS, SPSS, Stata, Parquet, Excel, CSV, TSV, and JSON files in your browser. Query them with SQL, plot with <code>VISUALIZE</code> — no install, no upload.</p>
      <div class="help-panel__about-section">
        <h3 class="help-panel__about-section-title">What's new in 0.15</h3>
        <ul class="help-panel__about-list">
          <li><strong>Charts handle 64-bit integers.</strong> <code>VISUALIZE</code> no longer crashes on <code>BIGINT</code> columns — <code>count(*)</code> bars, <code>range()</code> scatters, and friends all render.</li>
          <li><strong>Categorical axes just work.</strong> Boxplots, violins, and bars over text columns render without hand-annotating <code>:nominal</code>; explicit annotations now land on the right channel for every mark.</li>
          <li><strong>Query lifecycle fixed.</strong> Saving a query no longer swaps your editor content; drafts flush before the tab closes; on desktop, settings and saved queries survive a relaunch reliably.</li>
          <li><strong>Full export list on desktop.</strong> <code>.export</code> offers <code>xpt</code> / <code>sav</code> / <code>por</code> / <code>sas7bdat</code> alongside the text formats — stale extension caches can't hide the bundled stats_duck anymore.</li>
          <li><strong>Help, illustrated.</strong> The How-To gains a worked <code>table_one</code> example — stratify by species &times; island, ordered.</li>
        </ul>
      </div>
      <div class="help-panel__about-section">
        <h3 class="help-panel__about-section-title">Shell</h3>
        <p class="help-panel__about-shell-intro">
          Above the spreadsheet sits a command bar. Lines starting with <code>.</code> run as shell
          commands (type <code>.help</code> for the full list); anything else is executed as
          DuckDB SQL.
        </p>
      </div>
      <div class="help-panel__about-section">
        <h3 class="help-panel__about-section-title">Dependencies</h3>
        <ul class="help-panel__about-list">
          <li><a href="https://duckdb.org/docs/api/wasm/overview" target="_blank" rel="noopener noreferrer">DuckDB-WASM</a> &mdash; in-browser SQL engine.</li>
          <li><a href="https://github.com/KoliStat/the-stats-duck" target="_blank" rel="noopener noreferrer">Stats Duck</a> &mdash; DuckDB extension that adds <code>VISUALIZE … DRAW</code> and stats helpers.</li>
          <li><a href="https://codemirror.net/" target="_blank" rel="noopener noreferrer">CodeMirror 6</a> &mdash; SQL editor with autocomplete and theme-aware highlighting.</li>
          <li><a href="https://vega.github.io/vega-lite/" target="_blank" rel="noopener noreferrer">Vega-Lite</a> + <a href="https://github.com/vega/vega-embed" target="_blank" rel="noopener noreferrer">vega-embed</a> &mdash; chart rendering. Code-split: only loaded on first <code>VISUALIZE</code>.</li>
        </ul>
      </div>
      <div class="help-panel__about-links">
        <a href="https://github.com/KoliStat/bedevere-wise" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="help-panel__about-separator">·</span>
        <a href="https://github.com/KoliStat/bedevere-wise/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">Changelog</a>
        <span class="help-panel__about-separator">·</span>
        <a href="https://github.com/KoliStat/bedevere-wise/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
        <span class="help-panel__about-separator">·</span>
        <a href="${DESKTOP_DOWNLOAD_URL}" target="_blank" rel="noopener noreferrer">Download the desktop app</a>
        <span class="help-panel__about-separator">·</span>
        <a href="${CONTACT_URL}" target="_blank" rel="noopener noreferrer">Contact</a>
      </div>
      <p class="help-panel__about-author">Made by <a href="${KOLISTAT_URL}" target="_blank" rel="noopener noreferrer">KoliStat</a></p>
      <details class="help-panel__lore">
        <summary class="help-panel__lore-summary">Why a duck?</summary>
        <p class="help-panel__lore-body">
          Why is there a duck next to the name of a knight of the Round Table? Well, <i>logically</i>, you might think it's because
          the mighty DuckDB powers this application, and including references to it is wise and fair.<br>However, you would be at fault:
          the real reason for the duck is that Sir Bedevere the Wise is the one who can tell if a witch is such, thanks to just a duck.
        </p>
        <p class="help-panel__lore-body">
          <a href="https://www.youtube.com/watch?v=yp_l5ntikaU" target="_blank" rel="noopener noreferrer">https://www.youtube.com/watch?v=yp_l5ntikaU</a>
        </p>
      </details>
    `;
}
