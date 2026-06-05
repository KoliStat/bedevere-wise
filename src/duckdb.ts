/**
 * DuckDB-WASM sub-entry.
 *
 * Imports DuckDB-WASM and its worker URLs (Vite `?url` syntax). Use
 * this only if your bundler can resolve those imports — Vite
 * out-of-the-box, webpack 5 with `asset/resource`. Bun bundler /
 * esbuild / Parcel need explicit plugin configuration.
 *
 * If your stack can't handle the worker imports, implement your own
 * `DataProvider` against a different backend (HTTP API, IPC channel,
 * native process) and skip this entry entirely.
 *
 *   import { DuckDBService, DuckDBDataProvider } from
 *     "@caerbannogwhite/bedevere-wise/duckdb";
 */

export { DuckDBService } from "./data/DuckDBService";
export { DuckDBDataProvider } from "./data/DuckDBDataProvider";
