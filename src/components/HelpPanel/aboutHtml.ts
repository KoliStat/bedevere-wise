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
        <h3 class="help-panel__about-section-title">What's new in 0.12</h3>
        <ul class="help-panel__about-list">
          <li><strong>Environments.</strong> Opening a folder auto-creates an environment named after that folder — holding its datasets, saved queries, and open-tab state. Switch between environments from the dropdown above the file tree; the workspace restores when you switch back. Single-file drops land in a "default" env so casual imports don't bloat the list. <code>.env list | new | switch | rename | delete</code> covers the same surface from the shell.</li>
          <li><strong>SQL editor tabs.</strong> The single-document editor grew a tab strip. Each tab is a <code>.sql</code> "file" owned by the active environment; rename via double-click, close with the × on the tab, <code>Ctrl+S</code> still saves a named bookmark. Autosave (750&nbsp;ms idle) writes per-tab into the env, so reload restores exactly what was open.</li>
          <li><strong>Auto-import small files + size warnings.</strong> Drops &lt; 100&nbsp;KB import silently into DuckDB without opening a tab; larger files show a ⚠ glyph and a size label in the tree and wait for a click. Threshold is configurable in Settings (10&nbsp;KB / 100&nbsp;KB / 1&nbsp;MB / never).</li>
          <li><strong>Failed-import → text view.</strong> When a CSV / JSON / log import throws, the file opens as a read-only text tab with the DuckDB error pinned above. Binary files (PNG renamed to .csv, etc.) still surface a toast.</li>
          <li><strong>Embeddable view at <code>/embed</code>.</strong> A chromeless iframable Bedevere — pass <code>?dataset=…&amp;query=…&amp;theme=…&amp;autorun=1</code> in the URL, the iframe reports its rendered height back to the host via <code>postMessage</code>, and the host can flip the theme or trigger a re-run without reloading. Built for embedding writeups on a blog or doc site.</li>
          <li><strong>Editor resize handle + indent selector.</strong> The splitter between editor and result is now draggable; the editor toolbar carries an indent dropdown (2 / 4 spaces / Tab) that drives <code>Tab</code> behaviour.</li>
          <li><strong>Self-hosted DuckDB worker.</strong> The DuckDB-WASM worker JS now ships with the app instead of being fetched from jsDelivr — one fewer third-party runtime dependency and a reload that doesn't break when jsDelivr blips.</li>
          <li><strong>Bug-fix:</strong> <code>WITH … VISUALIZE</code> queries now route through the chart path instead of being treated as plain CTEs.</li>
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
