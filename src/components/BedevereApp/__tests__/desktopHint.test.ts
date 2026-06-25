import { afterEach, describe, expect, it, vi } from "vitest";
import { shouldShowDesktopHint, renderDesktopHint } from "../desktopHint";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shouldShowDesktopHint", () => {
  it("shows once on the web after onboarding", () => {
    expect(shouldShowDesktopHint({ hasSeenOnboarding: true }, "duckdb-wasm")).toBe(true);
  });
  it("never shows on a non-web backend (already on desktop)", () => {
    expect(shouldShowDesktopHint({ hasSeenOnboarding: true }, "desktop-ipc")).toBe(false);
  });
  it("does not show before onboarding or once already seen", () => {
    expect(shouldShowDesktopHint({}, "duckdb-wasm")).toBe(false);
    expect(
      shouldShowDesktopHint({ hasSeenOnboarding: true, hasSeenDesktopHint: true }, "duckdb-wasm"),
    ).toBe(false);
  });
});

describe("renderDesktopHint", () => {
  it("renders a download link and fires onDismiss on close", () => {
    const onDismiss = vi.fn();
    renderDesktopHint(document.body, "https://kolistat.com/x", onDismiss);
    const link = document.querySelector<HTMLAnchorElement>("a.desktop-hint__link")!;
    expect(link.href).toContain("https://kolistat.com/x");
    document.querySelector<HTMLButtonElement>("button.desktop-hint__dismiss")!.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".desktop-hint")).toBeNull();
  });
});
