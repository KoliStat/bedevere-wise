import { defineConfig } from "vite";
import { resolve } from "path";

/**
 * Library-build config for `@caerbannogwhite/bedevere`.
 *
 * This is separate from `vite.config.ts` (which builds the *standalone
 * app* with `index.html` + `embed.html` as MPA entries). Running
 * `bun run build:lib` against this config produces an ES module bundle
 * + CSS that downstream apps (e.g. `tflier`) can import as a package.
 *
 * Externals: peer-dep packages (DuckDB, CodeMirror, Vega) are NOT
 * bundled — consumers install them as their own dependencies. This
 * keeps the bundle small and avoids duplicate copies of CodeMirror
 * in a consuming app's tree.
 */
const external = [
  // DuckDB-WASM and its worker URLs. The worker `?url` imports also
  // need to be externalized so consumers' bundlers resolve them.
  /^@duckdb\/duckdb-wasm/,
  // CodeMirror + Lezer
  /^@codemirror\//,
  /^@lezer\//,
  "codemirror",
  // Vega
  "vega-embed",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  // Don't copy the `public/` directory (favicon, robots.txt, _headers,
  // the WASM extension assets, …) into the library bundle. Consumers
  // bring their own static assets.
  publicDir: false,
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "esnext",
    // tsc runs after vite in `build:lib` and writes .d.ts files into
    // the same dist; emptying here would wipe them. The script does
    // `rm -rf dist` up front to keep things clean.
    emptyOutDir: false,
    cssCodeSplit: false, // single style.css for the whole library
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.es.js",
    },
    rollupOptions: {
      external,
      output: {
        // Keep the CSS asset filename predictable so `./style.css`
        // in package.json `exports` resolves.
        assetFileNames: (asset) => {
          if (asset.name === "style.css" || asset.name?.endsWith(".css")) return "style.css";
          return "assets/[name][extname]";
        },
      },
    },
  },
});
