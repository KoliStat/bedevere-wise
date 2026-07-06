import type { AppSettings } from "../../data/PersistenceService";

/**
 * Whether to show the one-time "get the desktop app" hint: web only
 * (a non-WASM backend means we're already on desktop), post-onboarding,
 * and at most once.
 */
export function shouldShowDesktopHint(settings: AppSettings, backendId: string): boolean {
  return (
    backendId === "duckdb-wasm" &&
    settings.hasSeenOnboarding === true &&
    !settings.hasSeenDesktopHint
  );
}

/**
 * Render a small dismissible hint into `host`. `onDismiss` fires when the
 * user clicks the download link or the × — the caller persists the
 * "seen" flag there. Returns the banner element.
 */
export function renderDesktopHint(
  host: HTMLElement,
  downloadUrl: string,
  onDismiss: () => void,
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "desktop-hint";

  const text = document.createElement("span");
  text.className = "desktop-hint__text";
  text.textContent = "Bigger datasets & native speed — ";

  const link = document.createElement("a");
  link.className = "desktop-hint__link";
  link.href = downloadUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "get the desktop app";
  link.addEventListener("click", () => onDismiss());
  text.appendChild(link);

  const dismiss = document.createElement("button");
  dismiss.className = "desktop-hint__dismiss";
  dismiss.setAttribute("aria-label", "Dismiss");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    bar.remove();
    onDismiss();
  });

  bar.append(text, dismiss);
  host.appendChild(bar);
  return bar;
}
