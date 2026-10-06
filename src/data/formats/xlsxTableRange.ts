/**
 * Find the data table inside an .xlsx worksheet and express it as a
 * `range=` argument for DuckDB's `read_xlsx`.
 *
 * `read_xlsx` infers its range from the first row that holds any value.
 * The start column is that row's first filled cell. The width is the
 * run of filled cells that follows it. Reading stops at the first empty
 * row. Exports from banks, ERPs and reporting tools put a title, a
 * marker cell or an account block above the real table. The inference
 * then locks onto that stray cell and the import comes back as one
 * empty column (seen with a bank statement whose only value in row 1
 * was a two-letter marker in I1; the table started at A19).
 *
 * This module reads the sheet XML itself. It splits the sheet into
 * blocks of consecutive non-empty rows and picks the block with the
 * most filled cells. Inside that block it skips leading rows that are
 * less than half as wide as the block's widest row (titles, banners).
 * The range runs from that row to the block's last row. Its width is
 * the start row's first run of consecutive filled cells, which is the
 * rule `read_xlsx` applies to its own ranges, so the result matches
 * what a sheet with the junk rows deleted would give.
 *
 * When the chosen start row is the sheet's first non-empty row,
 * `read_xlsx` would start in the same place on its own. The sniffer
 * then returns null and the caller keeps DuckDB's inference. Only
 * sheets whose table starts lower get an explicit range. Known limit:
 * a header row narrower than half the data rows is treated as a title
 * and skipped.
 *
 * Everything here is plain byte and string work: a small ZIP reader
 * (stored and DEFLATE entries), regex scans over workbook.xml and the
 * relationship part to find the sheet file, and a linear scan over the
 * sheet's `<row>` / `<c>` elements. No DOM, so it runs in the browser,
 * in a worker, and under Node tests alike.
 */

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = DEFLATE. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Walk the ZIP central directory and list its entries. Returns null when
 * the bytes are not a ZIP (no end-of-central-directory record). ZIP64
 * archives are not supported; workbooks never need them.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();

  // End of Central Directory: signature 0x06054b50, 22 fixed bytes plus
  // an optional comment of up to 65535 bytes, so search the tail window.
  const windowStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= windowStart; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length) break;
    if (bytes[pos] !== 0x50 || bytes[pos + 1] !== 0x4b || bytes[pos + 2] !== 0x01 || bytes[pos + 3] !== 0x02) break;
    const method = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const uncompressedSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Return the decompressed bytes of one entry, or null when the entry is
 * damaged or uses a compression method other than stored / DEFLATE.
 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > bytes.length) return null;
  if (bytes[lh] !== 0x50 || bytes[lh + 1] !== 0x4b || bytes[lh + 2] !== 0x03 || bytes[lh + 3] !== 0x04) return null;
  // The local header repeats the name and may carry its own extra field,
  // so the payload offset comes from the local lengths, while the sizes
  // come from the central directory (the local ones may be zero when the
  // writer streamed the entry).
  const nameLen = view.getUint16(lh + 26, true);
  const extraLen = view.getUint16(lh + 28, true);
  const start = lh + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > bytes.length) return null;
  const payload = bytes.subarray(start, end);
  if (entry.method === 0) return payload;
  if (entry.method === 8) return inflateRaw(payload);
  return null;
}

async function inflateRaw(payload: Uint8Array): Promise<Uint8Array> {
  // A hand-built ReadableStream rather than Blob.stream(): jsdom's Blob
  // has no stream(), and the browser path works the same either way.
  const chunk = new Uint8Array(payload); // copy: the stream takes ownership of the view
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const inflated = source.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(inflated).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Workbook parts
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m) => {
    if (m in XML_ENTITIES) return XML_ENTITIES[m];
    const code = m[2] === "x" ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function attribute(tag: string, name: string): string | null {
  // Attribute names in SpreadsheetML are case-sensitive; `r:id` must not
  // match the `Id` in `sheetId`, hence the leading whitespace anchor.
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/**
 * Worksheet file for `sheetName`, or for the workbook's first worksheet
 * when no name is given. Mirrors read_xlsx: sheets are matched by their
 * entity-decoded name, and relationship targets are made absolute by
 * stripping a leading `/` or prefixing `xl/`.
 */
async function resolveWorksheetPath(
  bytes: Uint8Array,
  entries: ZipEntry[],
  sheetName: string | undefined,
): Promise<string | null> {
  const workbookEntry = entries.find((e) => e.name === "xl/workbook.xml");
  if (!workbookEntry) return null;
  const workbookBytes = await readZipEntry(bytes, workbookEntry);
  if (!workbookBytes) return null;
  const workbookXml = new TextDecoder().decode(workbookBytes);

  const relsEntry = entries.find((e) => e.name === "xl/_rels/workbook.xml.rels");
  const relTargets = new Map<string, string>();
  if (relsEntry) {
    const relsBytes = await readZipEntry(bytes, relsEntry);
    if (relsBytes) {
      const relsXml = new TextDecoder().decode(relsBytes);
      for (const m of relsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        const id = attribute(m[1], "Id");
        const target = attribute(m[1], "Target");
        const type = attribute(m[1], "Type") ?? "";
        if (id && target && type.endsWith("/worksheet")) relTargets.set(id, decodeXmlEntities(target));
      }
    }
  }

  // `<sheet .../>` elements only; `\b` keeps `<sheets>`, `<sheetView>`
  // and `<sheetPr>` out. The relationship id attribute is `r:id` in
  // every writer seen so far, but accept any prefix.
  let index = 0;
  for (const m of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    index++;
    const name = attribute(m[1], "name");
    if (name === null) continue;
    const decodedName = decodeXmlEntities(name);
    if (sheetName !== undefined && decodedName !== sheetName) continue;
    const ridMatch = /\s(?:\w+:)?id="([^"]*)"/.exec(m[1]);
    const target = ridMatch ? relTargets.get(ridMatch[1]) : undefined;
    if (target) return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    // No usable relationship part: fall back to the conventional layout.
    return `xl/worksheets/sheet${index}.xml`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sheet scan
// ---------------------------------------------------------------------------

/** One non-empty row: its 1-based number and its filled 1-based columns, ascending. */
export interface RowProfile {
  row: number;
  cols: number[];
}

/** "A" → 1, "Z" → 26, "AA" → 27. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

/** 1 → "A", 26 → "Z", 27 → "AA". */
export function columnName(index: number): string {
  let s = "";
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** True when `code` is whitespace, `>` or `/`: the characters that may follow a tag name. */
function endsTagName(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 62 || code === 47;
}

function cellHasValue(inner: string): boolean {
  // `<v>` carries numbers, booleans, errors, shared-string indexes and
  // cached formula results. Inline strings sit in `<is><t>…</t></is>`
  // (or `<is><r><t>…` for rich text). A cell with neither is empty, even
  // when it has a style.
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (v && v[1].length > 0) return true;
  const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
  return t !== null && t[1].length > 0;
}

function scanRowCells(body: string): number[] {
  const cols: number[] = [];
  let pos = 0;
  let lastCol = 0;
  for (;;) {
    const open = body.indexOf("<c", pos);
    if (open < 0) break;
    if (!endsTagName(body.charCodeAt(open + 2))) {
      pos = open + 2; // `<cols`, `<col`, `<cfRule`, …
      continue;
    }
    const tagEnd = body.indexOf(">", open);
    if (tagEnd < 0) break;
    const tag = body.slice(open, tagEnd + 1);
    const ref = /\sr="([A-Z]+)\d*"/.exec(tag);
    const col = ref ? columnIndex(ref[1]) : lastCol + 1;
    lastCol = col;
    if (tag.endsWith("/>")) {
      pos = tagEnd + 1;
      continue;
    }
    const close = body.indexOf("</c>", tagEnd);
    const inner = body.slice(tagEnd + 1, close < 0 ? body.length : close);
    pos = close < 0 ? body.length : close + 4;
    if (cellHasValue(inner)) cols.push(col);
  }
  // Cells arrive in column order from every known writer; sort only if not.
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] < cols[i - 1]) {
      cols.sort((a, b) => a - b);
      break;
    }
  }
  return cols;
}

/**
 * Linear scan over the worksheet XML. Rows and cells without an `r`
 * attribute take the position after the previous one, as the format
 * specifies. Rows with no filled cell are left out, so a gap in the
 * returned row numbers means empty rows.
 */
export function scanSheetRows(xml: string): RowProfile[] {
  const rows: RowProfile[] = [];
  let pos = 0;
  let lastRow = 0;
  for (;;) {
    const open = xml.indexOf("<row", pos);
    if (open < 0) break;
    if (!endsTagName(xml.charCodeAt(open + 4))) {
      pos = open + 4; // `<rowBreaks`
      continue;
    }
    const tagEnd = xml.indexOf(">", open);
    if (tagEnd < 0) break;
    const tag = xml.slice(open, tagEnd + 1);
    const ref = /\sr="(\d+)"/.exec(tag);
    const row = ref ? parseInt(ref[1], 10) : lastRow + 1;
    lastRow = row;
    if (tag.endsWith("/>")) {
      pos = tagEnd + 1;
      continue;
    }
    const close = xml.indexOf("</row>", tagEnd);
    const body = xml.slice(tagEnd + 1, close < 0 ? xml.length : close);
    pos = close < 0 ? xml.length : close + 6;
    const cols = scanRowCells(body);
    if (cols.length > 0) rows.push({ row, cols });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Table detection
// ---------------------------------------------------------------------------

export interface TableRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/**
 * Pick the table inside a sheet (see the module comment for the rule).
 * Returns null when the sheet is empty or when the table starts at the
 * first non-empty row, where read_xlsx's own inference already works.
 */
export function detectTableRange(rows: RowProfile[]): TableRange | null {
  if (rows.length === 0) return null;

  // Blocks of consecutive non-empty rows. read_xlsx stops at the first
  // empty row, so a block is the most it would ever read in one go.
  const blocks: RowProfile[][] = [];
  let current: RowProfile[] = [];
  for (const r of rows) {
    if (current.length > 0 && r.row !== current[current.length - 1].row + 1) {
      blocks.push(current);
      current = [];
    }
    current.push(r);
  }
  blocks.push(current);

  // The table is the block with the most filled cells. Ties go to the
  // first block.
  let best = blocks[0];
  let bestCells = -1;
  for (const block of blocks) {
    let cells = 0;
    for (const r of block) cells += r.cols.length;
    if (cells > bestCells) {
      best = block;
      bestCells = cells;
    }
  }

  // Skip title / banner rows: leading rows narrower than half the
  // block's widest row. Always keep at least one row.
  let widest = 0;
  for (const r of best) widest = Math.max(widest, r.cols.length);
  let startIdx = 0;
  while (startIdx < best.length - 1 && best[startIdx].cols.length * 2 < widest) startIdx++;
  const start = best[startIdx];

  if (start.row === rows[0].row) return null;

  // Width: the start row's first run of consecutive filled cells, the
  // same rule read_xlsx applies when it infers a range itself.
  const startCol = start.cols[0];
  let endCol = startCol;
  for (let i = 1; i < start.cols.length && start.cols[i] === endCol + 1; i++) endCol = start.cols[i];

  return { startRow: start.row, endRow: best[best.length - 1].row, startCol, endCol };
}

/** `{startRow: 19, endRow: 151, startCol: 1, endCol: 8}` → `"A19:H151"`. */
export function formatRange(range: TableRange): string {
  return `${columnName(range.startCol)}${range.startRow}:${columnName(range.endCol)}${range.endRow}`;
}

/** Shape of a value `sniffXlsxTableRange` returns. Hosts validate against this before building SQL. */
export const XLSX_RANGE_PATTERN = /^[A-Z]{1,3}[0-9]{1,7}:[A-Z]{1,3}[0-9]{1,7}$/;

// Sheets whose XML inflates beyond this are left to read_xlsx's own
// inference. Big exports are almost always clean tables, and holding a
// multi-hundred-MB string in the renderer is not worth the edge case.
const MAX_SHEET_XML_BYTES = 64 * 1024 * 1024;

/**
 * Sniff `bytes` (an .xlsx file) and return the `range=` value read_xlsx
 * should use for `sheetName` (the first sheet when omitted), or null
 * when DuckDB's own inference is the right call. Never throws: a file
 * that is not a ZIP (.xls, a mislabelled CSV), a damaged archive, an
 * unknown sheet name or an oversized sheet all yield null.
 */
export async function sniffXlsxTableRange(bytes: Uint8Array, sheetName?: string): Promise<string | null> {
  try {
    const entries = listZipEntries(bytes);
    if (!entries) return null;
    const sheetPath = await resolveWorksheetPath(bytes, entries, sheetName);
    if (!sheetPath) return null;
    const entry = entries.find((e) => e.name === sheetPath);
    if (!entry || entry.uncompressedSize > MAX_SHEET_XML_BYTES) return null;
    const xmlBytes = await readZipEntry(bytes, entry);
    if (!xmlBytes) return null;
    const range = detectTableRange(scanSheetRows(new TextDecoder().decode(xmlBytes)));
    if (!range) return null;
    const formatted = formatRange(range);
    return XLSX_RANGE_PATTERN.test(formatted) ? formatted : null;
  } catch {
    return null;
  }
}
