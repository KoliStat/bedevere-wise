import { describe, expect, it } from "vitest";

import { buildCsp, isEmbedPath } from "./csp";

describe("isEmbedPath", () => {
  it("is true only for the embed document", () => {
    expect(isEmbedPath("/embed")).toBe(true);
    expect(isEmbedPath("/embed.html")).toBe(true);
    expect(isEmbedPath("/")).toBe(false);
    expect(isEmbedPath("/demo")).toBe(false);
    expect(isEmbedPath("/anything")).toBe(false);
  });
});

describe("buildCsp", () => {
  it("lets any origin frame /embed and drops the analytics beacon there", () => {
    const csp = buildCsp("/embed");
    expect(csp).toContain("frame-ancestors *");
    expect(csp).not.toContain("cloudflareinsights.com");
  });

  it("forbids framing and allows the beacon on the main app (incl. arbitrary SPA URLs)", () => {
    for (const path of ["/", "/index.html", "/demo", "/anything"]) {
      const csp = buildCsp(path);
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("https://static.cloudflareinsights.com");
    }
  });

  it("keeps wasm-unsafe-eval but never plain unsafe-eval", () => {
    const csp = buildCsp("/");
    expect(csp).toContain("'wasm-unsafe-eval'");
    // `'wasm-unsafe-eval'` does not contain the standalone `'unsafe-eval'` token.
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
