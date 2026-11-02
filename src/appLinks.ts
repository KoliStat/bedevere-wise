/** External URLs used across the app — single source of truth. */

/** KoliStat umbrella site. */
export const KOLISTAT_URL = "https://kolistat.com";

/** bedevere-desktop download section on kolistat.com. */
export const DESKTOP_DOWNLOAD_URL = "https://kolistat.com/products/bedevere#desktop";

/** Contact / support page (KoliStat). */
export const CONTACT_URL = "https://kolistat.com/contact";

/** End-user license agreement of bedevere desktop, on kolistat.com. */
export const DESKTOP_TERMS_URL = "https://kolistat.com/products/bedevere/terms";

/** Public repo with bedevere desktop's installers, release notes and third-party notices. */
export const DESKTOP_RELEASES_REPO_URL = "https://github.com/KoliStat/bedevere-desktop-releases";

/**
 * Production /embed origin. Constant, NOT `window.location.origin` — the
 * embed builder runs inside the app (any origin, or `file://` on desktop)
 * but the embed is always served from bedeverewise.app.
 */
export const EMBED_BASE_URL = "https://bedeverewise.app/embed";
