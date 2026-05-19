import { DuckDBService } from "../DuckDBService";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";
import { importCsvText } from "./CsvFormatHandler";
import { MultipleHtmlTablesError, parseHtmlTables, tableToCsv } from "./htmlTables";

export class HtmlFormatHandler implements FormatHandler {
  canHandle(fileType: SupportedFileType): boolean {
    return fileType === "html";
  }

  async import(
    file: File,
    tableName: string,
    duckDBService: DuckDBService,
    _options?: ImportFileOptions,
  ): Promise<void> {
    const html = await file.text();
    const tables = parseHtmlTables(html);

    if (tables.length === 0) {
      throw new Error(`No <table> found in ${file.name}.`);
    }
    if (tables.length > 1) {
      // Defer the disambiguation to the UI — the dialog catches this
      // and lets the user pick which table to import without re-parsing.
      throw new MultipleHtmlTablesError(tables, file.name);
    }

    const csvText = tableToCsv(tables[0]);
    // Mark the registered file `.csv` so the read_csv_auto path is the
    // natural fit; the name only matters as a key inside DuckDB-WASM's
    // virtual FS, never user-visible.
    await importCsvText(duckDBService, `${file.name}.csv`, csvText, tableName, {
      delimiter: ",",
      hasHeader: true,
    });
  }
}
