import { DuckDBService } from "./DuckDBService";
import { Column, ColumnStats, DataProvider, DatasetMetadata, normalizeDuckDBType } from "./types";
import { ColumnFilterManager } from "./ColumnFilterManager";
import { unwrapArrowValue } from "./arrowUnwrap";
import { parseDuckDBType, TypeNode } from "./duckdbTypeParser";
import { quoteIdent } from "./sqlIdent";

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

  /**
   * Returns the source columns minus any hidden by `filterManager`.
   * `getMetadata` / `fetchData` / `fetchDataColumnRange` all project
   * through this so the spreadsheet only sees columns it should render.
   * Filter and sort clauses can still reference hidden columns — SQL
   * allows WHERE / ORDER BY to mention columns absent from the SELECT.
   */
  private async getVisibleColumns(): Promise<Array<any>> {
    const columns = await this.duckDBService.getTableInfo(this.sourceTableName);
    const hidden = new Set(this.filterManager.getHiddenColumns(this.name));
    return columns.filter((c: any) => !hidden.has(c.column_name));
  }

  private buildBaseQuery(): string {
    return this.filterManager.buildFilteredQuery(this.sourceTableName, this.name);
  }

  public async getMetadata(): Promise<DatasetMetadata> {
    const baseQuery = this.buildBaseQuery();
    const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) AS _filtered`;
    const totalRows = (await this.duckDBService.executeQuery(countQuery))[0].toArray()[0] as bigint;

    const columns = await this.getVisibleColumns();

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
    const visible = await this.getVisibleColumns();
    const projection = visible.length > 0
      ? visible.map((c: any) => `"${c.column_name}"`).join(", ")
      : "*";

    const where = this.filterManager.buildWhereClause(this.name);
    const orderBy = this.filterManager.buildOrderByClause(this.name);

    const query =
      `SELECT ${projection} FROM "${this.sourceTableName}" ${where} ${orderBy} ` +
      `LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, allTypes] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    // `allTypes` is keyed by the source table's column order; filter to
    // the visible-projection order so unwrapArrowValue lines up.
    const sourceColumns = await this.duckDBService.getTableInfo(this.sourceTableName);
    const visibleSet = new Set(visible.map((c: any) => c.column_name));
    const types = sourceColumns
      .map((c: any, idx: number) => (visibleSet.has(c.column_name) ? allTypes[idx] : null))
      .filter((t): t is TypeNode | undefined => t !== null);
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
    const visible = await this.getVisibleColumns();
    const columnNames = visible.map((c: any) => `"${c.column_name}"`).slice(startCol, endCol);
    const columnNamesString = columnNames.join(", ");

    const where = this.filterManager.buildWhereClause(this.name);
    const orderBy = this.filterManager.buildOrderByClause(this.name);

    const query = `SELECT ${columnNamesString} FROM "${this.sourceTableName}" ${where} ${orderBy} LIMIT ${endRow - startRow} OFFSET ${startRow}`;
    const [rows, allTypes] = await Promise.all([
      this.duckDBService.executeQuery(query),
      this.ensureColumnTypes(),
    ]);
    const sourceColumns = await this.duckDBService.getTableInfo(this.sourceTableName);
    const visibleSet = new Set(visible.map((c: any) => c.column_name));
    const visibleTypes = sourceColumns
      .map((c: any, idx: number) => (visibleSet.has(c.column_name) ? allTypes[idx] : null))
      .filter((t): t is TypeNode | undefined => t !== null);
    const sliceTypes = visibleTypes.slice(startCol, endCol);
    return rows.map((row: any) =>
      (row.toArray() as any[]).map((cell, i) => unwrapArrowValue(cell, sliceTypes[i])),
    );
  }

  /**
   * Unfiltered stats — drives the filter UI's value list and slider
   * bounds. The categorical filter needs to render checkboxes for the
   * categories the user *deselected*, otherwise they can't add them
   * back; numeric / temporal sliders need the unfiltered min/max as
   * outer bounds for the same reason.
   */
  public async getColumnStats(column: string | Column): Promise<ColumnStats | null> {
    const { DuckDBDataProvider } = await import("./DuckDBDataProvider");
    const sourceProvider = new DuckDBDataProvider(this.duckDBService, this.sourceTableName, this.fileName);
    return sourceProvider.getColumnStats(column);
  }

  public async searchColumnValues(
    column: string | Column,
    options: { query: string; mode: "substring" | "regex"; limit: number },
  ): Promise<Array<{ value: string; count: number }>> {
    // Search runs against the unfiltered source — same rationale as
    // getColumnStats above: the filter UI needs to be able to find
    // values the current filter is hiding.
    const { DuckDBDataProvider } = await import("./DuckDBDataProvider");
    const sourceProvider = new DuckDBDataProvider(this.duckDBService, this.sourceTableName, this.fileName);
    return sourceProvider.searchColumnValues(column, options);
  }

  /**
   * Filtered stats — runs the existing stats queries against a temp
   * view that applies the same WHERE clause the cell grid uses. Drives
   * the side-panel display (mean / median / counts / histogram). Sort
   * isn't relevant for aggregates so we skip the ORDER BY.
   *
   * The view name is random-suffixed per call so concurrent stats
   * fetches (the common pattern: showStats fires in response to a
   * selection change that's racing the filter-change reinitialize)
   * don't drop each other's views mid-query. Best-effort cleanup in
   * `finally`; orphan temp views auto-clear on session end.
   */
  public async getColumnStatsFiltered(column: string | Column): Promise<ColumnStats | null> {
    const { DuckDBDataProvider } = await import("./DuckDBDataProvider");
    const whereClause = this.filterManager.buildWhereClause(this.name);

    if (!whereClause) {
      const sourceProvider = new DuckDBDataProvider(this.duckDBService, this.sourceTableName, this.fileName);
      return sourceProvider.getColumnStats(column);
    }

    // Regular (non-TEMP) view: `DuckDBService.executeQuery` opens and
    // closes a fresh connection per call, and TEMP views are
    // connection-scoped — they'd evaporate between the CREATE and the
    // first stats query. Database-scoped views survive that, at the
    // cost of brief visibility in SHOW TABLES while the stats fetch
    // is in flight. The random suffix keeps concurrent callers from
    // tripping over each other.
    const viewName = `__bedevere_stats_${this.name}_${Math.random().toString(36).slice(2, 10)}`;
    try {
      await this.duckDBService.executeQuery(
        `CREATE OR REPLACE VIEW ${quoteIdent(viewName)} AS ` +
          `SELECT * FROM ${quoteIdent(this.sourceTableName)} ${whereClause}`,
      );
      const tempProvider = new DuckDBDataProvider(this.duckDBService, viewName, this.fileName);
      return await tempProvider.getColumnStats(column);
    } finally {
      try {
        await this.duckDBService.executeQuery(`DROP VIEW IF EXISTS ${quoteIdent(viewName)}`);
      } catch {
        // best-effort cleanup; an orphan view is harmless beyond
        // showing up once in SHOW TABLES until the page reloads
      }
    }
  }

  public getSourceTableName(): string {
    return this.sourceTableName;
  }
}
