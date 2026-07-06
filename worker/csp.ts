// Content-Security-Policy for the deployed app, built per request path.
//
// This lives in the Worker (worker/index.ts) rather than a `public/_headers`
// file because Cloudflare Workers Assets APPENDS the headers of every matching
// `_headers` rule — it is NOT "most specific wins". So a `frame-ancestors` set
// on `/*` can never be *loosened* for `/embed`: the browser enforces the
// intersection of all CSP headers present, and the strict one wins. Owning the
// header here yields exactly one policy per document — the main app forbids
// framing, the public `/embed` widget allows any origin — and it covers
// arbitrary SPA-fallback URLs too (which the per-path `_headers` rules could
// not reach).

/** True for the embeddable widget document — any origin may frame it. */
export function isEmbedPath(pathname: string): boolean {
  return pathname === "/embed" || pathname === "/embed.html";
}

/** Build the Content-Security-Policy header value for a document at `pathname`. */
export function buildCsp(pathname: string): string {
  const embed = isEmbedPath(pathname);
  // The cookieless analytics beacon runs on the main app only, never in /embed.
  const scriptSrc = embed
    ? "'self' 'wasm-unsafe-eval'"
    : "'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com";
  // Every document forbids framing except /embed — a public, read-only widget
  // framable by any origin. (No `'unsafe-eval'`: DuckDB-WASM uses
  // `'wasm-unsafe-eval'` and Vega renders via the CSP-safe interpreter.)
  const frameAncestors = embed ? "*" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https: blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}
