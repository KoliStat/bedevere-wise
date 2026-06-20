/**
 * Resolve the source URL for the stats_duck DuckDB extension (the ggsql
 * `VISUALIZE` parser plus the stats table functions — `meta`, `lm`,
 * `lm_summary`, `bootstrap`, `table_one`, the distribution functions, …).
 *
 * Shared by `BedevereApp.initAsync` (the full app) and the `/embed`
 * bootstrap so the two paths can never drift — if only one of them resolved
 * the URL, the embed could silently load a different (or no) extension.
 *
 * `VITE_STATS_DUCK_URL` is inlined at build time (see `.env.example`): it can
 * be absolute (the published GitHub Pages repo, used as the fallback) or
 * page-relative. Page-relative paths get `window.location.origin` prefixed
 * because DuckDB-WASM's `INSTALL … FROM` requires an absolute URL. In
 * production the same-origin bundled build under
 * `public/extensions/stats-duck/...` is served, so the embed loads it from
 * the same Cloudflare origin it is framed from.
 */
export function resolveStatsDuckUrl(): string {
  const raw =
    (import.meta.env.VITE_STATS_DUCK_URL as string | undefined) ||
    "https://kolistat.github.io/the-stats-duck";
  return raw.startsWith("/") ? `${window.location.origin}${raw}` : raw;
}
