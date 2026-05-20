// Public re-export surface. Components are imported by file path —
// the previous per-component `index.ts` barrels each re-exported a
// single sibling, which just added an indirection layer without
// grouping anything. The exception is `./data` which actively
// aggregates a dozen sibling files.

// Main components
export { BedevereApp } from "./components/BedevereApp/BedevereApp";
export { TabManager } from "./components/TabManager/TabManager";
export { ControlPanel } from "./components/ControlPanel/ControlPanel";
export { SpreadsheetVisualizer } from "./components/SpreadsheetVisualizer/SpreadsheetVisualizer";
export { ColumnStatsVisualizer } from "./components/ColumnStatsVisualizer/ColumnStatsVisualizer";
export { StatusBar } from "./components/StatusBar/StatusBar";
export { CommandBar } from "./components/CommandBar/CommandBar";

// Data types and utilities
export type { DataProvider } from "./data/types";

// Component-side types
export type { BedevereAppOptions } from "./components/BedevereApp/BedevereApp";
export type { StatusBarItem } from "./components/StatusBar/StatusBar";
export type { Command } from "./data/CommandRegistry";
export type { CommandBarOptions, CellInfo } from "./components/CommandBar/CommandBar";

// SpreadsheetVisualizer types
export type { SpreadsheetOptions } from "./components/SpreadsheetVisualizer/types";

// Import styles
import "./styles/main.scss";
