import "../styles/main.scss";
import "../styles/embed.scss";
import { duckDBService } from "../data/DuckDBService";
import { DuckDBExtensionLoader } from "../data/DuckDBExtensionLoader";
import { resolveStatsDuckUrl } from "../data/statsDuckUrl";
import { EmbedApp } from "./EmbedApp";
import { parseEmbedConfig } from "./embedConfig";
import { applyTheme, resolveTheme } from "./embedTheme";

/**
 * Bootstrap for the /embed route. Mirrors src/main.ts's responsibilities
 * (parse settings, init DuckDB, mount the UI) without the heavy
 * BedevereApp surface — no left panel, no tab manager, no help panel.
 */
async function initEmbed(): Promise<void> {
  const config = parseEmbedConfig(window.location.search);

  // Apply theme synchronously before DuckDB init so the loading state
  // matches the eventual UI. Avoids a dark→light (or vice versa) flash.
  applyTheme(resolveTheme(config.theme));

  const root = document.getElementById("embed-root");
  if (!root) {
    console.error("/embed: missing #embed-root mount node");
    return;
  }

  try {
    await duckDBService.initialize();
  } catch (err) {
    console.error("/embed: DuckDB initialize failed", err);
    root.textContent = "";
    const banner = document.createElement("div");
    banner.className = "embed-result__error";
    banner.style.padding = "12px";
    banner.textContent = "Failed to initialize DuckDB-WASM. See browser console for details.";
    root.appendChild(banner);
    return;
  }

  // Load stats_duck so the ggsql `VISUALIZE` parser and the stats table
  // functions (meta / lm / lm_summary / bootstrap / table_one / distributions)
  // are available — the main app does this in BedevereApp.initAsync; the embed
  // must too, or every stats_duck call is a "function does not exist" catalog
  // error. Eager (before EmbedApp.bootstrap → autorun) so a ?query= using
  // VISUALIZE or a stats function works on first run. Non-fatal: plain SQL
  // still runs if it fails. Served same-origin in production; the browser
  // caches the WASM across iframes after the first load.
  const statsDuckUrl = resolveStatsDuckUrl();
  const statsDuckOk = await new DuckDBExtensionLoader(duckDBService).tryLoad("stats_duck", statsDuckUrl);
  if (!statsDuckOk) {
    console.warn(`/embed: stats_duck failed to load from ${statsDuckUrl} — VISUALIZE and stats functions are unavailable.`);
  }

  const app = new EmbedApp(root, { duck: duckDBService, config });
  await app.bootstrap();

  if (import.meta.env.DEV) {
    (window as unknown as { embedApp?: EmbedApp }).embedApp = app;
    (window as unknown as { duckDBService?: typeof duckDBService }).duckDBService = duckDBService;
  }
}

initEmbed().catch((err) => {
  console.error("/embed bootstrap failed:", err);
});
