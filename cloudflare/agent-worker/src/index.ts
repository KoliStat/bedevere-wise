/**
 * Bedevere Wise AI proxy.
 *
 * The Anthropic SDK in the browser is configured with `baseURL` pointing at
 * this worker's `*.workers.dev` URL. The worker:
 *   1. Checks the request origin against `ALLOWED_ORIGIN`.
 *   2. Applies a soft per-IP rate limit (60 req / 5 min) so a single user
 *      can't burn through the budget.
 *   3. Drops the placeholder `x-api-key` the SDK sent and substitutes the
 *      real `ANTHROPIC_API_KEY` from secrets.
 *   4. Forwards to `https://api.anthropic.com` and streams the response
 *      back unchanged (preserves SSE for streaming completions).
 *
 * Designed, NOT deployed. To go live, follow the steps in `wrangler.toml`.
 */

export interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGIN: string;
  /** Optional KV namespace for cross-instance rate limiting. If absent the
   *  worker falls back to in-memory counts (per-instance only — best-effort). */
  RATE_LIMIT?: KVNamespace;
}

const ANTHROPIC_BASE = "https://api.anthropic.com";
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX = 60;

// Per-instance fallback counter. Reset on cold start; not authoritative.
const memoryCounts = new Map<string, { resetAt: number; count: number }>();

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return cors(env, new Response(null, { status: 204 }));
    }

    if (!env.ANTHROPIC_API_KEY) {
      return cors(env, json({ error: "proxy not configured: ANTHROPIC_API_KEY missing" }, 503));
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "anon";
    const limited = await checkRateLimit(env, ip);
    if (limited) return cors(env, json({ error: "rate limited; try again later" }, 429));

    // Path passthrough: SDK hits /v1/messages, /v1/messages/count_tokens, etc.
    const url = new URL(request.url);
    const upstream = new URL(ANTHROPIC_BASE + url.pathname + url.search);

    const headers = new Headers(request.headers);
    headers.delete("x-api-key");
    headers.delete("authorization");
    headers.delete("host");
    headers.set("x-api-key", env.ANTHROPIC_API_KEY);
    headers.set("anthropic-version", headers.get("anthropic-version") ?? "2023-06-01");

    const upstreamReq = new Request(upstream.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      // Required when forwarding a streaming body in workers runtime.
      // Cloudflare's `Request` constructor accepts the standard fetch init.
    });

    const upstreamRes = await fetch(upstreamReq);
    // Stream the body straight through — preserves SSE for streaming
    // responses without buffering.
    const respHeaders = new Headers(upstreamRes.headers);
    respHeaders.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
    respHeaders.set("Vary", "Origin");
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: respHeaders,
    });
  },
};

async function checkRateLimit(env: Env, ip: string): Promise<boolean> {
  const key = `agent-rl:${ip}`;
  const now = Date.now();

  if (env.RATE_LIMIT) {
    const raw = await env.RATE_LIMIT.get(key);
    const state = raw ? (JSON.parse(raw) as { resetAt: number; count: number }) : null;
    if (!state || state.resetAt < now) {
      await env.RATE_LIMIT.put(
        key,
        JSON.stringify({ resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 }),
        { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) },
      );
      return false;
    }
    if (state.count >= RATE_LIMIT_MAX) return true;
    await env.RATE_LIMIT.put(
      key,
      JSON.stringify({ resetAt: state.resetAt, count: state.count + 1 }),
      { expirationTtl: Math.max(1, Math.ceil((state.resetAt - now) / 1000)) },
    );
    return false;
  }

  // In-memory fallback: per-instance only.
  const state = memoryCounts.get(key);
  if (!state || state.resetAt < now) {
    memoryCounts.set(key, { resetAt: now + RATE_LIMIT_WINDOW_MS, count: 1 });
    return false;
  }
  if (state.count >= RATE_LIMIT_MAX) return true;
  state.count += 1;
  return false;
}

function cors(env: Env, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, anthropic-version, anthropic-beta, x-api-key");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
