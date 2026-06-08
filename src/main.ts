import "./styles/main.scss";
import { BedevereApp } from "./components/BedevereApp/BedevereApp";
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
  const debugMode = import.meta.env.DEV;
  const appVersion = "0.13-i-am";

  // Initialize DuckDB first
  try {
    await duckDBService.initialize();
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
    console.log("- Press F11 to toggle fullscreen");
    console.log("- Access 'bedevereApp' from the console for debugging");
    console.log("- Access 'duckDBService' from the console for database operations");
  }
}

// Start the application
initApplication().catch(console.error);
