/**
 * App-shell sub-entry — the full Bedevere Wise UI (file panel, query
 * tabs, spreadsheet, chart, command bar, status bar) as composable
 * shells, with **no DuckDB-WASM dependency**.
 *
 * `BedevereApp` is backend-agnostic: you bring the engine. For the
 * in-browser default, pair this with `/duckdb`; for a native/remote
 * host, pass an `IpcBackend` (or any `Backend`). Importing this entry
 * does NOT drag the DuckDB-WASM worker `?url` chain into your bundle —
 * that's the difference from the back-compat root entry, which still
 * re-exports `/duckdb`.
 *
 *   import { BedevereApp } from "@kolistat/bedevere-wise/app";
 *   import { DuckDBService } from "@kolistat/bedevere-wise/duckdb";
 *   import "@kolistat/bedevere-wise/style.css";
 *
 *   const backend = new DuckDBService();
 *   await backend.initialize();
 *   const app = new BedevereApp(el, "1.0.0", { backend });
 *   await app.initAsync();
 *
 * The stylesheet lives in `/ui` (and `./style.css`); this entry omits
 * it so a host that already pulls the CSS (the desktop renderer imports
 * `@kolistat/bedevere-wise/style.css`) doesn't bundle it twice.
 */

// App-shell surface — top-level components that compose the standalone
// web app around an injected Backend.
export { BedevereApp } from "./components/BedevereApp/BedevereApp";
export { TabManager } from "./components/TabManager/TabManager";
export { ControlPanel } from "./components/ControlPanel/ControlPanel";
export { StatusBar } from "./components/StatusBar/StatusBar";
export { CommandBar } from "./components/CommandBar/CommandBar";

export type { BedevereAppOptions } from "./components/BedevereApp/BedevereApp";
export type { StatusBarItem } from "./components/StatusBar/StatusBar";
export type { Command } from "./data/CommandRegistry";
export type { CommandBarOptions, CellInfo } from "./components/CommandBar/CommandBar";

// PersistenceService singleton — the kv store that backs settings,
// environments, query bookmarks, and the editor autosave draft. Hosts
// that want to swap its substrate (the desktop's IpcFilesystemPersistence,
// a future server-synced backend) call `persistenceService.setBackend(...)`
// before constructing BedevereApp.
export { PersistenceService, persistenceService } from "./data/PersistenceService";
export type { AppSettings, QueryBookmark, RecentFolderEntry } from "./data/PersistenceService";
