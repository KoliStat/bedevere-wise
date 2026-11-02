import { describe, it, expect, afterEach } from "vitest";
import { HelpPanel } from "../HelpPanel";
import { DESKTOP_DOWNLOAD_URL } from "../../../appLinks";

function aboutHtml(): string {
  return document.querySelector(".help-panel__tab-body--about")?.innerHTML ?? "";
}

describe("HelpPanel About tab", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the web About when no host is given", () => {
    new HelpPanel(document.body, { version: "0.16-patsy", onLoadSampleDataset: () => {} }).show("about");
    expect(aboutHtml()).toContain(DESKTOP_DOWNLOAD_URL);
  });

  it("renders the desktop About when the host is the desktop app", () => {
    new HelpPanel(document.body, {
      version: "0.16-patsy",
      onLoadSampleDataset: () => {},
      host: "desktop",
    }).show("about");
    const html = aboutHtml();
    expect(html).toContain("v0.16-patsy");
    expect(html).not.toContain(DESKTOP_DOWNLOAD_URL);
  });
});
