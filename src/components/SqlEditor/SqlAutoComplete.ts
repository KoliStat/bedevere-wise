import { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { DuckDBService } from "../../data/DuckDBService";
import { KNOWN_DIRECTIVES } from "../../data/sqlScript";
import { getSchemaSnapshot } from "../../data/agent/schemaSnapshot";
import { STATS_DUCK_FUNCTIONS } from "./sqlDialect";

const DUCKDB_FUNCTIONS: string[] = [
  // Aggregate functions
  "SUM", "AVG", "COUNT", "MIN", "MAX", "STDDEV", "VARIANCE", "MEDIAN",
  "STRING_AGG", "LIST", "ARRAY_AGG", "GROUP_CONCAT", "FIRST", "LAST",
  "ANY_VALUE", "BIT_AND", "BIT_OR", "BIT_XOR", "BOOL_AND", "BOOL_OR",
  // Scalar functions
  "ABS", "CEIL", "FLOOR", "ROUND", "SQRT", "POWER", "LOG", "LN", "EXP",
  "MOD", "SIGN", "GREATEST", "LEAST", "RANDOM",
  // String functions
  "CONCAT", "LENGTH", "UPPER", "LOWER", "TRIM", "LTRIM", "RTRIM",
  "SUBSTRING", "REPLACE", "REVERSE", "LEFT", "RIGHT", "LPAD", "RPAD",
  "REPEAT", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "REGEXP_MATCHES",
  "SPLIT_PART", "STRING_SPLIT", "STRIP_ACCENTS",
  // Date/time functions
  "CURRENT_DATE", "CURRENT_TIMESTAMP", "NOW", "DATE_PART", "DATE_TRUNC",
  "DATE_DIFF", "DATE_ADD", "DATE_SUB", "EXTRACT", "STRFTIME", "STRPTIME",
  "AGE", "MAKE_DATE", "MAKE_TIMESTAMP",
  // Conversion
  "CAST", "TRY_CAST", "TYPEOF",
  // Conditional
  "CASE", "WHEN", "THEN", "ELSE", "END", "COALESCE", "NULLIF",
  "IF", "IIF", "IFNULL",
  // Window functions
  "ROW_NUMBER", "RANK", "DENSE_RANK", "NTILE", "LAG", "LEAD",
  "FIRST_VALUE", "LAST_VALUE", "NTH_VALUE",
  // Table functions
  "UNNEST", "GENERATE_SERIES", "RANGE",
  "READ_CSV", "READ_PARQUET", "READ_JSON",
];

const SQL_KEYWORDS: string[] = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING",
  "LIMIT", "OFFSET", "JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT JOIN",
  "FULL JOIN", "CROSS JOIN", "ON", "USING", "AS", "AND", "OR", "NOT",
  "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL",
  "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM",
  "CREATE TABLE", "CREATE VIEW", "CREATE TEMPORARY TABLE",
  "DROP TABLE", "DROP VIEW", "ALTER TABLE", "RENAME TO",
  "UNION", "UNION ALL", "INTERSECT", "EXCEPT",
  "DISTINCT", "ALL", "ASC", "DESC", "NULLS FIRST", "NULLS LAST",
  "WITH", "RECURSIVE", "OVER", "PARTITION BY", "ROWS", "FILTER",
  "DESCRIBE", "SHOW TABLES", "EXPLAIN", "COPY", "EXPORT",
  // GGSQL (stats_duck) extensions
  "VISUALIZE", "DRAW",
];

const SQL_TYPES: string[] = [
  "BOOLEAN", "BOOL",
  "TINYINT", "SMALLINT", "INTEGER", "INT", "BIGINT", "HUGEINT",
  "REAL", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC",
  "VARCHAR", "TEXT", "BLOB",
  "DATE", "TIME", "TIMESTAMP", "INTERVAL",
  "UUID", "JSON",
  "ENUM", "STRUCT", "MAP", "LIST", "ARRAY",
];

interface SchemaInfo {
  tables: Map<string, string[]>; // table name -> column names
  lastRefresh: number;
}

/** Initial function list before `duckdb_functions()` introspection runs. */
function staticFunctionSeed(): string[] {
  return [...DUCKDB_FUNCTIONS, ...STATS_DUCK_FUNCTIONS.map((n) => n.toUpperCase())];
}

export class SqlAutoComplete {
  private duckDBService: DuckDBService;
  private schema: SchemaInfo = { tables: new Map(), lastRefresh: 0 };
  // Seeded with the static lists (DuckDB built-ins + the stats_duck names we
  // explicitly know about) so suggestions still work before the first refresh
  // completes or when introspection fails. Replaced with the union of static
  // + dynamic names whenever `duckdb_functions()` succeeds — that's how any
  // extension-contributed functions we didn't pre-list end up in the dropdown.
  private functions: string[] = staticFunctionSeed();
  private refreshInterval = 10000; // 10 seconds

  constructor(duckDBService: DuckDBService) {
    this.duckDBService = duckDBService;
  }

  public async refreshSchema(): Promise<void> {
    // Reuse the shared snapshot helper that the agent prompt builder also
    // uses, so completion + agent-prompt always see the same schema.
    const snapshot = await getSchemaSnapshot(this.duckDBService);
    const newSchema = new Map<string, string[]>();
    for (const table of snapshot.tables) {
      newSchema.set(table.name, table.columns.map((c) => c.name));
    }
    this.schema = { tables: newSchema, lastRefresh: Date.now() };

    // Pull function names so extension-contributed functions (stats_duck,
    // etc.) round-trip into autocomplete without us hand-maintaining a list.
    // Failure leaves the seeded static list in place.
    try {
      const rows = await this.duckDBService.executeQuery(
        "SELECT DISTINCT function_name FROM duckdb_functions()",
      );
      const merged = new Set<string>(staticFunctionSeed());
      for (const row of rows) {
        const name = (row as { function_name?: unknown }).function_name;
        if (typeof name === "string" && name.length > 0) merged.add(name.toUpperCase());
      }
      this.functions = [...merged].sort();
    } catch (e) {
      console.error("Failed to refresh SQL function list:", e);
    }
  }

  public getCompletionSource() {
    return (context: CompletionContext): CompletionResult | null => {
      // Directive completion (`.no-output`, …). Only fires when the dot is
      // the first non-whitespace character on its line, so a `tablename.`
      // column-access dot doesn't accidentally suggest directives.
      const line = context.state.doc.lineAt(context.pos);
      const lineBefore = line.text.slice(0, context.pos - line.from);
      const directiveMatch = /^\s*(\.[\w-]*)$/.exec(lineBefore);
      if (directiveMatch) {
        const dir = directiveMatch[1];
        const matches = KNOWN_DIRECTIVES.filter((d) => d.startsWith(dir));
        if (matches.length > 0) {
          return {
            from: context.pos - dir.length,
            options: matches.map((d): Completion => ({
              label: d,
              type: "keyword",
              detail: "directive",
            })),
          };
        }
      }

      const word = context.matchBefore(/[\w.]+/);
      if (!word && !context.explicit) return null;

      // Refresh schema if stale
      if (Date.now() - this.schema.lastRefresh > this.refreshInterval) {
        this.refreshSchema();
      }

      const from = word ? word.from : context.pos;
      const text = word ? word.text : "";
      const textUpper = text.toUpperCase();

      // Check if we're completing after "tablename."
      const dotIndex = text.lastIndexOf(".");
      if (dotIndex >= 0) {
        const tableName = text.substring(0, dotIndex);
        const columns = this.schema.tables.get(tableName);
        if (columns) {
          const prefix = text.substring(dotIndex + 1).toLowerCase();
          return {
            from: from + dotIndex + 1,
            options: columns
              .filter((col) => col.toLowerCase().startsWith(prefix))
              .map((col): Completion => ({
                label: col,
                type: "property",
                detail: "column",
              })),
          };
        }
      }

      const options: Completion[] = [];

      // Table names
      for (const [table, columns] of this.schema.tables) {
        if (table.toUpperCase().startsWith(textUpper)) {
          options.push({
            label: table,
            type: "class",
            detail: `table (${columns.length} cols)`,
          });
        }
      }

      // Column names from all tables
      for (const [table, columns] of this.schema.tables) {
        for (const col of columns) {
          if (col.toUpperCase().startsWith(textUpper)) {
            options.push({
              label: col,
              type: "property",
              detail: `${table}.${col}`,
            });
          }
        }
      }

      // SQL keywords
      for (const kw of SQL_KEYWORDS) {
        if (kw.startsWith(textUpper)) {
          options.push({
            label: kw,
            type: "keyword",
          });
        }
      }

      // SQL types (DOUBLE, INTEGER, VARCHAR, …) — handy after CAST/AS.
      for (const ty of SQL_TYPES) {
        if (ty.startsWith(textUpper)) {
          options.push({
            label: ty,
            type: "type",
          });
        }
      }

      // DuckDB functions (static set + anything `duckdb_functions()` returned
      // on the last refresh — covers extension-contributed names too).
      for (const fn of this.functions) {
        if (fn.startsWith(textUpper)) {
          options.push({
            label: fn,
            type: "function",
            apply: fn + "()",
          });
        }
      }

      if (options.length === 0) return null;

      return { from, options };
    };
  }
}
