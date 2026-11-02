import { afterEach, describe, expect, it, vi } from "vitest";
import { ColumnFilterManager } from "../ColumnFilterManager";
import { persistenceService } from "../PersistenceService";
import { EnvironmentService } from "../environments/EnvironmentService";

const COLS = [
  { name: "id", dataType: "INTEGER" },
  { name: "name", dataType: "VARCHAR" },
  { name: "when", dataType: "DATE" },
] as const;

describe("ColumnFilterManager.hydrate", () => {
  it("loads filters and sorts for columns that still exist", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      {
        filters: [{ columnName: "name", filterType: "include", values: ["a"] }],
        sorts: [{ columnName: "id", direction: "desc" }],
      },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([{ columnName: "name", filterType: "include", values: ["a"], dataType: "VARCHAR" }]);
    expect(fm.getSorts("t")).toEqual([{ columnName: "id", direction: "desc" }]);
    expect(fm.hasAnyState("t")).toBe(true);
  });

  it("drops entries whose column is gone", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      { filters: [{ columnName: "old", filterType: "include", values: ["x"] }], sorts: [{ columnName: "old", direction: "asc" }] },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([]);
    expect(fm.getSorts("t")).toEqual([]);
    expect(fm.hasAnyState("t")).toBe(false);
  });

  it("drops a numeric range filter when the column is no longer numeric", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate("t", { filters: [{ columnName: "name", filterType: "range", min: 1, max: 5 }] }, COLS);
    expect(fm.getFilters("t")).toEqual([]);
  });

  it("drops a temporal range filter when the column is no longer temporal", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate("t", { filters: [{ columnName: "id", filterType: "range", minStr: "2026-01-01", maxStr: "2026-02-01" }] }, COLS);
    expect(fm.getFilters("t")).toEqual([]);
  });

  it("keeps range filters that still match the column type and refreshes dataType", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      {
        filters: [
          { columnName: "id", filterType: "range", min: 1, max: 5, dataType: "BIGINT" },
          { columnName: "when", filterType: "range", minStr: "2026-01-01", maxStr: "2026-02-01" },
        ],
      },
      COLS,
    );
    expect(fm.getFilters("t").map((f) => [f.columnName, f.dataType])).toEqual([
      ["id", "INTEGER"],
      ["when", "DATE"],
    ]);
  });

  it("does not fire onChange", () => {
    const fm = new ColumnFilterManager();
    const spy = vi.fn();
    fm.onChange(spy);
    fm.hydrate("t", { filters: [{ columnName: "name", filterType: "include", values: ["a"] }] }, COLS);
    expect(spy).not.toHaveBeenCalled();
  });

  it("tolerates malformed entries", () => {
    const fm = new ColumnFilterManager();
    fm.hydrate(
      "t",
      { filters: [{ columnName: "name", filterType: "bogus" as never }, null as never, { columnName: 42 as never, filterType: "include" }] },
      COLS,
    );
    expect(fm.getFilters("t")).toEqual([]);
  });
});

describe("persisted shapes round-trip", () => {
  afterEach(() => localStorage.clear());

  it("keeps columnFilters and columnSorts in app settings", () => {
    const s = persistenceService.loadAppSettings();
    s.columnFilters = { t: [{ columnName: "name", filterType: "include", values: ["a"] }] };
    s.columnSorts = { t: [{ columnName: "id", direction: "asc" }] };
    persistenceService.saveAppSettings(s);
    const back = persistenceService.loadAppSettings();
    expect(back.columnFilters).toEqual(s.columnFilters);
    expect(back.columnSorts).toEqual(s.columnSorts);
  });

  it("keeps activeDataNodeId in the environment workspace", () => {
    const svc = new EnvironmentService();
    const env = svc.create({ name: "f", kind: "folder", folderHandleId: "ipc:C:/data" });
    svc.setWorkspace(env.id, { openDataNodeIds: ["ipc/C:/data/a.csv"], openQueryIds: [], activeDataNodeId: "ipc/C:/data/a.csv" });
    expect(new EnvironmentService().get(env.id)?.workspace.activeDataNodeId).toBe("ipc/C:/data/a.csv");
  });
});
