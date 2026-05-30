import type { DuckDBService } from "../data/DuckDBService";
import {
  parseScript,
  classifyStatement,
  extractCreateTargetName,
  KNOWN_DIRECTIVES,
} from "../data/sqlScript";
import { DuckDBDataProvider } from "../data/DuckDBDataProvider";

const KNOWN = new Set<string>(KNOWN_DIRECTIVES);

export interface DispatchedResult {
  /** The DuckDB-backed data provider for the last `query`/CREATE result.
   *  null when the script produced no displayable relation. */
  resultProvider: DuckDBDataProvider | null;
  /** Friendly result-table name surfaced in the canvas chrome. */
  resultName: string | null;
}

let resultCounter = 0;

/**
 * Slim version of TabManager.executeBareSQL for the /embed route. The
 * main app's dispatcher routes to tabs (chart / dataset / text); the
 * embed only ever shows a single result panel, so we just hand back
 * the data provider for the last query-producing statement and let
 * EmbedApp render it.
 *
 * VISUALIZE is intentionally not supported here — the embed targets
 * tabular result rendering for blog posts; chart rendering would pull
 * vega-embed + stats_duck into the embed bundle. If a script contains
 * VISUALIZE we throw a friendly error so the embed surfaces it as a
 * banner instead of silently returning a stale result.
 */
export async function dispatchEmbedScript(
  input: string,
  duck: DuckDBService,
): Promise<DispatchedResult> {
  const script = parseScript(input);
  if (script.length === 0) return { resultProvider: null, resultName: null };

  // Validate directives up front so a typo in statement #3 doesn't
  // leave statements #1 and #2 executed.
  for (const { directives } of script) {
    for (const d of directives) {
      if (!KNOWN.has(d.toLowerCase())) {
        throw new Error(`Unknown SQL directive: ${d}`);
      }
    }
  }

  let lastProvider: DuckDBDataProvider | null = null;
  let lastName: string | null = null;

  for (const { sql, directives } of script) {
    const kind = classifyStatement(sql);
    const noOutput = directives.some((d) => d.toLowerCase() === ".no-output");

    if (kind === "visualize") {
      throw new Error(
        "VISUALIZE / charting isn't supported in /embed yet — open the same query in the full app.",
      );
    }

    if (kind === "query" && !noOutput) {
      resultCounter += 1;
      const name = `result_${resultCounter}`;
      const provider = await duck.executeQueryAsDataProvider(sql, name);
      lastProvider = provider;
      lastName = name;
      continue;
    }

    // Side-effects: CREATE/INSERT/DROP/etc. Run, then auto-display the
    // created relation when applicable (matches the main app's behavior).
    await duck.executeQuery(sql);
    if (!noOutput) {
      const created = extractCreateTargetName(sql);
      if (created) {
        const provider = new DuckDBDataProvider(duck, created, "");
        lastProvider = provider;
        lastName = created;
      }
    }
  }

  return { resultProvider: lastProvider, resultName: lastName };
}
