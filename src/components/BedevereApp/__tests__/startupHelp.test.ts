import { describe, expect, it } from "vitest";
import { startupHelpTab } from "../startupHelp";

describe("startupHelpTab", () => {
  it("opens the How-To onboarding on the first visit", () => {
    expect(startupHelpTab({})).toBe("howto");
    // The toggle never suppresses the one-time onboarding.
    expect(startupHelpTab({ showHelpOnStartup: true })).toBe("howto");
  });

  it("opens nothing on later visits by default", () => {
    expect(startupHelpTab({ hasSeenOnboarding: true })).toBeNull();
    expect(startupHelpTab({ hasSeenOnboarding: true, showHelpOnStartup: false })).toBeNull();
  });

  it("opens the Import tab on later visits when the user opted in", () => {
    expect(startupHelpTab({ hasSeenOnboarding: true, showHelpOnStartup: true })).toBe("import");
  });
});
