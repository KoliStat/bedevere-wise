import { describe, it, expect } from "vitest";
import { quoteIdent, quoteLiteral } from "../sqlIdent";
import { ColumnFilterManager } from "../ColumnFilterManager";

/**
 * Regression tests for the SQL-injection hardening: identifiers sourced
 * from untrusted files (column names from a CSV header / Parquet schema,
 * table names from a filename) must be escaped via `quoteIdent`, and any
 * embedded `"` doubled, so a crafted name can't break out of the quotes.
 * See the v0.14 "Harden SQL identifier quoting" change.
 */
describe("quoteIdent", () => {
  it("wraps a plain identifier in double quotes (byte-identical to the old path)", () => {
    expect(quoteIdent("foo")).toBe('"foo"');
  });

  it("doubles an embedded double quote so the identifier can't be escaped", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("keeps an injection attempt inside the quotes", () => {
    // A column/table named to break out and stack a statement.
    const evil = 'x" AS y; DROP TABLE t; --';
    const quoted = quoteIdent(evil);
    expect(quoted).toBe('"x"" AS y; DROP TABLE t; --"');
    // The lone closing quote the attacker supplied is doubled, so the
    // identifier never terminates early.
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
  });
});

describe("quoteLiteral", () => {
  it("wraps a plain string literal in single quotes", () => {
    expect(quoteLiteral("foo")).toBe("'foo'");
  });

  it("doubles an embedded single quote", () => {
    expect(quoteLiteral("a'b")).toBe("'a''b'");
    expect(quoteLiteral("'); DROP TABLE t; --")).toBe("'''); DROP TABLE t; --'");
  });
});

describe("ColumnFilterManager escapes untrusted identifiers", () => {
  const ds = "dataset-1";

  it("escapes a malicious column name in ORDER BY", () => {
    const m = new ColumnFilterManager();
    m.setSort(ds, { columnName: 'c"x', direction: "asc" });
    expect(m.buildOrderByClause(ds)).toBe('ORDER BY "c""x" ASC');
  });

  it("escapes a malicious table name in the filtered query", () => {
    const m = new ColumnFilterManager();
    expect(m.buildFilteredQuery('t"x', ds)).toBe('SELECT * FROM "t""x"');
  });

  it("escapes a malicious column name in a WHERE condition", () => {
    const m = new ColumnFilterManager();
    m.setFilter(ds, { columnName: 'c"x', filterType: "include", values: ["a"] });
    expect(m.buildWhereClause(ds)).toBe('WHERE "c""x" IN (\'a\')');
  });
});
