/**
 * Combined (back-compat) entry — re-exports every sub-entry so
 * `import { ... } from "@kolistat/bedevere-wise"` keeps working.
 *
 * Prefer the sub-entries; they let non-Vite bundlers and non-DuckDB
 * consumers avoid the worker `?url` chain:
 *
 *   import { SpreadsheetVisualizer } from "@kolistat/bedevere-wise/ui";    // components, no WASM
 *   import { BedevereApp }          from "@kolistat/bedevere-wise/app";   // app shell, BYO backend, no WASM
 *   import { DuckDBService }        from "@kolistat/bedevere-wise/duckdb"; // in-browser engine (pulls WASM)
 *
 * This root entry re-exports `/duckdb`, so importing anything from it
 * pulls the DuckDB-WASM worker chain into your bundle. A host that
 * brings its own backend (the desktop, a remote relay) should import
 * `BedevereApp` from `/app` instead to keep DuckDB-WASM out.
 *
 * The stylesheet rides along with the `/ui` tier, so importing the root
 * (which re-exports `/ui`) brings the CSS. `/app` deliberately omits it
 * (see its docblock) — app-shell hosts import `./style.css` explicitly.
 */

export * from "./ui";
export * from "./duckdb";
export * from "./app";
