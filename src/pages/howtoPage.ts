import { PENGUINS_TUTORIAL } from "../components/HelpPanel/tutorial";
import { buildTutorialNodes } from "../components/HelpPanel/tutorialDom";
import { renderPageShell } from "./pageShell";

/** Standalone /howto page: the How-To tab's tutorial inside the page shell. */
export function renderHowtoPage(root: HTMLElement): void {
  const main = renderPageShell(root, "howto");
  const article = document.createElement("article");
  article.className = "page-shell__article";
  article.innerHTML = `
    <h1 class="page-shell__title">How to use Bedevere Wise</h1>
    <p class="help-panel__lead">
      Bedevere Wise is a local-first SQL data viewer. Open a file in your browser and query it
      with DuckDB SQL. Nothing is uploaded.
    </p>
    <p class="help-panel__hint">
      The examples below run against the Palmer Penguins sample dataset.
      <a class="page-shell__cta" href="/">Open the app</a> and load the sample from the Help
      panel's How-To tab to follow along.
    </p>
    <div class="help-panel__tutorial" data-tutorial></div>
  `;
  const host = article.querySelector("[data-tutorial]")!;
  for (const el of buildTutorialNodes(PENGUINS_TUTORIAL)) {
    host.appendChild(el);
  }
  main.appendChild(article);
}
