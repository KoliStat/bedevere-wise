/**
 * Static HTML template for the About tab — version chip, "What's new"
 * highlights for the current release, shell intro, dependency list,
 * external links, lore, attribution. Pure data with a single
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
        <h3 class="help-panel__about-section-title">What's new in 0.11</h3>
        <ul class="help-panel__about-list">
          <li>The <strong>SQL editor autosaves</strong> while you type and restores the draft on reload. Press <code>Ctrl+S</code> to save the current query as a named bookmark; <code>Ctrl+F</code> opens an in-editor find panel.</li>
          <li><em>(preview)</em> <strong>Import HTML tables</strong> from the clipboard (<code>.paste</code>) or from a saved <code>.html</code> file — multi-table pages open a picker; image-only cells (e.g. flag icons) fall back to the <code>alt</code> attribute or the <code>src</code> basename so a column of icons still carries data.</li>
          <li><em>(preview)</em> <strong>Fetch remote files by URL</strong> (<code>.fetch &lt;url&gt;</code>) — CSV / JSON / Parquet / HTML routed through the same handlers as local files. CORS-blocked sources surface a clear "save and drag it in" hint.</li>
          <li><strong>Drag-to-reorder columns</strong> in the spreadsheet header; the order persists per dataset alongside hide / sort / filter.</li>
          <li><strong>Click-to-copy</strong> on the column-stats panel — clicking the column name or any categorical histogram value copies it to the clipboard with a brief flash.</li>
          <li><strong>Ctrl+C respects text selections outside the spreadsheet</strong> — drag-select text in the column-stats panel, status bar, help panel, etc. and Ctrl+C copies that instead of the spreadsheet cells.</li>
          <li>Dirty CSV / Excel imports recover gracefully — full-file type detection and an <code>ignore_errors</code> fallback handle stray non-numeric values that used to abort the whole import.</li>
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
      <p class="help-panel__attribution">
        Duck icons created by <a href="https://www.flaticon.com/free-icons/duck" target="_blank" rel="noopener noreferrer" title="duck icons">Marz Gallery &mdash; Flaticon</a>.
      </p>
    `;
}
