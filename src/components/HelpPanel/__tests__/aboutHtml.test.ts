import { describe, it, expect } from "vitest";
import { renderAboutBody } from "../aboutHtml";
import { KOLISTAT_URL, DESKTOP_DOWNLOAD_URL } from "../../../appLinks";

describe("renderAboutBody", () => {
  const html = renderAboutBody("0.15-my-trusty-servant");

  it("links the KoliStat umbrella site", () => {
    expect(html).toContain(`href="${KOLISTAT_URL}"`);
  });

  it("offers the desktop download", () => {
    expect(html).toContain(`href="${DESKTOP_DOWNLOAD_URL}"`);
    expect(html).toMatch(/desktop app/i);
  });

  it("groups the legal links in their own block", () => {
    const legalBlock = html.match(/<p class="about-legal">[\s\S]*?<\/p>/)?.[0];
    expect(legalBlock).toBeTruthy();
    expect(legalBlock).toContain(`href="https://kolistat.com/terms"`);
    expect(legalBlock).toContain(`href="https://kolistat.com/privacy"`);
    expect(legalBlock).toContain(`href="/third-party-licenses.txt"`);
  });
});
