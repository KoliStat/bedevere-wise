import type { DuckDBService } from "../data/DuckDBService";
import {
  parseScript,
  classifyStatement,
  extractCreateTargetName,
  KNOWN_DIRECTIVES,
} from "../data/sqlScript";
import { DuckDBDataProvider } from "../data/DuckDBDataProvider";
import { runVisualize, type VisualizeResult } from "../data/visualize";

const KNOWN = new Set<string>(KNOWN_DIRECTIVES);

/**
 * Dispatched result of running a script through the embed. Discriminated
 * by `kind` so the panel can mount the right visualizer:
 *   - "table" — last `query` / auto-displayed CREATE produced a relation;
 *               provider + name flow to SpreadsheetVisualizer.
 *   - "chart" — last statement was VISUALIZE; spec + datasets flow to
 *               ChartVisualizer.
 *   - "none"  — script ran but produced no displayable result
 *               (side-effects only, .no-output, empty script, …).
 */
export type DispatchedResult =
  | {
      kind: "table";
      resultProvider: DuckDBDataProvider;
      resultName: string;
    }
  | {
      kind: "chart";
      visualizeResult: VisualizeResult;
      resultName: string;
    }
  | { kind: "none" };

let resultCounter = 0;
let chartCounter = 0;

/**
 * Slim version of TabManager.executeBareSQL for the /embed route. The
 * main app's dispatcher routes to tabs (chart / dataset / text); the
 * embed only ever shows a single result panel, so we just hand back
 * the data needed to render the last displayable statement.
 *
 * VISUALIZE rides {@link runVisualize} — the spec + datasets come back
 * pre-processed (Arrow rows unwrapped, decimals scaled, composite spec
 * data refs patched) and EmbedApp routes them to ChartVisualizer via
 * EmbedResultPanel.showChart. ChartVisualizer dynamic-imports vega-embed
 * so the embed entry bundle stays slim until the user actually runs a
 * VISUALIZE query.
 */
export async function dispatchEmbedScript(
  input: string,
  duck: DuckDBService,
): Promise<DispatchedResult> {
  const script = parseScript(input);
  if (script.length === 0) return { kind: "none" };

  // Validate directives up front so a typo in statement #3 doesn't
  // leave statements #1 and #2 executed.
  for (const { directives } of script) {
    for (const d of directives) {
      if (!KNOWN.has(d.toLowerCase())) {
        throw new Error(`Unknown SQL directive: ${d}`);
      }
    }
  }

  let last: DispatchedResult = { kind: "none" };

  for (const { sql, directives } of script) {
    const kind = classifyStatement(sql);
    const noOutput = directives.some((d) => d.toLowerCase() === ".no-output");

    if (kind === "visualize") {
      if (noOutput) {
        // VISUALIZE with .no-output: still execute through stats_duck (so a
        // bad spec / missing table errors out the same way) but don't
        // surface the chart. Mirrors the side-effecting branch below.
        await runVisualize(sql, duck);
        continue;
      }
      const visualizeResult = await runVisualize(sql, duck);
      chartCounter += 1;
      last = {
        kind: "chart",
        visualizeResult,
        resultName: `chart_${chartCounter}`,
      };
      continue;
    }

    if (kind === "query" && !noOutput) {
      resultCounter += 1;
      const name = `result_${resultCounter}`;
      const provider = await duck.executeQueryAsDataProvider(sql, name);
      last = { kind: "table", resultProvider: provider, resultName: name };
      continue;
    }

    // Side-effects: CREATE/INSERT/DROP/etc. Run, then auto-display the
    // created relation when applicable (matches the main app's behavior).
    await duck.executeQuery(sql);
    if (!noOutput) {
      const created = extractCreateTargetName(sql);
      if (created) {
        const provider = new DuckDBDataProvider(duck, created, "");
        last = { kind: "table", resultProvider: provider, resultName: created };
      }
    }
  }

  return last;
}
