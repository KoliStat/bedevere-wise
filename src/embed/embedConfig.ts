/**
 * URL parameters the /embed route reads on load. See README / blog
 * integration spec — these match the names emitted by the
 * caveofcaerbannog renderer.
 */
export interface EmbedConfig {
  /** Each `dataset=…` query-string entry, in order. */
  datasets: string[];
  /** Optional SQL to prefill the editor. */
  query: string | null;
  /** Explicit theme, or null to follow prefers-color-scheme. */
  theme: "light" | "dark" | null;
  /** Auto-run the prefilled query once all datasets are loaded. */
  autorun: boolean;
  /** Opaque tag from the parent — echoed back in postMessage payloads
   *  so a parent with multiple iframes can demux. */
  id: string | null;
}

export function parseEmbedConfig(search: string): EmbedConfig {
  const params = new URLSearchParams(search);
  const themeRaw = params.get("theme");
  const theme = themeRaw === "light" || themeRaw === "dark" ? themeRaw : null;
  return {
    datasets: params.getAll("dataset"),
    query: params.get("query"),
    theme,
    autorun: params.get("autorun") === "1",
    id: params.get("id"),
  };
}

/**
 * Describe a dataset URL: the virtual-file name to register it under
 * (with extension so the DuckDB extension layer can sniff it), the
 * user-facing table name (sanitized stem), and the reader SQL
 * fragment. Returns null for unsupported extensions so the caller
 * can surface a friendly error instead of trying to register a file
 * DuckDB can't read.
 *
 * The blog spec uses `.parquet`; CSV / NDJSON are supported because
 * they're cheap to add and useful for ad-hoc embeds.
 */
export function describeDatasetUrl(
  url: string,
): { fileName: string; tableName: string; readerSql: (registeredName: string) => string } | null {
  // Strip query string + hash before extension sniffing so
  // /datasets/foo.parquet?v=2 still matches `.parquet`.
  const cleanPath = url.split("?")[0].split("#")[0];
  const base = cleanPath.split("/").pop() ?? "dataset";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const stem = base.slice(0, dot);
  const ext = base.slice(dot + 1).toLowerCase();
  // Sanitize stem to a SQL-safe identifier (letters/digits/underscore,
  // not starting with a digit). DuckDB allows quoted weird names but
  // the embed table name appears in user-written queries, so an
  // unquoted-safe stem is friendlier.
  const safe = stem.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[0-9]/, "_$&") || "dataset";

  switch (ext) {
    case "parquet":
      return { fileName: base, tableName: safe, readerSql: (n) => `read_parquet('${n}')` };
    case "csv":
    case "tsv":
      return {
        fileName: base,
        tableName: safe,
        readerSql: (n) => (ext === "tsv" ? `read_csv_auto('${n}', delim='\t')` : `read_csv_auto('${n}')`),
      };
    case "json":
    case "ndjson":
      return { fileName: base, tableName: safe, readerSql: (n) => `read_json_auto('${n}')` };
    default:
      return null;
  }
}
