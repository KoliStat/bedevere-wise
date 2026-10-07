import type { Backend } from "../Backend";
import { DuckDBExtensionLoader } from "../DuckDBExtensionLoader";
import { SupportedFileType } from "../FileTreeTypes";
import { FormatHandler, ImportFileOptions } from "./FormatHandler";
import { quoteIdent, quoteLiteral } from "../sqlIdent";
import { listZipEntries, readZipEntry, sniffXlsxTableRange } from "./xlsxTableRange";

export class ExcelFormatHandler implements FormatHandler {
  private extensionLoader: DuckDBExtensionLoader | null;

  constructor(extensionLoader: DuckDBExtensionLoader | null) {
    this.extensionLoader = extensionLoader;
  }

  canHandle(fileType: SupportedFileType): boolean {
    // DuckDB-WASM gates on the loaded extension; an IPC backend (loader
    // null) defers to the host's native read_xlsx.
    return (fileType === "xlsx" || fileType === "xls") && (this.extensionLoader?.isLoaded("excel") ?? true);
  }

  async import(file: File, tableName: string, backend: Backend, options?: ImportFileOptions): Promise<void> {
    const buffer = new Uint8Array(await file.arrayBuffer());

    // read_xlsx infers its range from the first filled cell of the sheet
    // and stops at the first empty row. Exports with a title, a marker
    // cell or an account block above the table then come back as one
    // empty column. Scan the sheet ourselves and pin the table with an
    // explicit range when it does not start where read_xlsx would start
    // (null for clean sheets and for anything we cannot parse, e.g. .xls).
    //
    // This has to run BEFORE registerFileBuffer: DuckDB-WASM hands the
    // ArrayBuffer to its worker as a transferable, which detaches it on
    // this thread, so afterwards `buffer` is empty and the sniff would
    // silently find nothing.
    const detectedRange = await sniffXlsxTableRange(buffer, options?.sheetName);
    const range = detectedRange ? `, range=${quoteLiteral(detectedRange)}` : "";
    if (detectedRange && import.meta.env.DEV) {
      console.log(`Excel import for ${file.name}: table detected at ${detectedRange}`);
    }

    const effectiveName = (await backend.registerFileBuffer(file.name, buffer)) ?? file.name;

    const sheet = options?.sheetName ? `, sheet = ${quoteLiteral(options.sheetName)}` : "";
    const fname = effectiveName.replace(/'/g, "''");

    // Try several read paths, widening tolerance each time. The order
    // matters: each step preserves more correctness than the next.
    //
    //   1. Default read_xlsx — clean files; rich types inferred.
    //   2. read_xlsx with ignore_errors=true — keep the inferred types
    //      but turn un-convertible cells (e.g. a stray "]" in a mostly
    //      numeric column) into NULL rather than aborting the import.
    //      Best fallback because downstream filters / stats / sliders
    //      still work normally.
    //   3. read_xlsx with all_varchar=true — give up on type inference
    //      entirely; every column comes in as VARCHAR. The user can
    //      still read the data but loses numeric/temporal column stats
    //      until they cast.
    //   4. st_read — the spatial extension's reader, last-ditch for
    //      older DuckDB builds where read_xlsx isn't registered.
    const attempts: Array<{ label: string; sql: string }> = [
      {
        label: "read_xlsx",
        sql: `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_xlsx('${fname}'${range}${sheet})`,
      },
      {
        label: "read_xlsx ignore_errors",
        sql: `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_xlsx('${fname}', ignore_errors=true${range}${sheet})`,
      },
      {
        label: "read_xlsx all_varchar",
        sql: `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM read_xlsx('${fname}', all_varchar=true${range}${sheet})`,
      },
      {
        label: "st_read",
        sql: `CREATE OR REPLACE TABLE ${quoteIdent(tableName)} AS SELECT * FROM st_read('${fname}'${sheet})`,
      },
    ];

    const failures: Array<{ label: string; message: string }> = [];
    for (const attempt of attempts) {
      try {
        await backend.executeQuery(attempt.sql);
        if (failures.length > 0) {
          console.warn(
            `Excel import for ${file.name} succeeded via ${attempt.label}; earlier attempts failed:`,
            failures,
          );
        }
        return;
      } catch (err) {
        failures.push({
          label: attempt.label,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Surface the underlying DuckDB error messages so the user (and we)
    // can see *why* every attempt failed. The previous "no compatible
    // read function available" message was opaque to the point of being
    // misleading — usually the extension itself loaded fine; the file
    // just didn't parse.
    const detail = failures.map((f) => `[${f.label}] ${f.message}`).join("\n");
    throw new Error(`Failed to import Excel file ${file.name}.\n${detail}`);
  }

  async getSheetNames(file: File, backend: Backend): Promise<string[]> {
    // Primary: parse the XLSX workbook.xml directly — reliable across DuckDB
    // extension versions. XLSX is a ZIP containing xl/workbook.xml which lists
    // every sheet with its real name.
    try {
      const names = await extractSheetNamesFromXlsx(file);
      if (names && names.length > 0) return names;
    } catch {
      // fall through to SQL probes
    }

    // Fallback: DuckDB-side probes in case the ZIP parse fails (e.g. .xls
    // binary-format files, which are not ZIPs and have no workbook.xml).
    const buffer = new Uint8Array(await file.arrayBuffer());
    const effectiveName = (await backend.registerFileBuffer(file.name, buffer)) ?? file.name;
    const fname = effectiveName.replace(/'/g, "''");

    const queries = [
      `SELECT name FROM read_xlsx_names('${fname}')`,
      `SELECT DISTINCT sheet_name as name FROM read_xlsx('${fname}', all_varchar=true, sheet='*') LIMIT 0`,
    ];

    for (const query of queries) {
      try {
        const result = await backend.executeQuery(query);
        const names = result.map((row: any) => row.name).filter(Boolean);
        if (names.length > 0) return names;
      } catch {
        // Try next approach
      }
    }

    // Last-ditch: probe read_xlsx with no sheet arg. If DuckDB accepts it,
    // at least one sheet exists — return a single-entry sentinel so the UI
    // shows something rather than lying with "Sheet1".
    throw new Error("Unable to enumerate sheets for this workbook");
  }
}

/**
 * Extract sheet names from an .xlsx file by reading the embedded
 * xl/workbook.xml entry from the ZIP container (the ZIP reader lives in
 * xlsxTableRange.ts, shared with the table-range sniff). Uses DOMParser
 * for the XML — no dependencies. Returns null if the structure doesn't
 * match (not a valid XLSX, .xls binary, corrupt archive, etc.).
 */
async function extractSheetNamesFromXlsx(file: File): Promise<string[] | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = listZipEntries(bytes);
  const entry = entries?.find((e) => e.name === "xl/workbook.xml");
  if (!entry) return null;
  const xmlBytes = await readZipEntry(bytes, entry);
  if (!xmlBytes) return null;

  const xml = new TextDecoder().decode(xmlBytes);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return null;

  // Sheet elements live under <workbook><sheets><sheet name="..."/>. They may
  // appear in the default namespace (so a plain querySelectorAll still works)
  // or under a prefix — iterate elementsByTagName to cover both.
  const sheetEls = Array.from(doc.getElementsByTagName("sheet"));
  const names: string[] = [];
  for (const el of sheetEls) {
    // Only consider elements whose parent is <sheets>; skip <sheetView>,
    // <sheetPr>, etc. that share the "sheet" token.
    const parent = el.parentElement;
    if (!parent) continue;
    const parentTag = parent.tagName.toLowerCase().replace(/^.*:/, "");
    if (parentTag !== "sheets") continue;
    const name = el.getAttribute("name");
    if (name) names.push(name);
  }

  return names.length > 0 ? names : null;
}
