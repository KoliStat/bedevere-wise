import type { TutorialNode } from "./tutorial";

/**
 * Renders TutorialNode data into help-panel DOM. Shared by the
 * HelpPanel How-To tab and the standalone /howto page, so both show
 * the same tutorial by construction.
 */
export interface TutorialDomOptions {
  /**
   * Clipboard write for the snippet Copy button; must resolve true on
   * success. Defaults to {@link copyTextToClipboard}.
   */
  copyText?: (text: string) => Promise<boolean>;
  /** Called when a copy attempt reports failure. */
  onCopyFailed?: () => void;
}

/** navigator.clipboard with a textarea/execCommand fallback for older engines. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function buildTutorialNode(node: TutorialNode, options?: TutorialDomOptions): HTMLElement {
  switch (node.kind) {
    case "heading": {
      const h = document.createElement("h4");
      h.className = "help-panel__tutorial-heading";
      h.textContent = node.text;
      return h;
    }
    case "prose": {
      const p = document.createElement("p");
      p.className = "help-panel__tutorial-prose";
      p.innerHTML = node.html;
      return p;
    }
    case "tip": {
      const p = document.createElement("p");
      p.className = "help-panel__tip";
      p.innerHTML = `<strong>Tip:</strong> ${node.html}`;
      return p;
    }
    case "snippet":
      return buildSnippet(node.sql, options);
  }
}

export function buildTutorialNodes(
  nodes: readonly TutorialNode[],
  options?: TutorialDomOptions,
): HTMLElement[] {
  return nodes.map((node) => buildTutorialNode(node, options));
}

function buildSnippet(sql: string, options?: TutorialDomOptions): HTMLElement {
  const card = document.createElement("div");
  card.className = "help-panel__snippet help-panel__snippet--titleless";

  const head = document.createElement("div");
  head.className = "help-panel__snippet-head help-panel__snippet-head--titleless";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "help-panel__copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    const copy = options?.copyText ?? copyTextToClipboard;
    const ok = await copy(sql);
    if (!ok) {
      options?.onCopyFailed?.();
      return;
    }
    const original = copyBtn.textContent ?? "Copy";
    copyBtn.textContent = "Copied!";
    copyBtn.classList.add("help-panel__copy-btn--copied");
    window.setTimeout(() => {
      copyBtn.textContent = original;
      copyBtn.classList.remove("help-panel__copy-btn--copied");
    }, 1500);
  });
  head.appendChild(copyBtn);

  const pre = document.createElement("pre");
  pre.className = "help-panel__snippet-code";
  const code = document.createElement("code");
  code.textContent = sql;
  pre.appendChild(code);

  card.appendChild(head);
  card.appendChild(pre);
  return card;
}
