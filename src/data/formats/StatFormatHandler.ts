import type { Backend } from "../Backend";
import { DuckDBExtensionLoader } from "../DuckDBExtensionLoader";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";

export class StatFormatHandler implements FormatHandler {
  private extensionLoader: DuckDBExtensionLoader | null;

  constructor(extensionLoader: DuckDBExtensionLoader | null) {
    this.extensionLoader = extensionLoader;
  }

  canHandle(fileType: SupportedFileType): boolean {
    const statTypes: SupportedFileType[] = ["sas7bdat", "xpt", "sav", "dta"];
    // DuckDB-WASM gates on the loaded extension; an IPC backend (loader
    // null) defers to the host's native read_stat — stats_duck is loaded
    // host-side, so assume it's available and let import surface any error.
    return statTypes.includes(fileType) && (this.extensionLoader?.isLoaded("stats_duck") ?? true);
  }

  async import(file: File, tableName: string, backend: Backend, _options?: ImportFileOptions): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const effectiveName = (await backend.registerFileBuffer(file.name, buffer)) ?? file.name;

    await backend.executeQuery(
      `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_stat('${effectiveName.replace(/'/g, "''")}')`
    );
  }
}
