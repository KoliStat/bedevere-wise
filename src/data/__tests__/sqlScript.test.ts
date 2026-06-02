import { describe, it, expect } from "vitest";
import {
  parseScript,
  classifyStatement,
  firstSqlKeyword,
  extractCreateTargetName,
  hasTopLevelVisualize,
} from "../sqlScript";

describe("parseScript", () => {
  it("returns [] for empty / whitespace / comment-only input", () => {
    expect(parseScript("")).toEqual([]);
    expect(parseScript("   ")).toEqual([]);
    expect(parseScript("-- just a comment\n")).toEqual([]);
    expect(parseScript("/* block */\n   ")).toEqual([]);
  });

  it("captures a single statement with or without trailing semicolon", () => {
    expect(parseScript("SELECT 1")).toEqual([{ sql: "SELECT 1", directives: [] }]);
    expect(parseScript("SELECT 1;")).toEqual([{ sql: "SELECT 1", directives: [] }]);
    expect(parseScript("  SELECT 1 ;  ")).toEqual([{ sql: "SELECT 1", directives: [] }]);
  });

  it("splits multiple statements on top-level semicolons", () => {
    const out = parseScript("SELECT 1; SELECT 2; SELECT 3");
    expect(out.map((s) => s.sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("does not split on semicolons inside string literals", () => {
    const out = parseScript("SELECT 'a;b;c'; SELECT 2");
    expect(out.map((s) => s.sql)).toEqual(["SELECT 'a;b;c'", "SELECT 2"]);
  });

  it("honors SQL doubled-quote escapes inside strings", () => {
    const out = parseScript("SELECT 'It''s a;test'; SELECT 2");
    expect(out.map((s) => s.sql)).toEqual(["SELECT 'It''s a;test'", "SELECT 2"]);
  });

  it("honors backslash escapes inside strings", () => {
    const out = parseScript("SELECT 'a\\';b' ; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[1].sql).toBe("SELECT 2");
  });

  it("does not split on semicolons inside double-quoted identifiers", () => {
    const out = parseScript('SELECT "weird;name" FROM t; SELECT 2');
    expect(out.map((s) => s.sql)).toEqual(['SELECT "weird;name" FROM t', "SELECT 2"]);
  });

  it("does not split on semicolons inside line / block comments", () => {
    expect(parseScript("SELECT 1 -- a;b\nFROM t; SELECT 2").map((s) => s.sql)).toEqual([
      "SELECT 1 -- a;b\nFROM t",
      "SELECT 2",
    ]);
    expect(parseScript("SELECT 1 /* a;b */ FROM t; SELECT 2").map((s) => s.sql)).toEqual([
      "SELECT 1 /* a;b */ FROM t",
      "SELECT 2",
    ]);
  });

  it("does not split on semicolons inside dollar-quoted strings", () => {
    const out = parseScript("SELECT $$has;semis$$; SELECT 2");
    expect(out.map((s) => s.sql)).toEqual(["SELECT $$has;semis$$", "SELECT 2"]);
  });

  it("supports tagged dollar quotes", () => {
    const out = parseScript("SELECT $tag$nested $$ ; still in$tag$; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0].sql).toBe("SELECT $tag$nested $$ ; still in$tag$");
  });

  it("attaches a leading directive to the next statement", () => {
    const out = parseScript(".no-output\nCREATE TABLE t AS SELECT 1;");
    expect(out).toEqual([
      { sql: "CREATE TABLE t AS SELECT 1", directives: [".no-output"] },
    ]);
  });

  it("queues multiple directives for the same statement", () => {
    const out = parseScript(".one\n.two\nSELECT 1;");
    expect(out[0].directives).toEqual([".one", ".two"]);
  });

  it("resets directives after the statement they modify", () => {
    const out = parseScript(".no-output\nCREATE TABLE t AS SELECT 1;\nSELECT * FROM t;");
    expect(out).toHaveLength(2);
    expect(out[0].directives).toEqual([".no-output"]);
    expect(out[1].directives).toEqual([]);
  });

  it("handles the user's headline mixed-script example", () => {
    const out = parseScript(
      ".no-output\n" +
        "CREATE TABLE penguins_clean AS SELECT * FROM penguins;\n" +
        "VISUALIZE bill_depth_mm AS x FROM penguins_clean DRAW point;",
    );
    expect(out).toHaveLength(2);
    expect(out[0].directives).toEqual([".no-output"]);
    expect(out[0].sql.startsWith("CREATE TABLE")).toBe(true);
    expect(out[1].directives).toEqual([]);
    expect(out[1].sql.startsWith("VISUALIZE")).toBe(true);
  });
});

describe("classifyStatement", () => {
  it("recognises VISUALIZE as the chart kind", () => {
    expect(classifyStatement("VISUALIZE x AS y FROM t DRAW point")).toBe("visualize");
    expect(classifyStatement("  visualize x AS y FROM t DRAW point")).toBe("visualize");
  });
  it("treats SELECT and WITH as query kinds", () => {
    expect(classifyStatement("SELECT 1")).toBe("query");
    expect(classifyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe("query");
  });
  it("routes WITH … VISUALIZE to the chart kind, not the wrapped-query path", () => {
    // Headline bug: a CTE feeding VISUALIZE starts with WITH, so the
    // first-keyword check misrouted it to the result-grid path and the
    // CREATE TABLE wrapper broke the embedded VISUALIZE.
    expect(
      classifyStatement("WITH c AS (SELECT 1 AS r, 2 AS p) VISUALIZE r AS x, p AS y FROM c DRAW point"),
    ).toBe("visualize");
    expect(
      classifyStatement("with c as (select 1) visualize x as x from c draw bar"),
    ).toBe("visualize");
  });
  it("keeps a WITH whose only 'visualize' is inside a string/identifier as a query", () => {
    expect(classifyStatement("WITH c AS (SELECT 'visualize' AS s) SELECT * FROM c")).toBe("query");
    expect(classifyStatement('WITH c AS (SELECT 1 AS visualize_count) SELECT * FROM c')).toBe("query");
  });
  it("treats CREATE / INSERT / DROP as side-effects", () => {
    expect(classifyStatement("CREATE TABLE t AS SELECT 1")).toBe("side-effect");
    expect(classifyStatement("INSERT INTO t VALUES (1)")).toBe("side-effect");
    expect(classifyStatement("DROP TABLE t")).toBe("side-effect");
  });
  it("skips leading comments before reading the keyword", () => {
    expect(classifyStatement("-- header\nSELECT 1")).toBe("query");
    expect(classifyStatement("/* header */ SELECT 1")).toBe("query");
  });
});

describe("extractCreateTargetName", () => {
  it("returns the table name for a plain CREATE TABLE", () => {
    expect(extractCreateTargetName("CREATE TABLE foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("CREATE TABLE foo (a INT)")).toBe("foo");
  });
  it("handles OR REPLACE / TEMP / TEMPORARY / IF NOT EXISTS", () => {
    expect(extractCreateTargetName("CREATE OR REPLACE TABLE foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("CREATE TEMP TABLE foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("CREATE TEMPORARY TABLE foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("CREATE TABLE IF NOT EXISTS foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("CREATE OR REPLACE TEMP TABLE IF NOT EXISTS foo AS SELECT 1")).toBe("foo");
  });
  it("handles CREATE VIEW", () => {
    expect(extractCreateTargetName("CREATE VIEW v AS SELECT 1")).toBe("v");
    expect(extractCreateTargetName("CREATE OR REPLACE VIEW v AS SELECT 1")).toBe("v");
  });
  it("strips double-quoted identifiers (with `\"\"` escape)", () => {
    expect(extractCreateTargetName('CREATE TABLE "weird name" AS SELECT 1')).toBe("weird name");
    expect(extractCreateTargetName('CREATE TABLE "she said ""hi""" AS SELECT 1')).toBe('she said "hi"');
  });
  it("skips leading whitespace and comments", () => {
    expect(extractCreateTargetName("  -- header\n  CREATE TABLE foo AS SELECT 1")).toBe("foo");
    expect(extractCreateTargetName("/* header */\n  CREATE TABLE foo AS SELECT 1")).toBe("foo");
  });
  it("returns null for non-CREATE statements", () => {
    expect(extractCreateTargetName("SELECT 1")).toBeNull();
    expect(extractCreateTargetName("INSERT INTO foo VALUES (1)")).toBeNull();
    expect(extractCreateTargetName("DROP TABLE foo")).toBeNull();
    expect(extractCreateTargetName("")).toBeNull();
  });
  it("returns null for schema-qualified targets (only bare names supported)", () => {
    expect(extractCreateTargetName("CREATE TABLE myschema.foo AS SELECT 1")).toBeNull();
  });
  it("ignores CREATE INDEX / CREATE SCHEMA / etc.", () => {
    expect(extractCreateTargetName("CREATE INDEX idx ON foo (a)")).toBeNull();
    expect(extractCreateTargetName("CREATE SCHEMA s")).toBeNull();
  });
});

describe("hasTopLevelVisualize", () => {
  it("finds a standalone VISUALIZE after a CTE", () => {
    expect(hasTopLevelVisualize("WITH c AS (SELECT 1) VISUALIZE x FROM c DRAW point")).toBe(true);
    expect(hasTopLevelVisualize("with c as (select 1) visualize x from c")).toBe(true);
  });
  it("returns false when there is no VISUALIZE token", () => {
    expect(hasTopLevelVisualize("WITH c AS (SELECT 1) SELECT * FROM c")).toBe(false);
    expect(hasTopLevelVisualize("SELECT 1")).toBe(false);
  });
  it("ignores VISUALIZE inside string literals", () => {
    expect(hasTopLevelVisualize("SELECT 'VISUALIZE this'")).toBe(false);
    expect(hasTopLevelVisualize("SELECT $$VISUALIZE$$")).toBe(false);
  });
  it("ignores VISUALIZE inside parentheses (depth > 0)", () => {
    // Not legal SQL, but the depth guard should still not claim it.
    expect(hasTopLevelVisualize("SELECT * FROM (VISUALIZE x FROM t)")).toBe(false);
  });
  it("requires a word boundary so identifiers don't match", () => {
    expect(hasTopLevelVisualize("SELECT 1 AS visualize_count FROM t")).toBe(false);
    expect(hasTopLevelVisualize("SELECT myvisualize FROM t")).toBe(false);
  });
  it("ignores VISUALIZE inside comments", () => {
    expect(hasTopLevelVisualize("SELECT 1 -- VISUALIZE\nFROM t")).toBe(false);
    expect(hasTopLevelVisualize("SELECT 1 /* VISUALIZE */ FROM t")).toBe(false);
  });
});

describe("firstSqlKeyword", () => {
  it("returns the uppercase first keyword", () => {
    expect(firstSqlKeyword("select 1")).toBe("SELECT");
    expect(firstSqlKeyword("  CREATE TABLE t")).toBe("CREATE");
  });
  it("skips line comments and block comments", () => {
    expect(firstSqlKeyword("-- skip\nSELECT 1")).toBe("SELECT");
    expect(firstSqlKeyword("/* skip */ SELECT 1")).toBe("SELECT");
  });
  it("returns '' when the input has no alphabetic prefix", () => {
    expect(firstSqlKeyword("")).toBe("");
    expect(firstSqlKeyword("   ")).toBe("");
    expect(firstSqlKeyword(";")).toBe("");
  });
});
