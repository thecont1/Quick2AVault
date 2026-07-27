/**
 * First-run finance-preferences window.
 *
 * On a fresh install we ask the user to review a small set of financial
 * preferences (currency, financial-year definition, date + number formatting)
 * prefilled with India defaults, before the app starts serious analysis. A
 * normal framed, centered window — calm and modal-feeling without being a hard
 * modal.
 */
import { BrowserWindow, logger } from "@glaze/core/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";

let onboardingWindow: BrowserWindow | null = null;

export async function openOnboardingWindow(): Promise<void> {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    return;
  }

  logger.info("onboarding", "Creating onboarding window");
  onboardingWindow = new BrowserWindow({
    windowKey: "onboarding",
    width: 480,
    height: 600,
    minWidth: 420,
    minHeight: 520,
    title: "Welcome to Quick2Afvault",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  onboardingWindow.once("ready-to-show", () => onboardingWindow?.show());
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });

  const url = await getWindowUrl("onboarding-window.html");
  await onboardingWindow.loadURL(url);
}

export function closeOnboardingWindow(): void {
  onboardingWindow?.close();
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboardingWindow;
}
