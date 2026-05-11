import { DuckDBService } from "./DuckDBService";
import { Column, ColumnStats, DataProvider, DatasetMetadata, normalizeDuckDBType } from "./types";
import { ColumnFilterManager } from "./ColumnFilterManager";
import { unwrapArrowValue } from "./arrowUnwrap";
import { parseDuckDBType, TypeNode } from "./duckdbTypeParser";

export class FilteredDuckDBDataProvider implements DataProvider {
  private name: string;
  private fileName: string;
  private description: string = "";
  private label: string = "";
  private duckDBService: DuckDBService;
  private filterManager: ColumnFilterManager;
  private sourceTableName: string;
  private parsedColumnTypes: Array<TypeNode | undefined> | null = null;

  private async ensureColumnTypes(): Promise<Array<TypeNode | undefined>> {
    if (this.parsedColumnTypes) return this.parsedColumnTypes;
    const info = await this.duckDBService.getTableInfo(this.sourceTableName);
    this.parsedColumnTypes = info.map((c: any) => parseDuckDBType(c.column_type));
    return this.parsedColumnTypes;
  }

  constructor(
    duckDBService: DuckDBService,
    sourceTableName: string,
    filterManager: ColumnFilterManager,
    name: string,
    fileName: string
  ) {
    this.duckDBService = duckDBService;
    this.sourceTableName = sourceTableName;
    this.filterManager = filterManager;
    this.name = name;
    this.fileName = fileName;
  }

  public setName(name: string): void {
    this.name = name;
  }

  public setDescription(description: string): void {
    this.description = description;
  }

  public setLabel(label: string): void {
    this.label = label;
  }

  private buildBaseQuery(): string {
    return this.filterManager.buildFilteredQuery(this.sourceTableName, this.name);
  }

  public async getMetadata(): Promise<DatasetMetadata> {
    const baseQuery = this.buildBaseQuery();
    const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) AS _filtered`;
    const totalRows = (await this.duckDBService.executeQuery(countQuery))[0].toArray()[0] as bigint;

    const columns = await this.duckDBService.getTableInfo(this.sourceTableName);

    return {
      name: this.name,
      fileName: this.fileName,
      description: this.description,
      label: this.label,
      totalRows: Number(totalRows),
      totalColumns: columns.length,
      columns: columns.map((column: any) => ({
        name: column.column_name,
        key: column.key,
        extra: column.extra,
        default: column.default,
        dataType: normalizeDuckDBType(column.column_type),
        rawType: column.column_type,
        hasNulls: column.nulls === "YES",
      })),
    };
  }

  public async fetchData(startRow: number, endRow: number): Promise<any[][]> {
    const baseQuery = this.buildBaseQuery();
    const query = `SELECT * FROM (${baseQuery}) AS _filtered LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, types] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    return rows.map((row: any) =>
      (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, types[i])),
    );
  }

  public async fetchDataColumnRange(
    startRow: number,
    endRow: number,
    startCol: number,
    endCol: number
  ): Promise<any[][]> {
    const columns = await this.duckDBService.getTableInfo(this.sourceTableName);
    const columnNames = columns.map((column: any) => `"${column.column_name}"`).slice(startCol, endCol);
    const columnNamesString = columnNames.join(", ");

    const where = this.filterManager.buildWhereClause(this.name);
    const orderBy = this.filterManager.buildOrderByClause(this.name);

    const query = `SELECT ${columnNamesString} FROM "${this.sourceTableName}" ${where} ${orderBy} LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, types] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    const sliceTypes = types.slice(startCol, endCol);
    return rows.map((row: any) =>
      (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, sliceTypes[i])),
    );
  }

  public async getColumnStats(column: string | Column): Promise<ColumnStats | null> {
    // Stats run against the unfiltered source. Reflecting the filtered
    // view would be nice (histograms move with the visible rows) but
    // breaks the filter UI itself: a filtered `valueCounts` doesn't
    // include the categories the user deselected, so there's no way
    // to broaden the filter from the panel. Numeric/temporal sliders
    // collapse to the filtered min/max for the same reason. Restoring
    // unfiltered stats — the next release will introduce a dual-view
    // shape (filtered for display, unfiltered for filter-UI bounds).
    const { DuckDBDataProvider } = await import("./DuckDBDataProvider");
    const sourceProvider = new DuckDBDataProvider(this.duckDBService, this.sourceTableName, this.fileName);
    return sourceProvider.getColumnStats(column);
  }

  public getSourceTableName(): string {
    return this.sourceTableName;
  }
}
