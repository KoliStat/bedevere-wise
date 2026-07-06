# Deploying Bedevere Wise

The app is a static SPA (DuckDB runs in the browser via WASM). There's no
"backend server" — everything user-data-related lives in the browser.

This document covers the recommended Cloudflare Workers Builds path.

## Cloudflare Workers Builds (the deploy target)

Cloudflare's dashboard now routes static-SPA deploys through "Workers
Builds with static assets" rather than the legacy Pages flow. The end
result is the same — a static site on the global CDN — but the
configuration story is slightly different.

1. **Create a Worker** in the Cloudflare dashboard
   (Workers & Pages → Create → Connect to Git). Point it at the repo.
   The **Production branch** field defaults to `main` but accepts any
   branch — pick whichever you want as the live deploy target. Other
   branches become preview deployments automatically.

2. **Build settings**:
   - Build command: `bun run build`
   - Deploy command: `bunx wrangler deploy`
   - Build output directory: `dist`
   - Root directory: `/`
   - (Cloudflare auto-installs `bun` when it sees the lockfile.)

3. **`wrangler.jsonc`** at the repo root declares the project name, the
   static-asset directory, and SPA-style 404 routing (unknown paths
   serve `index.html` so client-side routes resolve). If you renamed
   the Cloudflare project, update the `name` field to match its slug.

4. **Custom domain** (Custom domains → Add): point a CNAME at
   `<project>.workers.dev` (Cloudflare manages the TLS cert
   automatically). If you registered the domain through Cloudflare
   Registrar, the DNS record is created with one click.

5. **Push to your production branch** — the build runs in ~1 min.

### Token gotcha

The auto-created build token (named "<project> build token" on
https://dash.cloudflare.com/profile/api-tokens) sometimes ships with a
narrower scope than `wrangler deploy` actually needs. If the deploy
fails with `Authentication error [code: 10000]`, edit that token and
add **Account → Workers Scripts: Edit**.

### What the user sees as costs

- Workers itself: $0 on the free tier (100k requests/day, 10ms CPU/req).
- Domain: depends on registrar. Cloudflare Registrar charges at-cost
  (about $9.15/yr for `.com`, $13/yr for `.dev`, $32.99/yr for `.io`).
- TLS cert: $0 (Cloudflare-issued).

## When to consider a real server

A Bun server (e.g. on Fly.io or Render) is worth the operational cost
once you have **two** server-side needs that overlap. Examples:

- Persistent user state (saved layouts, query history) keyed to an
  account.
- Server-side AI integration (LLM proxying with rate limits / metering).
- Multi-user collaboration or shared workspaces.

Until then, static + worker is the right shape.
