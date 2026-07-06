import type { Backend } from "../Backend";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";
import { quoteIdent } from "../sqlIdent";

export class ParquetFormatHandler implements FormatHandler {
  canHandle(fileType: SupportedFileType): boolean {
    return fileType === "parquet";
  }

  async import(file: File, tableName: string, backend: Backend, _options?: ImportFileOptions): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const effectiveName = (await backend.registerFileBuffer(file.name, buffer)) ?? file.name;
    await backend.executeQuery(
      `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_parquet('${effectiveName.replace(/'/g, "''")}')`
    );
  }
}
