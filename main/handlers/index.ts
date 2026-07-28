/**
 * Handler Registration
 *
 * Registers all IPC handlers for the Quick2Afvault orb.
 */

import * as path from "path";
import { fileURLToPath } from "url";

import { ipcMain, shell, logger } from "@glaze/core/backend";

import {
  getSettingsWindow,
  openSettingsWindow,
  takePendingSettingsSection,
} from "../windows/settings-window.js";
import { closeOnboardingWindow, openOnboardingWindow } from "../windows/onboarding-window.js";
import { openDocumentsWindow, takeInitialDocumentsContext } from "../windows/documents-window.js";
import type { DocumentDrilldown } from "../services/document-browser-model.js";
import { showOrbMenu } from "../windows/orb-menu.js";
import { beginOrbDrag, endOrbDrag, moveOrbBy } from "../windows/orb-window.js";
import {
  closeSnapshotWindow,
  openSnapshotWindow,
  setSnapshotBusy,
} from "../windows/snapshot-window.js";
import { closeTrainingWindow, openTrainingWindow } from "../windows/training-window.js";
import { showToast } from "../windows/toast-window.js";
import {
  ensureVaultDirs,
  getVaultRoot,
  ingestFile,
  ingestFiles,
  type IngestResult,
} from "../services/vault.js";
import { enqueueDrop } from "../services/ingest-queue.js";
import { notifyIngestOutcome, toastConversionFailures } from "../services/notify.js";
import {
  deleteRecurringEntry,
  getPendingReviewCount,
  getStats,
  getTrainingStats,
  insertRecurringEntry,
  listDocuments,
  listRecurringEntries,
  removeDocumentOverride,
  setDocumentOverride,
  updateRecurringEntry,
  PERSON_ROLES,
  REVIEW_FIELDS,
  type PersonRole,
  type ReviewField,
  type RuleType,
} from "../services/database.js";
import { getCachedSnapshot, refreshSnapshot } from "../services/snapshot.js";
import { getImpactPrefs, setImpactPrefs, type ImpactPrefs } from "../services/impact.js";
import { getWatchCategories, setWatchCategories } from "../services/watch-categories.js";
import { coerceRecurringInput } from "../services/recurring.js";
import {
  getFinancePrefs,
  isFirstRun,
  setFinancePrefs,
  type FinancePrefs,
} from "../services/preferences.js";
import {
  confirmAllSuggestions,
  getDocumentReviewDetail,
  listReviewQueue,
  resolveField,
  reviewCount,
} from "../services/reviews.js";
import {
  getDocumentDetail,
  listDocumentBrowser,
  openDocumentFile,
  openDocumentMarkdown,
} from "../services/document-detail.js";
import { listDuplicateEvents } from "../services/database.js";
import {
  deleteDocumentPermanently,
  excludeDocument,
  requestReprocess,
  resolveDuplicate,
  restoreDocument,
} from "../services/lifecycle.js";
import {
  addPersonAlias,
  confirmNameForPerson,
  deletePersonEntity,
  ensurePerson,
  listPeople,
  markSelf,
  mergePersons,
  removePersonAlias,
  renamePerson,
  setPersonRoles,
  splitPerson,
} from "../services/people.js";
import {
  addRule,
  editRule,
  isTrainingDefault,
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

const VALID_RULE_TYPES: RuleType[] = [
  "vendor_category",
  "person_variant",
  "keyword_doctype",
  "source_scope",
  "accounting_treatment",
  "impact_bucket",
];

function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (VALID_RULE_TYPES as string[]).includes(value);
}

const VALID_DATE_FORMATS = new Set(["DD-MM-YYYY", "DD MMM YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]);
const VALID_GROUPINGS = new Set(["indian", "western"]);

/** Coerce a loosely-typed IPC value into a finance-prefs patch (only known keys). */
function coercePrefsPatch(value: unknown): Partial<FinancePrefs> {
  if (!value || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  const patch: Partial<FinancePrefs> = {};
  if (typeof v.currency === "string" && v.currency.trim())
    patch.currency = v.currency.trim().toUpperCase();
  if (typeof v.locale === "string" && v.locale.trim()) patch.locale = v.locale.trim();
  if (typeof v.dateFormat === "string" && VALID_DATE_FORMATS.has(v.dateFormat))
    patch.dateFormat = v.dateFormat as FinancePrefs["dateFormat"];
  if (typeof v.decimalSeparator === "string" && v.decimalSeparator)
    patch.decimalSeparator = v.decimalSeparator;
  if (typeof v.thousandsSeparator === "string") patch.thousandsSeparator = v.thousandsSeparator;
  if (typeof v.grouping === "string" && VALID_GROUPINGS.has(v.grouping))
    patch.grouping = v.grouping as FinancePrefs["grouping"];
  if (typeof v.fyStartMonth === "number" && Number.isInteger(v.fyStartMonth))
    patch.fyStartMonth = v.fyStartMonth;
  return patch;
}

/** Coerce a loosely-typed IPC value into a list of valid person roles. */
function toPersonRoles(value: unknown): PersonRole[] {
  if (!Array.isArray(value)) return [];
  const out: PersonRole[] = [];
  for (const item of value) {
    if (typeof item === "string" && (PERSON_ROLES as string[]).includes(item))
      out.push(item as PersonRole);
  }
  return out;
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
  ipcMain.broadcast("training:changed", {
    pendingCount: getPendingReviewCount(),
    mode: isTrainingMode(),
  });
}

/** Tell listeners (snapshot header, etc.) how many documents await review. */
function broadcastReview(): void {
  ipcMain.broadcast("review:changed", { count: reviewCount() });
}

const REVIEW_ACTIONS = new Set(["confirm", "correct", "defer"]);

function isReviewField(value: unknown): value is ReviewField {
  return typeof value === "string" && (REVIEW_FIELDS as string[]).includes(value);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function registerHandlers(): void {
  logger.info("handlers", "Registering IPC handlers...");

  // Return the .glaze project path (used for deep links back to the host)
  ipcMain.handle("app:getProjectPath", async () => {
    return path.join(__dirname, "..", "..");
  });

  // Settings window handlers. An optional section id scrolls the settings view
  // to that section on open (e.g. the Review Queue).
  ipcMain.handle("window:openSettings", async (_event, section?: unknown) => {
    await openSettingsWindow(typeof section === "string" ? section : null);
  });

  ipcMain.handle("window:closeSettings", async () => {
    getSettingsWindow()?.close();
  });

  // Consumed once by the settings renderer on mount to scroll to a section.
  ipcMain.handle("settings:takeFocusSection", async () => {
    return takePendingSettingsSection();
  });

  // ── Finance / locale preferences ────────────────────────────────────
  ipcMain.handle("prefs:get", async () => getFinancePrefs());
  ipcMain.handle("prefs:isFirstRun", async () => isFirstRun());

  ipcMain.handle("prefs:set", async (_event, patch: unknown) => {
    const next = setFinancePrefs(coercePrefsPatch(patch));
    ipcMain.broadcast("prefs:changed", next);
    return next;
  });

  // First-run: persist the (reviewed) preferences and dismiss the window.
  ipcMain.handle("onboarding:complete", async (_event, patch: unknown) => {
    const next = setFinancePrefs(coercePrefsPatch(patch));
    ipcMain.broadcast("prefs:changed", next);
    closeOnboardingWindow();
    return next;
  });

  ipcMain.handle("window:openOnboarding", async () => {
    await openOnboardingWindow();
  });

  // ── Impact-mapping preferences ──────────────────────────────────────
  ipcMain.handle("impactPrefs:get", async () => getImpactPrefs());

  ipcMain.handle("impactPrefs:set", async (_event, patch: unknown) => {
    const next = setImpactPrefs((patch ?? {}) as Partial<ImpactPrefs>);
    ipcMain.broadcast("impactPrefs:changed", next);
    return next;
  });

  ipcMain.handle("watchCategories:get", async () => getWatchCategories());

  ipcMain.handle("watchCategories:set", async (_event, categories: unknown) => {
    const next = setWatchCategories(categories);
    ipcMain.broadcast("watchCategories:changed", next);
    return next;
  });

  // ── Manual recurring entries ────────────────────────────────────────
  ipcMain.handle("recurring:list", async () => listRecurringEntries());

  ipcMain.handle("recurring:add", async (_event, input: unknown) => {
    const coerced = coerceRecurringInput(input);
    if (!coerced) return null;
    const entry = insertRecurringEntry(coerced);
    ipcMain.broadcast("recurring:changed", {});
    return entry;
  });

  ipcMain.handle("recurring:update", async (_event, id: unknown, patch: unknown) => {
    const entryId = Number(id);
    const coerced = coerceRecurringInput(patch);
    if (!Number.isFinite(entryId) || !coerced) return { ok: false };
    updateRecurringEntry(entryId, coerced);
    ipcMain.broadcast("recurring:changed", {});
    return { ok: true };
  });

  ipcMain.handle("recurring:delete", async (_event, id: unknown) => {
    const entryId = Number(id);
    if (Number.isFinite(entryId)) {
      deleteRecurringEntry(entryId);
      ipcMain.broadcast("recurring:changed", {});
    }
    return { ok: true };
  });

  // ── Document Browser / evidence card ────────────────────────────────
  ipcMain.handle(
    "window:openDocuments",
    async (_event, focusDocId?: unknown, drilldown?: unknown) => {
      const id = typeof focusDocId === "number" && Number.isFinite(focusDocId) ? focusDocId : null;
      const input = drilldown as Partial<DocumentDrilldown> | null | undefined;
      const validDrilldown =
        input &&
        (input.metric === "income" ||
          input.metric === "spending" ||
          input.metric === "investments") &&
        (input.period === "month" || input.period === "financial_year") &&
        typeof input.label === "string" &&
        typeof input.startDate === "string" &&
        typeof input.endDate === "string" &&
        Array.isArray(input.docIds) &&
        input.docIds.every((id) => typeof id === "number" && Number.isFinite(id))
          ? (input as DocumentDrilldown)
          : null;
      await openDocumentsWindow(id, validDrilldown);
    },
  );

  // Consumed once by the browser on mount to select an initially-focused doc.
  ipcMain.handle("documents:takeInitialFocus", async () => {
    return takeInitialDocumentsContext();
  });

  ipcMain.handle("documents:list", async () => {
    return listDocumentBrowser();
  });

  ipcMain.handle("documents:detail", async (_event, docId: unknown) => {
    const id = Number(docId);
    return Number.isFinite(id) ? await getDocumentDetail(id) : null;
  });

  ipcMain.handle("documents:open", async (_event, docId: unknown) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return "Invalid document.";
    return await openDocumentFile(id);
  });

  ipcMain.handle("documents:openMarkdown", async (_event, docId: unknown) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return "Invalid document.";
    return await openDocumentMarkdown(id);
  });

  // ── Lifecycle actions (exclude / restore / reprocess / delete) ────────
  ipcMain.handle("documents:exclude", async (_event, docId: unknown) => {
    const id = Number(docId);
    return Number.isFinite(id) ? excludeDocument(id) : { ok: false, message: "Invalid document." };
  });

  ipcMain.handle("documents:restore", async (_event, docId: unknown) => {
    const id = Number(docId);
    return Number.isFinite(id) ? restoreDocument(id) : { ok: false, message: "Invalid document." };
  });

  ipcMain.handle("documents:reprocess", async (_event, docId: unknown, when: unknown) => {
    const id = Number(docId);
    const w = when === "later" ? "later" : "now";
    return Number.isFinite(id)
      ? requestReprocess(id, w)
      : { ok: false, message: "Invalid document." };
  });

  ipcMain.handle("documents:deletePermanently", async (_event, docId: unknown) => {
    const id = Number(docId);
    return Number.isFinite(id)
      ? await deleteDocumentPermanently(id)
      : { ok: false, message: "Invalid document." };
  });

  // ── Duplicate events ──────────────────────────────────────────────────
  ipcMain.handle("duplicates:list", async () => {
    return listDuplicateEvents();
  });

  ipcMain.handle("duplicates:resolve", async (_event, eventId: unknown, action: unknown) => {
    const id = Number(eventId);
    const a = action === "delete" ? "delete" : "acknowledge";
    return Number.isFinite(id)
      ? resolveDuplicate(id, a)
      : { ok: false, message: "Invalid duplicate." };
  });

  // ── Vault handlers ──────────────────────────────────────────────────
  // Non-blocking intake: copies the originals into the vault immediately and
  // returns a receipt, then processes them in the background (progress + result
  // broadcasts drive the orb). Additional drops queue instead of blocking.
  ipcMain.handle("vault:enqueue", async (_event, filePaths: unknown) => {
    if (!Array.isArray(filePaths)) return { accepted: 0, duplicate: 0, unsupported: 0, error: 0 };
    const valid = filePaths.filter((p) => typeof p === "string" && p.length > 0) as string[];
    return await enqueueDrop(valid);
  });

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
    const result = await refreshSnapshot();
    // A refresh runs person entity resolution, which may add person reviews.
    broadcastReview();
    return result;
  });

  ipcMain.handle("snapshot:setBusy", async (_event, value: boolean) => {
    setSnapshotBusy(Boolean(value));
  });

  // ── Manual attribution corrections ──────────────────────────────────
  // Rename or merge a person by name: fold `from` onto the canonical person for
  // `to`. Re-aggregated instantly (no AI re-run needed).
  ipcMain.handle("people:remap", async (_event, from: string, to: string) => {
    if (typeof from === "string" && typeof to === "string" && from.trim() && to.trim()) {
      confirmNameForPerson(from.trim(), ensurePerson(to.trim()), "user_confirmed");
    }
  });

  // ── Canonical People management ─────────────────────────────────────
  ipcMain.handle("people:list", async () => {
    return listPeople();
  });

  ipcMain.handle("people:rename", async (_event, id: number, name: unknown) => {
    const pid = Number(id);
    if (Number.isFinite(pid) && typeof name === "string" && name.trim()) renamePerson(pid, name);
  });

  ipcMain.handle("people:setRoles", async (_event, id: number, roles: unknown) => {
    const pid = Number(id);
    if (Number.isFinite(pid)) setPersonRoles(pid, toPersonRoles(roles));
  });

  ipcMain.handle("people:markSelf", async (_event, id: number) => {
    const pid = Number(id);
    if (Number.isFinite(pid)) markSelf(pid);
  });

  ipcMain.handle("people:addAlias", async (_event, id: number, alias: unknown) => {
    const pid = Number(id);
    if (Number.isFinite(pid) && typeof alias === "string" && alias.trim())
      addPersonAlias(pid, alias);
  });

  ipcMain.handle("people:removeAlias", async (_event, aliasId: number) => {
    const aid = Number(aliasId);
    if (Number.isFinite(aid)) removePersonAlias(aid);
  });

  ipcMain.handle("people:merge", async (_event, fromId: number, toId: number) => {
    const from = Number(fromId);
    const to = Number(toId);
    if (Number.isFinite(from) && Number.isFinite(to) && from !== to) mergePersons(from, to);
  });

  ipcMain.handle("people:split", async (_event, id: number, aliasIds: unknown) => {
    const pid = Number(id);
    if (!Number.isFinite(pid) || !Array.isArray(aliasIds)) return null;
    const ids = aliasIds.map((a) => Number(a)).filter((a) => Number.isFinite(a));
    if (ids.length === 0) return null;
    return splitPerson(pid, ids);
  });

  ipcMain.handle("people:delete", async (_event, id: number) => {
    const pid = Number(id);
    if (Number.isFinite(pid)) deletePersonEntity(pid);
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
      void showToast(
        `Learned ${learned} new rule${learned === 1 ? "" : "s"}`,
        "Training Mode is getting smarter.",
        "info",
      );
    } else if (reinforced > 0) {
      void showToast(
        `Reinforced ${reinforced} rule${reinforced === 1 ? "" : "s"}`,
        "Thanks — noted.",
        "info",
      );
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
    return { ...getTrainingStats(), mode: isTrainingMode(), isDefault: isTrainingDefault() };
  });

  ipcMain.handle("training:listRules", async () => {
    return listRules();
  });

  ipcMain.handle(
    "training:addRule",
    async (_event, ruleType: unknown, matchKey: unknown, value: unknown) => {
      if (!isRuleType(ruleType) || typeof matchKey !== "string" || typeof value !== "string")
        return null;
      if (!matchKey.trim() || !value.trim()) return null;
      const rule = await addRule({ ruleType, matchKey, value });
      broadcastTraining();
      return rule;
    },
  );

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

  // ── Review Queue ────────────────────────────────────────────────────
  ipcMain.handle("reviews:queue", async () => {
    return listReviewQueue();
  });

  ipcMain.handle("reviews:detail", async (_event, docId: number) => {
    const id = Number(docId);
    return Number.isFinite(id) ? getDocumentReviewDetail(id) : null;
  });

  ipcMain.handle("reviews:count", async () => {
    return reviewCount();
  });

  ipcMain.handle(
    "reviews:resolve",
    async (_event, docId: number, field: unknown, action: unknown, value: unknown) => {
      const id = Number(docId);
      if (
        !Number.isFinite(id) ||
        !isReviewField(field) ||
        typeof action !== "string" ||
        !REVIEW_ACTIONS.has(action)
      ) {
        return { ok: false, message: "Invalid review action." };
      }
      const result = await resolveField(
        id,
        field,
        action as "confirm" | "correct" | "defer",
        typeof value === "string" ? value : undefined,
      );
      broadcastReview();
      if (result.ruleLearned || result.ruleReinforced) {
        const verb = result.ruleLearned ? "Learned" : "Reinforced";
        const tail = result.ruleAutoApplies ? " It will now auto-apply to future documents." : "";
        void showToast(
          `${verb} a rule from your correction`,
          `Training Mode is getting smarter.${tail}`,
          "info",
        );
      }
      return result;
    },
  );

  ipcMain.handle("reviews:confirmAll", async (_event, docId: number) => {
    const id = Number(docId);
    if (!Number.isFinite(id)) return { confirmed: 0 };
    const result = await confirmAllSuggestions(id);
    broadcastReview();
    return result;
  });

  logger.info("handlers", "✓ IPC handlers registered");
}
