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
      <p class="help-panel__about-description">Open SAS, SPSS, Stata, Parquet, Excel, and CSV files in your browser. Query them with SQL, plot with <code>VISUALIZE</code> — no install, no upload.</p>
      <div class="help-panel__about-section">
        <h3 class="help-panel__about-section-title">What's new in 0.13</h3>
        <ul class="help-panel__about-list">
          <li><strong>Charts in <code>/embed</code>.</strong> The embed route now renders <code>VISUALIZE … DRAW</code> charts in addition to tables — same URL prefill protocol (<code>?dataset=…&amp;query=…</code>), same iframe height-report contract; chart data flows through the lazy-loaded <code>vega-embed</code> chunk so non-chart embeds stay slim.</li>
          <li><strong>NPM package split.</strong> <code>@caerbannogwhite/bedevere-wise</code> now exposes <code>/ui</code> and <code>/duckdb</code> sub-entries. UI consumers (spreadsheet, column stats, chart, slim SQL editor) can import without dragging in the DuckDB-WASM worker URL chain — works in any browser bundler, not just Vite. The root entry still re-exports both for back-compat.</li>
          <li><strong>Extractable <code>runVisualize</code> helper.</strong> The full <code>VISUALIZE … DRAW</code> pipeline (spec + layer SQL run + dataset materialization) is now a standalone helper exported from <code>/ui</code>. <code>TabManager</code> consumes it; embed consumes it; downstream tools (desktop, tflier) can drive it against their own SQL executor.</li>
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
          <li><a href="https://github.com/caerbannogwhite/the-stats-duck" target="_blank" rel="noopener noreferrer">Stats Duck</a> &mdash; DuckDB extension that adds <code>VISUALIZE … DRAW</code> and stats helpers.</li>
          <li><a href="https://codemirror.net/" target="_blank" rel="noopener noreferrer">CodeMirror 6</a> &mdash; SQL editor with autocomplete and tokyonight highlighting.</li>
          <li><a href="https://vega.github.io/vega-lite/" target="_blank" rel="noopener noreferrer">Vega-Lite</a> + <a href="https://github.com/vega/vega-embed" target="_blank" rel="noopener noreferrer">vega-embed</a> &mdash; chart rendering. Code-split: only loaded on first <code>VISUALIZE</code>.</li>
        </ul>
      </div>
      <div class="help-panel__about-links">
        <a href="https://github.com/caerbannogwhite/bedevere-wise" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span class="help-panel__about-separator">·</span>
        <a href="https://github.com/caerbannogwhite/bedevere-wise/blob/main/CHANGELOG.md" target="_blank" rel="noopener noreferrer">Changelog</a>
        <span class="help-panel__about-separator">·</span>
        <a href="https://github.com/caerbannogwhite/bedevere-wise/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
      </div>
      <p class="help-panel__about-author">Made by <a href="https://github.com/caerbannogwhite" target="_blank" rel="noopener noreferrer">caerbannogwhite</a></p>
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
