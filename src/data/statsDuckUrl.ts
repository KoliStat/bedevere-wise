/**
 * Resolve the source URL for the stats_duck DuckDB extension (the ggsql
 * `VISUALIZE` parser plus the stats table functions — `meta`, `lm`,
 * `lm_summary`, `bootstrap`, `table_one`, the distribution functions, …).
 *
 * Shared by `BedevereApp.initAsync` (the full app) and the `/embed`
 * bootstrap so the two paths can never drift — if only one of them resolved
 * the URL, the embed could silently load a different (or no) extension.
 *
 * The default is the bundled copy committed under
 * `public/extensions/stats-duck/`, served same-origin at
 * `/extensions/stats-duck` by the dev server and the production build alike
 * (the build copies it into `dist/`; Cloudflare serves it from the edge
 * cache — no external repository to be down or rate-limited).
 * `VITE_STATS_DUCK_URL` (inlined at build time, see `.env.example`)
 * overrides it, absolute or page-relative. Page-relative paths (starting
 * `/`) get `window.location.origin` prefixed because DuckDB-WASM's
 * `INSTALL … FROM` requires an absolute URL.
 */
export function resolveStatsDuckUrl(): string {
  const raw =
    (import.meta.env.VITE_STATS_DUCK_URL as string | undefined) ||
    "/extensions/stats-duck";
  return raw.startsWith("/") ? `${window.location.origin}${raw}` : raw;
}
