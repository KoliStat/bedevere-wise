import { renderAboutBody } from "../components/HelpPanel/aboutHtml";
import { APP_VERSION } from "../version";
import { renderPageShell } from "./pageShell";

/** Standalone /about page: the About tab's content inside the page shell. */
export function renderAboutPage(root: HTMLElement): void {
  const main = renderPageShell(root, "about");
  const article = document.createElement("article");
  article.className = "page-shell__article";
  article.innerHTML =
    `<h1 class="page-shell__title">About Bedevere Wise</h1>` + renderAboutBody(APP_VERSION);
  main.appendChild(article);
}
