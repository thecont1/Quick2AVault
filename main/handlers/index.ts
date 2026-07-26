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
import { showToast } from "../windows/toast-window.js";
import { ensureVaultDirs, getVaultRoot, ingestFile, ingestFiles, type IngestResult } from "../services/vault.js";
import { notifyIngestOutcome } from "../services/notify.js";
import { getStats, listDocuments, removeDocumentOverride, setDocumentOverride, setNameOverride } from "../services/database.js";
import { getCachedSnapshot, refreshSnapshot } from "../services/snapshot.js";

// Sentinels used by the document-reassignment select in Settings.
const REASSIGN_AUTO = "__auto__";
const REASSIGN_UNIDENTIFIED = "__unidentified__";

/** Surface a near-orb toast when a genuine (non-AI-blocked) conversion failed. */
function toastConversionFailures(results: IngestResult[]): void {
  const failed = results.filter((r) => r.status === "ingested" && r.markdownSuccess === false && !r.aiBlocked);
  if (failed.length === 0) return;
  const n = failed.length;
  void showToast(
    `Couldn't convert ${n === 1 ? "a file" : `${n} files`} to Markdown`,
    n === 1
      ? "The original is stored safely in your vault."
      : "The originals are stored safely in your vault.",
    "warn",
  );
}

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
    toastConversionFailures(results);
    return results;
  });

  // Ingest one file at a time so the renderer can show batch progress. No
  // notification here — the renderer reports the whole batch via vault:notifyBatch.
  ipcMain.handle("vault:ingestFile", async (_event, filePath: string) => {
    if (typeof filePath !== "string" || filePath.length === 0) {
      return { filename: "", status: "error", error: "Invalid file path" } satisfies IngestResult;
    }
    return await ingestFile(filePath);
  });

  // Summarize a finished batch: a native notification plus a near-orb toast for
  // any genuine conversion failures.
  ipcMain.handle("vault:notifyBatch", async (_event, results: IngestResult[]) => {
    if (!Array.isArray(results)) return;
    notifyIngestOutcome(results);
    toastConversionFailures(results);
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

  // ── Manual attribution corrections ──────────────────────────────────
  // Rename or merge a person: both remap one name onto another. The change is
  // applied when the cached snapshot is re-aggregated (no AI re-run needed).
  ipcMain.handle("people:remap", async (_event, from: string, to: string) => {
    if (typeof from === "string" && typeof to === "string") {
      setNameOverride(from.trim(), to.trim());
    }
  });

  // Reassign a single document to a person, to "unidentified", or back to the
  // AI's own attribution (auto).
  ipcMain.handle("people:reassignDoc", async (_event, docId: number, target: string) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return;
    if (target === REASSIGN_AUTO) {
      removeDocumentOverride(id);
    } else if (target === REASSIGN_UNIDENTIFIED) {
      setDocumentOverride(id, null);
    } else if (typeof target === "string" && target.trim().length > 0) {
      setDocumentOverride(id, target.trim());
    }
  });

  logger.info("handlers", "✓ IPC handlers registered");
}
