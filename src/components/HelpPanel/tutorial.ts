/**
 * "How to" tab content for the Palmer Penguins sample dataset. A flat
 * list of mixed-kind nodes (headings, prose paragraphs, callout tips,
 * runnable SQL snippets) that the HelpPanel renders in order. Kept
 * here as pure data so the component file stays focused on rendering
 * and lifecycle — editing the tutorial doesn't need a code review of
 * the panel itself.
 */
export type TutorialNode =
  | { kind: "heading"; text: string }
  | { kind: "prose"; html: string }
  | { kind: "tip"; html: string }
  | { kind: "snippet"; sql: string };

export const PENGUINS_TUTORIAL: TutorialNode[] = [
  {
    kind: "prose",
    html:
      `DuckDB supports a rich SQL dialect — see the ` +
      `<a href="https://duckdb.org/docs/current/sql/introduction" target="_blank" rel="noopener noreferrer">DuckDB SQL reference</a> ` +
      `for the full syntax. The examples below assume the Palmer Penguins sample loaded via the button above.`,
  },

  { kind: "heading", text: "Parse the dataset" },
  {
    kind: "prose",
    html:
      `The raw CSV stores numeric columns as strings with <code>"NA"</code> for missing values and leaves the ` +
      `categorical columns as free-form text. Cast the numerics with <code>TRY_CAST</code>, and tighten the ` +
      `categoricals into <code>ENUM</code>s so they take less memory and only accept valid values.`,
  },
  {
    kind: "snippet",
    sql:
      "CREATE OR REPLACE TYPE sex_type AS ENUM ('female', 'male');\n" +
      "\n" +
      "-- Tighten categorical text into ENUMs (less memory, only valid values)\n" +
      "-- and cast measurements to DOUBLE. TRY_CAST yields NULL on failure, so\n" +
      "-- the string \"NA\" becomes a real NULL.\n" +
      "CREATE OR REPLACE TABLE penguins_clean AS\n" +
      "SELECT\n" +
      "    species::ENUM ('Adelie', 'Gentoo', 'Chinstrap') AS species\n" +
      "  , island::ENUM ('Dream', 'Torgersen', 'Biscoe') AS island\n" +
      "  , TRY_CAST(sex AS sex_type) AS sex\n" +
      "  , TRY_CAST(bill_length_mm AS DOUBLE) AS bill_length_mm\n" +
      "  , TRY_CAST(bill_depth_mm AS DOUBLE) AS bill_depth_mm\n" +
      "  , TRY_CAST(flipper_length_mm AS DOUBLE) AS flipper_length_mm\n" +
      "  , TRY_CAST(body_mass_g AS DOUBLE) AS body_mass_g\n" +
      "FROM penguins\n" +
      "ORDER BY species, island, sex\n" +
      ";",
  },

  { kind: "heading", text: "Basic summary" },
  {
    kind: "prose",
    html: `A classic <code>GROUP BY</code> with the standard <code>AVG</code> / <code>STDDEV</code> aggregates.`,
  },
  {
    kind: "snippet",
    sql:
      "-- Mean and standard deviation of every measurement, broken down by\n" +
      "-- species x island x sex. Rows where sex couldn't be parsed are\n" +
      "-- NULL after the TRY_CAST in penguins_clean — GROUP BY drops them\n" +
      "-- into their own bucket, which is usually what you want.\n" +
      "SELECT species, island, sex\n" +
      "  , AVG(bill_length_mm)    AS mean_bill_length\n" +
      "  , STDDEV(bill_length_mm) AS std_bill_length\n" +
      "  , AVG(bill_depth_mm)     AS mean_bill_depth\n" +
      "  , STDDEV(bill_depth_mm)  AS std_bill_depth\n" +
      "  , AVG(flipper_length_mm)    AS mean_flipper_length\n" +
      "  , STDDEV(flipper_length_mm) AS std_flipper_length\n" +
      "  , AVG(body_mass_g)    AS mean_body_mass\n" +
      "  , STDDEV(body_mass_g) AS std_body_mass\n" +
      "FROM penguins_clean\n" +
      "GROUP BY species, island, sex\n" +
      "ORDER BY species, island, sex",
  },

  { kind: "heading", text: "Better summary with Stats Duck" },
  {
    kind: "prose",
    html:
      `Bedevere auto-loads the ` +
      `<a href="https://github.com/caerbannogwhite/the-stats-duck" target="_blank" rel="noopener noreferrer">Stats Duck</a> ` +
      `DuckDB extension. Its <code>summary_stats()</code> aggregate returns a STRUCT with count, mean, sd, quartiles, ` +
      `min/max, skewness, and kurtosis.`,
  },
  {
    kind: "snippet",
    sql:
      "-- One summary_stats() call per measurement. Each result cell is a\n" +
      "-- STRUCT holding count, mean, sd, quartiles, min/max, skewness, and\n" +
      "-- kurtosis — click a cell to inspect it.\n" +
      "SELECT species, island, sex\n" +
      "  , summary_stats(bill_length_mm)    AS bill_length_summ\n" +
      "  , summary_stats(bill_depth_mm)     AS bill_depth_summ\n" +
      "  , summary_stats(flipper_length_mm) AS flipper_length_summ\n" +
      "  , summary_stats(body_mass_g)       AS body_mass_summ\n" +
      "FROM penguins_clean\n" +
      "GROUP BY species, island, sex\n" +
      "ORDER BY species, island, sex",
  },
  {
    kind: "tip",
    html:
      `Each result cell is a STRUCT. Click the cell, then click the value in the status bar to open an inspector ` +
      `with every field on its own row.`,
  },

  { kind: "heading", text: "Publication-style \"Table 1\"" },
  {
    kind: "prose",
    html:
      `Stats Duck's <code>TABLE_ONE()</code> produces a long-format summary — one row per ` +
      `(variable × level × statistic) — that you can pivot into the wide layout most papers use. ` +
      `Variables are passed by name; the <code>by</code> argument splits the summary by a stratifier ` +
      `(here, <code>species</code>). Display strings are already formatted (e.g. <code>"45.32 ± 5.46"</code>); ` +
      `the <code>PIVOT … USING FIRST(display)</code> step reshapes them into one column per stratum.`,
  },
  {
    kind: "snippet",
    sql:
      "-- Build the long-format summary silently — we only want to see the\n" +
      "-- pivoted result, so .no-output suppresses the intermediate tab.\n" +
      ".no-output\n" +
      "CREATE OR REPLACE TABLE penguins_temp AS\n" +
      "SELECT * FROM TABLE_ONE(\n" +
      "  'penguins_clean'\n" +
      "  , variables := ['island', 'sex', 'bill_length_mm', 'flipper_length_mm', 'body_mass_g']\n" +
      "  , by := 'species'\n" +
      ")\n" +
      ";\n" +
      "\n" +
      "-- Reshape into one column per species. Each row carries the\n" +
      "-- variable, its level (for categoricals) or NULL (for numerics),\n" +
      "-- and the statistic name; FIRST(display) picks up the pre-formatted\n" +
      "-- value for each stratum.\n" +
      "CREATE OR REPLACE TABLE penguins_summ AS\n" +
      "PIVOT penguins_temp ON stratum USING FIRST(display)\n" +
      "GROUP BY variable, level, statistic\n" +
      ";",
  },
  {
    kind: "tip",
    html:
      `Drop the <code>by</code> argument to get an overall (unstratified) Table 1.`,
  },

  { kind: "heading", text: "All in one query" },
  {
    kind: "prose",
    html: `Skip the intermediate view — cast inline.`,
  },
  {
    kind: "snippet",
    sql:
      "-- Cast and summarise in one pass, without a saved view.\n" +
      "SELECT species, island\n" +
      "  , summary_stats(TRY_CAST(bill_length_mm AS DOUBLE))    AS bill_length_mm\n" +
      "  , summary_stats(TRY_CAST(bill_depth_mm AS DOUBLE))     AS bill_depth_mm\n" +
      "  , summary_stats(TRY_CAST(flipper_length_mm AS DOUBLE)) AS flipper_length_mm\n" +
      "  , summary_stats(TRY_CAST(body_mass_g AS DOUBLE))       AS body_mass_g\n" +
      "FROM penguins\n" +
      "GROUP BY species, island",
  },

  { kind: "heading", text: "Testing a hypothesis" },
  {
    kind: "prose",
    html:
      `Stats Duck ships a battery of hypothesis tests. Here's a two-sample t-test comparing body mass between Adelie and ` +
      `Gentoo penguins. <code>CASE WHEN species = 'X'</code> selects one group per argument and NULLs out the rest; ` +
      `Stats Duck ignores NULLs.`,
  },
  {
    kind: "snippet",
    sql:
      "-- Two-sample Welch's t-test on two measurements at once: is body mass\n" +
      "-- (and flipper length) different between Adelie and Gentoo penguins?\n" +
      "-- CASE WHEN selects one group per argument; NULLs in the other group\n" +
      "-- are ignored by Stats Duck. Each result cell is a STRUCT with\n" +
      "-- t_statistic, p_value, df, and the confidence interval.\n" +
      "SELECT\n" +
      "    ttest_2samp(\n" +
      "      CASE WHEN species = 'Adelie' THEN body_mass_g END,\n" +
      "      CASE WHEN species = 'Gentoo' THEN body_mass_g END\n" +
      "    ) AS t_test_body_mass\n" +
      "  , ttest_2samp(\n" +
      "      CASE WHEN species = 'Adelie' THEN flipper_length_mm END,\n" +
      "      CASE WHEN species = 'Gentoo' THEN flipper_length_mm END\n" +
      "    ) AS t_test_flipper_length\n" +
      "FROM penguins_clean\n" +
      "WHERE body_mass_g IS NOT NULL\n" +
      "  AND flipper_length_mm IS NOT NULL",
  },
  {
    kind: "tip",
    html:
      `For a non-parametric alternative (no normality assumption), replace <code>ttest_2samp</code> with ` +
      `<code>mann_whitney_u</code>.`,
  },

  { kind: "heading", text: "Plot it" },
  {
    kind: "prose",
    html:
      `Stats Duck also adds a <code>VISUALIZE … DRAW &lt;mark&gt;</code> clause that compiles to a Vega-Lite spec. ` +
      `Channels are <code>x</code>, <code>y</code>, <code>color</code> (and a few others); marks include ` +
      `<code>point</code>, <code>line</code>, <code>bar</code>, <code>area</code>, <code>tick</code>, <code>circle</code>, ` +
      `<code>square</code>, <code>rect</code>. Run the query and a chart tab opens alongside the dataset tabs.`,
  },
  {
    kind: "snippet",
    sql:
      "-- Scatter of bill depth vs bill length, coloured by species.\n" +
      "VISUALIZE\n" +
      "    bill_depth_mm AS x\n" +
      "    , bill_length_mm AS y\n" +
      "    , species AS color\n" +
      "FROM penguins_clean\n" +
      "DRAW point\n" +
      ";",
  },
  {
    kind: "tip",
    html:
      `Stack <code>DRAW</code> clauses to layer marks (e.g. <code>DRAW point DRAW line</code>) and add ` +
      `<code>FACET BY &lt;col&gt;</code> (optionally followed by <code>ROWS</code>) for small multiples. ` +
      `Use the action menu in the chart's top-right corner — or <code>.export png</code> / <code>.export svg</code> — to save the chart.`,
  },
];
