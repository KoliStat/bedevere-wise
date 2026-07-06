import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveStatsDuckUrl } from "../statsDuckUrl";

describe("resolveStatsDuckUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the bundled same-origin copy", () => {
    vi.stubEnv("VITE_STATS_DUCK_URL", "");
    expect(resolveStatsDuckUrl()).toBe(
      `${window.location.origin}/extensions/stats-duck`,
    );
  });

  it("returns an absolute override verbatim", () => {
    vi.stubEnv("VITE_STATS_DUCK_URL", "https://example.com/ext-repo");
    expect(resolveStatsDuckUrl()).toBe("https://example.com/ext-repo");
  });

  it("origin-prefixes a page-relative override", () => {
    vi.stubEnv("VITE_STATS_DUCK_URL", "/extensions/stats-duck-dev");
    expect(resolveStatsDuckUrl()).toBe(
      `${window.location.origin}/extensions/stats-duck-dev`,
    );
  });
});
