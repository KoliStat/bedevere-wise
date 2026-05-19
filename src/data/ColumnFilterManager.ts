import {
  DataType,
  isBooleanType,
  isDateType,
  isNumericType,
  isStringType,
  isTemporalType,
  isTimeType,
  isTimestampType,
} from "./types";

export type FilterType = "include" | "exclude" | "range";

export interface ColumnFilter {
  columnName: string;
  /** The column's data type — needed for proper SQL quoting/casting. */
  dataType?: DataType;
  filterType: FilterType;
  /** For include/exclude filters. Values are stored as their display string representation. */
  values?: string[];
  /** For range filters on numeric columns. */
  min?: number;
  max?: number;
  /** For range filters on temporal columns: ISO strings (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS or HH:MM:SS). */
  minStr?: string;
  maxStr?: string;
}

export interface SortConfig {
  columnName: string;
  direction: "asc" | "desc";
}

export class ColumnFilterManager {
  private filters: Map<string, ColumnFilter[]> = new Map(); // dataset name -> filters
  private sorts: Map<string, SortConfig[]> = new Map(); // dataset name -> sorts
  // dataset name -> set of column names hidden from the spreadsheet view.
  // Hide is a presentation-only concern; filter / sort still reference
  // hidden columns by name and apply correctly to the underlying data.
  private hiddenColumns: Map<string, Set<string>> = new Map();
  // dataset name -> user-defined column order. Like `hiddenColumns`,
  // this is a presentation-only concern: filter / sort still address
  // columns by name regardless of where they sit in the display order.
  // Columns absent from the order array (a newly-added column to a
  // dataset that already had a saved order) are appended in their
  // source order — see `applyColumnOrder` consumers.
  private columnOrder: Map<string, string[]> = new Map();
  private onChangeCallbacks: Array<(datasetName: string) => void> = [];

  public setFilter(datasetName: string, filter: ColumnFilter): void {
    const filters = this.filters.get(datasetName) || [];

    // Replace existing filter on the same column, or add new
    const existingIndex = filters.findIndex((f) => f.columnName === filter.columnName);
    if (existingIndex >= 0) {
      filters[existingIndex] = filter;
    } else {
      filters.push(filter);
    }

    this.filters.set(datasetName, filters);
    this.notifyChange(datasetName);
  }

  public removeFilter(datasetName: string, columnName: string): void {
    const filters = this.filters.get(datasetName);
    if (!filters) return;

    const newFilters = filters.filter((f) => f.columnName !== columnName);
    if (newFilters.length === 0) {
      this.filters.delete(datasetName);
    } else {
      this.filters.set(datasetName, newFilters);
    }

    this.notifyChange(datasetName);
  }

  public clearFilters(datasetName: string): void {
    this.filters.delete(datasetName);
    this.notifyChange(datasetName);
  }

  public getFilters(datasetName: string): ColumnFilter[] {
    return this.filters.get(datasetName) || [];
  }

  public hasFilters(datasetName: string): boolean {
    const filters = this.filters.get(datasetName);
    return !!filters && filters.length > 0;
  }

  public isColumnFiltered(datasetName: string, columnName: string): boolean {
    const filters = this.filters.get(datasetName);
    return !!filters && filters.some((f) => f.columnName === columnName);
  }

  public setSort(datasetName: string, sort: SortConfig): void {
    // Replace all sorts with a single sort. Used by the column-stats
    // panel's explicit asc/desc buttons, which always set a single key.
    this.sorts.set(datasetName, [sort]);
    this.notifyChange(datasetName);
  }

  /**
   * Header-arrow click entry point. Cycles the column's sort state:
   *   not-sorted -> asc -> desc -> not-sorted
   *
   * `multi` (shift held) preserves the rest of the sort chain so the
   * column slots in/out of a multi-key ORDER BY in place. When false,
   * the click resets all other sorts and treats this column as the
   * sole key.
   */
  public cycleSort(datasetName: string, columnName: string, multi: boolean): void {
    const current = this.sorts.get(datasetName) || [];
    const idx = current.findIndex((s) => s.columnName === columnName);
    const dir = idx === -1 ? null : current[idx].direction;

    const next: "asc" | "desc" | null =
      dir === null ? "asc" : dir === "asc" ? "desc" : null;

    if (!multi) {
      if (next === null) {
        this.sorts.delete(datasetName);
      } else {
        this.sorts.set(datasetName, [{ columnName, direction: next }]);
      }
      this.notifyChange(datasetName);
      return;
    }

    if (next === null) {
      const updated = current.filter((_, i) => i !== idx);
      if (updated.length === 0) this.sorts.delete(datasetName);
      else this.sorts.set(datasetName, updated);
    } else if (idx === -1) {
      this.sorts.set(datasetName, [...current, { columnName, direction: next }]);
    } else {
      const updated = [...current];
      updated[idx] = { columnName, direction: next };
      this.sorts.set(datasetName, updated);
    }
    this.notifyChange(datasetName);
  }

  /**
   * 1-indexed position of the column in the sort chain, or `null` if
   * the column isn't sorted. Used by the header renderer to draw the
   * superscript number (1, 2, 3, ...) when a multi-key sort is active.
   */
  public getSortPosition(datasetName: string, columnName: string): number | null {
    const sorts = this.sorts.get(datasetName);
    if (!sorts) return null;
    const idx = sorts.findIndex((s) => s.columnName === columnName);
    return idx === -1 ? null : idx + 1;
  }

  public removeSort(datasetName: string, columnName: string): void {
    const sorts = this.sorts.get(datasetName);
    if (!sorts) return;

    const newSorts = sorts.filter((s) => s.columnName !== columnName);
    if (newSorts.length === 0) {
      this.sorts.delete(datasetName);
    } else {
      this.sorts.set(datasetName, newSorts);
    }

    this.notifyChange(datasetName);
  }

  public clearSorts(datasetName: string): void {
    this.sorts.delete(datasetName);
    this.notifyChange(datasetName);
  }

  public getSorts(datasetName: string): SortConfig[] {
    return this.sorts.get(datasetName) || [];
  }

  public isColumnSorted(datasetName: string, columnName: string): "asc" | "desc" | null {
    const sorts = this.sorts.get(datasetName);
    if (!sorts) return null;
    const sort = sorts.find((s) => s.columnName === columnName);
    return sort ? sort.direction : null;
  }

  public buildWhereClause(datasetName: string): string {
    const filters = this.filters.get(datasetName);
    if (!filters || filters.length === 0) return "";

    const conditions = filters
      .map((filter) => buildConditionForFilter(filter))
      .filter((c) => c.length > 0);

    return conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  }

  public buildOrderByClause(datasetName: string): string {
    const sorts = this.sorts.get(datasetName);
    if (!sorts || sorts.length === 0) return "";

    const orderParts = sorts.map((sort) => `"${sort.columnName}" ${sort.direction.toUpperCase()}`);
    return `ORDER BY ${orderParts.join(", ")}`;
  }

  public buildFilteredQuery(tableName: string, datasetName: string): string {
    const where = this.buildWhereClause(datasetName);
    const orderBy = this.buildOrderByClause(datasetName);
    return `SELECT * FROM "${tableName}" ${where} ${orderBy}`.trim();
  }

  public hasAnyFiltersOrSorts(datasetName: string): boolean {
    return this.hasFilters(datasetName) || (this.sorts.get(datasetName)?.length ?? 0) > 0;
  }

  // ---- Hidden columns -----------------------------------------------------

  /**
   * Replace the hidden-column set for a dataset. Empty array (or empty
   * set) clears hidden state. Fires `onChange` so the spreadsheet's
   * `handleFilterChange` re-projects the data provider.
   */
  public setHiddenColumns(datasetName: string, columnNames: Iterable<string>): void {
    const names = new Set(columnNames);
    if (names.size === 0) {
      this.hiddenColumns.delete(datasetName);
    } else {
      this.hiddenColumns.set(datasetName, names);
    }
    this.notifyChange(datasetName);
  }

  public getHiddenColumns(datasetName: string): string[] {
    const set = this.hiddenColumns.get(datasetName);
    return set ? Array.from(set) : [];
  }

  public isColumnHidden(datasetName: string, columnName: string): boolean {
    return this.hiddenColumns.get(datasetName)?.has(columnName) ?? false;
  }

  public hasHiddenColumns(datasetName: string): boolean {
    return (this.hiddenColumns.get(datasetName)?.size ?? 0) > 0;
  }

  // ---- Column order -------------------------------------------------------

  /**
   * Replace the user-defined column order for a dataset. Empty array
   * clears the override (columns then render in source order). Fires
   * `onChange` so the spreadsheet re-projects.
   */
  public setColumnOrder(datasetName: string, order: Iterable<string>): void {
    const arr = Array.from(order);
    if (arr.length === 0) {
      this.columnOrder.delete(datasetName);
    } else {
      this.columnOrder.set(datasetName, arr);
    }
    this.notifyChange(datasetName);
  }

  public getColumnOrder(datasetName: string): string[] {
    return this.columnOrder.get(datasetName)?.slice() ?? [];
  }

  public hasColumnOrder(datasetName: string): boolean {
    return (this.columnOrder.get(datasetName)?.length ?? 0) > 0;
  }

  /**
   * Apply the saved column order to a list of source column names.
   * Names present in the saved order render in that order first; any
   * names not in the saved order (e.g. a column added to the source
   * after the order was saved) are appended in their source order.
   * Names in the saved order but not in `sourceNames` (e.g. a column
   * that was renamed / dropped) are silently skipped.
   *
   * No-op when there is no saved order for the dataset — returns
   * `sourceNames` unchanged.
   */
  public applyColumnOrder(datasetName: string, sourceNames: string[]): string[] {
    const order = this.columnOrder.get(datasetName);
    if (!order || order.length === 0) return sourceNames;
    const present = new Set(sourceNames);
    const ordered = order.filter((n) => present.has(n));
    const orderedSet = new Set(ordered);
    const trailing = sourceNames.filter((n) => !orderedSet.has(n));
    return [...ordered, ...trailing];
  }

  /**
   * Move a column from one position to another within the order. If
   * no saved order exists yet, the move is computed against
   * `sourceNames` (the natural order) and stored. Drop semantics:
   * `position === "before"` inserts before `targetName`, `"after"`
   * inserts after.
   *
   * No-op when `sourceColumnName === targetColumnName` or when either
   * name is missing from `sourceNames`.
   */
  public moveColumn(
    datasetName: string,
    sourceNames: string[],
    sourceColumnName: string,
    targetColumnName: string,
    position: "before" | "after",
  ): void {
    if (sourceColumnName === targetColumnName) return;
    const current = this.columnOrder.get(datasetName)?.slice() ?? sourceNames.slice();
    // Ensure both names are present in `current` (a freshly-loaded
    // dataset may have columns not yet in the persisted order).
    const presentInCurrent = new Set(current);
    for (const n of sourceNames) {
      if (!presentInCurrent.has(n)) current.push(n);
    }

    const srcIdx = current.indexOf(sourceColumnName);
    const tgtIdx = current.indexOf(targetColumnName);
    if (srcIdx === -1 || tgtIdx === -1) return;

    const [moved] = current.splice(srcIdx, 1);
    const insertIdx = current.indexOf(targetColumnName) + (position === "after" ? 1 : 0);
    current.splice(insertIdx, 0, moved);

    this.columnOrder.set(datasetName, current);
    this.notifyChange(datasetName);
  }

  /**
   * Predicate the TabManager uses to decide between
   * `FilteredDuckDBDataProvider` and the plain provider. Hidden
   * columns and column-order overrides both count as state — even
   * with no filter / sort, they require the projection-aware
   * provider.
   */
  public hasAnyState(datasetName: string): boolean {
    return (
      this.hasAnyFiltersOrSorts(datasetName) ||
      this.hasHiddenColumns(datasetName) ||
      this.hasColumnOrder(datasetName)
    );
  }

  public onChange(callback: (datasetName: string) => void): void {
    this.onChangeCallbacks.push(callback);
  }

  public removeOnChange(callback: (datasetName: string) => void): void {
    this.onChangeCallbacks = this.onChangeCallbacks.filter((cb) => cb !== callback);
  }

  private notifyChange(datasetName: string): void {
    for (const cb of this.onChangeCallbacks) {
      cb(datasetName);
    }
  }
}

// ---------- SQL generation helpers ----------

function sqlLiteralForValue(value: string, dataType?: DataType): string {
  if (!dataType) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (isBooleanType(dataType)) {
    const v = value.toUpperCase();
    if (v === "TRUE" || v === "1" || v === "T") return "TRUE";
    if (v === "FALSE" || v === "0" || v === "F") return "FALSE";
    return "NULL";
  }
  if (isNumericType(dataType)) {
    // Emit as-is (numeric); fall back to quoted string if not parseable
    if (value.trim() === "") return "NULL";
    const n = Number(value);
    if (isFinite(n)) return String(n);
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (isDateType(dataType)) {
    return `DATE '${value.replace(/'/g, "''")}'`;
  }
  if (isTimeType(dataType)) {
    return `TIME '${value.replace(/'/g, "''")}'`;
  }
  if (isTimestampType(dataType)) {
    return `TIMESTAMP '${value.replace(/'/g, "''")}'`;
  }
  if (isStringType(dataType)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlBoundForRange(value: number | string | undefined, dataType?: DataType): string | null {
  if (value === undefined || value === null || value === "") return null;

  if (dataType && isTemporalType(dataType)) {
    const str = String(value);
    if (isDateType(dataType)) return `DATE '${str}'`;
    if (isTimeType(dataType)) return `TIME '${str}'`;
    if (isTimestampType(dataType)) return `TIMESTAMP '${str.replace("T", " ")}'`;
  }
  if (typeof value === "number") {
    return isFinite(value) ? String(value) : null;
  }
  const n = Number(value);
  return isFinite(n) ? String(n) : null;
}

function buildConditionForFilter(filter: ColumnFilter): string {
  const col = `"${filter.columnName}"`;
  const dt = filter.dataType;

  switch (filter.filterType) {
    case "include": {
      if (!filter.values || filter.values.length === 0) return "";
      const literals = filter.values.map((v) => sqlLiteralForValue(v, dt)).join(", ");
      return `${col} IN (${literals})`;
    }
    case "exclude": {
      if (!filter.values || filter.values.length === 0) return "";
      const literals = filter.values.map((v) => sqlLiteralForValue(v, dt)).join(", ");
      return `${col} NOT IN (${literals})`;
    }
    case "range": {
      const parts: string[] = [];
      // Temporal range uses minStr/maxStr; numeric uses min/max.
      const minLit = dt && isTemporalType(dt)
        ? sqlBoundForRange(filter.minStr, dt)
        : sqlBoundForRange(filter.min, dt);
      const maxLit = dt && isTemporalType(dt)
        ? sqlBoundForRange(filter.maxStr, dt)
        : sqlBoundForRange(filter.max, dt);
      if (minLit !== null) parts.push(`${col} >= ${minLit}`);
      if (maxLit !== null) parts.push(`${col} <= ${maxLit}`);
      return parts.length > 0 ? parts.join(" AND ") : "";
    }
    default:
      return "";
  }
}
