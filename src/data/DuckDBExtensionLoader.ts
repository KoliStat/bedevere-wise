// Types only: the loader runs `INSTALL`/`LOAD` via `executeQuery`, which is
// a Backend method. Typing against the Backend interface (not DuckDBService)
// keeps the DuckDB-WASM worker chain out of the static graph of anything
// that imports the loader (e.g. BedevereApp). Construction is still gated on
// `backend.id === "duckdb-wasm"` by the caller, since INSTALL FROM URL is a
// WASM-only concept.
import type { Backend } from "./Backend";

export class DuckDBExtensionLoader {
  private loaded: Set<string> = new Set();
  private backend: Backend;
  private customRepository?: string;

  constructor(backend: Backend, customRepository?: string) {
    this.backend = backend;
    this.customRepository = customRepository;
  }

  /**
   * Try to install and load a DuckDB extension.
   * Returns true if the extension loaded successfully, false otherwise.
   * Failures are silent — the extension is simply marked as unavailable.
   */
  /**
   * Try to install and load a DuckDB extension.
   * @param probeQueries Optional SQL queries to verify functions work (catches WASM runtime errors)
   */
  public async tryLoad(name: string, source?: string, probeQueries?: string[]): Promise<boolean> {
    try {
      // If a custom repository is configured, set it before installing
      if (this.customRepository && !source) {
        await this.backend.executeQuery(
          `SET custom_extension_repository = '${this.customRepository}'`
        );
      }

      const installCmd = source
        ? `INSTALL ${name} FROM '${source}'`
        : `INSTALL ${name}`;
      await this.backend.executeQuery(installCmd);
      await this.backend.executeQuery(`LOAD ${name}`);
      this.loaded.add(name);

      if (import.meta.env.DEV) {
        console.log(`DuckDB extension "${name}" loaded`);
      }

      // Run smoke tests for known-problematic functions.
      // SQL-level errors (file not found, etc.) are expected and fine.
      // WASM runtime errors (signature mismatch, memory OOB) mean the
      // function is compiled incorrectly and the extension is unusable.
      if (probeQueries) {
        for (const probe of probeQueries) {
          try {
            await this.backend.executeQuery(probe);
          } catch (probeError) {
            const msg = probeError instanceof Error ? probeError.message : String(probeError);
            const isWasmCrash =
              msg.includes("signature mismatch") ||
              msg.includes("memory access out of bounds") ||
              msg.includes("RuntimeError") ||
              msg.includes("unreachable");
            if (isWasmCrash) {
              console.warn(`DuckDB extension "${name}" loaded but functions crash in WASM — disabling`);
              this.loaded.delete(name);
              return false;
            }
            // SQL-level error (e.g. "file not found") is expected — probe passes
          }
        }
      }

      return true;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.log(`DuckDB extension "${name}" not available in WASM environment`);
      }
      return false;
    }
  }

  public isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  public getLoadedExtensions(): string[] {
    return Array.from(this.loaded);
  }
}
