# Bedevere Wise

**Open SAS, SPSS, Stata, Parquet, and Excel files in your browser. Query them with SQL — no install, no upload.**

Drop a `.sas7bdat`, `.sav`, `.dta`, `.xpt`, `.parquet`, `.xlsx`, `.csv`, or `.tsv` and start querying. Runs entirely in your browser via [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) — your data rows never leave your machine. (Optional AI features, when enabled, send your prompt and dataset *schema* to the LLM provider you configure — your row data still stays local.)

[**Live app · bedeverewise.app**](https://bedeverewise.app/) · [Changelog](CHANGELOG.md)

## Screenshots

<p align="center">
  <img src="docs/media/light.png" alt="Bedevere Wise — light theme" width="48%" />
  <img src="docs/media/dark.png"  alt="Bedevere Wise — dark theme"  width="48%" />
</p>

## Why this exists

Most SQL clients (DBeaver, TablePlus, DataGrip) speak to database servers and won't open `.sas7bdat`. Most "open my SAS file" tools (the SAS Universal Viewer, IBM SPSS Statistics) are vendor-locked desktop apps without SQL. Pandas can do it but needs a Python install plus boilerplate per file. Bedevere Wise sits in the gap: drop the file, get a spreadsheet view, and run SQL against it in seconds.

## Features

- **Stats-software file formats** — `.sas7bdat`, `.sav` (SPSS), `.dta` (Stata), `.xpt` (SAS Transport)
- **General data formats** — CSV, TSV, JSON, Parquet, Excel (.xlsx / .xls)
- **SQL editor** — CodeMirror 6 with schema-aware autocomplete; results open in their own tabs
- **Inline column statistics** — per-type summaries, histograms, and value filters next to the table
- **High-performance grid** — canvas-rendered, virtually scrolled, HiDPI-sharp
- **Dot-command shell** — `.import`, `.open`, `.export`, `.tables`, `.columns`, `.help`, plus argument autocomplete
- **Persistent workspace** — saved queries and settings survive page reloads
- **Fully client-side** — no server, no uploads; data rows stay in your browser. AI features are opt-in and only send prompt + schema (never row data) to the provider you configure.

## License

MIT — see [LICENSE](LICENSE) for details.
