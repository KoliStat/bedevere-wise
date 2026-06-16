/**
 * IpcDataProvider — bridges Bedevere's DataProvider interface to a host
 * process over the WebSocket sidecar.
 *
 * The UI components have no idea this exists; they take a DataProvider;
 * an IpcBackend hands them an IpcDataProvider; everything else is
 * plumbing.
 *
 * The host speaks the Wire* shapes declared in ./types.ts; the
 * DataProvider interface expects runtime shapes (Map fields,
 * Intl.NumberFormatOptions, etc.). Translation happens at this boundary
 * via the small `decode*` helpers at the bottom of this file.
 */

import type { DataProvider, DatasetMetadata, ColumnStats, Column } from "../types";
import { Bridge } from "./bridge";
import type { WireColumn, WireColumnStats, WireDatasetMetadata } from "./types";
import { arrowTableToRowArrays } from "./arrow";

function columnName(column: string | Column): string {
  return typeof column === "string" ? column : column.name;
}

export class IpcDataProvider implements DataProvider {
  constructor(
    private readonly bridge: Bridge,
    private table: string,
    private fileName: string,
  ) {}

  /** The host-side relation this provider addresses in every RPC. */
  getSourceTable(): string {
    return this.table;
  }

  // ------------------------------------------------------------------------
  // Metadata
  // ------------------------------------------------------------------------

  async getMetadata(): Promise<DatasetMetadata> {
    const wire = await this.bridge.call("getMetadata", { table: this.table });
    return decodeDatasetMetadata(wire);
  }

  // ------------------------------------------------------------------------
  // Data fetches (Arrow over the binary channel)
  // ------------------------------------------------------------------------

  async fetchData(startRow: number, endRow: number): Promise<any[][]> {
    const { streamId } = await this.bridge.call("fetchData", {
      table: this.table,
      start: startRow,
      end: endRow,
    });
    const arrowTable = await this.bridge.awaitArrowStream(streamId);
    return arrowTableToRowArrays(arrowTable);
  }

  async fetchDataColumnRange(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ): Promise<any[][]> {
    const { streamId } = await this.bridge.call("fetchDataColumnRange", {
      table: this.table,
      start: startRow,
      end: endRow,
      startCol,
      endCol,
    });
    const arrowTable = await this.bridge.awaitArrowStream(streamId);
    return arrowTableToRowArrays(arrowTable);
  }

  // ------------------------------------------------------------------------
  // Column stats (JSON channel only — small payloads)
  // ------------------------------------------------------------------------

  async getColumnStats(column: string | Column): Promise<ColumnStats | null> {
    const wire = await this.bridge.call("getColumnStats", {
      table: this.table,
      column: columnName(column),
    });
    return decodeColumnStats(wire);
  }

  async getColumnStatsFiltered(column: string | Column): Promise<ColumnStats | null> {
    const wire = await this.bridge.call("getColumnStatsFiltered", {
      table: this.table,
      column: columnName(column),
    });
    return decodeColumnStats(wire);
  }

  async searchColumnValues(
    column: string | Column,
    options: { query: string; mode: "substring" | "regex"; limit: number },
  ): Promise<Array<{ value: string; count: number }>> {
    return this.bridge.call("searchColumnValues", {
      table: this.table,
      column: columnName(column),
      query: options.query,
      mode: options.mode,
      limit: options.limit,
    });
  }

  // ------------------------------------------------------------------------
  // Synchronous setters — local-only state, no IPC round-trip
  // ------------------------------------------------------------------------

  setName(name: string): void {
    // Server-side rename (ALTER TABLE) is a separate executeQuery flow if
    // the user ever wants to persist it; for the in-memory tag we just
    // update local state.
    this.table = name;
  }

  setDescription(_description: string): void {
    // No-op for v0. Description is a UI-side annotation today.
  }

  setLabel(_label: string): void {
    // No-op for v0. Label is a UI-side annotation today.
  }

  // ------------------------------------------------------------------------
  // Backend-specific helpers (not part of DataProvider)
  // ------------------------------------------------------------------------

  /** Current file name (for display in headers, recent-files menus, etc.). */
  getFileName(): string {
    return this.fileName;
  }
}

// ----------------------------------------------------------------------------
// Wire → runtime decoders.
//
// The host sends JSON-safe shapes (Map → [k, v][], Intl.NumberFormatOptions
// → Record<string, unknown>). These helpers reconstitute the runtime types
// declared in ../types so the UI never sees a wire shape. Pure functions;
// safe to call on the result of any RPC.
// ----------------------------------------------------------------------------

function decodeColumn(wire: WireColumn): Column {
  // WireColumn matches Column structurally except `format`, which the wire
  // sends as `string | Record<string, unknown>` (the JSON-safe view of
  // `Intl.NumberFormatOptions`). Casting is safe: the JSON object IS the
  // options literal, just typed loosely on the wire.
  return {
    name: wire.name,
    key: wire.key,
    extra: wire.extra,
    default: wire.default,
    label: wire.label,
    dataType: wire.dataType,
    rawType: wire.rawType,
    length: wire.length,
    hasNulls: wire.hasNulls,
    format: wire.format as Column["format"],
  };
}

function decodeDatasetMetadata(wire: WireDatasetMetadata): DatasetMetadata {
  return {
    name: wire.name,
    alias: wire.alias,
    fileName: wire.fileName,
    description: wire.description,
    label: wire.label,
    totalRows: wire.totalRows,
    totalColumns: wire.totalColumns,
    columns: wire.columns.map(decodeColumn),
  };
}

function decodeColumnStats(wire: WireColumnStats | null): ColumnStats | null {
  if (!wire) return null;
  return {
    isCategorical: wire.isCategorical,
    totalCount: wire.totalCount,
    nullCount: wire.nullCount,
    distinctCount: wire.distinctCount,
    valueCounts: new Map(wire.valueCounts),
    valueCountsRaw: wire.valueCountsRaw ? new Map(wire.valueCountsRaw) : undefined,
    numericStats: wire.numericStats,
    temporalStats: wire.temporalStats,
    histogramEdges: wire.histogramEdges,
  };
}
