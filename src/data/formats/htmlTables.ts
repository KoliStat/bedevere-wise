/**
 * HTML → tabular data conversion.
 *
 * Browser pasteboards and saved web pages routinely contain useful data
 * locked inside `<table>` elements. This module extracts those tables
 * into a plain row/cell structure and serialises them to CSV so the
 * rest of the import pipeline (DuckDB `read_csv_auto`) can take over
 * with its usual type inference / error tolerance.
 *
 * Design notes:
 *   - Pure DOM work: uses the browser's `DOMParser`, no library.
 *   - Top-level `<table>` only; nested tables almost always indicate
 *     layout-driven HTML and not actual data.
 *   - Image-only cells (icons, flags) fall back to `alt` then the
 *     `src` basename — so the user's Eurovision flag column becomes
 *     `AL/AM/AT/…` instead of a column full of empty strings.
 */

export interface ParsedHtmlTable {
  /** <caption>, or document <title>, or "" — used as a default name hint. */
  caption: string | null;
  /** De-duplicated header names; collisions get a `__2`/`__3`/… suffix. */
  headers: string[];
  /** Raw cell strings; same length as `headers` per row. */
  rows: string[][];
  rowCount: number;
  colCount: number;
}

/**
 * Thrown by `HtmlFormatHandler` when the source carries more than one
 * `<table>`. The control panel / drop site catches this and opens the
 * paste dialog seeded with the parsed tables, so the user picks which
 * one to import without re-parsing.
 */
export class MultipleHtmlTablesError extends Error {
  public readonly tables: ParsedHtmlTable[];
  public readonly sourceName: string;

  constructor(tables: ParsedHtmlTable[], sourceName: string) {
    super(`${tables.length} tables found in ${sourceName}; pick one to import.`);
    this.name = "MultipleHtmlTablesError";
    this.tables = tables;
    this.sourceName = sourceName;
  }
}

/**
 * Parse every top-level `<table>` in an HTML string. Returns an empty
 * array when no usable tables are found — caller decides whether
 * that's an error or a "try the paste dialog again" prompt.
 */
export function parseHtmlTables(htmlString: string): ParsedHtmlTable[] {
  const doc = new DOMParser().parseFromString(htmlString, "text/html");
  const docTitle = doc.querySelector("title")?.textContent?.trim() ?? "";
  const all = Array.from(doc.querySelectorAll("table"));

  // Drop nested tables — they're almost always layout, and including
  // them would produce duplicates of their outer table's content. A
  // table is "top-level" if no ancestor `<table>` exists.
  const topLevel = all.filter((t) => !t.parentElement?.closest("table"));

  const out: ParsedHtmlTable[] = [];
  for (const table of topLevel) {
    const parsed = parseTable(table, docTitle);
    if (parsed && parsed.rowCount > 0 && parsed.colCount > 0) out.push(parsed);
  }
  return out;
}

function parseTable(table: HTMLTableElement, docTitle: string): ParsedHtmlTable | null {
  const caption = table.querySelector("caption")?.textContent?.trim() || docTitle || null;

  // Collect every row as a flat list of cells (with colspan/rowspan
  // expanded). Then split into header rows and body rows.
  const allRows: HTMLTableRowElement[] = [];
  // Some pages skip <tbody> entirely; <tr>s become direct children of
  // <table>. querySelectorAll("tr") catches every shape.
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    // Skip rows that belong to a nested table inside this one.
    if (tr.closest("table") !== table) continue;
    allRows.push(tr);
  }
  if (allRows.length === 0) return null;

  // Decide the header row. Prefer <thead>'s last <tr> (some workbooks
  // emit a multi-row thead with a title row above the column-name row).
  // Fall back to a leading row that's entirely <th>, then the first row.
  let headerRow: HTMLTableRowElement | null = null;
  const theadRows = Array.from(table.querySelectorAll("thead tr")).filter(
    (r) => r.closest("table") === table,
  ) as HTMLTableRowElement[];
  if (theadRows.length > 0) {
    headerRow = theadRows[theadRows.length - 1];
  } else if (allRows[0] && cellsOf(allRows[0]).every((c) => c.tagName.toLowerCase() === "th")) {
    headerRow = allRows[0];
  } else if (allRows[0] && cellsOf(allRows[0]).some((c) => c.tagName.toLowerCase() === "th")) {
    headerRow = allRows[0];
  }

  const expanded = expandSpans(allRows);
  const colCount = expanded.reduce((m, r) => Math.max(m, r.length), 0);
  if (colCount === 0) return null;

  // Normalise every row to colCount cells so downstream CSV serialisation
  // never has a ragged row.
  for (const row of expanded) {
    while (row.length < colCount) row.push("");
  }

  // Headers: derived from the expanded headerRow's index in allRows,
  // or auto-generated `col_1`/`col_2`/… if no header was identified.
  let headers: string[];
  if (headerRow) {
    const idx = allRows.indexOf(headerRow);
    headers = expanded[idx].slice(0, colCount);
    expanded.splice(0, idx + 1); // drop everything up to and including header
  } else {
    headers = Array.from({ length: colCount }, (_, i) => `col_${i + 1}`);
  }

  // Empty header → fall back to col_N; trim whitespace; dedupe.
  headers = headers.map((h, i) => h.trim() || `col_${i + 1}`);
  headers = dedupeHeaders(headers);

  const rows = expanded;
  return {
    caption,
    headers,
    rows,
    rowCount: rows.length,
    colCount,
  };
}

function cellsOf(row: HTMLTableRowElement): HTMLTableCellElement[] {
  return Array.from(row.children).filter(
    (n) => n.tagName === "TD" || n.tagName === "TH",
  ) as HTMLTableCellElement[];
}

/**
 * Expand `colspan` / `rowspan` so every output row has the same column
 * positions. Cells with rowspan > 1 are repeated downward; cells with
 * colspan > 1 are repeated across. This keeps columns aligned with the
 * header row even when the source HTML uses spans for visual grouping.
 *
 * Best-effort: pathological span configurations may still misalign, but
 * the common data-table cases (occasional spanned header, occasional
 * spanned cell) round-trip correctly.
 */
function expandSpans(allRows: HTMLTableRowElement[]): string[][] {
  const out: string[][] = allRows.map(() => []);
  // Pending row-spanned values: column index → { value, rowsRemaining }.
  const pending = new Map<number, { value: string; rowsRemaining: number }>();

  for (let r = 0; r < allRows.length; r++) {
    const cells = cellsOf(allRows[r]);
    const row = out[r];
    let c = 0;

    const placeAt = (col: number, value: string): void => {
      // Skip columns already filled by a previous row's rowspan.
      while (row[col] !== undefined) col++;
      row[col] = value;
    };

    // First, drop any pending rowspan cells into their columns.
    for (const [col, p] of Array.from(pending.entries())) {
      row[col] = p.value;
      p.rowsRemaining -= 1;
      if (p.rowsRemaining <= 0) pending.delete(col);
    }

    for (const cell of cells) {
      // Advance c past any columns already filled.
      while (row[c] !== undefined) c++;
      const value = cellText(cell);
      const colspan = Math.max(1, Math.min(64, parseInt(cell.getAttribute("colspan") || "1", 10) || 1));
      const rowspan = Math.max(1, Math.min(64, parseInt(cell.getAttribute("rowspan") || "1", 10) || 1));
      for (let k = 0; k < colspan; k++) {
        placeAt(c + k, value);
        if (rowspan > 1) {
          pending.set(c + k, { value, rowsRemaining: rowspan - 1 });
        }
      }
      c += colspan;
    }
  }

  return out;
}

/**
 * Extract the canonical string value from a `<td>` or `<th>`. The
 * image-only fallback is the load-bearing piece: a cell that holds
 * just an icon should not become an empty string when the icon's name
 * carries the actual data (e.g. country code in a flag filename).
 */
function cellText(cell: HTMLTableCellElement): string {
  // Collapse internal whitespace so "  Albania \n" becomes "Albania".
  const text = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text.length > 0) return text;

  // Image-only cell: prefer alt; fall back to src basename.
  const imgs = cell.querySelectorAll("img");
  if (imgs.length === 1) {
    const img = imgs[0];
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt) return alt;
    const src = img.getAttribute("src") || "";
    if (src) {
      // basename without query/hash, strip extension
      const last = src.split(/[?#]/)[0].split(/[\\/]/).pop() || "";
      const dot = last.lastIndexOf(".");
      return dot > 0 ? last.slice(0, dot) : last;
    }
  }
  return "";
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const n = seen.get(h) ?? 0;
    seen.set(h, n + 1);
    return n === 0 ? h : `${h}__${n + 1}`;
  });
}

/**
 * Serialise a parsed table to RFC-4180-ish CSV. Quote any field that
 * contains a quote, comma, CR, or LF; escape embedded quotes by
 * doubling. The result is fed straight to DuckDB `read_csv_auto`.
 */
export function tableToCsv(table: ParsedHtmlTable): string {
  const lines: string[] = [];
  lines.push(table.headers.map(escapeCsvField).join(","));
  for (const row of table.rows) {
    lines.push(row.map(escapeCsvField).join(","));
  }
  // Trailing newline keeps `read_csv_auto` happy on every parser path.
  return lines.join("\n") + "\n";
}

function escapeCsvField(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
