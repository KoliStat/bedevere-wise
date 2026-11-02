import { describe, expect, it } from "vitest";
import { resolveTableName } from "../tableNames";

describe("resolveTableName", () => {
  it("keeps the base name when nothing is taken", () => {
    expect(resolveTableName("AE", new Set())).toBe("AE");
  });

  it("keeps the base name when only other names are taken", () => {
    expect(resolveTableName("AE", new Set(["DM", "CM"]))).toBe("AE");
  });

  it("appends _2 when the base name is taken", () => {
    expect(resolveTableName("AE", new Set(["AE"]))).toBe("AE_2");
  });

  it("counts upward past taken suffixes", () => {
    expect(resolveTableName("AE", new Set(["AE", "AE_2", "AE_3"]))).toBe("AE_4");
  });

  it("compares names case-insensitively, like the DuckDB catalog", () => {
    expect(resolveTableName("AE", new Set(["ae"]))).toBe("AE_2");
    expect(resolveTableName("ae", new Set(["AE", "Ae_2"]))).toBe("ae_3");
  });

  it("accepts a plain array of taken names", () => {
    expect(resolveTableName("AE", ["AE", "AE_2"])).toBe("AE_3");
  });

  it("leaves a free base name alone even when a suffixed sibling exists", () => {
    expect(resolveTableName("AE", new Set(["AE_2"]))).toBe("AE");
  });
});
