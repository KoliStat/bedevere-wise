import type { SchemaSnapshot, SchemaTable } from "./schemaSnapshot";

/**
 * Pure functions that build the system + user messages for a one-shot
 * text-to-SQL request. Same `SchemaSnapshot` input → identical bytes (the
 * snapshot's `takenAt` field is intentionally ignored), so Anthropic prompt
 * caching can hit on repeated `.ai` calls within a session.
 */

/**
 * Top-level instruction block. Frozen across calls — schema is appended
 * after, and the cache breakpoint sits at the end of `buildSystemPrompt`.
 */
const ROLE_BLOCK = `You are a SQL assistant for a local DuckDB-WASM database. The user types a natural-language prompt; you reply with a DuckDB SQL script that answers it.

Output rules — non-negotiable:
- Reply with ONE SQL script, nothing else. No prose, no commentary, no explanations.
- Do NOT wrap the script in Markdown code fences (\`\`\`sql … \`\`\`).
- Use semicolons to separate multiple statements.
- DuckDB speaks the PostgreSQL dialect; prefer DuckDB-idiomatic functions when they're shorter.

Multi-statement scripts:
- Each statement is dispatched independently. SELECT/WITH opens as a result tab; CREATE TABLE / CREATE VIEW also auto-opens the new relation as a tab; everything else runs silently.
- Prefix a statement with the directive line \`.no-output\` (on its own line, immediately before the statement) to suppress its tab — useful for intermediate \`CREATE TABLE foo AS …\` steps when only the next query/chart should surface.
- Example:
    .no-output
    CREATE TABLE penguins_clean AS SELECT * FROM penguins WHERE sex IS NOT NULL;
    SELECT species, AVG(body_mass_g) FROM penguins_clean GROUP BY species;`;

const STATS_DUCK_BLOCK = `Stats and visualization (the stats_duck DuckDB extension is loaded):
- Hypothesis testing: \`ttest_2samp(group_a_expr, group_b_expr)\` for Welch's two-sample t-test (NULLs ignored). Non-parametric: \`mann_whitney_u\`. Use \`CASE WHEN species = 'Adelie' THEN body_mass_g END\` to slice one group per arg.
- Summary stats: \`summary_stats(col)\` aggregate returning a STRUCT (count, mean, sd, quartiles, skew, kurtosis).
- Charts: \`VISUALIZE <expr> AS x, <expr> AS y[, <expr> AS color] FROM <table> DRAW <mark>\` where \`<mark>\` is one of \`point\`, \`line\`, \`bar\`, \`area\`, \`tick\`, \`circle\`, \`square\`, \`rect\`. Reach for VISUALIZE when the user asks for a plot/chart/scatter/histogram.`;

const NO_STATS_DUCK_BLOCK = `Stats / visualization extensions are NOT loaded — the \`VISUALIZE\` keyword and \`summary_stats\` / \`ttest_2samp\` / \`mann_whitney_u\` functions are unavailable. Stick to standard SQL aggregates (\`AVG\`, \`STDDEV\`, \`COUNT\`, \`PERCENTILE_CONT\`, …).`;

/**
 * Build the system prompt. Excludes any volatile data (timestamps, sample
 * rows, request IDs) so two calls with the same schema produce identical
 * bytes — a hard requirement for prompt-caching cache hits.
 */
export function buildSystemPrompt(schema: SchemaSnapshot): string {
  const sections: string[] = [ROLE_BLOCK];
  sections.push(schema.statsDuckLoaded ? STATS_DUCK_BLOCK : NO_STATS_DUCK_BLOCK);
  sections.push(formatSchema(schema.tables));
  return sections.join("\n\n");
}

/**
 * Build the user-turn content. Plain text — the user's prompt as typed.
 * Kept separate from the system prompt so the cache breakpoint can sit
 * between them (the system prefix is reused across calls; only this varies).
 */
export function buildUserMessage(prompt: string): string {
  return prompt.trim();
}

/** Deterministic schema rendering: tables sorted by name, columns kept in
 *  DuckDB's `DESCRIBE` order (matches their declared ordinal). */
function formatSchema(tables: SchemaTable[]): string {
  if (tables.length === 0) {
    return "Schema: (no tables loaded)";
  }
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = ["Schema:"];
  for (const t of sorted) {
    lines.push(`TABLE ${t.name}`);
    for (const c of t.columns) {
      lines.push(`  ${c.name}: ${c.type}`);
    }
  }
  return lines.join("\n");
}
