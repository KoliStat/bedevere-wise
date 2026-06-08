import type { Backend } from "../Backend";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";

export class ParquetFormatHandler implements FormatHandler {
  canHandle(fileType: SupportedFileType): boolean {
    return fileType === "parquet";
  }

  async import(file: File, tableName: string, backend: Backend, _options?: ImportFileOptions): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    await backend.registerFileBuffer(file.name, buffer);
    await backend.executeQuery(
      `CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_parquet('${file.name}')`
    );
  }
}
