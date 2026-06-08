import type { Backend } from "./Backend";
import { DataProvider } from "./types";
import { detectFileType, getAllSupportedExtensions, SupportedFileType } from "./FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./formats/FormatHandler";
import { CsvFormatHandler } from "./formats/CsvFormatHandler";
import { JsonFormatHandler } from "./formats/JsonFormatHandler";
import { ParquetFormatHandler } from "./formats/ParquetFormatHandler";

export class FileImportService {
  private handlers: FormatHandler[] = [];
  private backend: Backend;

  constructor(backend: Backend) {
    this.backend = backend;

    // Register built-in handlers
    this.register(new CsvFormatHandler());
    this.register(new JsonFormatHandler());
    this.register(new ParquetFormatHandler());
  }

  public register(handler: FormatHandler): void {
    this.handlers.push(handler);
  }

  public canImport(fileName: string): boolean {
    const fileType = detectFileType(fileName);
    return fileType !== null && this.handlers.some((h) => h.canHandle(fileType));
  }

  public getHandler(fileType: SupportedFileType): FormatHandler | null {
    return this.handlers.find((h) => h.canHandle(fileType)) ?? null;
  }

  public async importFile(file: File, tableName?: string, options?: ImportFileOptions): Promise<DataProvider> {
    const fileType = detectFileType(file.name);
    if (!fileType) {
      throw new Error(`Unsupported file type: ${file.name}`);
    }

    const handler = this.getHandler(fileType);
    if (!handler) {
      throw new Error(`No handler registered for file type: ${fileType}`);
    }

    const preferred = tableName ?? file.name.replace(/\.[^/.]+$/, "");
    const name = await this.resolveUniqueTableName(preferred);

    await handler.import(file, name, this.backend, options);
    return this.backend.getDataProvider(name, file.name);
  }

  /**
   * Pick a DuckDB table name that doesn't clash with anything already
   * registered. Same-named files in different sub-folders (a common
   * shape in clinical-data trees) used to collide on the basename and
   * either fail or silently overwrite the earlier import; now the
   * later one becomes `<base>__2`, `<base>__3`, ...
   *
   * The user can rename via `.alias <auto-name> <preferred>` after the
   * fact (which calls DuckDB's real ALTER TABLE … RENAME, so existing
   * SQL keeps working).
   */
  private async resolveUniqueTableName(preferred: string): Promise<string> {
    const taken = new Set(await this.backend.listTables());
    if (!taken.has(preferred)) return preferred;
    let i = 2;
    while (taken.has(`${preferred}__${i}`)) i++;
    return `${preferred}__${i}`;
  }

  public async getSheetNames(file: File): Promise<string[]> {
    const fileType = detectFileType(file.name);
    if (!fileType) return [];

    const handler = this.getHandler(fileType);
    if (!handler?.getSheetNames) return [];

    return handler.getSheetNames(file, this.backend);
  }

  public getSupportedExtensions(): string[] {
    // Surface every extension the app knows about, even if the backing
    // extension (e.g. Excel, stats_duck) hasn't finished loading yet. The
    // file picker needs a stable list at open time; if a chosen format
    // isn't actually usable, the import step surfaces a clear error rather
    // than silently greying out files in the OS dialog.
    return getAllSupportedExtensions();
  }
}
