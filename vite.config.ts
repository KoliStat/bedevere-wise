import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

// /about and /howto are served as about.html / howto.html in production
// (Cloudflare html_handling). Mirror that mapping in dev and preview so
// the clean URLs work locally instead of falling back to the SPA app.
function pageCleanUrls(): Plugin {
  const PAGES: Record<string, string> = { "/about": "/about.html", "/howto": "/howto.html" };
  const rewrite = (req: { url?: string }): void => {
    const url = req.url ?? "";
    const splitAt = url.search(/[?#]/);
    const path = splitAt === -1 ? url : url.slice(0, splitAt);
    const target = PAGES[path.replace(/\/$/, "") || "/"];
    if (target) req.url = target + (splitAt === -1 ? "" : url.slice(splitAt));
  };
  return {
    name: "bedevere:page-clean-urls",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        rewrite(req);
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // Base path resolution — different deploy targets serve from different
  // roots, so the path is env-driven instead of baked in:
  //   - Cloudflare Pages (and any custom-domain root): set BASE_PATH=/ or leave unset.
  //   - GitHub Pages project page:                     set BASE_PATH=/bedevere-wise/.
  //   - Local dev:                                     always /.
  // Configure via the BASE_PATH env var in the deploy environment; the
  // GH Pages workflow continues to work as long as it exports
  // BASE_PATH=/bedevere-wise/ before `bun run build`.
  const base = command === "build" ? process.env.BASE_PATH ?? "/" : "/";

  return {
    base,
    plugins: [pageCleanUrls()],
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 3000,
      open: true,
    },
    build: {
      outDir: "dist",
      // No source maps in the production app bundle — they bloat the deploy and
      // expose source, and add nothing for the live site / embeds (a thrown
      // error there is usually inside the third-party duckdb-wasm worker, which
      // our maps don't cover anyway). The library build keeps maps for package
      // consumers (bedevere-desktop).
      sourcemap: false,
      target: "esnext",
      // Drop Vite's inline modulepreload-polyfill <script>. It's the only
      // inline script in the built HTML; removing it lets the CSP use a
      // strict `script-src 'self'` (no 'unsafe-inline'). Native
      // modulepreload is universal in the browsers this WASM app targets.
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: resolve(__dirname, "index.html"),
          // /embed is a slim, iframable view for blog posts (see
          // src/embed/main.ts). MPA shape — its own bundle so the
          // main app's tabs/env/help-panel code doesn't ride along.
          embed: resolve(__dirname, "embed.html"),
          // Standalone, indexable pages serving the Help panel's About
          // and How-To content outside the app.
          about: resolve(__dirname, "about.html"),
          howto: resolve(__dirname, "howto.html"),
        },
      },
    },
  };
});
