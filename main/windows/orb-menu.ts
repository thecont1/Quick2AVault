/**
 * Right-click context menu for the orb: Open Vault Folder, Settings, Quit.
 */
import { Menu, app, shell, logger } from "@glaze/core/backend";

import { ensureVaultDirs, getVaultRoot } from "../services/vault.js";
import { openSettingsWindow } from "./settings-window.js";

export async function showOrbMenu(): Promise<void> {
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Vault Folder",
      click: async () => {
        try {
          await ensureVaultDirs();
          await shell.openPath(getVaultRoot());
        } catch (error) {
          logger.error("orb-menu", "Failed to open vault folder", { error: String(error) });
        }
      },
    },
    {
      label: "Settings…",
      click: () => {
        void openSettingsWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit Quick2Afvault",
      click: () => {
        app.quit();
      },
    },
  ]);

  menu.popup();
}
