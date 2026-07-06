import { describe, it, expect } from "vitest";
import { buildEmbedUrl, buildEmbedIframe } from "../embedUrl";
import { parseEmbedConfig } from "../embedConfig";

const frag = (url: string) => url.slice(url.indexOf("#") + 1);

describe("buildEmbedUrl", () => {
  it("round-trips through parseEmbedConfig, incl. reserved chars", () => {
    const url = buildEmbedUrl({
      datasets: ["https://x.org/a.parquet"],
      query: "SELECT * FROM a WHERE n & 1 = 0 -- #note",
      theme: "dark",
      autorun: true,
    });
    expect(url.startsWith("https://bedeverewise.app/embed#")).toBe(true);
    const cfg = parseEmbedConfig(frag(url));
    expect(cfg.datasets).toEqual(["https://x.org/a.parquet"]);
    expect(cfg.query).toBe("SELECT * FROM a WHERE n & 1 = 0 -- #note");
    expect(cfg.theme).toBe("dark");
    expect(cfg.autorun).toBe(true);
  });

  it("omits theme when Auto (null) and autorun when off", () => {
    const url = buildEmbedUrl({ datasets: [], query: "SELECT 1", theme: null, autorun: false });
    const cfg = parseEmbedConfig(frag(url));
    expect(cfg.theme).toBeNull();
    expect(cfg.autorun).toBe(false);
  });

  it("supports multiple datasets", () => {
    const url = buildEmbedUrl({
      datasets: ["https://x/a.csv", "https://x/b.csv"],
      query: "",
      theme: null,
      autorun: false,
    });
    expect(parseEmbedConfig(frag(url)).datasets).toEqual([
      "https://x/a.csv",
      "https://x/b.csv",
    ]);
  });
});

describe("buildEmbedIframe", () => {
  it("wraps the url with a default height", () => {
    const html = buildEmbedIframe("https://bedeverewise.app/embed#x=1");
    expect(html).toContain('src="https://bedeverewise.app/embed#x=1"');
    expect(html).toContain('height="480"');
    expect(html).toContain("<iframe");
  });
});
