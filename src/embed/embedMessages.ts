/**
 * postMessage protocol for the /embed route. Child→parent for height
 * reporting; parent→child for theme switches and run-trigger so the
 * parent can drive the embed (e.g. sync a dark-mode toggle).
 *
 * Asymmetry worth noting: the /embed route is framable by ANY origin
 * (see frame-ancestors in public/_headers — it's a public widget), but
 * the parent→child *control* messages below are accepted only from our
 * first-party blogs. Arbitrary embedders set the theme via the `theme=`
 * URL param instead; the child→parent resize broadcast already goes to
 * everyone. Off-allowlist messages are silently dropped — never thrown —
 * because a noisy iframe is harder to debug than a quiet one.
 */

export const ALLOWED_PARENT_ORIGINS = [
  "https://kolistat.com",
  "https://www.kolistat.com",
  "https://caveofcaerbannog.com",
  "https://www.caveofcaerbannog.com",
  // Local dev (blog + embed both run on localhost during development)
  "http://localhost:3000",
  "http://localhost:4173",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:5173",
] as const;

export type EmbedOutboundMessage = {
  type: "embed-resize";
  height: number;
  id?: string;
} | {
  type: "embed-ready";
  id?: string;
};

export type EmbedInboundMessage =
  | { type: "embed-theme"; theme: "light" | "classic-light" | "dark" | "classic-dark" }
  | { type: "embed-run" };

export interface EmbedMessageHandlers {
  onSetTheme: (theme: "light" | "classic-light" | "dark" | "classic-dark") => void;
  onRunRequested: () => void;
}

/**
 * Post a message to the parent window. Uses `*` as targetOrigin because
 * the embed doesn't know its parent origin in advance — the parent is
 * the one with the responsibility for validating; we just send and let
 * them choose to listen. Resize/ready payloads contain nothing
 * sensitive (a number and an opaque echo id).
 */
export function postToParent(msg: EmbedOutboundMessage): void {
  if (typeof window === "undefined" || window.parent === window) return;
  try {
    window.parent.postMessage(msg, "*");
  } catch {
    // Cross-origin throws are swallowed: the parent isn't listening or
    // the iframe was detached. Nothing actionable.
  }
}

/**
 * Watch the embed root for size changes and emit `embed-resize` to the
 * parent. Debounced so a burst of layout changes (e.g. canvas
 * initialization, query result reflow) coalesces into one message.
 * Returns a teardown function.
 */
export function installResizeReporter(root: HTMLElement, id: string | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHeight = -1;
  const emit = () => {
    const height = document.documentElement.scrollHeight;
    if (height === lastHeight) return;
    lastHeight = height;
    postToParent({ type: "embed-resize", height, ...(id ? { id } : {}) });
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(emit, 50);
  };
  // ResizeObserver covers layout changes inside the embed; window
  // resize covers iframe-viewport changes from the parent. Both feed
  // the same debounced emit.
  const ro = new ResizeObserver(schedule);
  ro.observe(root);
  window.addEventListener("resize", schedule);
  // Emit once on install so the parent gets an initial height before
  // any content changes.
  schedule();
  return () => {
    ro.disconnect();
    window.removeEventListener("resize", schedule);
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * Listen for parent → child messages, validate origin against the
 * allowlist, validate shape, then dispatch. Returns a teardown
 * function for symmetry with `installResizeReporter`.
 */
export function installParentListener(handlers: EmbedMessageHandlers): () => void {
  const allowed = new Set<string>(ALLOWED_PARENT_ORIGINS);
  const onMessage = (e: MessageEvent) => {
    if (!allowed.has(e.origin)) return;
    const data = e.data;
    if (!data || typeof data !== "object") return;
    const msg = data as Partial<EmbedInboundMessage>;
    if (
      msg.type === "embed-theme" &&
      (msg.theme === "light" || msg.theme === "classic-light" || msg.theme === "dark" || msg.theme === "classic-dark")
    ) {
      handlers.onSetTheme(msg.theme);
    } else if (msg.type === "embed-run") {
      handlers.onRunRequested();
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
