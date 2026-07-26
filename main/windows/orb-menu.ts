/**
 * Right-click context menu for the orb: Open Vault Folder, Settings, Quit.
 */
import { Menu, app, shell, logger } from "@glaze/core/backend";

import { ensureVaultDirs, getVaultRoot } from "../services/vault.js";
import { reviewCount } from "../services/reviews.js";
import { openSettingsWindow } from "./settings-window.js";
import { openSnapshotWindow } from "./snapshot-window.js";

export async function showOrbMenu(): Promise<void> {
  const pendingReviews = reviewCount();
  const menu = Menu.buildFromTemplate([
    {
      label: "Financial Snapshot…",
      click: () => {
        void openSnapshotWindow();
      },
    },
    {
      label: pendingReviews > 0 ? `Review Queue (${pendingReviews})…` : "Review Queue…",
      click: () => {
        void openSettingsWindow();
      },
    },
    { type: "separator" },
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
