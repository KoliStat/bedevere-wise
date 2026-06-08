import type { Backend } from "../Backend";
import { quoteIdent } from "../sqlIdent";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";

export class JsonFormatHandler implements FormatHandler {
  canHandle(fileType: SupportedFileType): boolean {
    return fileType === "json";
  }

  async import(file: File, tableName: string, backend: Backend, _options?: ImportFileOptions): Promise<void> {
    const text = await file.text();
    await backend.registerFileText(file.name, text);
    // `read_json_auto` is engine-portable across Backend impls (DuckDB-WASM
    // + native DuckDB both have it). Earlier this used DuckDB-WASM's
    // `connection.insertJSONFromPath` path which doesn't work over IPC.
    const virtualPath = file.name.replace(/'/g, "''");
    await backend.executeQuery(
      `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_json_auto('${virtualPath}')`,
    );
  }
}
