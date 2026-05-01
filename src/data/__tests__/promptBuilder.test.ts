import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserMessage } from "../agent/promptBuilder";
import type { SchemaSnapshot } from "../agent/schemaSnapshot";

const PENGUINS: SchemaSnapshot = {
  takenAt: "2026-04-30T12:00:00.000Z",
  statsDuckLoaded: true,
  tables: [
    {
      name: "penguins",
      columns: [
        { name: "species", type: "VARCHAR" },
        { name: "island", type: "VARCHAR" },
        { name: "bill_length_mm", type: "DOUBLE" },
        { name: "body_mass_g", type: "INTEGER" },
      ],
    },
  ],
};

describe("buildSystemPrompt", () => {
  it("is byte-stable across calls with identical schema", () => {
    expect(buildSystemPrompt(PENGUINS)).toBe(buildSystemPrompt(PENGUINS));
  });

  it("ignores the snapshot's `takenAt` field (so caching can hit)", () => {
    const a = buildSystemPrompt(PENGUINS);
    const b = buildSystemPrompt({ ...PENGUINS, takenAt: "1999-01-01T00:00:00.000Z" });
    expect(a).toBe(b);
  });

  it("sorts tables alphabetically so iteration order doesn't break the cache", () => {
    const reordered: SchemaSnapshot = {
      ...PENGUINS,
      tables: [
        { name: "iris", columns: [{ name: "petal_length", type: "DOUBLE" }] },
        ...PENGUINS.tables,
      ],
    };
    const same: SchemaSnapshot = {
      ...PENGUINS,
      tables: [
        ...PENGUINS.tables,
        { name: "iris", columns: [{ name: "petal_length", type: "DOUBLE" }] },
      ],
    };
    expect(buildSystemPrompt(reordered)).toBe(buildSystemPrompt(same));
  });

  it("changes when a column is added", () => {
    const extra: SchemaSnapshot = {
      ...PENGUINS,
      tables: [
        {
          name: "penguins",
          columns: [
            ...PENGUINS.tables[0].columns,
            { name: "year", type: "INTEGER" },
          ],
        },
      ],
    };
    expect(buildSystemPrompt(extra)).not.toBe(buildSystemPrompt(PENGUINS));
  });

  it("includes the stats_duck block only when stats_duck is loaded", () => {
    const withDuck = buildSystemPrompt(PENGUINS);
    const noDuck = buildSystemPrompt({ ...PENGUINS, statsDuckLoaded: false });
    // Loaded → cheatsheet syntax is present; agent is encouraged to use it.
    expect(withDuck).toMatch(/DRAW <mark>/);
    expect(withDuck).toMatch(/Reach for VISUALIZE when/);
    // Not loaded → cheatsheet absent; agent told the keyword is unavailable.
    expect(noDuck).not.toMatch(/DRAW <mark>/);
    expect(noDuck).toMatch(/extensions are NOT loaded/);
  });

  it("documents the .no-output directive so the agent uses it", () => {
    expect(buildSystemPrompt(PENGUINS)).toMatch(/\.no-output/);
  });

  it("emits a 'no tables loaded' line for an empty schema", () => {
    const empty = buildSystemPrompt({ ...PENGUINS, tables: [] });
    expect(empty).toMatch(/no tables loaded/);
  });

  it("renders columns in the order they were declared (DuckDB's DESCRIBE order)", () => {
    const out = buildSystemPrompt(PENGUINS);
    const idxSpecies = out.indexOf("  species:");
    const idxBill = out.indexOf("  bill_length_mm:");
    const idxMass = out.indexOf("  body_mass_g:");
    expect(idxSpecies).toBeGreaterThan(0);
    expect(idxBill).toBeGreaterThan(idxSpecies);
    expect(idxMass).toBeGreaterThan(idxBill);
  });
});

describe("buildUserMessage", () => {
  it("trims surrounding whitespace", () => {
    expect(buildUserMessage("  show me the top 10 penguins by body mass  ")).toBe(
      "show me the top 10 penguins by body mass",
    );
  });
  it("preserves internal newlines", () => {
    expect(buildUserMessage("line1\nline2")).toBe("line1\nline2");
  });
});
