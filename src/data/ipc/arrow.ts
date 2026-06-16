/**
 * Arrow IPC streaming reader.
 *
 * Decodes the per-streamId chunk bucket produced by ./bridge.ts into an
 * apache-arrow Table.
 *
 * Status: simple one-shot decode. Concatenates all chunks into a single
 * buffer and parses it as a complete Arrow IPC stream. A future
 * iteration should switch to `RecordBatchStreamReader.from()` fed
 * incrementally so the renderer can paint partial results while later
 * chunks are still in flight (see roadmap in docs/backend-protocol.md).
 */

import { tableFromIPC, type Table } from "apache-arrow";

/**
 * Concatenate the chunk bucket into a single byte buffer and parse it
 * as an Arrow IPC stream. We assume the host emits the entire stream as
 * a complete IPC payload (schema + record batches + EOS), and we hand
 * it to `tableFromIPC` in one shot.
 *
 * OPEN_QUESTION: does the host prefix each chunk with the Arrow IPC
 * stream framing, or only the first chunk with the schema header?
 * Locks this down with the host's arrow_stream implementation.
 */
export async function decodeArrowStream(chunks: Uint8Array[]): Promise<Table> {
  if (chunks.length === 0) {
    throw new Error("decodeArrowStream: no chunks");
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // tableFromIPC accepts a Uint8Array of a complete IPC stream.
  return tableFromIPC(joined);
}

/**
 * Reshape an Arrow Table into the row-array of cell values that
 * SpreadsheetVisualizer's DataProvider expects today.
 *
 * Carrying cost: re-marshaling is O(rows × cols) per fetch. The roadmap
 * upgrade is teaching the visualizer to consume Arrow Tables natively.
 */
export function arrowTableToRowArrays(table: Table): unknown[][] {
  const numRows = table.numRows;
  const fields = table.schema.fields;
  const rows: unknown[][] = new Array(numRows);
  // Pull each column once (zero-copy where possible) and walk index-by-index.
  const cols = fields.map((f) => table.getChild(f.name));
  for (let r = 0; r < numRows; r++) {
    const row: unknown[] = new Array(fields.length);
    for (let c = 0; c < fields.length; c++) {
      row[c] = cols[c]?.get(r) ?? null;
    }
    rows[r] = row;
  }
  return rows;
}
