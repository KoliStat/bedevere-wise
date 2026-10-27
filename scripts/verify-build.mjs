// Postbuild guard. Asserts that the stats_duck parser-extension WASM
// files made it into `dist/` after `vite build`. If they're missing,
// production VISUALIZE silently breaks: Cloudflare's SPA fallback
// serves `index.html` for the missing path, DuckDB-WASM fetches it,
// and reports "need to see wasm magic number".
//
// Failure modes this catches:
//   * `public/extensions/` got re-broadened in `.gitignore` and the
//     committed snapshot disappeared on a clean checkout.
//   * Someone accidentally `git rm`-ed the WASM files.
//   * A junction got deleted without committing the snapshot first.
//   * The build ran from a branch where the snapshot doesn't exist.
//
// Failure modes this does NOT catch:
//   * `@duckdb/duckdb-wasm` was bumped and DUCKDB_VERSION below wasn't
//     updated to match — keep the two in lockstep.

import { statSync, existsSync } from "node:fs";

// The DuckDB version @duckdb/duckdb-wasm resolves at runtime: `INSTALL …
// FROM` derives the path `/<DUCKDB_VERSION>/wasm_eh/`. This is NOT the
// duckdb-wasm npm version — it's the DuckDB that version bundles
// (duckdb-wasm 1.33.1-dev65.0 → DuckDB v1.5.6). Bump in lockstep with
// @duckdb/duckdb-wasm. duckdb-wasm has no stable 1.5.x release, so the pin
// is the npm dev build that bundles the v1.5.6 release. Keep it exact. The
// `latest` tag (1.33.1-dev57.0) bundles v1.5.4, and an extension loads only
// in the DuckDB version it was built for.
const DUCKDB_VERSION = "v1.5.6";

// Only stats_duck is served from this same-origin bundle: BedevereApp runs
// `INSTALL stats_duck FROM '<origin>/extensions/stats-duck'`. excel, parquet
// and core_functions load from duckdb-wasm's own built-in repo (no
// customRepository is set), so they don't need staging here.
const required = [
  [`dist/extensions/stats-duck/${DUCKDB_VERSION}/wasm_eh/stats_duck.duckdb_extension.wasm`, 100_000],
  // Standalone pages — a dropped rollup input would ship broken routes.
  ["dist/about.html", 500],
  ["dist/howto.html", 500],
];

const failures = [];
for (const [path, minSize] of required) {
  if (!existsSync(path)) {
    failures.push(`${path} missing`);
    continue;
  }
  const { size } = statSync(path);
  if (size < minSize) {
    failures.push(`${path} only ${size} bytes (expected at least ${minSize})`);
  }
}

if (failures.length > 0) {
  console.error("\nbuild verification FAILED — required build outputs missing or too small:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nCheck public/extensions/stats-duck/ has the wasm_eh build for this\n" +
      "@duckdb/duckdb-wasm version. The release-day checklist (memory) item 5\n" +
      "has the rebuild flow.\n",
  );
  process.exit(1);
}

console.log(`build verification passed: ${required.length} required outputs present`);
