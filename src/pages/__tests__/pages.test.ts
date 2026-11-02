import { describe, expect, it } from "vitest";
import { renderAboutPage } from "../aboutPage";
import { renderHowtoPage } from "../howtoPage";
import { APP_VERSION } from "../../version";
import { PENGUINS_TUTORIAL } from "../../components/HelpPanel/tutorial";

function freshRoot(): HTMLElement {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

function navHrefs(root: HTMLElement): Array<string | null> {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>(".page-shell__nav a")).map((a) =>
    a.getAttribute("href"),
  );
}

describe("renderAboutPage", () => {
  it("renders the shell with a brand link to the app and nav to both pages", () => {
    const root = freshRoot();
    renderAboutPage(root);
    expect(root.querySelector(".page-shell__brand")?.getAttribute("href")).toBe("/");
    const hrefs = navHrefs(root);
    expect(hrefs).toContain("/about");
    expect(hrefs).toContain("/howto");
  });

  it("shows the version from the shared constant", () => {
    const root = freshRoot();
    renderAboutPage(root);
    expect(root.querySelector(".help-panel__about-version")?.textContent).toBe(`v${APP_VERSION}`);
  });

  it("marks About as the active nav entry", () => {
    const root = freshRoot();
    renderAboutPage(root);
    const active = root.querySelector(".page-shell__nav a[aria-current='page']");
    expect(active?.getAttribute("href")).toBe("/about");
  });
});

describe("renderHowtoPage", () => {
  it("renders every tutorial node", () => {
    const root = freshRoot();
    renderHowtoPage(root);
    const host = root.querySelector(".help-panel__tutorial");
    expect(host?.children.length).toBe(PENGUINS_TUTORIAL.length);
  });

  it("links into the app where the tab has its sample button", () => {
    const root = freshRoot();
    renderHowtoPage(root);
    expect(root.querySelector("a.page-shell__cta")?.getAttribute("href")).toBe("/");
  });

  it("marks How-To as the active nav entry", () => {
    const root = freshRoot();
    renderHowtoPage(root);
    const active = root.querySelector(".page-shell__nav a[aria-current='page']");
    expect(active?.getAttribute("href")).toBe("/howto");
  });
});
