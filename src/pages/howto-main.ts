// Self-hosted fonts (Statistical-Report identity), matching src/main.ts.
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/400-italic.css";
import "@fontsource/source-sans-3/600.css";

import "../styles/main.scss";
import "../styles/pages.scss";
import { renderHowtoPage } from "./howtoPage";

const root = document.getElementById("page-root");
if (root) {
  renderHowtoPage(root);
} else {
  console.error("/howto: missing #page-root mount node");
}
