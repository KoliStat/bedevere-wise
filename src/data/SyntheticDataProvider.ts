import { Column, ColumnStats, DataProvider, DatasetMetadata, DataType } from "./types";

/**
 * Synthetic DataProvider for the perf harness. Generates rows deterministically
 * on demand — no I/O, no DuckDB. Optional simulated fetch latency lets the
 * harness exercise the skeleton-placeholder + onLoaded path of the cache.
 *
 * Schema: a configurable mix of INTEGER / DOUBLE / VARCHAR / BOOLEAN / DATE
 * columns so the formatter / per-type colour code paths get realistic
 * exercise.
 */
export interface SyntheticOptions {
  rows: number;
  cols: number;
  /** Simulated fetch latency in ms. 0 = instant. */
  fetchLatencyMs?: number;
  /** Optional seed override. Affects which deterministic values are produced. */
  seed?: number;
}

const TYPE_CYCLE: DataType[] = ["INTEGER", "DOUBLE", "VARCHAR", "BOOLEAN", "DATE"];

export class SyntheticDataProvider implements DataProvider {
  private opts: Required<SyntheticOptions>;
  private columns: Column[];
  private name = "synthetic";
  private description = "Perf-harness synthetic dataset";
  private label = "synthetic";

  constructor(opts: SyntheticOptions) {
    this.opts = {
      fetchLatencyMs: 0,
      seed: 42,
      ...opts,
    };
    this.columns = Array.from({ length: this.opts.cols }, (_, i) => {
      const dataType = TYPE_CYCLE[i % TYPE_CYCLE.length];
      const col: Column = {
        name: `col_${String(i).padStart(2, "0")}_${dataType.toLowerCase()}`,
        key: null,
        extra: null,
        default: null,
        dataType,
        rawType: dataType,
        hasNulls: i % 7 === 0,
      };
      return col;
    });
  }

  async getMetadata(): Promise<DatasetMetadata> {
    return {
      name: this.name,
      alias: this.name,
      fileName: "synthetic.parquet",
      description: this.description,
      label: this.label,
      totalRows: this.opts.rows,
      totalColumns: this.opts.cols,
      columns: this.columns,
    };
  }

  async fetchData(startRow: number, endRow: number): Promise<any[][]> {
    if (this.opts.fetchLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.fetchLatencyMs));
    }
    const result: any[][] = new Array(endRow - startRow);
    for (let r = startRow; r < endRow; r++) {
      const row = new Array(this.columns.length);
      for (let c = 0; c < this.columns.length; c++) {
        row[c] = this.cellValue(r, c);
      }
      result[r - startRow] = row;
    }
    return result;
  }

  async fetchDataColumnRange(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number,
  ): Promise<any[][]> {
    if (this.opts.fetchLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.opts.fetchLatencyMs));
    }
    const result: any[][] = new Array(endRow - startRow);
    for (let r = startRow; r < endRow; r++) {
      const row = new Array(endCol - startCol);
      for (let c = startCol; c < endCol; c++) {
        row[c - startCol] = this.cellValue(r, c);
      }
      result[r - startRow] = row;
    }
    return result;
  }

  async getColumnStats(_column: string | Column): Promise<ColumnStats | null> {
    return null;
  }

  setName(name: string): void { this.name = name; }
  setDescription(description: string): void { this.description = description; }
  setLabel(label: string): void { this.label = label; }

  private cellValue(row: number, col: number): any {
    // Some scattered nulls for the columns flagged hasNulls.
    if (col % 7 === 0 && (row * 13 + col) % 23 === 0) return null;

    const dataType = this.columns[col].dataType;
    const seed = (row * 31 + col * 7 + this.opts.seed) >>> 0;
    switch (dataType) {
      case "INTEGER":
        return seed % 100000;
      case "DOUBLE":
        return ((seed % 100000) / 100).toFixed(2);
      case "VARCHAR":
        return `r${row}c${col}_${(seed % 9999).toString(36)}`;
      case "BOOLEAN":
        return (seed & 1) === 1;
      case "DATE":
        // Days since epoch — formatter takes it from there.
        return 18000 + (seed % 5000);
      default:
        return seed;
    }
  }
}
