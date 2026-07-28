/**
 * Document lifecycle actions — the deliberate, reversible controls behind the
 * intake triage model. Deleting a document first means removing it from active
 * analysis (its raw file stays on disk); a permanent delete is a separate,
 * explicit step. Irrelevant/excluded documents can be rescued and reprocessed
 * from their existing raw file without a re-drop.
 *
 * Never throws — every action returns a small result the UI can surface.
 */
import * as fs from "node:fs/promises";

import { ipcMain, logger } from "@glaze/core/backend";

import {
  deleteDocumentRow,
  deleteDuplicateEvent,
  findDocumentById,
  setDocumentLifecycle,
  setDuplicateEventStatus,
  type DuplicateEvent,
  type LifecycleState,
} from "./database.js";
import { reviewCount } from "./reviews.js";
import { enqueueReprocess } from "./ingest-queue.js";

export interface LifecycleResult {
  ok: boolean;
  message?: string;
}

/** Broadcast the signals that keep the browser, review queue, and snapshot fresh. */
function broadcastChanges(): void {
  ipcMain.broadcast("documents:changed", {});
  ipcMain.broadcast("review:changed", { count: reviewCount() });
}

async function tryUnlink(p: string | null | undefined): Promise<void> {
  if (!p) return;
  await fs.unlink(p).catch(() => {});
}

/** Remove a document from active analysis (keeps the raw file on disk). */
export function excludeDocument(docId: number): LifecycleResult {
  const doc = findDocumentById(docId);
  if (!doc) return { ok: false, message: "Document not found." };
  setDocumentLifecycle(docId, "excluded", "Excluded from active analysis by you.");
  broadcastChanges();
  return { ok: true };
}

/**
 * Restore a document into active analysis. A document that was never processed
 * as financial (irrelevant, or with no Markdown) is reprocessed from its raw
 * file; an already-processed excluded document is simply reactivated.
 */
export function restoreDocument(docId: number): LifecycleResult {
  const doc = findDocumentById(docId);
  if (!doc) return { ok: false, message: "Document not found." };
  const neverProcessed =
    doc.lifecycleState === "irrelevant" || !doc.markdownPath || !doc.markdownSuccess;
  if (neverProcessed) {
    void enqueueReprocess([docId]);
    return { ok: true, message: "Restoring and processing…" };
  }
  setDocumentLifecycle(docId, "active", null);
  broadcastChanges();
  return { ok: true };
}

/** Reprocess a document from its raw file — now (queued) or later (on request). */
export function requestReprocess(docId: number, when: "now" | "later"): LifecycleResult {
  const doc = findDocumentById(docId);
  if (!doc) return { ok: false, message: "Document not found." };
  if (when === "later") {
    setDocumentLifecycle(
      docId,
      "reprocess_requested",
      "Reprocess requested — will run on next launch.",
    );
    broadcastChanges();
    return { ok: true, message: "Marked for reprocessing." };
  }
  void enqueueReprocess([docId]);
  return { ok: true, message: "Reprocessing…" };
}

/** Permanently delete a document: its raw + Markdown files and its record. */
export async function deleteDocumentPermanently(docId: number): Promise<LifecycleResult> {
  const doc = findDocumentById(docId);
  if (!doc) return { ok: false, message: "Document not found." };
  await tryUnlink(doc.rawPath);
  await tryUnlink(doc.markdownPath);
  deleteDocumentRow(docId);
  logger.info("lifecycle", "Permanently deleted document", { docId });
  broadcastChanges();
  return { ok: true };
}

/** Acknowledge (keep ignored) or delete a logged exact-duplicate event. */
export function resolveDuplicate(
  eventId: number,
  action: "acknowledge" | "delete",
): LifecycleResult {
  if (action === "acknowledge") {
    setDuplicateEventStatus(eventId, "acknowledged");
  } else {
    deleteDuplicateEvent(eventId);
  }
  ipcMain.broadcast("duplicates:changed", {});
  return { ok: true };
}

export type { DuplicateEvent, LifecycleState };
