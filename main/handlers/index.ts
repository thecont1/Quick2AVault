/**
 * Handler Registration
 *
 * Registers all IPC handlers for the Quick2Afvault orb.
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { ipcMain, shell, logger } from "@glaze/core/backend";

import { getSettingsWindow, openSettingsWindow } from "../windows/settings-window.js";
import { showOrbMenu } from "../windows/orb-menu.js";
import { beginOrbDrag, endOrbDrag, moveOrbBy } from "../windows/orb-window.js";
import { closeSnapshotWindow, openSnapshotWindow, setSnapshotBusy } from "../windows/snapshot-window.js";
import { ensureVaultDirs, getVaultRoot, ingestFiles } from "../services/vault.js";
import { notifyIngestOutcome } from "../services/notify.js";
import { getStats, listDocuments } from "../services/database.js";
import { getCachedSnapshot, refreshSnapshot } from "../services/snapshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Return the .glaze project path (used for deep links back to the host)
  ipcMain.handle("app:getProjectPath", async () => {
    return path.join(__dirname, "..", "..");
  });

  // Settings window handlers
  ipcMain.handle("window:openSettings", async () => {
    await openSettingsWindow();
  });

  ipcMain.handle("window:closeSettings", async () => {
    getSettingsWindow()?.close();
  });

  // ── Vault handlers ──────────────────────────────────────────────────
  ipcMain.handle("vault:ingestFiles", async (_event, filePaths: string[]) => {
    if (!Array.isArray(filePaths)) return [];
    const valid = filePaths.filter((p) => typeof p === "string" && p.length > 0);
    const results = await ingestFiles(valid);
    notifyIngestOutcome(results);
    return results;
  });

  ipcMain.handle("vault:openFolder", async () => {
    await ensureVaultDirs();
    return await shell.openPath(getVaultRoot());
  });

  ipcMain.handle("vault:getVaultPath", async () => {
    return getVaultRoot();
  });

  ipcMain.handle("vault:listDocuments", async () => {
    return listDocuments();
  });

  ipcMain.handle("vault:getStats", async () => {
    return getStats();
  });

  // ── Orb context menu ────────────────────────────────────────────────
  ipcMain.handle("orb:showContextMenu", async () => {
    await showOrbMenu();
  });

  // ── Orb custom drag (fire-and-forget) ───────────────────────────────
  ipcMain.on("orb:dragStart", () => beginOrbDrag());
  ipcMain.on("orb:dragMove", (_event, dx: number, dy: number) => {
    moveOrbBy(Number(dx) || 0, Number(dy) || 0);
  });
  ipcMain.on("orb:dragEnd", () => endOrbDrag());

  // ── Financial snapshot ──────────────────────────────────────────────
  ipcMain.handle("snapshot:open", async () => {
    await openSnapshotWindow();
  });

  ipcMain.handle("snapshot:close", async () => {
    closeSnapshotWindow();
  });

  ipcMain.handle("snapshot:getCached", async () => {
    return getCachedSnapshot();
  });

  ipcMain.handle("snapshot:refresh", async () => {
    return await refreshSnapshot();
  });

  ipcMain.handle("snapshot:setBusy", async (_event, value: boolean) => {
    setSnapshotBusy(Boolean(value));
  });

  logger.info("handlers", "✓ IPC handlers registered");
}
