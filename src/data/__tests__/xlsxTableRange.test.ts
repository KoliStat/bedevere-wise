import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  columnIndex,
  columnName,
  detectTableRange,
  formatRange,
  scanSheetRows,
  sniffXlsxTableRange,
} from "../formats/xlsxTableRange";
import { ExcelFormatHandler } from "../formats/ExcelFormatHandler";
import type { Backend } from "../Backend";

// ---------------------------------------------------------------------------
// Minimal .xlsx writer. Produces a ZIP with the parts read_xlsx and the
// sniffer look at: workbook.xml, workbook.xml.rels, and one XML file per
// sheet. Strings go out as inline strings, numbers as <v>, and `null`
// as a styled cell with no value (what Excel writes for a formatted but
// empty cell). Entries are stored by default; `deflate` compresses them
// with raw DEFLATE so the inflate path gets exercised too.
// ---------------------------------------------------------------------------

type CellValue = string | number | null;
interface SheetSpec {
  name: string;
  cells: Record<string, CellValue>;
  /** Emit rows and cells without `r` attributes (some writers do). */
  omitRefs?: boolean;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function splitRef(ref: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error(`bad ref ${ref}`);
  return { col: columnIndex(m[1]), row: parseInt(m[2], 10) };
}

function sheetXml(spec: SheetSpec): string {
  const byRow = new Map<number, Array<{ col: number; value: CellValue }>>();
  for (const [ref, value] of Object.entries(spec.cells)) {
    const { col, row } = splitRef(ref);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row)!.push({ col, value });
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  let out =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  let lastRow = 0;
  for (const r of rows) {
    const cells = byRow.get(r)!.sort((a, b) => a.col - b.col);
    if (spec.omitRefs) {
      // Without `r` attributes every row and cell is implicit: pad the
      // gaps with empty rows / cells so positions still line up.
      for (let pad = lastRow + 1; pad < r; pad++) out += "<row/>";
      out += "<row>";
      let lastCol = 0;
      for (const c of cells) {
        for (let pad = lastCol + 1; pad < c.col; pad++) out += "<c/>";
        out += cellXml(null, c.value);
        lastCol = c.col;
      }
      out += "</row>";
    } else {
      out += `<row r="${r}">`;
      for (const c of cells) out += cellXml(`${columnName(c.col)}${r}`, c.value);
      out += "</row>";
    }
    lastRow = r;
  }
  return out + "</sheetData></worksheet>";
}

function cellXml(ref: string | null, value: CellValue): string {
  const r = ref ? ` r="${ref}"` : "";
  if (value === null) return `<c${r} s="1"/>`;
  if (typeof value === "number") return `<c${r}><v>${value}</v></c>`;
  return `<c${r} t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function workbookXml(sheets: SheetSpec[]): string {
  const items = sheets
    .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${items}</sheets></workbook>`
  );
}

function workbookRels(sheets: SheetSpec[], absoluteTargets = false): string {
  const items = sheets
    .map((_, i) => {
      const target = absoluteTargets ? `/xl/worksheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`;
      return (
        `<Relationship Id="rId${i + 1}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        `Target="${target}"/>`
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
  );
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: Array<{ name: string; data: Uint8Array }>, deflate: boolean): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const payload = deflate ? new Uint8Array(deflateRawSync(f.data)) : f.data;
    const method = deflate ? 8 : 0;
    const crc = crc32(f.data);

    const lh = new Uint8Array(30 + nameBytes.length + payload.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    lh.set(payload, 30 + nameBytes.length);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    locals.push(lh);
    centrals.push(cd);
    offset += lh.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function buildXlsx(sheets: SheetSpec[], opts: { deflate?: boolean; absoluteTargets?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const files = [
    { name: "xl/workbook.xml", data: enc.encode(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels(sheets, opts.absoluteTargets)) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s)) })),
  ];
  return zip(files, opts.deflate ?? false);
}

// Layout of a bank statement export: a marker cell at I1, an account
// block in B7:D17 with blank rows between its lines, the table header at
// row 19, and the transactions from row 20 down.
function bankCells(dataRows = 5): Record<string, CellValue> {
  const cells: Record<string, CellValue> = {
    I1: "PF",
    A1: null,
    B1: null,
    B7: "Conti e Carte:",
    C7: "Conto 1234",
    B10: "Finanziamento:",
    C10: "-",
    B14: "I movimenti selezionati sono:",
    C14: dataRows,
    D14: "Tipo operazione:",
    B16: "Data inizio periodo",
    C16: "30/09/2025",
    B17: "Data fine periodo",
    C17: "27/09/2026",
    A19: "Data",
    B19: "Operazione",
    C19: "Dettagli",
    D19: "Conto o carta",
    E19: "Contabilizzazione",
    F19: "Categoria",
    G19: "Valuta",
    H19: "Importo",
  };
  for (let i = 0; i < dataRows; i++) {
    const r = 20 + i;
    cells[`A${r}`] = 46290 - i;
    cells[`B${r}`] = "Addebito diretto";
    cells[`C${r}`] = "Dettaglio";
    cells[`D${r}`] = "Conto 1234";
    cells[`E${r}`] = "SI";
    cells[`F${r}`] = "Utenze";
    cells[`G${r}`] = "EUR";
    cells[`H${r}`] = -10.5 * (i + 1);
  }
  return cells;
}

const CLEAN_CELLS: Record<string, CellValue> = {
  A1: "id",
  B1: "name",
  C1: "score",
  A2: 1,
  B2: "a",
  C2: 0.5,
  A3: 2,
  B3: "b",
  C3: 0.7,
  A4: 3,
  B4: "c",
  C4: 0.9,
};

function rowsOf(cells: Record<string, CellValue>) {
  return scanSheetRows(sheetXml({ name: "s", cells }));
}

/** Move every cell of `cells` down by `rows`. */
function shift(cells: Record<string, CellValue>, rows: number): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  for (const [ref, v] of Object.entries(cells)) {
    const { col, row } = splitRef(ref);
    out[`${columnName(col)}${row + rows}`] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("columnIndex / columnName", () => {
  it("round-trips spreadsheet column letters", () => {
    expect(columnIndex("A")).toBe(1);
    expect(columnIndex("Z")).toBe(26);
    expect(columnIndex("AA")).toBe(27);
    expect(columnIndex("XFD")).toBe(16384);
    for (const n of [1, 26, 27, 52, 53, 702, 703, 16384]) expect(columnIndex(columnName(n))).toBe(n);
  });
});

describe("scanSheetRows", () => {
  it("lists the filled columns of every non-empty row", () => {
    const rows = rowsOf({ A1: "x", C1: 1, B2: null, A3: "y" });
    expect(rows).toEqual([
      { row: 1, cols: [1, 3] },
      { row: 3, cols: [1] },
    ]);
  });

  it("treats a styled cell without a value as empty", () => {
    expect(rowsOf({ A1: null, B1: null })).toEqual([]);
  });

  it("treats an inline string with no text as empty", () => {
    expect(rowsOf({ A1: "", B1: "x" })).toEqual([{ row: 1, cols: [2] }]);
  });

  it("follows implicit positions when rows and cells carry no r attribute", () => {
    const xml = sheetXml({ name: "s", cells: { A1: "x", C1: "y", B3: 2 }, omitRefs: true });
    expect(scanSheetRows(xml)).toEqual([
      { row: 1, cols: [1, 3] },
      { row: 3, cols: [2] },
    ]);
  });

  it("ignores self-closing empty rows", () => {
    const xml =
      '<worksheet><sheetData><row r="1"/><row r="2"><c r="A2"><v>1</v></c></row>' +
      '<row r="3" spans="1:2"/></sheetData></worksheet>';
    expect(scanSheetRows(xml)).toEqual([{ row: 2, cols: [1] }]);
  });
});

describe("detectTableRange", () => {
  it("returns null for a sheet without values", () => {
    expect(detectTableRange([])).toBeNull();
  });

  it("returns null when the table starts at the first filled row", () => {
    // read_xlsx's own inference already starts here.
    expect(detectTableRange(rowsOf(CLEAN_CELLS))).toBeNull();
  });

  it("skips a marker cell and a metadata block above the table", () => {
    const range = detectTableRange(rowsOf(bankCells(5)));
    expect(range).toEqual({ startRow: 19, endRow: 24, startCol: 1, endCol: 8 });
    expect(formatRange(range!)).toBe("A19:H24");
  });

  it("skips a one-cell title row directly above the header", () => {
    const range = detectTableRange(rowsOf({ A1: "Quarterly report", ...shift(CLEAN_CELLS, 1) }));
    expect(range && formatRange(range)).toBe("A2:C5");
  });

  it("keeps a header row that is at least half as wide as the data rows", () => {
    // A pandas export with an index: the header has one cell fewer than
    // the data rows. The table still starts at row 1, so no range.
    const cells: Record<string, CellValue> = { B1: "x", C1: "y", A2: 0, B2: 1, C2: 2, A3: 1, B3: 3, C3: 4 };
    expect(detectTableRange(rowsOf(cells))).toBeNull();
  });

  it("uses the start row's first run of consecutive filled cells for the width", () => {
    // read_xlsx measures the width the same way on its own ranges, so a
    // sniffed range gives the same columns as a cleaned-up sheet would.
    const cells: Record<string, CellValue> = {
      A1: "title",
      A3: "a",
      B3: "b",
      D3: "note",
      A4: 1,
      B4: 2,
      D4: "n",
      A5: 3,
      B5: 4,
      D5: "m",
    };
    const range = detectTableRange(rowsOf(cells));
    expect(range && formatRange(range)).toBe("A3:B5");
  });

  it("picks the block with the most filled cells", () => {
    // A wide-but-short block above, a taller table below.
    const cells: Record<string, CellValue> = {};
    for (let c = 1; c <= 6; c++) cells[`${columnName(c)}1`] = `h${c}`;
    for (let r = 3; r <= 10; r++) for (let c = 1; c <= 3; c++) cells[`${columnName(c)}${r}`] = r === 3 ? `c${c}` : r * c;
    const range = detectTableRange(rowsOf(cells));
    expect(range && formatRange(range)).toBe("A3:C10");
  });

  it("ends the range at the last row of the chosen block", () => {
    const cells: Record<string, CellValue> = { A1: "x", ...shift(CLEAN_CELLS, 2), A20: "footer note" };
    const range = detectTableRange(rowsOf(cells));
    expect(range && formatRange(range)).toBe("A3:C6");
  });
});

describe("sniffXlsxTableRange", () => {
  it("returns the table range for a bank-style export", async () => {
    const bytes = buildXlsx([{ name: "Lista Operazione", cells: bankCells(5) }]);
    expect(await sniffXlsxTableRange(bytes)).toBe("A19:H24");
  });

  it("returns null for a clean table", async () => {
    const bytes = buildXlsx([{ name: "Sheet1", cells: CLEAN_CELLS }]);
    expect(await sniffXlsxTableRange(bytes)).toBeNull();
  });

  it("reads the first sheet by default and a named sheet on request", async () => {
    const bytes = buildXlsx([
      { name: "Clean", cells: CLEAN_CELLS },
      { name: "Dirty", cells: bankCells(3) },
    ]);
    expect(await sniffXlsxTableRange(bytes)).toBeNull();
    expect(await sniffXlsxTableRange(bytes, "Dirty")).toBe("A19:H22");
    expect(await sniffXlsxTableRange(bytes, "Clean")).toBeNull();
  });

  it("returns null for a sheet name that does not exist", async () => {
    const bytes = buildXlsx([{ name: "Dirty", cells: bankCells(3) }]);
    expect(await sniffXlsxTableRange(bytes, "Missing")).toBeNull();
  });

  it("matches sheet names that contain XML entities", async () => {
    const bytes = buildXlsx([{ name: "P&L <2026>", cells: bankCells(2) }]);
    expect(await sniffXlsxTableRange(bytes, "P&L <2026>")).toBe("A19:H21");
  });

  it("resolves absolute relationship targets", async () => {
    const bytes = buildXlsx([{ name: "S", cells: bankCells(2) }], { absoluteTargets: true });
    expect(await sniffXlsxTableRange(bytes)).toBe("A19:H21");
  });

  it("inflates deflated entries", async () => {
    const bytes = buildXlsx([{ name: "S", cells: bankCells(4) }], { deflate: true });
    expect(await sniffXlsxTableRange(bytes)).toBe("A19:H23");
  });

  it("returns null for bytes that are not a zip", async () => {
    expect(await sniffXlsxTableRange(new TextEncoder().encode("not a workbook"))).toBeNull();
    expect(await sniffXlsxTableRange(new Uint8Array(0))).toBeNull();
  });
});

describe("ExcelFormatHandler.import", () => {
  function fakeBackend(): { backend: Backend; sql: string[] } {
    const sql: string[] = [];
    const backend = {
      registerFileBuffer: async (name: string) => name,
      executeQuery: async (q: string) => {
        sql.push(q);
        return [];
      },
    } as unknown as Backend;
    return { backend, sql };
  }

  function asFile(bytes: Uint8Array, name: string): File {
    // jsdom's File has no arrayBuffer(); the handler only needs that and
    // the name.
    return {
      name,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as File;
  }

  it("passes the sniffed range to read_xlsx", async () => {
    const { backend, sql } = fakeBackend();
    const file = asFile(buildXlsx([{ name: "Lista Operazione", cells: bankCells(5) }]), "lista.xlsx");
    await new ExcelFormatHandler(null).import(file, "lista", backend);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toBe(`CREATE OR REPLACE TABLE "lista" AS SELECT * FROM read_xlsx('lista.xlsx', range='A19:H24')`);
  });

  it("leaves read_xlsx to its own inference for a clean sheet", async () => {
    const { backend, sql } = fakeBackend();
    const file = asFile(buildXlsx([{ name: "Sheet1", cells: CLEAN_CELLS }]), "clean.xlsx");
    await new ExcelFormatHandler(null).import(file, "clean", backend);
    expect(sql[0]).toBe(`CREATE OR REPLACE TABLE "clean" AS SELECT * FROM read_xlsx('clean.xlsx')`);
  });

  it("sniffs the selected sheet and passes both sheet= and range=", async () => {
    const { backend, sql } = fakeBackend();
    const bytes = buildXlsx([
      { name: "Clean", cells: CLEAN_CELLS },
      { name: "Dirty", cells: bankCells(3) },
    ]);
    await new ExcelFormatHandler(null).import(asFile(bytes, "book.xlsx"), "t", backend, { sheetName: "Dirty" });
    expect(sql[0]).toBe(
      `CREATE OR REPLACE TABLE "t" AS SELECT * FROM read_xlsx('book.xlsx', range='A19:H22', sheet = 'Dirty')`,
    );
  });

  it("sniffs before the upload detaches the buffer (DuckDB-WASM transfers it to its worker)", async () => {
    const sql: string[] = [];
    const backend = {
      registerFileBuffer: async (name: string, bytes: Uint8Array) => {
        // Same effect as duckdb-wasm's postMessage with a transfer list:
        // the caller's ArrayBuffer is detached and reads as empty.
        structuredClone(bytes, { transfer: [bytes.buffer as ArrayBuffer] });
        return name;
      },
      executeQuery: async (q: string) => {
        sql.push(q);
        return [];
      },
    } as unknown as Backend;
    const file = asFile(buildXlsx([{ name: "S", cells: bankCells(3) }]), "s.xlsx");
    await new ExcelFormatHandler(null).import(file, "s", backend);
    expect(sql[0]).toContain("range='A19:H22'");
  });

  it("keeps the range on the ignore_errors and all_varchar retries", async () => {
    const sql: string[] = [];
    let calls = 0;
    const backend = {
      registerFileBuffer: async (name: string) => name,
      executeQuery: async (q: string) => {
        sql.push(q);
        if (++calls < 3) throw new Error("Conversion Error: boom");
        return [];
      },
    } as unknown as Backend;
    const file = asFile(buildXlsx([{ name: "S", cells: bankCells(2) }]), "s.xlsx");
    await new ExcelFormatHandler(null).import(file, "s", backend);
    expect(sql).toHaveLength(3);
    expect(sql[1]).toContain("ignore_errors=true");
    expect(sql[1]).toContain("range='A19:H21'");
    expect(sql[2]).toContain("all_varchar=true");
    expect(sql[2]).toContain("range='A19:H21'");
  });
});
