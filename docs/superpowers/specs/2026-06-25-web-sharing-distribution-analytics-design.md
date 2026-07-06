# Web app: sharing, distribution & analytics — design

- **Date:** 2026-06-25
- **Status:** approved (brainstorm); spec under review
- **Branch:** `feature/web-sharing` (off `dev-0.14`)
- **Scope:** bedevere-wise web app only — no bedevere-desktop changes

## Overview

Three small, related additions to the standalone web app:

1. **KoliStat links + desktop hint** — point users at the KoliStat umbrella site and, once, at the bedevere-desktop download.
2. **Embed builder** — a dialog (and `.embed` command) that composes an `/embed` URL + `<iframe>` snippet from a public dataset URL, a query, a theme, and an autorun toggle.
3. **Cookieless analytics** — usage metrics on the main app (never the embed).

**Out of scope:** any bedevere-desktop change; the kolistat.com site itself (the download page lives there, owned separately); cookie-based analytics and consent UI (explicitly rejected — see Decisions).

## Decisions (from brainstorm)

- **Analytics:** cookieless (Cloudflare Web Analytics), **main app only**; the embed stays analytics-free. No cookies, no consent banner.
- **Embed builder:** a modal dialog opened via a `.embed` shell command; **Copy URL** + **Copy iframe** + **Preview in new tab** (no inline live preview).
- **Desktop link:** an About-tab link **plus** a one-time dismissible hint.

---

## 1. KoliStat links + desktop hint

### 1.1 URLs — single source of truth

New module `src/appLinks.ts`:

```ts
export const KOLISTAT_URL = "https://kolistat.com";
// Placeholder until the kolistat.com desktop page is live — confirm exact path.
export const DESKTOP_DOWNLOAD_URL = "https://kolistat.com/products/bedevere";
export const EMBED_BASE_URL = "https://bedeverewise.app/embed";
```

Both the About tab and the embed builder import from here, so the public URLs change in one place.

### 1.2 About tab — `src/components/HelpPanel/aboutHtml.ts`

- Repoint **"Made by KoliStat"** → `KOLISTAT_URL` (currently `github.com/KoliStat`).
- Add a **"Download the desktop app"** link → `DESKTOP_DOWNLOAD_URL` in the links row.

`aboutHtml` is a static template returning a string; it interpolates the constants the way it already interpolates `version`.

### 1.3 One-time hint

- Add `hasSeenDesktopHint?: boolean` to `AppSettings` (PersistenceService).
- In `BedevereApp` init (where `hasSeenOnboarding` is handled), after onboarding: if `!hasSeenDesktopHint`, show a small **dismissible** hint — *"Bigger datasets & native speed — get the desktop app"* with a link to `DESKTOP_DOWNLOAD_URL`. Clicking the link or dismissing sets `hasSeenDesktopHint = true` and persists. Shown at most once.
- **Web-only:** gate on a non-desktop backend (`backend.id === "duckdb-wasm"`) so the desktop renderer never shows "get the desktop app".
- **Widget (resolve in plan):** reuse the status-bar message surface if it supports an action/link + manual dismiss; otherwise a minimal dismissible banner above the status bar.

---

## 2. Embed builder

### 2.1 Surface

- New `.embed` shell command, registered in `CommandRegistry` (so it appears in the command palette). Opens `EmbedBuilderDialog`.
- (Optional, not v1: an editor-area affordance.)

### 2.2 Component

`src/components/EmbedBuilderDialog/EmbedBuilderDialog.{ts,scss}`, modeled on `SaveQueryDialog` (modal, focus-trapped, Esc / click-outside to close).

Opened by `BedevereApp` with the current context:

- `query` — the active SQL editor tab's content.
- `datasetUrl` — the active dataset's source URL if recoverable, else `null` → blank field + local-file notice.
- current app theme — to default the Theme select (or default **Auto**).

### 2.3 Fields

- **Dataset URL** (text, https only). If the active dataset is a local file (no source URL), show an inline notice: *this dataset is a local file and can't be embedded — paste a public https URL*. See the table-name caveat (2.6).
- **Query** (textarea) — prefilled, editable.
- **Theme** (select): Auto (default; omits the param) / Light / Classic Light / Dark / Classic Dark.
- **Autorun** (checkbox, default **on**).

### 2.4 Outputs (recomputed live on edit)

- **Embed URL** (read-only) + Copy.
- **iframe snippet** (read-only) + Copy.
- **Preview in new tab** → `window.open(embedUrl)`.

### 2.5 URL construction — `src/embed/embedUrl.ts` (new, unit-tested)

```ts
buildEmbedUrl(cfg: { datasets: string[]; query: string;
  theme: EmbedTheme | null; autorun: boolean }): string
buildEmbedIframe(url: string, opts?: { height?: number }): string
```

- Base = `EMBED_BASE_URL` (constant — **not** `window.location.origin`, which is wrong on desktop / dev).
- Params via `URLSearchParams`: `dataset` (repeatable), `query`, `theme` (omit when Auto), `autorun=1` (omit when off). Serialize and place after `#` (fragment) — matching `parseEmbedConfig`, which reads the fragment first.
- iframe: `<iframe src="<url>" width="100%" height="480" style="border:0" loading="lazy" title="Bedevere Wise"></iframe>`. Fixed height; the postMessage height-report (`embedMessages`) still lets a host opt into auto-resize.
- **Unit test:** `buildEmbedUrl(cfg)` → take the fragment → `parseEmbedConfig` round-trips back to `cfg` (encoding correctness, incl. SQL with `&`, `#`, spaces).

### 2.6 Table-name caveat

The `/embed` route derives a table name from each dataset URL (same convention as the app's URL import). The query's table references must match that name. For v1: a **single** dataset URL, and surface the **derived table name** next to the field so the user can confirm/adjust the query. (Verify the embed's exact naming convention at build time; multi-dataset is a future extension.)

---

## 3. Cookieless analytics

- Add the **Cloudflare Web Analytics** beacon to the **root `index.html` only**. The embed has its own HTML entry — leave it beacon-free.
- CSP (`public/_headers`), **main-app rule only**: `script-src` += `https://static.cloudflareinsights.com`; `connect-src` += `https://cloudflareinsights.com`. The `/embed` CSP is unchanged.
- Token comes from the Cloudflare dashboard (Web Analytics → add site); use a placeholder in the snippet until provisioned.
- No cookies; nothing to consent to.

---

## Testing

- **Unit:** `embedUrl` round-trip (`buildEmbedUrl` → `parseEmbedConfig`), including SQL with reserved characters.
- **Manual:** `.embed` opens the dialog; Copy URL / Copy iframe produce a valid embed; Preview-in-new-tab loads; a local-file dataset shows the notice (no dead link); the one-time hint shows once then never again; the analytics beacon loads on the app and **not** on `/embed`; the CSP doesn't block the beacon (smoke-test on a preview deploy).

## Files

- **New:** `src/appLinks.ts`; `src/embed/embedUrl.ts` (+ `__tests__/embedUrl.test.ts`); `src/components/EmbedBuilderDialog/EmbedBuilderDialog.{ts,scss}`.
- **Changed:** `src/components/HelpPanel/aboutHtml.ts`; `PersistenceService` (`AppSettings`); `BedevereApp` (hint + `.embed` command + dialog wiring); `CommandRegistry` / `Shell` (`.embed`); `index.html` (beacon); `public/_headers` (CSP).

## Open items

- Exact `DESKTOP_DOWNLOAD_URL` path — placeholder until the kolistat.com page is live.
- Whether a dataset's source URL is recoverable for prefill — fallback is blank field + local-file notice.
- The one-time-hint widget — status-bar message vs. a small banner.
- Cloudflare Web Analytics token — provision in the dashboard.
