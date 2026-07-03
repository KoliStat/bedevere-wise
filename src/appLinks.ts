/** External URLs used across the app — single source of truth. */

/** KoliStat umbrella site. */
export const KOLISTAT_URL = "https://kolistat.com";

/** bedevere-desktop download page on kolistat.com. */
export const DESKTOP_DOWNLOAD_URL = "https://kolistat.com/products/bedevere";

/** Contact / support page (KoliStat). */
export const CONTACT_URL = "https://kolistat.com/contact";

/**
 * Production /embed origin. Constant, NOT `window.location.origin` — the
 * embed builder runs inside the app (any origin, or `file://` on desktop)
 * but the embed is always served from bedeverewise.app.
 */
export const EMBED_BASE_URL = "https://bedeverewise.app/embed";
