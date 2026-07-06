/// <reference types="@cloudflare/workers-types" />
import { buildCsp } from "./csp";

interface Env {
  ASSETS: Fetcher;
}

// Static-asset front door. `run_worker_first: true` (wrangler.jsonc) runs this
// Worker for every request; we serve the asset through the ASSETS binding —
// which honours html_handling and `not_found_handling: single-page-application`
// (embed.html for /embed, index.html for unknown paths) — and stamp the
// security headers onto HTML documents. Non-HTML responses (JS, CSS, wasm,
// fonts) pass straight through: CSP is a document-level concern.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(request);

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return response;

    // Clone so the headers are mutable, then set (replace) the policy.
    const withHeaders = new Response(response.body, response);
    withHeaders.headers.set(
      "Content-Security-Policy",
      buildCsp(new URL(request.url).pathname),
    );
    withHeaders.headers.set("X-Content-Type-Options", "nosniff");
    return withHeaders;
  },
};
