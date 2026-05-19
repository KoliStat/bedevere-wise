import { DuckDBService } from "../DuckDBService";
import { SupportedFileType } from "../FileTreeTypes";
import { quoteIdent } from "../sqlIdent";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";

/**
 * Quote a string literal for safe interpolation into a SQL statement.
 * Single quotes are doubled per the SQL standard; we control the inputs
 * (registered filename + caller-chosen delimiter) but defensive quoting
 * keeps the code resilient to filenames with apostrophes etc.
 */
function quoteLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Resilient CSV-text → table import. Used by `CsvFormatHandler` for
 * actual `.csv` / `.tsv` files and by the HTML / URL ingestion paths
 * once they've produced a CSV string. We bypass
 * `connection.insertCSVFromPath` because its options surface doesn't
 * expose `sample_size`, `ignore_errors`, or `all_varchar` — exactly
 * the levers needed when DuckDB's default 20480-row type-detection
 * sample picks too-narrow a type for a column whose oddball values
 * appear later in the file (e.g. CDBRFS90.csv's WINDDOWN column,
 * inferred as BIGINT from the first 20k rows, then blowing up on a
 * stray `]` at row 41587).
 *
 * Strategy: first attempt with `sample_size=-1` so DuckDB scans the
 * whole file before settling on column types. That alone fixes the
 * common case. If the import still throws (e.g. malformed rows that
 * no column type can absorb), retry once with `ignore_errors=true`
 * so the user gets *something* in the workspace rather than nothing,
 * and console-warn so the lost rows aren't silent.
 */
export async function importCsvText(
  duckDBService: DuckDBService,
  virtualFileName: string,
  csvText: string,
  tableName: string,
  opts?: { delimiter?: string; hasHeader?: boolean },
): Promise<void> {
  await duckDBService.registerFileText(virtualFileName, csvText);

  const baseOptions: Record<string, string> = {
    header: opts?.hasHeader === false ? "false" : "true",
    delim: quoteLit(opts?.delimiter ?? ","),
    sample_size: "-1",
  };

  const buildSql = (options: Record<string, string>): string => {
    const optsSql = Object.entries(options)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return (
      `CREATE TABLE ${quoteIdent(tableName)} AS ` +
      `SELECT * FROM read_csv_auto(${quoteLit(virtualFileName)}, ${optsSql})`
    );
  };

  try {
    await duckDBService.executeQuery(buildSql(baseOptions));
  } catch (firstError) {
    console.warn(
      `CSV import for ${virtualFileName} failed with strict mode; retrying with ignore_errors=true. ` +
        `Some rows may be skipped.`,
      firstError,
    );
    await duckDBService.executeQuery(
      buildSql({ ...baseOptions, ignore_errors: "true" }),
    );
  }
}

export class CsvFormatHandler implements FormatHandler {
  canHandle(fileType: SupportedFileType): boolean {
    return fileType === "csv" || fileType === "tsv";
  }

  async import(file: File, tableName: string, duckDBService: DuckDBService, options?: ImportFileOptions): Promise<void> {
    const text = await file.text();
    const delimiter = options?.delimiter ?? (file.name.endsWith(".tsv") ? "\t" : ",");
    const hasHeader = options?.hasHeader ?? true;
    await importCsvText(duckDBService, file.name, text, tableName, { delimiter, hasHeader });
  }
}
