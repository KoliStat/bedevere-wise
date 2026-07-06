import { describe, expect, it } from "vitest";
import { parseEmbedConfig } from "../embedConfig";

describe("parseEmbedConfig theme", () => {
  it("accepts all six variants", () => {
    for (const t of ["light", "classic-light", "dark", "classic-dark", "github-light", "github-dark"]) {
      expect(parseEmbedConfig(`?theme=${t}`).theme).toBe(t);
    }
  });
  it("rejects unknown values to null (prefers-color-scheme fallback)", () => {
    expect(parseEmbedConfig("?theme=paper").theme).toBeNull();
    expect(parseEmbedConfig("?theme=").theme).toBeNull();
  });
});
