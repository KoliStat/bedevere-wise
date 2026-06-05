/**
 * Combined entry — re-exports `./ui` and `./duckdb` for back-compat.
 *
 * New code should prefer the sub-entry imports so non-Vite bundlers
 * and non-DuckDB consumers don't drag in the worker URL chain:
 *
 *   import { SpreadsheetVisualizer } from "@caerbannogwhite/bedevere-wise/ui";
 *   import { DuckDBService }         from "@caerbannogwhite/bedevere-wise/duckdb";
 *
 * The root entry stays around so `import { ... } from
 * "@caerbannogwhite/bedevere-wise"` keeps working. The UI tier
 * carries the SCSS import; importing only the root or `/ui` brings
 * the stylesheet, importing only `/duckdb` does not.
 */

export * from "./ui";
export * from "./duckdb";

// App-shell surface (top-level components composing the standalone
// web app). Kept for completeness; the embedding contract is the
// `./ui` + `./duckdb` tiers above. See README.
export { BedevereApp } from "./components/BedevereApp/BedevereApp";
export { TabManager } from "./components/TabManager/TabManager";
export { ControlPanel } from "./components/ControlPanel/ControlPanel";
export { StatusBar } from "./components/StatusBar/StatusBar";
export { CommandBar } from "./components/CommandBar/CommandBar";

export type { BedevereAppOptions } from "./components/BedevereApp/BedevereApp";
export type { StatusBarItem } from "./components/StatusBar/StatusBar";
export type { Command } from "./data/CommandRegistry";
export type { CommandBarOptions, CellInfo } from "./components/CommandBar/CommandBar";
