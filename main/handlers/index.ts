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
import { closeTrainingWindow, openTrainingWindow } from "../windows/training-window.js";
import { showToast } from "../windows/toast-window.js";
import { ensureVaultDirs, getVaultRoot, ingestFile, ingestFiles, type IngestResult } from "../services/vault.js";
import { notifyIngestOutcome } from "../services/notify.js";
import {
  getPendingReviewCount,
  getStats,
  getTrainingStats,
  listDocuments,
  removeDocumentOverride,
  setDocumentOverride,
  setNameOverride,
  type RuleType,
} from "../services/database.js";
import { getCachedSnapshot, refreshSnapshot } from "../services/snapshot.js";
import {
  addRule,
  editRule,
  isTrainingMode,
  listRules,
  nextPendingReview,
  prepareTraining,
  removeRule,
  resetTrainingProgress,
  saveAnswers,
  setTrainingMode,
  skipReview,
  type TrainingAnswer,
} from "../services/training.js";

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

const VALID_RULE_TYPES: RuleType[] = ["vendor_category", "person_variant", "keyword_doctype", "source_scope"];

function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (VALID_RULE_TYPES as string[]).includes(value);
}

/** Coerce loosely-typed IPC answers into the training answer shape. */
function toTrainingAnswers(value: unknown): TrainingAnswer[] {
  if (!Array.isArray(value)) return [];
  const out: TrainingAnswer[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && "id" in item && "value" in item) {
      const id = (item as { id: unknown }).id;
      const val = (item as { value: unknown }).value;
      if (typeof id === "string" && (typeof val === "string" || Array.isArray(val))) {
        out.push({ id, value: val as string | string[] });
      }
    }
  }
  return out;
}

/** Tell the orb (and any listeners) how many training reviews are pending. */
function broadcastTraining(): void {
  ipcMain.broadcast("training:changed", { pendingCount: getPendingReviewCount(), mode: isTrainingMode() });
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

  // ── Training Mode ───────────────────────────────────────────────────
  ipcMain.handle("training:getMode", async () => {
    return isTrainingMode();
  });

  ipcMain.handle("training:setMode", async (_event, on: boolean) => {
    setTrainingMode(Boolean(on));
    broadcastTraining();
    return isTrainingMode();
  });

  // After a batch of drops, generate questions for each new document (when
  // Training Mode is on), then open the popup if anything needs asking.
  ipcMain.handle("training:prepareBatch", async (_event, docIds: number[]) => {
    if (!isTrainingMode() || !Array.isArray(docIds)) return { pendingCount: 0 };
    const ids = docIds.map((d) => Number(d)).filter((d) => Number.isFinite(d));
    for (const id of ids) {
      await prepareTraining(id);
    }
    const pendingCount = getPendingReviewCount();
    if (pendingCount > 0) await openTrainingWindow();
    broadcastTraining();
    return { pendingCount };
  });

  ipcMain.handle("training:getPending", async () => {
    return nextPendingReview();
  });

  ipcMain.handle("training:getPendingCount", async () => {
    return getPendingReviewCount();
  });

  ipcMain.handle("training:saveAnswers", async (_event, docId: number, answers: unknown) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return { learned: 0, reinforced: 0 };
    const result = await saveAnswers(id, toTrainingAnswers(answers));
    broadcastTraining();
    // Subtle near-orb confirmation of what was learned.
    const { learned, reinforced } = result;
    if (learned > 0) {
      void showToast(`Learned ${learned} new rule${learned === 1 ? "" : "s"}`, "Training Mode is getting smarter.", "info");
    } else if (reinforced > 0) {
      void showToast(`Reinforced ${reinforced} rule${reinforced === 1 ? "" : "s"}`, "Thanks — noted.", "info");
    } else {
      void showToast("Answers saved", "Thanks — noted.", "info");
    }
    return result;
  });

  ipcMain.handle("training:skip", async (_event, docId: number) => {
    const id = Number(docId);
    if (Number.isFinite(id)) skipReview(id);
    broadcastTraining();
  });

  ipcMain.handle("training:open", async () => {
    await openTrainingWindow();
  });

  ipcMain.handle("training:close", async () => {
    closeTrainingWindow();
  });

  ipcMain.handle("training:getStats", async () => {
    return { ...getTrainingStats(), mode: isTrainingMode() };
  });

  ipcMain.handle("training:listRules", async () => {
    return listRules();
  });

  ipcMain.handle("training:addRule", async (_event, ruleType: unknown, matchKey: unknown, value: unknown) => {
    if (!isRuleType(ruleType) || typeof matchKey !== "string" || typeof value !== "string") return null;
    if (!matchKey.trim() || !value.trim()) return null;
    const rule = await addRule({ ruleType, matchKey, value });
    broadcastTraining();
    return rule;
  });

  ipcMain.handle("training:updateRule", async (_event, id: number, patch: unknown) => {
    const ruleId = Number(id);
    if (!Number.isFinite(ruleId) || !patch || typeof patch !== "object") return;
    const p = patch as { value?: unknown; autoApply?: unknown };
    await editRule(ruleId, {
      value: typeof p.value === "string" ? p.value : undefined,
      autoApply: typeof p.autoApply === "boolean" ? p.autoApply : undefined,
    });
    broadcastTraining();
  });

  ipcMain.handle("training:deleteRule", async (_event, id: number) => {
    const ruleId = Number(id);
    if (Number.isFinite(ruleId)) await removeRule(ruleId);
    broadcastTraining();
  });

  ipcMain.handle("training:reset", async () => {
    await resetTrainingProgress();
    broadcastTraining();
  });

  logger.info("handlers", "✓ IPC handlers registered");
}
