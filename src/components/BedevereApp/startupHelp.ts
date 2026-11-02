import type { AppSettings } from "../../data/PersistenceService";
import type { HelpPanelTab } from "../HelpPanel/HelpPanel";

/**
 * Which Help tab to open when the app starts, or null for none.
 * The first-ever visit always gets the How-To onboarding. After that
 * the app starts quiet unless the user turned "Show Help at startup"
 * on in Settings (the pre-0.16 behavior, Import tab).
 */
export function startupHelpTab(settings: AppSettings): HelpPanelTab | null {
  if (!settings.hasSeenOnboarding) return "howto";
  if (settings.showHelpOnStartup) return "import";
  return null;
}
