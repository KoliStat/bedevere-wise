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
//   * `@duckdb/duckdb-wasm` was bumped and the runtime now expects a
//     different DuckDB-version path than what's committed. The
//     release-day checklist memory has that one (item 5).

import { statSync, existsSync } from "node:fs";

const required = [
  ["dist/extensions/stats-duck/v1.5.1/wasm_eh/stats_duck.duckdb_extension.wasm", 100_000],
  ["dist/extensions/stats-duck/v1.5.1/wasm_eh/core_functions.duckdb_extension.wasm", 100_000],
  ["dist/extensions/stats-duck/v1.5.1/wasm_eh/parquet.duckdb_extension.wasm", 100_000],
  ["dist/extensions/stats-duck/v1.5.1/wasm_eh/marks_demo.duckdb_extension.wasm", 1_000],
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
  console.error("\nbuild verification FAILED — production VISUALIZE would be broken:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nCheck public/extensions/stats-duck/ has the wasm_eh build for this\n" +
      "@duckdb/duckdb-wasm version. The release-day checklist (memory) item 5\n" +
      "has the rebuild flow.\n",
  );
  process.exit(1);
}

console.log(`build verification passed: ${required.length} stats-duck wasm files present`);
