import { describe, expect, it } from "vitest";
import { ColumnFilterManager } from "../ColumnFilterManager";
import type { AppSettings } from "../PersistenceService";
import type { DatasetMetadata } from "../types";
import { hydrateColumnState, withColumnFilters, withColumnSorts } from "../columnStatePersistence";

const META = {
  name: "t",
  totalRows: 0,
  totalColumns: 2,
  columns: [
    { name: "id", dataType: "INTEGER" },
    { name: "name", dataType: "VARCHAR" },
  ],
} as unknown as DatasetMetadata;

describe("withColumnFilters / withColumnSorts", () => {
  it("sets the dataset entry and leaves other datasets alone", () => {
    const next = withColumnFilters({ columnFilters: { u: [] } }, "t", [{ columnName: "id", filterType: "include", values: ["1"] }]);
    expect(next.columnFilters).toEqual({ u: [], t: [{ columnName: "id", filterType: "include", values: ["1"] }] });
  });

  it("removes the key when the list is empty", () => {
    const next = withColumnSorts({ columnSorts: { t: [{ columnName: "id", direction: "asc" }] } }, "t", []);
    expect(next.columnSorts).toEqual({});
  });

  it("does not mutate the input", () => {
    const input: AppSettings = { columnFilters: {} };
    withColumnFilters(input, "t", [{ columnName: "id", filterType: "include", values: ["1"] }]);
    expect(input.columnFilters).toEqual({});
  });
});

describe("hydrateColumnState", () => {
  it("loads hidden columns, order, filters and sorts for live columns", () => {
    const fm = new ColumnFilterManager();
    hydrateColumnState(
      fm,
      {
        hiddenColumns: { t: ["name", "gone"] },
        columnOrder: { t: ["name", "id", "gone"] },
        columnFilters: { t: [{ columnName: "id", filterType: "range", min: 1, max: 2 }] },
        columnSorts: { t: [{ columnName: "name", direction: "desc" }] },
      },
      META,
    );
    expect(fm.getHiddenColumns("t")).toEqual(["name"]);
    expect(fm.getColumnOrder("t")).toEqual(["name", "id"]);
    expect(fm.getFilters("t")).toHaveLength(1);
    expect(fm.getSorts("t")).toEqual([{ columnName: "name", direction: "desc" }]);
  });

  it("hydrates filters before hidden columns so an onChange subscriber never sees an empty list", () => {
    // Mirrors BedevereApp: a subscriber that writes the filter list on
    // every change. If hidden columns were applied first, that write would
    // happen while the filters were still empty and erase them.
    const fm = new ColumnFilterManager();
    let settings: AppSettings = {
      hiddenColumns: { t: ["name"] },
      columnFilters: { t: [{ columnName: "id", filterType: "include", values: ["1"] }] },
    };
    fm.onChange((name) => {
      settings = withColumnFilters(settings, name, fm.getFilters(name));
    });
    hydrateColumnState(fm, settings, META);
    expect(settings.columnFilters?.t).toHaveLength(1);
  });
});
