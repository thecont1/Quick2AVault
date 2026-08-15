/**
 * Pipeline — P0 intake (sync, no AI) and P1 conversion (queued, no AI).
 * Plan §2. P2 analysis (Claude) plugs into the same `jobs` table.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import type { AiProvider } from "./ai-provider.js";
import { EXTRACTION_VERSION } from "./extraction-contract.js";
import { recordTransaction, resolveEntity } from "./ledger.js";
import { resolvePerson } from "./identity.js";
import { findMatches, linkEvidence, AUTO_LINK, REVIEW_FLOOR } from "./matcher.js";
import { ask } from "./learning.js";
import { flattenExtraction, hashText, indexDocument } from "./search.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { embedDocument } from "./embeddings.js";
import { parseStatementMarkdown, stageStatementLines, reconcileStatement } from "./statements.js";
import { loadPack } from "./jurisdiction.js";
import { triage, dispositionToIntakeKind, type TriageResult } from "./triage.js";
import {
  extractTypedDocument,
  generateLearningQuestions,
  impactFor,
  transitionPipeline,
  type LearningAmbiguity,
  type PipelineState,
  type TypedExtraction,
} from "./workorders.js";
import { setDocumentParty, writeClaim, type DocumentPartyRole } from "./claims.js";

/**
 * Intake disposition — work order 06 §3. `added` is kept as an alias for
 * `accepted` for backward compatibility with existing callers and tests; new
 * code reads `disposition`. `duplicate` is produced by the hash-lookup step,
 * not by triage.
 */
export type IntakeDisposition = "accepted" | "irrelevant" | "duplicate" | "failed";

export interface IntakeResult {
  /** Legacy status field — "added" means accepted. Kept for existing callers. */
  status: "added" | "duplicate" | "failed" | "irrelevant";
  /** Work order 06 disposition. Always present. */
  disposition: IntakeDisposition;
  intake_id?: number;
  document_id?: string;
  sha256?: string;
  existing_document_id?: string;
  archived_to?: string;
  canonical_path?: string;
  reason_code?: string;
  reason?: string;
  confidence?: "high" | "medium" | "low";
  triage_review?: boolean;
  error?: string;
}

export interface IngestOptions {
  source?: string;
  externalId?: string;
  /**
   * Remove the source file once a VERIFIED copy exists in the vault.
   *
   * Only ever true for files that arrived in the watched Drop folder. A file
   * pushed through POST /v1/intake lives somewhere the user owns (Downloads,
   * Desktop, another app's folder) and must never be deleted.
   */
  consumeSource?: boolean;
  /**
   * Work order 06 §4: write-stability check. When true (folder/drag sources),
   * the daemon re-stats the file after a short delay and refuses to ingest if
   * the size is still changing — a partial download must never be archived.
   * API-pushed files are owned by the caller and assumed stable.
   */
  checkStable?: boolean;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** Strip characters that break Finder or shell round-trips, keep it readable. */
function safeName(name: string): string {
  return name.replace(/[/\\:\x00-\x1f]/g, "-").replace(/^\.+/, "").trim() || "document";
}

/**
 * A free path in `dir` for `filename`, appending " (2)", " (3)" on collision.
 * Two different invoices can legitimately share a name ("invoice.pdf"), and
 * silently overwriting one would destroy a user's document.
 */
async function uniquePath(dir: string, filename: string): Promise<string> {
  const base = safeName(filename);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  for (let n = 2; ; n++) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem} (${n})${ext}`);
    } catch {
      return candidate;
    }
  }
}

/** Move a file, falling back to copy+unlink across filesystems (EXDEV). */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

// ── Work order 06 §4 — write-stability + MIME detection ──────────────────────

/**
 * Refuse to ingest a file whose size is still changing. A partial download
 * archived mid-write produces a truncated document that fails conversion and
 * can never be recovered — the original is gone. Re-stat after a short window
 * and require the size to be stable.
 *
 * Returns the stable size, or throws if the file is still being written.
 */
async function stableSize(filePath: string, delayMs = 150): Promise<number> {
  const a = await fs.stat(filePath);
  await new Promise((r) => setTimeout(r, delayMs));
  const b = await fs.stat(filePath);
  if (a.size !== b.size) {
    throw new Error(`file not stable (size ${a.size} → ${b.size}); partial write suspected`);
  }
  return b.size;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".eml": "message/rfc822",
  ".msg": "application/vnd.ms-outlook",
  ".rtf": "application/rtf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

/** Best-effort MIME type from extension, then magic bytes. */
function detectMime(filename: string, bytes: Buffer): string {
  const ext = path.extname(filename).toLowerCase();
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "application/zip";
  }
  return "application/octet-stream";
}

/**
 * Best-effort text extraction for triage. Triage must not require a full P1
 * conversion (§6.3) — it only needs enough text to look for financial signals.
 * For plaintext formats we read directly; for images/PDFs we return "" and let
 * triage decide (accepted pending OCR, or irrelevant only on strong signals).
 */
async function cheapText(filePath: string, ext: string): Promise<string> {
  const e = ext.toLowerCase();
  if ([".txt", ".md", ".html", ".htm", ".json", ".csv", ".tsv", ".log", ".text"].includes(e)) {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }
  // .eml: pull the body cheaply via the same emlToMarkdown the converter uses.
  if (e === ".eml") {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      // Reuse the adapter's eml parser without importing the whole converter.
      const headerEnd = raw.search(/\r?\n\r?\n/);
      return headerEnd > 0 ? raw.slice(headerEnd).trim() : raw.trim();
    } catch {
      return "";
    }
  }
  return "";
}

function transitionIntakePipeline(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  toState: PipelineState,
  source: string,
  reason?: string,
): void {
  const result = transitionPipeline(db, {
    documentId,
    toState,
    timestamp: ports.clock.isoNow(),
    source,
    reason,
  });
  if (!result.changed || !result.event) return;
  ports.bus.publish({
    type: "PipelineStateChanged",
    document_id: documentId,
    from_state: result.event.fromState,
    to_state: result.event.toState,
    source,
    reason: result.event.reason ?? null,
    at: result.event.timestamp,
  });
}

function pipelineSource(db: DatabaseSync, documentId: string): string {
  return (
    db.prepare("SELECT source FROM intake_events WHERE document_id=? ORDER BY id DESC LIMIT 1").get(documentId) as
      | { source: string }
      | undefined
  )?.source ?? "pipeline";
}

async function removeCompletedSource(db: DatabaseSync, ports: Ports, documentId: string): Promise<void> {
  const row = db
    .prepare(
      "SELECT received_path, consume_source FROM intake_events WHERE document_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(documentId) as { received_path: string | null; consume_source: number } | undefined;
  if (!row?.consume_source || !row.received_path) return;
  try {
    await fs.unlink(row.received_path);
    ports.logger.info("removed watched source after complete", {
      document_id: documentId,
      source_path: row.received_path,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ports.logger.warn("pipeline completed but watched source could not be removed", {
        document_id: documentId,
        source_path: row.received_path,
        err: (error as Error).message,
      });
    }
  }
}

/**
 * P0 — synchronous intake with deterministic triage (work order 06 §4).
 *
 * Pipeline boundary, in order:
 *   source → write-stability → SHA-256 + metadata → exact duplicate lookup
 *   → deterministic relevance triage → safe archive → disposition event
 *   → accepted queue only → (P1 convert runs later via the job queue)
 *
 * Hard rules (§4): duplicate detection precedes AnyDoc and AI; triage needs no
 * AI or network; irrelevant items never reach AnyDoc/Claude/ledger/People/
 * embeddings; a triage failure never deletes the original; every disposition
 * is reversible and emits an audit event.
 */
export async function ingestFile(
  db: DatabaseSync,
  ports: Ports,
  filePath: string,
  opts: IngestOptions = {},
): Promise<IntakeResult> {
  const source = opts.source ?? "folder";
  const filename = path.basename(filePath);
  const now = ports.clock.isoNow();
  const pipelineDocumentId = newId("doc");

  // ── record the receipt FIRST so a crash mid-intake leaves an audit trail ──
  const intakeId = recordIntakeReceived(db, ports, {
    documentId: pipelineDocumentId,
    source,
    sourceReference: opts.externalId,
    filename,
    receivedPath: filePath,
    consumeSource: opts.consumeSource === true,
  });
  ports.bus.publish({
    type: "IntakeReceived",
    intake_id: intakeId,
    source,
    filename,
    received_path: filePath,
    at: now,
  });

  try {
    // ── 1. write-stability check (§4) ──────────────────────────────────────
    if (opts.checkStable) {
      await stableSize(filePath);
    }
    setIntakeState(db, ports, intakeId, "stable");
    transitionIntakePipeline(db, ports, pipelineDocumentId, "stable", source);

    // ── 2. SHA-256 + metadata ──────────────────────────────────────────────
    const buf = await fs.readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const ext = path.extname(filename).toLowerCase();
    const mimeType = detectMime(filename, buf);
    updateIntakeHashed(db, ports, intakeId, { sha256, mimeType, byteSize: buf.length, ext });
    setIntakeState(db, ports, intakeId, "hashed");
    transitionIntakePipeline(db, ports, pipelineDocumentId, "hashed", source);

    // ── 3. exact duplicate lookup (§4, §7) ─────────────────────────────────
    // Source-level idempotency (Gmail message id, invoice number) is checked
    // first because it is cheaper and covers the case where the bytes differ
    // but the source considers them the same artifact.
    if (opts.externalId) {
      const seen = db
        .prepare("SELECT document_id FROM source_events WHERE source=? AND external_id=?")
        .get(source, opts.externalId) as { document_id?: string } | undefined;
      if (seen) {
        transitionIntakePipeline(db, ports, pipelineDocumentId, "duplicate", source, "external_id seen");
        return await finalizeDuplicate(db, ports, intakeId, filename, sha256, seen.document_id!, source, opts, filePath, "external_id seen");
      }
    }
    // Content-level dedupe — the same bytes never become two documents.
    const existing = db.prepare("SELECT id FROM documents WHERE sha256=?").get(sha256) as
      | { id: string }
      | undefined;
    if (existing) {
      transitionIntakePipeline(db, ports, pipelineDocumentId, "duplicate", source, "sha256 match");
      return await finalizeDuplicate(db, ports, intakeId, filename, sha256, existing.id, source, opts, filePath, "sha256 match");
    }

    // ── 4. deterministic relevance triage (§6) ─────────────────────────────
    const text = await cheapText(filePath, ext);
    const result = triage({ filename, mimeType, byteSize: buf.length, bytes: buf, text, source });
    setIntakeState(db, ports, intakeId, "triaged");
    transitionIntakePipeline(db, ports, pipelineDocumentId, "triaged", source);
    ports.bus.publish({
      type: "IntakeTriaged",
      intake_id: intakeId,
      source,
      filename,
      disposition: result.disposition,
      reason_code: result.reasonCode,
      reason: result.reason,
      confidence: result.confidence,
      triage_review: !!result.triage_review,
      at: ports.clock.isoNow(),
    });

    // ── 5a. IRRELEVANT → preserve under Irrelevant/<date>/, never analyse ──
    if (result.disposition === "irrelevant") {
      transitionIntakePipeline(db, ports, pipelineDocumentId, "irrelevant", source, result.reason);
      return await finalizeIrrelevant(db, ports, intakeId, filename, sha256, buf, result, source, opts, filePath, ext, mimeType);
    }

    // ── 5b. FAILED → retain source, record reason, never delete ────────────
    if (result.disposition === "failed") {
      transitionIntakePipeline(db, ports, pipelineDocumentId, "failed", source, result.reason);
      return await finalizeFailed(db, ports, intakeId, filename, source, result.reason);
    }

    // ── 5c. ACCEPTED → archive under Raw/<date>/, record document, enqueue ──
    return await finalizeAccepted(db, ports, pipelineDocumentId, intakeId, filename, sha256, buf, result, source, opts, filePath, ext, mimeType, now);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ports.logger.error("P0 intake failed", { filename, err: msg });
    try {
      transitionIntakePipeline(db, ports, pipelineDocumentId, "failed", source, msg);
    } catch {
      // Preserve the original intake error when a terminal state was already recorded.
    }
    // A triage/intake failure never deletes or loses the original (§4). The
    // file stays where it is — visible, retryable, never silently swallowed.
    return await finalizeFailed(db, ports, intakeId, filename, source, msg);
  }
}

// ── intake_events helpers (work order 06 §5) ─────────────────────────────────

function recordIntakeReceived(
  db: DatabaseSync,
  ports: Ports,
  info: {
    documentId: string;
    source: string;
    sourceReference?: string;
    filename: string;
    receivedPath: string;
    consumeSource: boolean;
  },
): number {
  const now = ports.clock.isoNow();
  const r = db.prepare(
    `INSERT INTO intake_events
       (kind, filename, source, source_reference, received_path, consume_source, processing_state, created_at, updated_at)
     VALUES ('failed', ?, ?, ?, ?, ?, 'received', ?, ?)`,
  ).run(
    info.filename,
    info.source,
    info.sourceReference ?? null,
    info.receivedPath,
    info.consumeSource ? 1 : 0,
    now,
    now,
  );
  transitionIntakePipeline(db, ports, info.documentId, "received", info.source);
  // 'failed' is the safe default until triage upgrades it; a crash between
  // here and the finalizer leaves an honest "this did not complete" row rather
  // than a misleading 'accepted'.
  return Number(r.lastInsertRowid);
}

function setIntakeState(db: DatabaseSync, ports: Ports, id: number, state: string) {
  // Work order 07 §B3: track when the current stage was entered and update
  // the heartbeat. A stalled process (heartbeat_at stale) must not be
  // mistaken for successful analysis.
  const now = ports.clock.isoNow();
  const isTerminal = state === "complete" || state === "failed";
  db.prepare(
    `UPDATE intake_events
        SET processing_state=?, updated_at=?, stage_started_at=?,
            heartbeat_at=?,
            finished_at=CASE WHEN ?=1 THEN ? ELSE finished_at END
      WHERE id=?`,
  ).run(state, now, now, now, isTerminal ? 1 : 0, isTerminal ? now : null, id);
}

/**
 * Work order 07 §B3: update the heartbeat without changing state. Called by
 * long-running stages (conversion, analysis) to prove the worker is alive.
 */
function heartbeatIntake(db: DatabaseSync, ports: Ports, id: number) {
  db.prepare("UPDATE intake_events SET heartbeat_at=?, updated_at=? WHERE id=?")
    .run(ports.clock.isoNow(), ports.clock.isoNow(), id);
}

/**
 * Work order 07 §B3: mark an intake as failed with an error message.
 */
function setIntakeFailed(db: DatabaseSync, ports: Ports, id: number, error: string) {
  const now = ports.clock.isoNow();
  db.prepare(
    `UPDATE intake_events
        SET processing_state='failed', last_error=?, finished_at=?, updated_at=?, heartbeat_at=?
      WHERE id=?`,
  ).run(error, now, now, now, id);
}

/**
 * Work order 07 §B1: update the aggregated intake state for a document's
 * intake_event. Maps the job phase to a user-facing stage label. The
 * `stageLabel` is stored in `detail` so the UI can show "converting",
 * "analysing", etc. without inferring from individual JobStateChanged events.
 */
function updateIntakeForJob(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  state: "processing" | "complete" | "failed",
  stageLabel: string | null,
) {
  const now = ports.clock.isoNow();
  const isTerminal = state === "complete" || state === "failed";
  db.prepare(
    `UPDATE intake_events
        SET processing_state=?,
            detail=COALESCE(?, detail),
            stage_started_at=?,
            heartbeat_at=?,
            updated_at=?,
            finished_at=CASE WHEN ?=1 THEN ? ELSE finished_at END
      WHERE document_id=? AND kind IN ('accepted','added')`,
  ).run(state, stageLabel, now, now, now, isTerminal ? 1 : 0, isTerminal ? now : null, documentId);
}

/**
 * Work order 07 §B3: mark an intake as failed by document_id (used when a
 * job permanently fails).
 */
function setIntakeFailedByDoc(db: DatabaseSync, ports: Ports, documentId: string, error: string) {
  const now = ports.clock.isoNow();
  db.prepare(
    `UPDATE intake_events
        SET processing_state='failed', last_error=?, finished_at=?, updated_at=?, heartbeat_at=?
      WHERE document_id=? AND kind IN ('accepted','added')`,
  ).run(error, now, now, now, documentId);
}

function updateIntakeHashed(
  db: DatabaseSync,
  ports: Ports,
  id: number,
  info: { sha256: string; mimeType: string; byteSize: number; ext: string },
) {
  db.prepare(
    `UPDATE intake_events
        SET sha256=?, mime_type=?, byte_size=?, updated_at=?
      WHERE id=?`,
  ).run(info.sha256, info.mimeType, info.byteSize, ports.clock.isoNow(), id);
}

function updateIntakeTriaged(
  db: DatabaseSync,
  ports: Ports,
  id: number,
  result: TriageResult,
) {
  db.prepare(
    `UPDATE intake_events
        SET reason_code=?, reason=?, confidence=?, signals_json=?, triage_review=?, updated_at=?
      WHERE id=?`,
  ).run(
    result.reasonCode,
    result.reason,
    result.confidence,
    JSON.stringify(result.signals),
    result.triage_review ? 1 : 0,
    ports.clock.isoNow(),
    id,
  );
}

function finalizeIntakeRow(
  db: DatabaseSync,
  ports: Ports,
  id: number,
  fields: {
    kind: "accepted" | "irrelevant" | "duplicate" | "failed";
    sha256?: string | null;
    documentId?: string | null;
    matchedDocumentId?: string | null;
    canonicalPath?: string | null;
    detail?: string | null;
    state?: string;
  },
) {
  const now = ports.clock.isoNow();
  const state = fields.state ?? "archived";
  const isTerminal = state === "complete" || state === "failed";
  db.prepare(
    `UPDATE intake_events
        SET kind=?, sha256=?, document_id=?, matched_document_id=?, canonical_path=?,
            detail=?, processing_state=?, updated_at=?, stage_started_at=?,
            heartbeat_at=?,
            finished_at=CASE WHEN ?=1 THEN ? ELSE finished_at END
      WHERE id=?`,
  ).run(
    fields.kind,
    fields.sha256 ?? null,
    fields.documentId ?? null,
    fields.matchedDocumentId ?? null,
    fields.canonicalPath ?? null,
    fields.detail ?? null,
    state,
    now,
    now,
    now,
    isTerminal ? 1 : 0,
    isTerminal ? now : null,
    id,
  );
}

// ── disposition finalizers ───────────────────────────────────────────────────

/** Accepted: archive under Raw/<date>/, write the documents row, enqueue P1. */
async function finalizeAccepted(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  intakeId: number,
  filename: string,
  sha256: string,
  buf: Buffer,
  result: TriageResult,
  source: string,
  opts: IngestOptions,
  filePath: string,
  ext: string,
  mimeType: string,
  now: string,
): Promise<IntakeResult> {
  const id = documentId;
  const rawDir = ports.paths.rawDir(dateKey(ports.clock.now()));
  // Keep the ORIGINAL filename. Raw/ is browsable in Finder; "doc_9f2f5429.pdf"
  // tells a human nothing, "Proton Mail invoice 21145650.pdf" tells them everything.
  const rawPath = await uniquePath(rawDir, filename);
  await fs.writeFile(rawPath, buf);

  // Verify the copy before touching the source. A truncated write followed by
  // an unlink would destroy the user's only copy of a document.
  const written = await fs.readFile(rawPath);
  const writtenHash = crypto.createHash("sha256").update(written).digest("hex");
  if (writtenHash !== sha256) {
    throw new Error(`archive verification failed for ${filename} (hash mismatch)`);
  }

  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, byte_size, raw_path, source, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, sha256, filename, ext, buf.length, rawPath, source, now);

  if (opts.externalId) {
    db.prepare("INSERT OR REPLACE INTO source_events(source,external_id,document_id,created_at) VALUES(?,?,?,?)")
      .run(source, opts.externalId, id, now);
  }

  updateIntakeTriaged(db, ports, intakeId, result);
  finalizeIntakeRow(db, ports, intakeId, {
    kind: "accepted",
    sha256,
    documentId: id,
    canonicalPath: rawPath,
    detail: result.reason,
    state: "queued",
  });

  ports.bus.publish({ type: "DocumentReceived", document_id: id, filename, sha256, at: now });
  ports.bus.publish({
    type: "IntakeAccepted",
    intake_id: intakeId,
    source,
    filename,
    sha256,
    document_id: id,
    canonical_path: rawPath,
    triage_review: !!result.triage_review,
    at: now,
  });
  enqueue(db, ports, id, "convert");

  return {
    status: "added",
    disposition: "accepted",
    intake_id: intakeId,
    document_id: id,
    sha256,
    archived_to: rawPath,
    canonical_path: rawPath,
    reason_code: result.reasonCode,
    reason: result.reason,
    confidence: result.confidence,
    triage_review: !!result.triage_review,
  };
}

/** Irrelevant: preserve under Irrelevant/<date>/, never analyse. */
async function finalizeIrrelevant(
  db: DatabaseSync,
  ports: Ports,
  intakeId: number,
  filename: string,
  sha256: string,
  buf: Buffer,
  result: TriageResult,
  source: string,
  opts: IngestOptions,
  filePath: string,
  ext: string,
  mimeType: string,
): Promise<IntakeResult> {
  const irrDir = ports.paths.irrelevantDir(dateKey(ports.clock.now()));
  const dest = await uniquePath(irrDir, filename);
  await fs.writeFile(dest, buf);
  // Verify the preserved copy — irrelevant files are still evidence and must
  // be restorable byte-for-byte.
  const written = await fs.readFile(dest);
  const writtenHash = crypto.createHash("sha256").update(written).digest("hex");
  if (writtenHash !== sha256) {
    throw new Error(`irrelevant archive verification failed for ${filename} (hash mismatch)`);
  }

  if (opts.consumeSource) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      ports.logger.warn("irrelevant archived but could not clear source", {
        filename,
        err: (err as Error)?.message,
      });
    }
  }

  updateIntakeTriaged(db, ports, intakeId, result);
  finalizeIntakeRow(db, ports, intakeId, {
    kind: "irrelevant",
    sha256,
    canonicalPath: dest,
    detail: result.reason,
    state: "archived",
  });

  ports.bus.publish({
    type: "IntakeIrrelevant",
    intake_id: intakeId,
    source,
    filename,
    sha256,
    reason_code: result.reasonCode,
    reason: result.reason,
    canonical_path: dest,
    at: ports.clock.isoNow(),
  });
  ports.logger.info("irrelevant — preserved, excluded from analysis", {
    filename,
    reason: result.reasonCode,
    dest,
  });

  return {
    status: "irrelevant",
    disposition: "irrelevant",
    intake_id: intakeId,
    sha256,
    archived_to: dest,
    canonical_path: dest,
    reason_code: result.reasonCode,
    reason: result.reason,
    confidence: result.confidence,
  };
}

/** Duplicate: log matched document, preserve bytes under Duplicates/<date>/. */
async function finalizeDuplicate(
  db: DatabaseSync,
  ports: Ports,
  intakeId: number,
  filename: string,
  sha256: string,
  matchedDocumentId: string,
  source: string,
  opts: IngestOptions,
  filePath: string,
  detail: string,
): Promise<IntakeResult> {
  let archivedTo: string | null = null;
  if (opts.consumeSource) {
    const dupDir = ports.paths.duplicatesDir(dateKey(ports.clock.now()));
    const dest = await uniquePath(dupDir, filename);
    await moveFile(filePath, dest);
    archivedTo = dest;
    ports.logger.info("duplicate set aside", { filename, dest });
  }

  finalizeIntakeRow(db, ports, intakeId, {
    kind: "duplicate",
    sha256,
    matchedDocumentId,
    canonicalPath: archivedTo,
    detail,
    state: "archived",
  });

  ports.bus.publish({
    type: "DocumentDuplicate",
    sha256,
    filename,
    existing_document_id: matchedDocumentId,
    at: ports.clock.isoNow(),
  });
  ports.bus.publish({
    type: "IntakeDuplicate",
    intake_id: intakeId,
    source,
    filename,
    sha256,
    matched_document_id: matchedDocumentId,
    canonical_path: archivedTo,
    at: ports.clock.isoNow(),
  });

  return {
    status: "duplicate",
    disposition: "duplicate",
    intake_id: intakeId,
    sha256,
    existing_document_id: matchedDocumentId,
    archived_to: archivedTo ?? undefined,
    canonical_path: archivedTo ?? undefined,
    reason_code: detail,
  };
}

/** Failed: retain source, record reason, never delete. */
async function finalizeFailed(
  db: DatabaseSync,
  ports: Ports,
  intakeId: number,
  filename: string,
  source: string,
  reason: string,
): Promise<IntakeResult> {
  finalizeIntakeRow(db, ports, intakeId, {
    kind: "failed",
    detail: reason,
    state: "failed",
  });
  ports.bus.publish({
    type: "IntakeFailed",
    intake_id: intakeId,
    source,
    filename,
    reason,
    at: ports.clock.isoNow(),
  });
  return {
    status: "failed",
    disposition: "failed",
    intake_id: intakeId,
    error: reason,
    reason: reason,
  };
}

/**
 * Restore an irrelevant intake: re-run triage on the preserved bytes and, if
 * accepted, archive under Raw/, create the document, and enqueue processing.
 * Work order 06 §7/§9: irrelevant files are reversible; restore re-triages and
 * audits the outcome. The original irrelevant copy is preserved (not deleted)
 * so the audit trail is intact even after a successful restore.
 */
export async function restoreIntake(
  db: DatabaseSync,
  ports: Ports,
  intakeId: number,
): Promise<IntakeResult> {
  const row = db
    .prepare(
      `SELECT id, kind, filename, sha256, canonical_path, source, source_reference,
              mime_type, byte_size, reason_code, processing_state
         FROM intake_events WHERE id=?`,
    )
    .get(intakeId) as
    | {
        id: number;
        kind: string;
        filename: string;
        sha256: string | null;
        canonical_path: string | null;
        source: string;
        source_reference: string | null;
        mime_type: string | null;
        byte_size: number | null;
        reason_code: string | null;
        processing_state: string;
      }
    | undefined;
  if (!row) throw new Error(`intake ${intakeId} not found`);
  if (row.kind !== "irrelevant") {
    throw new Error(`intake ${intakeId} is ${row.kind}, not irrelevant — only irrelevant items can be restored`);
  }
  if (!row.canonical_path) throw new Error(`intake ${intakeId} has no preserved canonical_path`);

  // Re-read the preserved bytes and re-triage. The original irrelevant copy
  // stays in place; restore writes a NEW accepted copy under Raw/.
  const buf = await fs.readFile(row.canonical_path);
  const sha256 = row.sha256 ?? crypto.createHash("sha256").update(buf).digest("hex");
  const ext = path.extname(row.filename).toLowerCase();
  const mimeType = row.mime_type ?? detectMime(row.filename, buf);
  const text = await cheapText(row.canonical_path, ext);
  const result = triage({
    filename: row.filename,
    mimeType,
    byteSize: buf.length,
    bytes: buf,
    text,
    source: row.source,
  });

  // If re-triage says irrelevant again, record the attempt but do not promote.
  if (result.disposition === "irrelevant") {
    updateIntakeTriaged(db, ports, intakeId, result);
    db.prepare("UPDATE intake_events SET detail=?, updated_at=? WHERE id=?")
      .run(`restore re-triaged irrelevant: ${result.reason}`, ports.clock.isoNow(), intakeId);
    ports.bus.publish({
      type: "IntakeRestored",
      intake_id: intakeId,
      source: row.source,
      filename: row.filename,
      new_disposition: "irrelevant",
      document_id: null,
      at: ports.clock.isoNow(),
    });
    return {
      status: "irrelevant",
      disposition: "irrelevant",
      intake_id: intakeId,
      reason_code: result.reasonCode,
      reason: `Restore re-triage still irrelevant: ${result.reason}`,
      confidence: result.confidence,
    };
  }

  // Accepted on restore: archive, create document, enqueue. Same path as a
  // fresh accepted intake, but the source file is the preserved irrelevant
  // copy (which we do NOT consume — it stays as audit evidence).
  const now = ports.clock.isoNow();
  const id = newId("doc");
  const rawDir = ports.paths.rawDir(dateKey(ports.clock.now()));
  const rawPath = await uniquePath(rawDir, row.filename);
  await fs.writeFile(rawPath, buf);
  const written = await fs.readFile(rawPath);
  if (crypto.createHash("sha256").update(written).digest("hex") !== sha256) {
    throw new Error(`restore archive verification failed for ${row.filename}`);
  }

  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, byte_size, raw_path, source, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, sha256, row.filename, ext, buf.length, rawPath, row.source, now);

  if (row.source_reference) {
    db.prepare("INSERT OR REPLACE INTO source_events(source,external_id,document_id,created_at) VALUES(?,?,?,?)")
      .run(row.source, row.source_reference, id, now);
  }

  updateIntakeTriaged(db, ports, intakeId, result);
  finalizeIntakeRow(db, ports, intakeId, {
    kind: "accepted",
    sha256,
    documentId: id,
    canonicalPath: rawPath,
    detail: `restored from irrelevant (${row.reason_code}); ${result.reason}`,
    state: "queued",
  });

  ports.bus.publish({ type: "DocumentReceived", document_id: id, filename: row.filename, sha256, at: now });
  ports.bus.publish({
    type: "IntakeAccepted",
    intake_id: intakeId,
    source: row.source,
    filename: row.filename,
    sha256,
    document_id: id,
    canonical_path: rawPath,
    triage_review: !!result.triage_review,
    at: now,
  });
  ports.bus.publish({
    type: "IntakeRestored",
    intake_id: intakeId,
    source: row.source,
    filename: row.filename,
    new_disposition: "accepted",
    document_id: id,
    at: now,
  });
  enqueue(db, ports, id, "convert");

  return {
    status: "added",
    disposition: "accepted",
    intake_id: intakeId,
    document_id: id,
    sha256,
    archived_to: rawPath,
    canonical_path: rawPath,
    reason_code: result.reasonCode,
    reason: `Restored from irrelevant: ${result.reason}`,
    confidence: result.confidence,
    triage_review: !!result.triage_review,
  };
}

/**
 * Reclassify an intake: force a re-triage of the preserved bytes regardless of
 * current disposition. Used when the user disagrees with the original triage.
 * For an irrelevant item this is equivalent to restore; for an accepted item it
 * re-runs triage but does NOT undo the document (call the delete workflow for
 * that). Primarily a re-triage audit on the irrelevant copy.
 */
export async function reclassifyIntake(
  db: DatabaseSync,
  ports: Ports,
  intakeId: number,
): Promise<IntakeResult> {
  // Reclassify on an irrelevant item is a restore; on anything else it is a
  // no-op re-triage that records the attempt. This keeps the destructive
  // surface small: reclassify never deletes a document.
  const row = db.prepare("SELECT kind FROM intake_events WHERE id=?").get(intakeId) as
    | { kind: string }
    | undefined;
  if (!row) throw new Error(`intake ${intakeId} not found`);
  if (row.kind === "irrelevant") return restoreIntake(db, ports, intakeId);
  throw new Error(`intake ${intakeId} is ${row.kind} — reclassify only applies to irrelevant items`);
}

/**
 * How many times a job may run before it is parked as `failed`.
 * Named because the retry threshold was previously an inline `>= 2` compared
 * against a STALE pre-increment counter, which quietly allowed one extra try.
 */
const MAX_JOB_ATTEMPTS = 3;

export function enqueue(db: DatabaseSync, ports: Ports, documentId: string, phase: "convert" | "analyse" | "reconcile") {
  const info = db
    .prepare("INSERT INTO jobs (document_id, phase, state, created_at) VALUES (?,?,'pending',?)")
    .run(documentId, phase, ports.clock.isoNow());
  ports.bus.publish({
    type: "JobStateChanged",
    job_id: Number(info.lastInsertRowid),
    phase,
    state: "pending",
    at: ports.clock.isoNow(),
  });
}

/**
 * P1 — conversion. anydoc/plaintext/Vision-OCR -> canonical markdown v1.
 * AI never rewrites this text; it is the reading surface for every later claim.
 */
export async function runConvertJob(db: DatabaseSync, ports: Ports, jobId: number, documentId: string): Promise<void> {
  const doc = db
    .prepare("SELECT id, raw_path, ext, original_filename, password FROM documents WHERE id=?")
    .get(documentId) as
    | { id: string; raw_path: string; ext: string; original_filename: string; password: string | null }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  try {
    const conv = await ports.converter.toMarkdown(doc.raw_path, doc.ext ?? "", doc.password ?? undefined);
    if (conv === null) throw new Error(`conversion returned null for ${doc.ext}`);
    const md = conv.markdown;

  const mdDir = ports.paths.markdownDir(dateKey(ports.clock.now()));
  // Mirror the original filename so Markdown/ is browsable alongside Raw/.
  const stem = path.basename(doc.original_filename, path.extname(doc.original_filename));
  const mdPath = await uniquePath(mdDir, `${stem}.md`);
  await fs.writeFile(mdPath, md, "utf-8");

  const now = ports.clock.isoNow();
  db.prepare(
    `UPDATE documents
        SET markdown_path=?, markdown_chars=?, converted_at=?,
            converter=?, converter_version=?, markdown_hash=?
      WHERE id=?`,
  ).run(mdPath, md.length, now, conv.converter, conv.converterVersion, hashText(md), documentId);

  // Search must see the document as soon as it is readable — an index that
  // only fills at analysis time leaves every un-analysed document unfindable.
  indexDocument(db, documentId, md);

  ports.bus.publish({ type: "MarkdownReady", document_id: documentId, markdown_path: mdPath, chars: md.length, at: now });

  // P2 is queued but only runs when an AI provider is configured; the worker
  // marks it done-with-note otherwise, so the pipeline never wedges.
  enqueue(db, ports, documentId, "analyse");
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // Detect encryption: mark the intake as password_needed so the UI can
    // prompt the user for a password. This is not a permanent failure —
    // the user can provide a password and retry.
    if (msg.startsWith("ENCRYPTED:") || /encrypt|password|passwd|protected/i.test(msg)) {
      const now = ports.clock.isoNow();
      db.prepare(
        `UPDATE intake_events
            SET processing_state='password_needed', last_error=?, updated_at=?, heartbeat_at=?
          WHERE document_id=? AND kind IN ('accepted','added')`,
      ).run("Document is encrypted — password required", now, now, documentId);
      // Don't rethrow — the job is not "failed", it's waiting for user input.
      // But we do need to stop the retry loop, so throw a non-retryable error.
      throw new Error(`PASSWORD_NEEDED: ${msg}`);
    }
    throw err;
  }
}

/**
 * Regenerate a document's markdown from the ORIGINAL, in place.
 *
 * First-class because the doctrine makes markdown a cache: anything allowed to
 * treat it as disposable (retention policy, re-extraction, a corrupted file)
 * needs one supported way to rebuild it. Reuses the same converter path as P1
 * so a regenerated document is byte-identical to a freshly ingested one when
 * nothing has changed — which is exactly what makes DRIFT detectable.
 *
 * Returns what changed, so a caller can decide whether re-extraction is
 * warranted rather than re-running Claude on identical text.
 */
export async function regenerateMarkdown(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
): Promise<{
  document_id: string;
  markdown_path: string;
  chars: number;
  converter: string;
  converter_version: string;
  markdown_hash: string;
  previous_hash: string | null;
  changed: boolean;
  converter_changed: boolean;
}> {
  const doc = db
    .prepare(
      `SELECT id, raw_path, ext, original_filename, markdown_path, markdown_hash, converter_version
         FROM documents WHERE id=?`,
    )
    .get(documentId) as
    | {
        id: string;
        raw_path: string;
        ext: string | null;
        original_filename: string;
        markdown_path: string | null;
        markdown_hash: string | null;
        converter_version: string | null;
      }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  const conv = await ports.converter.toMarkdown(doc.raw_path, doc.ext ?? "");
  if (conv === null) throw new Error(`conversion returned null for ${doc.ext}`);
  const md = conv.markdown;
  const hash = hashText(md);

  // Overwrite in place when a markdown file already exists: the path is
  // referenced by documents.markdown_path and re-filing logic, and minting a
  // new " (2)" file on every regeneration would litter the vault.
  let mdPath = doc.markdown_path;
  if (!mdPath) {
    const dir = ports.paths.markdownDir(dateKey(ports.clock.now()));
    const stem = path.basename(doc.original_filename, path.extname(doc.original_filename));
    mdPath = await uniquePath(dir, `${stem}.md`);
  } else {
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
  }
  await fs.writeFile(mdPath, md, "utf-8");

  const now = ports.clock.isoNow();
  db.prepare(
    `UPDATE documents
        SET markdown_path=?, markdown_chars=?, converted_at=?,
            converter=?, converter_version=?, markdown_hash=?
      WHERE id=?`,
  ).run(mdPath, md.length, now, conv.converter, conv.converterVersion, hash, documentId);

  indexDocument(db, documentId, md);

  const changed = doc.markdown_hash !== null && doc.markdown_hash !== hash;
  const converterChanged =
    doc.converter_version !== null && doc.converter_version !== conv.converterVersion;
  if (changed) {
    ports.logger.warn("markdown regeneration DRIFTED from the text extraction read", {
      document_id: documentId,
      previous_hash: doc.markdown_hash?.slice(0, 12),
      new_hash: hash.slice(0, 12),
      previous_converter: doc.converter_version,
      converter: conv.converterVersion,
    });
  }

  ports.bus.publish({
    type: "MarkdownReady",
    document_id: documentId,
    markdown_path: mdPath,
    chars: md.length,
    at: now,
  });

  return {
    document_id: documentId,
    markdown_path: mdPath,
    chars: md.length,
    converter: conv.converter,
    converter_version: conv.converterVersion,
    markdown_hash: hash,
    previous_hash: doc.markdown_hash,
    changed,
    converter_changed: converterChanged,
  };
}

/**
 * Re-file a document's archive copies under its ECONOMIC date once analysis
 * knows it.
 *
 * At P0 we only know when the file arrived, so it lands in Raw/<received>/.
 * But a user hunting for "that Airtel bill from June" thinks in transaction
 * dates, not the day they happened to drag it in. Once P2 extracts
 * occurred_at, the originals move to Raw/<occurred>/ and Markdown/<occurred>/.
 *
 * Never destructive: on any failure the existing paths are left untouched.
 */
async function refileByEconomicDate(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  occurredAt: string,
): Promise<void> {
  const day = occurredAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

  const doc = db
    .prepare("SELECT raw_path, markdown_path FROM documents WHERE id=?")
    .get(documentId) as { raw_path: string; markdown_path: string | null } | undefined;
  if (!doc) return;

  try {
    let newRaw = doc.raw_path;
    if (doc.raw_path && path.basename(path.dirname(doc.raw_path)) !== day) {
      const dir = ports.paths.rawDir(day);
      const dest = await uniquePath(dir, path.basename(doc.raw_path));
      await moveFile(doc.raw_path, dest);
      newRaw = dest;
    }

    let newMd = doc.markdown_path;
    if (doc.markdown_path && path.basename(path.dirname(doc.markdown_path)) !== day) {
      const dir = ports.paths.markdownDir(day);
      const dest = await uniquePath(dir, path.basename(doc.markdown_path));
      await moveFile(doc.markdown_path, dest);
      newMd = dest;
    }

    if (newRaw !== doc.raw_path || newMd !== doc.markdown_path) {
      db.prepare("UPDATE documents SET raw_path=?, markdown_path=? WHERE id=?")
        .run(newRaw, newMd, documentId);
      ports.logger.info("re-filed under transaction date", {
        document_id: documentId,
        date: day,
      });
    }
  } catch (err) {
    ports.logger.warn("re-file failed; archive left as-is", {
      document_id: documentId,
      err: (err as Error)?.message,
    });
  }
}

/**
 * One-shot provenance backfill for documents ingested before §P0.
 *
 * markdown_hash is recomputed from the markdown ON DISK. For an already
 * analysed document that is an ASSERTION, not a measurement: we did not
 * observe what the model read, we are declaring the current file to be it.
 * That is the only honest baseline available, and it is what makes future
 * drift detectable — but it means a pre-P0 document whose markdown was
 * already stale will be recorded as if it were current. Only pre-P0 rows are
 * touched, so this never overwrites a hash that WAS measured.
 *
 * converter/converter_version are inferred from the extension, matching the
 * dispatch in createAnydocConverter. The inferred version is suffixed
 * `~backfill` so a reader can tell a reconstructed identity from an observed
 * one rather than trusting it as evidence.
 */
export async function backfillProvenance(
  db: DatabaseSync,
  ports: Ports,
): Promise<{ scanned: number; hashed: number; converter_tagged: number; markdown_missing: number }> {
  const rows = db
    .prepare(
      `SELECT id, ext, markdown_path, markdown_hash, converter, extraction_json, analysed_at
         FROM documents
        WHERE markdown_hash IS NULL OR converter IS NULL`,
    )
    .all() as Array<{
    id: string;
    ext: string | null;
    markdown_path: string | null;
    markdown_hash: string | null;
    converter: string | null;
    extraction_json: string | null;
    analysed_at: string | null;
  }>;

  let hashed = 0;
  let tagged = 0;
  let missing = 0;

  for (const r of rows) {
    if (r.markdown_hash === null && r.markdown_path) {
      try {
        const md = await fs.readFile(r.markdown_path, "utf-8");
        db.prepare("UPDATE documents SET markdown_hash=?, markdown_chars=? WHERE id=?")
          .run(hashText(md), md.length, r.id);
        hashed++;
      } catch {
        missing++;
        ports.logger.warn("provenance backfill: markdown missing", {
          document_id: r.id,
          expected_at: r.markdown_path,
        });
      }
    }

    if (r.converter === null) {
      const { converter, version } = inferConverter(r.ext);
      db.prepare("UPDATE documents SET converter=?, converter_version=? WHERE id=?")
        .run(converter, `${version}~backfill`, r.id);
      tagged++;
    }
  }

  ports.logger.info("provenance backfilled", {
    scanned: rows.length,
    hashed,
    converter_tagged: tagged,
    markdown_missing: missing,
  });
  return { scanned: rows.length, hashed, converter_tagged: tagged, markdown_missing: missing };
}

/** Mirrors createAnydocConverter's dispatch. Backfill only — never a claim of fact. */
function inferConverter(ext: string | null): { converter: string; version: string } {
  const e = (ext ?? "").toLowerCase();
  if ([".txt", ".md", ".html", ".htm", ".json"].includes(e)) {
    return { converter: "plaintext", version: "passthrough@1" };
  }
  if (e === ".eml") return { converter: "plaintext", version: "eml-reader@1" };
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"].includes(e)) {
    return { converter: "vision-ocr", version: "vision-ocr@unknown" };
  }
  return { converter: "anydoc", version: "anydoc@unknown" };
}

function writeTypedClaim(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  field: string,
  value: unknown,
  confidence: number,
): void {
  if (value === undefined || value === null) return;
  try {
    writeClaim(db, ports, {
      subject: "document",
      subjectId: documentId,
      field,
      value: typeof value === "string" ? value : JSON.stringify(value),
      source: "rule",
      confidence,
      provenanceRef: `typed-extractor:${field}`,
    });
  } catch (error) {
    ports.logger.warn("typed claim not written", { document_id: documentId, field, err: (error as Error).message });
  }
}

function persistTypedExtraction(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  extraction: TypedExtraction,
): void {
  const confidence = extraction.confidence;
  const claims: Array<[string, unknown]> = [
    ["doc_type", extraction.documentType],
    ["document_number", extraction.documentNumber ?? extraction.contractNoteNumber],
    ["document_date", extraction.documentDate ?? extraction.tradeDate],
    ["currency", extraction.currency],
    ["amount_minor", extraction.amountMinor],
    ["line_items", extraction.lineItems],
    ["trades", extraction.trades],
    ["financial_impact", impactFor(extraction.documentType, extraction.defaultImpactBucket, extraction.amountMinor ?? 0, extraction.currency ?? "INR")],
    ["person", extraction.person?.name],
    ["issuer", extraction.issuer?.name],
    ["vendor", extraction.vendor?.name],
  ];
  for (const [field, value] of claims) writeTypedClaim(db, ports, documentId, field, value, confidence);

  const parties: Array<{ name?: string; kind: "person" | "organisation" | "account"; role: DocumentPartyRole; identifiers?: Record<string, string> }> = [];
  if (extraction.issuer) parties.push({ name: extraction.issuer.name, kind: extraction.issuer.kind, role: "issuer", identifiers: { email: extraction.issuer.email ?? "", gstin: extraction.issuer.gstin ?? "" } });
  if (extraction.client) parties.push({ name: extraction.client.name, kind: "person", role: "owner", identifiers: { pan: extraction.client.pan ?? "", ucc: extraction.client.ucc ?? "" } });
  if (extraction.person) parties.push({ name: extraction.person.name, kind: "person", role: "owner" });
  if (extraction.vendor) parties.push({ name: extraction.vendor.name, kind: "organisation", role: "counterparty", identifiers: { email: extraction.vendor.email ?? "" } });
  else if (extraction.broker) parties.push({ name: extraction.broker.name, kind: "organisation", role: "counterparty", identifiers: { pan: extraction.broker.pan ?? "", gstin: extraction.broker.gstin ?? "" } });
  for (const party of parties) {
    if (!party.name) continue;
    const identifiers = Object.fromEntries(Object.entries(party.identifiers ?? {}).filter(([, value]) => value));
    const entityId = party.kind === "person"
      ? resolvePerson(db, ports, party.name, identifiers, documentId).id
      : resolveEntity(db, ports, party.name, party.kind, { identifiers });
    try {
      setDocumentParty(db, ports, {
        documentId,
        entityId,
        role: party.role,
        confidence,
        provenance: "rule-derived",
        editedBy: "typed-extractor",
      });
    } catch (error) {
      ports.logger.warn("typed party not written", { document_id: documentId, name: party.name, err: (error as Error).message });
    }
  }
  db.prepare("UPDATE documents SET doc_type=?, extraction_json=COALESCE(extraction_json,?), extraction_version=COALESCE(extraction_version,?), analysed_at=COALESCE(analysed_at,?) WHERE id=?")
    .run(extraction.documentType, JSON.stringify(extraction), EXTRACTION_VERSION, ports.clock.isoNow(), documentId);
}

function typedLearningAmbiguities(db: DatabaseSync, documentId: string, extraction: TypedExtraction): LearningAmbiguity[] {
  const ambiguities: LearningAmbiguity[] = [];
  const entity = extraction.issuer?.name ?? extraction.client?.name ?? extraction.vendor?.name ?? extraction.broker?.name;
  if (entity) {
    ambiguities.push({
      kind: "new-entity",
      dedupeKey: `typed:new-entity:${entity.toLowerCase()}`,
      prompt: `Is ${entity} a new entity in this vault?`,
      sourceFact: { document_id: documentId, name: entity },
      predictedRule: { kind: "entity-rule", payload: { match_key: entity.toLowerCase(), value: entity } },
      noveltyScore: 0.8,
      why: "The typed extractor found a party not yet confirmed by the user.",
    });
  }
  const seenType = db.prepare("SELECT 1 FROM documents WHERE id<>? AND doc_type=? LIMIT 1").get(documentId, extraction.documentType);
  if (!seenType) {
    ambiguities.push({
      kind: "known-vendor-new-doctype",
      dedupeKey: `typed:doctype:${entity ?? "unknown"}:${extraction.documentType}`.toLowerCase(),
      prompt: `Use ${extraction.documentType.replace(/_/g, " ")} for this document?`,
      sourceFact: { document_id: documentId, document_type: extraction.documentType },
      predictedRule: { kind: "document-type-rule", payload: { match_key: entity ?? documentId, value: extraction.documentType } },
      noveltyScore: 0.75,
      why: "This document type has not previously been confirmed for this party.",
    });
  }
  return ambiguities;
}

/**
 * P2 — analysis. Claude reads canonical markdown v1 and returns extraction
 * JSON. Then: match against existing transactions (many documents, one rupee)
 * or record a new one.
 *
 * AI never rewrites the markdown. Its only product is the JSON stored on
 * documents.extraction_json.
 */
export async function runAnalyseJob(
  db: DatabaseSync,
  ports: Ports,
  ai: AiProvider,
  documentId: string,
): Promise<void> {
  const doc = db
    .prepare("SELECT id, original_filename, markdown_path, markdown_chars FROM documents WHERE id=?")
    .get(documentId) as
    | { id: string; original_filename: string; markdown_path: string | null; markdown_chars: number | null }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  if (!doc.markdown_path || !doc.markdown_chars) {
    ports.logger.warn("analyse: no markdown to analyse", { document_id: documentId });
    return;
  }

  const markdown = await fs.readFile(doc.markdown_path, "utf-8");
  const typed = extractTypedDocument(markdown);
  persistTypedExtraction(db, ports, documentId, typed);
  generateLearningQuestions(db, ports, {
    documentId,
    pipelineState: "analysing",
    ambiguities: typedLearningAmbiguities(db, documentId, typed),
  });
  if (!ai.available) {
    ports.logger.info("analyse: deterministic extraction complete; no AI provider", {
      document_id: documentId,
      document_type: typed.documentType,
    });
    return;
  }
  const x = await ai.extract(markdown, doc.original_filename);
  const now = ports.clock.isoNow();

  if (!x) {
    // Extraction failure must not corrupt the ledger — the document stays in
    // the vault, unanalysed, and can be retried or reviewed.
    db.prepare("UPDATE documents SET analysed_at=? WHERE id=?").run(now, documentId);
    ports.logger.warn("analyse: extraction returned nothing", { document_id: documentId });
    return;
  }

  // markdown_hash is recorded against the text the model ACTUALLY read, not
  // whatever is on disk later. That is the whole point: if regeneration
  // produces a different hash, this extraction is provably stale.
  db.prepare(
    `UPDATE documents
        SET extraction_json=?, extraction_version=?, doc_type=?, analysed_at=?,
            extraction_model=?, extracted_at=?, markdown_hash=?
      WHERE id=?`,
  ).run(
    JSON.stringify(x),
    EXTRACTION_VERSION,
    x.doc_type,
    now,
    ai.model,
    now,
    hashText(markdown),
    documentId,
  );

  // Second index pass: the reading now exists, so the six questions become
  // searchable alongside the document text.
  indexDocument(db, documentId, markdown, flattenExtraction(x));

  ports.bus.publish({
    type: "AnalysisComplete",
    document_id: documentId,
    extraction_version: EXTRACTION_VERSION,
    at: now,
  });

  // ── statement path (work order 04 §Track A) ──────────────────────────────
  // A bank/card statement has amount_minor=null on the DOCUMENT-level
  // extraction — there is no single transaction amount for a document
  // containing dozens of them — so it must branch out here, before the
  // "no money movement" check below would otherwise discard it entirely.
  if (x.doc_type === "bank_statement" || x.doc_type === "card_statement") {
    const acctParty = x.parties.find((p) => p.kind === "account");
    const acctName =
      acctParty?.name ?? x.source_of_funds_text ?? `Unidentified ${x.doc_type === "card_statement" ? "card" : "account"}`;
    const accountEntityId = resolveEntity(db, ports, acctName, "account", {
      subtype: acctParty?.subtype ?? (x.doc_type === "card_statement" ? "credit_card" : "bank"),
    });

    // A statement is denominated in the ACCOUNT's currency, which for this
    // vault is the configured home currency — reading it from app_settings
    // keeps a non-INR vault correct. This is a statement-header default
    // only; the header's own printed currency still wins inside the parser.
    const homeCurrency = (
      db.prepare("SELECT value FROM app_settings WHERE key='jurisdiction.id'").get() as
        | { value?: string }
        | undefined
    )?.value;
    const parsed = parseStatementMarkdown(
      markdown,
      x.currency || loadPack(homeCurrency || "IN").currency.code,
    );
    if (!parsed.column_mapping_confident) {
      ports.logger.warn("statement: column mapping not confident, needs review", {
        document_id: documentId,
        unmapped_columns: parsed.unmapped_columns,
      });
      // Nothing staged automatically — an unfamiliar layout must be visible,
      // not silently mis-parsed. The document stays analysed but with no
      // staged lines; a future AI-assisted mapping pass or manual review
      // handles it. (statements-ai.ts, not yet built.)
      return;
    }

    const staged = stageStatementLines(db, ports, documentId, parsed, accountEntityId);
    const totals = reconcileStatement(db, ports, documentId);
    ports.logger.info("statement imported", {
      document_id: documentId,
      doc_type: x.doc_type,
      staged: staged.staged,
      already_present: staged.already_present,
      linked: totals.linked,
      created: totals.created,
      review: totals.review,
    });
    return;
  }

  if (x.doc_type === "irrelevant" || x.amount_minor === null) {
    ports.logger.info("analyse: no money movement", { document_id: documentId, doc_type: x.doc_type });
    return;
  }

  // File the archive under the ECONOMIC date now that we know it, so Finder
  // folders match how the user thinks about their documents.
  if (x.occurred_at) {
    await refileByEconomicDate(db, ports, documentId, x.occurred_at);
  }

  // ── the money shot: match before recording ──────────────────────────────
  const candidates = findMatches(db, x, documentId);
  const best = candidates[0];

  if (best && best.score >= AUTO_LINK) {
    linkEvidence(db, ports, best.transaction_id, documentId, x, best.score);
    ports.logger.info("AUTO-LINKED — two documents, one rupee", {
      document_id: documentId,
      transaction_id: best.transaction_id,
      score: best.score.toFixed(2),
      reasons: best.reasons.join("; "),
    });
    return;
  }

  if (best && best.score >= REVIEW_FLOOR) {
    // Ambiguous: surface through the Learning drawer via the
    // reconciliation-ambiguity trigger. The user's three answers are:
    //   Link    → promote to a confirmed transaction (D2)
    //   Don't   → dismiss; the pair stays separate (standing rule)
    //   Later   → leave pending; re-asked in a future ingest within budget
    const ambiguity: LearningAmbiguity = {
      kind: "reconciliation-ambiguity",
      dedupeKey: `${documentId}|${best.transaction_id}|${x.amount_minor}|${x.currency}|${x.occurred_at ?? ""}`,
      prompt: "These look like the same purchase. Link?",
      sourceFact: {
        document_id: documentId,
        transaction_id: best.transaction_id,
        amount_minor: x.amount_minor,
        currency: x.currency,
        occurred_at: x.occurred_at,
        counterparty_descriptor: x.counterparty_descriptor,
        source_of_funds_text: x.source_of_funds_text,
      },
      predictedRule: {
        kind: "entity-rule" as const,
        payload: {
          rule_type: "reconcile",
          candidate_document_id: documentId,
          transaction_id: best.transaction_id,
          amount_minor: x.amount_minor,
          currency: x.currency,
        },
      },
      noveltyScore: best.score,
      why: best.reasons.join("; "),
    };
    const questions = generateLearningQuestions(db, ports, {
      documentId,
      pipelineState: "analysing",
      ambiguities: [ambiguity],
    });
    if (questions.length > 0) {
      ports.logger.info("reconciliation question raised", {
        document_id: documentId,
        transaction_id: best.transaction_id,
        score: best.score.toFixed(2),
        reasons: best.reasons.join("; "),
      });
      // D2: do NOT create a transactions row. The document remains
      // unattached until the user answers the Learning question.
      return;
    } else {
      // Questions length is 0 — determine why before falling through.
      const existing = db.prepare(
        "SELECT 1 FROM training_reviews WHERE dedupe_key=? LIMIT 1",
      ).get(ambiguity.dedupeKey);
      if (existing) {
        // A dedup row exists (already asked, answered, or dismissed).
        // Do NOT create a transaction — the question was already handled.
        ports.logger.info("reconciliation question already exists (deduplicated)", {
          document_id: documentId,
          transaction_id: best.transaction_id,
          score: best.score.toFixed(2),
        });
        return;
      }
      // Budget genuinely exhausted and no prior question exists:
      // fall through to recordTransaction as a separate transaction.
      ports.logger.info("reconciliation score in review band but question budget exhausted", {
        document_id: documentId,
        transaction_id: best.transaction_id,
        score: best.score.toFixed(2),
      });
    }
  }

  const rec = recordTransaction(db, ports, documentId, x);
  if (rec) {
    ports.logger.info("transaction recorded", {
      transaction_id: rec.transaction_id,
      direction: rec.direction,
      amount: (rec.amount_minor / 100).toFixed(2),
      new_entities: rec.created_entities,
    });

    // ── curiosity engine (plan §5) ────────────────────────────────────────
    // Ask ONLY on novelty, and only within budget. Every question here would
    // otherwise be a silent guess the user never gets to correct.
    if (rec.created_entities > 0 && x.counterparty_descriptor) {
      const cp = x.parties.find((pp) => pp.role === "counterparty" && pp.kind === "organisation");
      // Only ask when the raw bank descriptor and the resolved entity name are
      // ACTUALLY different. They are frequently identical, which produced
      // questions like `Is "PAYTM MONEY LIMITED" the same as PAYTM MONEY
      // LIMITED?` — a tautology that burns the curiosity budget, trains the
      // user to dismiss the review queue, and teaches the ledger nothing.
      // Compare on the same normalised form used for matching, so casing and
      // punctuation differences alone do not count as novelty either.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (cp && norm(x.counterparty_descriptor) !== norm(cp.name)) {
        ask(db, ports, {
          trigger: "unseen_entity",
          question: `Is "${x.counterparty_descriptor}" the same as ${cp.name}?`,
          context: { document_id: documentId, entity_name: cp.name, descriptor: x.counterparty_descriptor },
          options: ["Yes, always", "No, keep separate"],
        });
      }
    }

    // A wallet-shaped payment that we did NOT book as a transfer is exactly
    // the ambiguity §3.1 warns about — worth one question, once.
    if (!rec.direction.startsWith("transfer") && x.is_wallet_topup) {
      ask(db, ports, {
        trigger: "load_vs_spend",
        question: `Was this ${x.counterparty_descriptor ?? "payment"} a wallet top-up rather than a purchase?`,
        context: { document_id: documentId, transaction_id: rec.transaction_id },
        options: ["Top-up (transfer)", "Purchase (spending)"],
      });
    }
  }
}

/**
 * Worker loop over the durable `jobs` table. Crash-safe: a job left in
 * 'running' by a killed process is reclaimed on next launch.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private db: DatabaseSync,
    private ports: Ports,
    private ai: AiProvider,
    private intervalMs = 400,
    private embed?: EmbeddingProvider,
  ) {}

  /** Reclaim jobs orphaned by a crash. Call once at startup. */
  reclaim(): number {
    const info = this.db
      .prepare("UPDATE jobs SET state='pending', last_error='reclaimed after restart' WHERE state='running'")
      .run();
    const n = Number(info.changes ?? 0);
    if (n > 0) this.ports.logger.warn("reclaimed orphaned jobs", { count: n });
    return n;
  }

  start() {
    if (this.timer) return;
    this.reclaim();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.ports.logger.info("job worker started", { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Embed one document for semantic search. Best-effort: reads the markdown
   * + extraction from disk/DB, calls the embedding provider, and persists.
   * Called fire-and-forget after a successful analyse job.
   */
  private async embedDocumentFor(documentId: string): Promise<void> {
    try {
      const doc = this.db
        .prepare("SELECT markdown_path, extraction_json FROM documents WHERE id=?")
        .get(documentId) as { markdown_path: string | null; extraction_json: string | null } | undefined;
      if (!doc?.markdown_path) return;
      let markdown = "";
      try {
        markdown = await import("node:fs/promises").then((fsp) => fsp.readFile(doc.markdown_path!, "utf-8"));
      } catch {
        return;
      }
      let extractionText = "";
      if (doc.extraction_json) {
        try {
          extractionText = flattenExtraction(JSON.parse(doc.extraction_json));
        } catch {
          // corrupt extraction — embed markdown only
        }
      }
      await embedDocument(this.db, this.ports, this.embed!, documentId, markdown, extractionText);
    } catch (err) {
      this.ports.logger.warn("embedding failed for document", {
        document_id: documentId,
        err: (err as Error)?.message,
      });
    }
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // ATOMIC CLAIM. Read-then-write let two daemons claim the same job:
      // both SELECT the same pending row, both UPDATE it to running, and the
      // document is analysed twice — two API calls, two transactions, a
      // double-counted rupee. Double-starts are routine in practice (launch
      // agent plus a manual run, crash-restart overlap).
      //
      // The conditional UPDATE is the guard: `AND state='pending'` means only
      // one writer can win, and SQLite serialises the writes. The loser sees
      // changes === 0 and moves on.
      const now = this.ports.clock.isoNow();
      let job: { id: number; document_id: string; phase: string; attempts: number } | undefined;

      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = this.db
          .prepare("SELECT id, document_id, phase, attempts FROM jobs WHERE state='pending' ORDER BY id LIMIT 1")
          .get() as { id: number; document_id: string; phase: string; attempts: number } | undefined;
        if (!candidate) return;

        const claim = this.db
          .prepare("UPDATE jobs SET state='running', started_at=?, attempts=attempts+1 WHERE id=? AND state='pending'")
          .run(now, candidate.id);
        if (Number(claim.changes) === 1) {
          job = candidate;
          break;
        }
        // Lost the race — another worker took it. Try the next pending job.
      }
      if (!job) return;

      // The row was incremented by the claim, so this run is attempt N+1.
      // Thresholding on the stale pre-increment value gave one extra retry
      // than MAX_ATTEMPTS specified.
      const attemptNo = job.attempts + 1;
      this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "running", at: now });

      try {
        if (job.phase === "convert") {
          // Work order 07 §B1: update the aggregated intake state to reflect
          // the current stage, not just the raw job churn.
          updateIntakeForJob(this.db, this.ports, job.document_id, "processing", "converting");
          transitionIntakePipeline(
            this.db,
            this.ports,
            job.document_id,
            "converting",
            pipelineSource(this.db, job.document_id),
          );
          await runConvertJob(this.db, this.ports, job.id, job.document_id);
        } else if (job.phase === "analyse") {
          updateIntakeForJob(this.db, this.ports, job.document_id, "processing", "analysing");
          transitionIntakePipeline(
            this.db,
            this.ports,
            job.document_id,
            "analysing",
            pipelineSource(this.db, job.document_id),
          );
          await runAnalyseJob(this.db, this.ports, this.ai, job.document_id);
          // Best-effort embedding (work order 04 §Track B). Non-blocking:
          // a failure here logs but does not fail the job — the document is
          // already analysed and lexically indexed, embeddings are a bonus.
          if (this.embed?.available) {
            void this.embedDocumentFor(job.document_id);
          }
        }
        const fin = this.ports.clock.isoNow();
        this.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(fin, job.id);
        this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "done", at: fin });
        // Work order 07 §B1: mark the intake as complete after the final phase.
        // The convert→analyse chain means the analyse job is the last one.
        if (job.phase === "analyse") {
          transitionIntakePipeline(
            this.db,
            this.ports,
            job.document_id,
            "complete",
            pipelineSource(this.db, job.document_id),
          );
          updateIntakeForJob(this.db, this.ports, job.document_id, "complete", null);
          await removeCompletedSource(this.db, this.ports, job.document_id);
        }
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        // PASSWORD_NEEDED is not a retryable failure — the intake is already
        // marked password_needed by runConvertJob. Mark the job as done (not
        // failed) so the worker doesn't retry it 3 times before giving up.
        if (msg.startsWith("PASSWORD_NEEDED:")) {
          this.db
            .prepare("UPDATE jobs SET state='done', last_error=?, finished_at=? WHERE id=?")
            .run(msg, this.ports.clock.isoNow(), job.id);
          transitionIntakePipeline(
            this.db,
            this.ports,
            job.document_id,
            "password_needed",
            pipelineSource(this.db, job.document_id),
            msg.slice("PASSWORD_NEEDED:".length).trim(),
          );
          this.ports.logger.warn("job awaiting password", { job: job.id, document_id: job.document_id });
          return;
        }
        const state = attemptNo >= MAX_JOB_ATTEMPTS ? "failed" : "pending";
        // Clear started_at when going back in the queue, so a requeued job
        // does not look like it has been running since its first attempt.
        this.db
          .prepare("UPDATE jobs SET state=?, last_error=?, finished_at=?, started_at=CASE WHEN ?='pending' THEN NULL ELSE started_at END WHERE id=?")
          .run(state, msg, this.ports.clock.isoNow(), state, job.id);
        this.ports.logger.error("job failed", { job: job.id, phase: job.phase, attempts: attemptNo, max: MAX_JOB_ATTEMPTS, err: msg });
        // Work order 07 §B3: if the job is permanently failed, mark the intake
        // as failed too so the UI shows a visible error, not indefinite pending.
        if (state === "failed") {
          transitionIntakePipeline(
            this.db,
            this.ports,
            job.document_id,
            "failed",
            pipelineSource(this.db, job.document_id),
            msg,
          );
          setIntakeFailedByDoc(this.db, this.ports, job.document_id, msg);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Drain the queue — used by tests and the CLI so runs are deterministic. */
  async drain(maxTicks = 200): Promise<void> {
    this.reclaim();
    for (let i = 0; i < maxTicks; i++) {
      const pending = this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='pending'").get() as { n: number };
      if (!pending.n) return;
      await this.tick();
    }
  }
}
