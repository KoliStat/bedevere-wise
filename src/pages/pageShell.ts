import duckPng from "@/assets/duck.png?url";
import { applyTheme } from "../embed/embedTheme";
import { CONTACT_URL, KOLISTAT_URL } from "../appLinks";

export type PageId = "about" | "howto";

/**
 * Shared shell for the standalone /about and /howto pages: theme
 * class on the body, a header with brand and nav, a content <main>,
 * and the footer. Returns the <main> element for the page to fill.
 */
export function renderPageShell(root: HTMLElement, active: PageId): HTMLElement {
  // No stored app settings on these pages; follow the system preference.
  const prefersDark =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");

  root.innerHTML = "";
  const shell = document.createElement("div");
  shell.className = "page-shell";

  const navLink = (href: string, label: string, id: PageId): string =>
    `<a href="${href}"${active === id ? ' aria-current="page"' : ""}>${label}</a>`;

  const header = document.createElement("header");
  header.className = "page-shell__header";
  header.innerHTML = `
    <a class="page-shell__brand" href="/">
      <img src="${duckPng}" alt="" width="22" height="22" />
      <span>Bedevere Wise</span>
    </a>
    <nav class="page-shell__nav" aria-label="Pages">
      ${navLink("/about", "About", "about")}
      ${navLink("/howto", "How-To", "howto")}
      <a class="page-shell__launch" href="/">Launch the app</a>
    </nav>
  `;

  const main = document.createElement("main");
  main.className = "page-shell__content";

  const footer = document.createElement("footer");
  footer.className = "page-shell__footer";
  footer.innerHTML = `
    <a href="https://github.com/KoliStat/bedevere-wise" target="_blank" rel="noopener noreferrer">GitHub</a>
    <span aria-hidden="true">·</span>
    <a href="${KOLISTAT_URL}" target="_blank" rel="noopener noreferrer">kolistat.com</a>
    <span aria-hidden="true">·</span>
    <a href="${CONTACT_URL}" target="_blank" rel="noopener noreferrer">Contact</a>
  `;

  shell.append(header, main, footer);
  root.appendChild(shell);
  return main;
}
