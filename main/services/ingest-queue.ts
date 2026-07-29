/**
 * Ingestion queue: keeps dropped files moving without ever blocking the orb.
 *
 * A drop is handled in two phases. Intake (hash + dedupe + copy the original
 * into the vault) is fast and runs synchronously so the UI can acknowledge that
 * the file is *received and safe* right away. The slow work (Markdown
 * conversion, AI extraction, recording, review routing) is queued and drained
 * one file at a time in the background. Additional drops that arrive while the
 * queue is busy are appended, never blocked.
 *
 * Progress is broadcast to the renderer so the orb can show a calm, lightweight
 * received → processing → done sequence. Never throws.
 */
import { ipcMain, logger } from "@glaze/core/backend";

import {
  ensureVaultDirs,
  intakeFile,
  processIntake,
  reprocessDocument,
  type IngestResult,
  type IntakeResult,
  type ProcessJob,
} from "./vault.js";
import { notifyIngestOutcome, toastConversionFailures } from "./notify.js";
import { reviewCount } from "./reviews.js";
import { getPendingReviewCount } from "./database.js";
import { isTrainingMode, prepareTraining } from "./training.js";
import { openTrainingWindow } from "../windows/training-window.js";

/** Immediate acknowledgement returned to the renderer after intake. */
export interface DropReceipt {
  accepted: number;
  duplicate: number;
  unsupported: number;
  error: number;
}

/** Live progress of the current processing run (broadcast on `ingest:progress`). */
export interface IngestProgress {
  /** Files still to finish in the current run (queued + the one in flight). */
  remaining: number;
  /** Files finished so far in the current run. */
  done: number;
  /** Total files accepted into the current run. */
  total: number;
  processing: boolean;
}

// ── Queue state ──────────────────────────────────────────────────────────

/** A unit of background work: a freshly-received file, or a reprocess request. */
type QueueTask = { kind: "new"; job: ProcessJob } | { kind: "reprocess"; docId: number };

const queue: QueueTask[] = [];
/** Hashes accepted but not yet recorded — guards dupes within a burst of drops. */
const inFlightHashes = new Set<string>();
let processing = false;
let draining = false;

/** Destructive maintenance may run only when no intake task can recreate data. */
export function isIngestIdle(): boolean {
  return !draining && !processing && queue.length === 0;
}

// Counters + collected results for the current run (reset when the queue drains).
let runTotal = 0;
let runDone = 0;
let runResults: IngestResult[] = [];

function progress(): IngestProgress {
  return {
    remaining: queue.length + (processing ? 1 : 0),
    done: runDone,
    total: runTotal,
    processing,
  };
}

function broadcastProgress(): void {
  ipcMain.broadcast("ingest:progress", progress());
}

/** Map a non-accepted intake outcome into a terminal ingest result. */
function terminalResult(intake: IntakeResult): IngestResult {
  if (intake.status === "duplicate") return { filename: intake.filename, status: "duplicate" };
  if (intake.status === "unsupported") return { filename: intake.filename, status: "unsupported" };
  return { filename: intake.filename, status: "error", error: intake.error };
}

/**
 * Accept a batch of dropped paths. Copies the originals into the vault
 * immediately and returns a receipt, then processes them in the background.
 */
export async function enqueueDrop(paths: string[]): Promise<DropReceipt> {
  await ensureVaultDirs();

  const receipt: DropReceipt = { accepted: 0, duplicate: 0, unsupported: 0, error: 0 };
  const jobs: ProcessJob[] = [];

  for (const p of paths) {
    const intake = await intakeFile(p, inFlightHashes);
    if (intake.status === "accepted" && intake.job) {
      jobs.push(intake.job);
      receipt.accepted += 1;
    } else {
      // Terminal outcomes (duplicate/unsupported/error) fold into the run so the
      // finishing notification reports them alongside processed files.
      runResults.push(terminalResult(intake));
      receipt[intake.status] += 1;
    }
  }

  if (jobs.length > 0) {
    queue.push(...jobs.map((job) => ({ kind: "new" as const, job })));
    runTotal += jobs.length;
    broadcastProgress();
    void drain();
  } else if (!draining) {
    // Nothing to process (e.g. all duplicates) and no run in flight — report now.
    await finalizeRun();
  }

  return receipt;
}

/**
 * Intake files created by a trusted internal source such as Gmail. This is the
 * same hash/copy/process queue as drag-and-drop, so cross-source duplicates are
 * suppressed by the existing document hash invariant.
 */
export async function enqueueInternalFiles(paths: string[]): Promise<DropReceipt> {
  return enqueueDrop(paths);
}

/**
 * Reprocess an existing document (rescue an irrelevant/excluded file) using its
 * raw file on disk — no re-drop. Queues alongside new drops, never blocking.
 */
export async function enqueueReprocess(docIds: number[]): Promise<void> {
  const ids = docIds.filter((id) => Number.isFinite(id));
  if (ids.length === 0) return;
  queue.push(...ids.map((docId) => ({ kind: "reprocess" as const, docId })));
  runTotal += ids.length;
  broadcastProgress();
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const task = queue.shift()!;
    processing = true;
    broadcastProgress();
    let result: IngestResult;
    if (task.kind === "new") {
      result = await processIntake(task.job);
      inFlightHashes.delete(task.job.hash);
    } else {
      result = await reprocessDocument(task.docId);
    }
    runResults.push(result);
    runDone += 1;
    processing = false;
    broadcastProgress();
  }
  draining = false;
  await finalizeRun();
}

async function finalizeRun(): Promise<void> {
  const results = runResults;
  runResults = [];
  runTotal = 0;
  runDone = 0;
  broadcastProgress();

  if (results.length === 0) return;

  ipcMain.broadcast("ingest:done", { results });
  notifyIngestOutcome(results);
  toastConversionFailures(results);

  // Processing may have created review items and (in Learning Mode) questions.
  ipcMain.broadcast("review:changed", { count: reviewCount() });
  // Nudge any open Document Browser to refresh its list (new/triaged/reprocessed).
  ipcMain.broadcast("documents:changed", {});
  const newDocIds = results
    .filter((r) => r.status === "ingested" && typeof r.docId === "number")
    .map((r) => r.docId as number);
  await prepareTrainingBatch(newDocIds);
}

/**
 * Generate Learning Mode questions for freshly-ingested documents (no-op when
 * the mode is off), open the popup if anything needs asking, and notify the orb.
 */
async function prepareTrainingBatch(docIds: number[]): Promise<void> {
  try {
    if (isTrainingMode() && docIds.length > 0) {
      for (const id of docIds) await prepareTraining(id);
      if (getPendingReviewCount() > 0) await openTrainingWindow();
    }
  } catch (error) {
    logger.warn("ingest-queue", "Training preparation failed", { error: String(error) });
  }
  ipcMain.broadcast("training:changed", {
    pendingCount: getPendingReviewCount(),
    mode: isTrainingMode(),
  });
}
