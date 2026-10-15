/**
 * Per-dataset column state (hidden columns, column order, filters,
 * sorts) in and out of AppSettings. Keyed by dataset name, which is the
 * DuckDB table name; two environments with a same-named table share an
 * entry. Known and accepted, see the design spec.
 */

import type { ColumnFilter, ColumnFilterManager, SortConfig } from "./ColumnFilterManager";
import type { AppSettings } from "./PersistenceService";
import type { DatasetMetadata } from "./types";

/**
 * Load everything persisted for `metadata.name` into the filter manager.
 * Runs before the dataset's tab is built (TabManager's before-add hook),
 * so the first render is already projected and filtered.
 *
 * Order matters: filters and sorts first, through the silent `hydrate`;
 * hidden columns and order after, because those setters fire `onChange`
 * and the subscriber in BedevereApp rewrites the persisted filter list
 * from the manager on every change. Doing it the other way round would
 * erase the persisted filters before they were loaded.
 */
export function hydrateColumnState(fm: ColumnFilterManager, settings: AppSettings, metadata: DatasetMetadata): void {
  const name = metadata.name;
  fm.hydrate(name, { filters: settings.columnFilters?.[name], sorts: settings.columnSorts?.[name] }, metadata.columns);

  const live = new Set(metadata.columns.map((c) => c.name));
  const hidden = (settings.hiddenColumns?.[name] ?? []).filter((c) => live.has(c));
  if (hidden.length > 0) fm.setHiddenColumns(name, hidden);
  const order = (settings.columnOrder?.[name] ?? []).filter((c) => live.has(c));
  if (order.length > 0) fm.setColumnOrder(name, order);
}

/** Settings with the dataset's filter list replaced; an empty list removes the key. */
export function withColumnFilters(settings: AppSettings, datasetName: string, filters: ColumnFilter[]): AppSettings {
  const next = { ...(settings.columnFilters ?? {}) };
  if (filters.length === 0) delete next[datasetName];
  else next[datasetName] = filters;
  return { ...settings, columnFilters: next };
}

/** Settings with the dataset's sort chain replaced; an empty list removes the key. */
export function withColumnSorts(settings: AppSettings, datasetName: string, sorts: SortConfig[]): AppSettings {
  const next = { ...(settings.columnSorts ?? {}) };
  if (sorts.length === 0) delete next[datasetName];
  else next[datasetName] = sorts;
  return { ...settings, columnSorts: next };
}
