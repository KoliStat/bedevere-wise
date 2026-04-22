import "./styles/main.scss";
import { BedevereApp } from "./components/BedevereApp";
import { duckDBService } from "./data/DuckDBService.ts";
import { persistenceService } from "./data/PersistenceService.ts";
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_DATETIME_FORMAT,
  DEFAULT_MIN_CELL_WIDTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_NUMBER_FORMAT,
} from "./components/SpreadsheetVisualizer/defaults.ts";

// Initialize the Bedevere Wise application
async function initApplication() {
  // WebGL exploratory spike — reachable via `?webgl-spike` in the URL.
  // Hands the page over to the spike entry; never returns. Lives outside
  // the normal app boot to keep its experimental nature explicit.
  if (typeof location !== "undefined" && location.search.includes("webgl-spike")) {
    const { runWebGLSpike } = await import("./webgl-spike");
    const host = document.getElementById("app") || document.body;
    host.innerHTML = "";
    await runWebGLSpike(host);
    return;
  }

  const debugMode = true;
  const appVersion = "0.7-son-of-uther-pendragon";

  // Initialize DuckDB first
  try {
    await duckDBService.initialize();
    console.log("DuckDB initialized successfully");
  } catch (error) {
    console.error("Failed to initialize DuckDB:", error);
    // Continue without DuckDB if initialization fails
  }

  const appContainer = document.getElementById("app") || document.body;

  // Clear existing content
  appContainer.innerHTML = "";

  const persistedSettings = persistenceService.loadAppSettings();

  // Create the Bedevere Wise application
  const app = new BedevereApp(appContainer, duckDBService, appVersion, {
    theme: "auto", // Automatically detect user's preferred theme
    // theme: "light",
    showLeftPanel: true,
    statusBarVisible: true,
    commandPaletteEnabled: true,
    spreadsheetOptions: {
      minHeight: 400,
      minWidth: 600,
      minCellWidth: persistedSettings.minCellWidth ?? DEFAULT_MIN_CELL_WIDTH,
      maxStringLength: persistedSettings.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
      dateFormat: persistedSettings.dateFormat ?? DEFAULT_DATE_FORMAT,
      datetimeFormat: persistedSettings.datetimeFormat ?? DEFAULT_DATETIME_FORMAT,
      numberFormat: {
        minimumFractionDigits: persistedSettings.numberMinDecimals ?? DEFAULT_NUMBER_FORMAT.minimumFractionDigits,
        maximumFractionDigits: persistedSettings.numberMaxDecimals ?? DEFAULT_NUMBER_FORMAT.maximumFractionDigits,
        useGrouping: persistedSettings.numberUseGrouping ?? true,
      },
    },
    debugMode: false,
  });

  // Restore persisted state (views, settings)
  await app.initAsync();

  app.showMessage("Drop a file or open a folder to get started", "info");

  // Make app and duckDBService globally available for debugging
  if (debugMode) {
    (window as any).bedevereApp = app;
    (window as any).duckDBService = duckDBService;

    console.log("Bedevere Wise initialized");
    console.log("- Press Ctrl+P to open the command palette");
    console.log("- Press F11 to toggle fullscreen");
    console.log("- Access 'bedevereApp' from the console for debugging");
    console.log("- Access 'duckDBService' from the console for database operations");
  }
}

// Start the application
initApplication().catch(console.error);
