# Bedevere Wise — Agent Worker

A Cloudflare Worker that proxies browser-side Anthropic API calls so end
users don't have to paste their own keys. Sibling to `feedback-worker`.

**Status: designed, not deployed.** The scaffold lives in source so the
client-side proxy mode (Help → Settings → AI assistant → Proxy) has
something to talk to, but the deployment step is intentionally pending —
once a real worker URL exists, paste it into the project's
`.env` (`VITE_AI_PROXY_URL`) and document it in the Settings UI hint.

## How it works

1. Browser SDK is configured with `baseURL = <this-worker-url>` and
   `dangerouslyAllowBrowser: true`.
2. The SDK POSTs to `${baseURL}/v1/messages` with a placeholder `x-api-key`.
3. This worker drops the placeholder header, substitutes the real
   `ANTHROPIC_API_KEY` from secrets, and forwards to `api.anthropic.com`.
4. The streaming response is piped back unchanged (preserves SSE).

A soft per-IP rate limit (60 requests / 5 min) caps abuse. Optional KV
namespace (`RATE_LIMIT`) makes the limit consistent across worker
instances; without it the limit is best-effort per-instance.

## Deploy (when ready)

```bash
cd cloudflare/agent-worker
bun install
bunx wrangler login
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler secret put ALLOWED_ORIGIN   # e.g. https://bedeverewise.app
# Optional: cross-instance rate limit
bunx wrangler kv namespace create RATE_LIMIT
# Paste the printed namespace id into wrangler.toml under [[kv_namespaces]]
bunx wrangler deploy
```

The worker URL prints at the end of `wrangler deploy`. Paste it into
`Help → Settings → AI assistant → Proxy mode`, or set
`VITE_AI_PROXY_URL` at build time so it's the default for every user.

## Why not deploy yet

Costs are real and the abuse model needs more thought before opening this
to anonymous users. BYOK direct mode covers the prototype's needs; the
proxy lights up only when there's a clear use case for hosted access.
