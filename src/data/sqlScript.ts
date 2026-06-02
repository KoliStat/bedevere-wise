/**
 * Multi-statement parser for the SQL editor. Splits a script into statements,
 * extracts leading dot-directives, and classifies each statement so the
 * dispatcher can route it (table tab / chart tab / silent side-effect).
 *
 * Handles:
 *   - `--` line comments and block comments (skipped).
 *   - `'...'` and `"..."` literals, including SQL `''`/`""` doubled-quote
 *     escapes and `\` escapes inside quotes.
 *   - PostgreSQL-style dollar-quoted strings: `$$...$$` and `$tag$...$tag$`.
 *   - Lines starting with `.directive` between statements. A directive
 *     applies to the next non-directive statement and then resets.
 */

export interface ScriptStatement {
  sql: string;
  directives: string[];
}

export type StatementKind = "query" | "visualize" | "side-effect";

/**
 * Directives the SQL dispatcher recognises. Single source of truth: the
 * dispatcher uses this for validation and the editor's autocomplete uses it
 * to surface them as suggestions when the user types `.`.
 */
export const KNOWN_DIRECTIVES = [".no-output"] as const;

export function parseScript(input: string): ScriptStatement[] {
  const out: ScriptStatement[] = [];
  let pending: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    if (input[i] === "-" && input[i + 1] === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (input[i] === "/" && input[i + 1] === "*") {
      i = skipBlockComment(input, i);
      continue;
    }

    // Directive: a line starting with `.`. Captured into `pending` and
    // attached to the next SQL statement we encounter.
    if (input[i] === ".") {
      const start = i;
      while (i < input.length && input[i] !== "\n") i++;
      pending.push(input.slice(start, i).trim());
      continue;
    }

    // SQL statement: scan forward to the next top-level `;`, respecting
    // string and comment boundaries so semicolons inside literals don't
    // split the statement.
    const stmtStart = i;
    while (i < input.length) {
      const c = input[i];
      if (c === "-" && input[i + 1] === "-") {
        while (i < input.length && input[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && input[i + 1] === "*") {
        i = skipBlockComment(input, i);
        continue;
      }
      if (c === "'" || c === '"') {
        i = skipQuoted(input, i, c);
        continue;
      }
      if (c === "$") {
        const after = skipDollarQuoted(input, i);
        if (after !== null) {
          i = after;
          continue;
        }
      }
      if (c === ";") break;
      i++;
    }

    const stmt = input.slice(stmtStart, i).trim();
    if (stmt.length > 0) {
      out.push({ sql: stmt, directives: pending });
      pending = [];
    }
    if (input[i] === ";") i++;
  }

  return out;
}

/** Skip past `/* ... *\/` starting at the slash. Returns index after the `*\/`,
 *  or `input.length` if unterminated. */
function skipBlockComment(input: string, start: number): number {
  let i = start + 2;
  while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
  return i < input.length ? i + 2 : i;
}

/** Skip a quoted string starting at the open quote. Returns the index AFTER
 *  the closing quote; treats `''`/`""` as escaped doubles and honors `\`. */
function skipQuoted(input: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < input.length) {
    const c = input[i];
    if (c === "\\" && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (c === quote) {
      if (input[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return i;
}

/** Try to skip a `$tag$...$tag$` dollar-quoted string starting at `start`.
 *  Returns the index AFTER the closing tag, or null if `start` doesn't open
 *  a dollar quote. */
function skipDollarQuoted(input: string, start: number): number | null {
  let j = start + 1;
  while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
  if (j >= input.length || input[j] !== "$") return null;
  const tag = input.slice(start, j + 1);
  const end = input.indexOf(tag, j + 1);
  return end === -1 ? input.length : end + tag.length;
}

export function classifyStatement(sql: string): StatementKind {
  const tok = firstSqlKeyword(sql);
  if (tok === "VISUALIZE") return "visualize";
  // `WITH <cte> VISUALIZE …` (ggsql) starts with WITH, so the first-keyword
  // check alone would route it to the result-grid path, which wraps the
  // statement in `CREATE TABLE result_n AS (…)`. That's invalid SQL —
  // VISUALIZE can't appear inside CREATE TABLE AS — and DuckDB's native
  // parser claims the CREATE before the stats_duck extension can intercept
  // the embedded VISUALIZE. Scan for a standalone top-level VISUALIZE so
  // these run raw (the extension's own GgsqlParse does the same depth-0
  // scan to claim the statement).
  if (tok === "WITH" && hasTopLevelVisualize(sql)) return "visualize";
  if (tok === "SELECT" || tok === "WITH") return "query";
  return "side-effect";
}

/**
 * True when `input` contains a standalone `VISUALIZE` keyword at paren
 * depth 0, outside of string literals, dollar-quotes and comments. Used
 * to route `WITH … VISUALIZE` scripts to the chart path. Mirrors the
 * stats_duck extension's claim logic so client and engine agree on what
 * counts as a plot statement.
 */
export function hasTopLevelVisualize(input: string): boolean {
  let i = 0;
  let depth = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === "-" && input[i + 1] === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && input[i + 1] === "*") {
      i = skipBlockComment(input, i);
      continue;
    }
    if (c === "'" || c === '"') {
      i = skipQuoted(input, i, c);
      continue;
    }
    if (c === "$") {
      const after = skipDollarQuoted(input, i);
      if (after !== null) {
        i = after;
        continue;
      }
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { if (depth > 0) depth--; i++; continue; }
    // Only consider a match at top level, on a word boundary, so column
    // aliases / identifiers containing "visualize" don't trip it.
    if (depth === 0 && (c === "v" || c === "V")) {
      const prev = i > 0 ? input[i - 1] : " ";
      if (!/[A-Za-z0-9_]/.test(prev)) {
        const word = input.slice(i, i + 9);
        const next = input[i + 9];
        if (/^visualize$/i.test(word) && (next === undefined || !/[A-Za-z0-9_]/.test(next))) {
          return true;
        }
      }
    }
    i++;
  }
  return false;
}

/**
 * First SQL keyword (uppercased) of `input`, skipping leading whitespace,
 * `--` line comments, and block comments. Returns "" when nothing alphabetic
 * is reached.
 */
export function firstSqlKeyword(input: string): string {
  return stripLeadingTrivia(input).match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? "";
}

/**
 * If `sql` is `CREATE [OR REPLACE] [TEMP] TABLE/VIEW [IF NOT EXISTS] <name> …`,
 * return `<name>` (with quotes stripped) so the dispatcher can open the new
 * relation as a tab. Returns null for any other statement, or for a
 * schema-qualified target (`schema.name`) — only bare names are supported.
 */
export function extractCreateTargetName(sql: string): string | null {
  const stripped = stripLeadingTrivia(sql);
  // The `(?![\w.])` boundary prevents the identifier branch from backtracking
  // a shorter name out of a schema-qualified target like `myschema.foo` —
  // such targets are intentionally rejected (we only auto-display bare names).
  const m = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|[A-Za-z_]\w*)(?![\w.])/i.exec(stripped);
  if (!m) return null;
  let name = m[1];
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/""/g, '"');
  }
  return name;
}

/** Skip leading whitespace and comments, returning the substring that begins
 *  at the first significant character. */
function stripLeadingTrivia(input: string): string {
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (input[i] === "-" && input[i + 1] === "-") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (input[i] === "/" && input[i + 1] === "*") {
      i = skipBlockComment(input, i);
      continue;
    }
    break;
  }
  return input.slice(i);
}
