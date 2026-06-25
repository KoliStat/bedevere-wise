import { EMBED_BASE_URL } from "../appLinks";
import type { EmbedTheme } from "./embedTheme";

export interface EmbedUrlConfig {
  datasets: string[];
  query: string;
  theme: EmbedTheme | null;
  autorun: boolean;
}

/**
 * Compose the /embed URL with all params in the fragment (`#…`). The
 * fragment (not the query string) keeps the prefilled SQL off the request
 * URL — see embed/main.ts. Mirrors what `parseEmbedConfig` reads back.
 */
export function buildEmbedUrl(config: EmbedUrlConfig): string {
  const params = new URLSearchParams();
  for (const ds of config.datasets) {
    const trimmed = ds.trim();
    if (trimmed) params.append("dataset", trimmed);
  }
  if (config.query.trim()) params.set("query", config.query);
  if (config.theme) params.set("theme", config.theme);
  if (config.autorun) params.set("autorun", "1");
  const frag = params.toString();
  return frag ? `${EMBED_BASE_URL}#${frag}` : EMBED_BASE_URL;
}

/** Wrap an embed URL in a copy-paste `<iframe>` snippet. */
export function buildEmbedIframe(url: string, opts: { height?: number } = {}): string {
  const height = opts.height ?? 480;
  return `<iframe src="${url}" width="100%" height="${height}" style="border:0" loading="lazy" title="Bedevere Wise"></iframe>`;
}
