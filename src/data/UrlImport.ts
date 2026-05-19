/**
 * Fetch a remote resource and wrap the response into a `File` so the
 * normal `FileImportService` dispatch can take over. Direct browser
 * fetch only — sources without permissive CORS will fail with a
 * humane "this is probably CORS" message rather than the generic
 * `TypeError: Failed to fetch`.
 *
 * Routes supported transparently because they share the file dispatch:
 *   - `.csv` / `.tsv` → CSV handler (read_csv_auto + sample_size=-1)
 *   - `.json` → JSON handler
 *   - `.parquet` → Parquet handler
 *   - `.html` / `.htm` → HTML handler (which may surface the multi-
 *     table picker)
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/json": "json",
  "application/parquet": "parquet",
  "application/x-parquet": "parquet",
  "text/html": "html",
  "application/xhtml+xml": "html",
};

export async function fetchAsFile(url: string): Promise<File> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}". Only http:// and https:// are supported.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(parsed.toString(), { redirect: "follow" });
  } catch (err) {
    // Browsers report CORS rejections as a generic TypeError with
    // no further detail. We can't distinguish that from "host
    // unreachable", but in practice CORS is the dominant reason this
    // throws — give the user something actionable.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to fetch ${parsed.toString()}.\n` +
        `This is usually a CORS restriction — the remote server didn't allow direct ` +
        `browser access. If you can download the file in your browser, save it and drag ` +
        `it into the app.\n` +
        `Underlying error: ${message}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status} ${response.statusText}) for ${parsed.toString()}.`);
  }

  const fileName = deriveFileName(parsed, response);
  const buffer = await response.arrayBuffer();
  const type = response.headers.get("content-type")?.split(";")[0].trim() || "";
  return new File([buffer], fileName, { type });
}

/**
 * Pick a filename that downstream extension detection will route to
 * the right format handler. Path basename wins when it has a known
 * extension; otherwise we synthesise a name from the Content-Type
 * (and a short URL hash to keep collisions low when the user fetches
 * multiple typed-only URLs in one session).
 */
function deriveFileName(url: URL, response: Response): string {
  const pathBase = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
  if (pathBase && /\.[a-z0-9]{1,8}$/i.test(pathBase)) return pathBase;

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  if (ext) {
    const stem = pathBase || `remote-${shortHash(url.toString())}`;
    return `${stem.replace(/\.[a-z0-9]+$/i, "")}.${ext}`;
  }

  // Last-ditch: keep the path basename if any, default to HTML
  // (most common typed-only ambiguity is "a web page").
  return pathBase || `remote-${shortHash(url.toString())}.html`;
}

/**
 * Short, stable identifier for a URL. Not cryptographic; just enough
 * to disambiguate `remote-…` filenames across multiple typed-only
 * fetches in the same session.
 */
function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 8);
}
