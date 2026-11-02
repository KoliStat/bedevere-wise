import { describe, it, expect } from "vitest";
import { renderAboutBody, aboutHostForBackend } from "../aboutHtml";
import { KOLISTAT_URL, DESKTOP_DOWNLOAD_URL } from "../../../appLinks";
import { APP_VERSION } from "../../../version";

function legalBlock(html: string): string {
  return html.match(/<p class="about-legal">[\s\S]*?<\/p>/)?.[0] ?? "";
}

describe("renderAboutBody", () => {
  const html = renderAboutBody(APP_VERSION);

  it("links the KoliStat umbrella site", () => {
    expect(html).toContain(`href="${KOLISTAT_URL}"`);
  });

  it("offers the desktop download", () => {
    expect(html).toContain(`href="${DESKTOP_DOWNLOAD_URL}"`);
    expect(html).toMatch(/desktop app/i);
  });

  it("groups the legal links in their own block", () => {
    const legal = legalBlock(html);
    expect(legal).toBeTruthy();
    expect(legal).toContain(`href="https://kolistat.com/terms"`);
    expect(legal).toContain(`href="https://kolistat.com/privacy"`);
    expect(legal).toContain(`href="/third-party-licenses.txt"`);
  });

  // Fails when a release bumps APP_VERSION but not the What's new section.
  it("names the current release in the What's new heading", () => {
    const release = APP_VERSION.split("-")[0];
    expect(html).toContain(`What's new in ${release}`);
  });
});

describe("renderAboutBody on desktop", () => {
  const html = renderAboutBody(APP_VERSION, "desktop");

  it("does not offer the desktop download", () => {
    expect(html).not.toContain(DESKTOP_DOWNLOAD_URL);
    expect(html).not.toMatch(/download the desktop app/i);
  });

  it("describes native DuckDB, not the browser engine", () => {
    expect(html).not.toMatch(/in your browser/i);
    expect(html).not.toContain("DuckDB-WASM");
  });

  it("links the desktop licence, the privacy notice and the desktop notices", () => {
    const legal = legalBlock(html);
    expect(legal).toContain(`href="https://kolistat.com/products/bedevere/terms"`);
    expect(legal).toContain(`href="https://kolistat.com/privacy"`);
    expect(legal).toContain(
      `href="https://github.com/KoliStat/bedevere-desktop-releases/blob/main/THIRD-PARTY-NOTICES.txt"`,
    );
    expect(legal).not.toContain(`href="/third-party-licenses.txt"`);
    expect(legal).not.toContain(`href="https://kolistat.com/terms"`);
  });

  it("links the desktop release notes instead of the web app's licence and changelog", () => {
    expect(html).toContain(`href="https://github.com/KoliStat/bedevere-desktop-releases/blob/main/CHANGELOG.md"`);
    expect(html).not.toContain("MIT License");
    expect(html).not.toContain("bedevere-wise/blob/main/CHANGELOG.md");
  });
});

describe("aboutHostForBackend", () => {
  it("treats the DuckDB-WASM backend as the web app", () => {
    expect(aboutHostForBackend("duckdb-wasm")).toBe("web");
  });

  it("treats any other backend as the desktop app", () => {
    expect(aboutHostForBackend("ipc")).toBe("desktop");
  });
});
