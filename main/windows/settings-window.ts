import { BrowserWindow, ipcMain, logger } from "@glaze/core/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";

let settingsWindow: BrowserWindow | null = null;
// A section to scroll to on open (e.g. "review-queue"), consumed once by the
// renderer on mount. When the window is already open we broadcast instead.
let pendingSection: string | null = null;

/** Consumed once by the settings renderer on mount to scroll to a section. */
export function takePendingSettingsSection(): string | null {
  const section = pendingSection;
  pendingSection = null;
  return section;
}

export async function openSettingsWindow(section?: string | null): Promise<void> {
  const target = section?.trim() || null;

  // If window exists and is not destroyed, just show it
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    logger.debug("settings", "Settings window already exists, showing it");
    settingsWindow.show();
    if (target) ipcMain.broadcast("settings:focusSection", { section: target });
    return;
  }

  pendingSection = target;

  logger.info("settings", "Creating settings window");

  settingsWindow = new BrowserWindow({
    windowKey: "settings",
    width: 880,
    height: 660,
    minWidth: 720,
    minHeight: 480,
    title: "Settings",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });

  const url = await getWindowUrl("settings-window.html");
  logger.info("settings", "Loading settings URL", { url });

  await settingsWindow.loadURL(url);
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}
