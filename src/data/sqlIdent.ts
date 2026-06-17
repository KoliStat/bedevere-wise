/**
 * Quote a SQL identifier (table name, view name, etc.) so it survives
 * characters like dashes, dots, reserved words, and whitespace. DuckDB
 * uses double quotes for identifiers; embedded double quotes are escaped
 * by doubling.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL string literal: wrap in single quotes and escape embedded
 * single quotes by doubling. Returns the fully-quoted literal (including the
 * surrounding quotes) — `quoteLiteral("a'b")` → `'a''b'`. Use this everywhere
 * a user-supplied string is interpolated into SQL (file paths, names in
 * `WHERE` clauses, COPY targets) so escaping lives in one audited place.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
