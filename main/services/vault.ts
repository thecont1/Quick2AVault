/**
 * Vault ingestion: copy dropped files into a dated Raw/ folder, convert them to
 * Markdown under a mirrored Markdown/ folder, dedupe by content hash, and record
 * everything in the local database.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app, logger } from "@glaze/core/backend";

import { extractText, getFileType, polishToMarkdown, type FileType } from "./converter.js";
import {
  deleteFieldReviewsForDoc,
  findByHash,
  findDocumentById,
  findLatestByFilename,
  insertDocument,
  insertDuplicateEvent,
  updateDocumentProcessing,
} from "./database.js";
import { extractDocument } from "./extraction.js";
import { recordExtractionReviews } from "./reviews.js";
import { deriveAccountingHint } from "./accounting.js";
import { financialYearKey, getFinancePrefs } from "./preferences.js";
import { classifyRelevance } from "./triage.js";

export function getVaultRoot(): string {
  return path.join(app.getPath("documents"), "Quick2Afvault");
}

function getRawRoot(): string {
  return path.join(getVaultRoot(), "Raw");
}

function getMarkdownRoot(): string {
  return path.join(getVaultRoot(), "Markdown");
}

function getIrrelevantRoot(): string {
  return path.join(getVaultRoot(), "Irrelevant");
}

/** Ensure the top-level vault folders exist. */
export async function ensureVaultDirs(): Promise<void> {
  await fs.mkdir(getRawRoot(), { recursive: true });
  await fs.mkdir(getMarkdownRoot(), { recursive: true });
  await fs.mkdir(getIrrelevantRoot(), { recursive: true });
}

function todayFolder(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a non-colliding destination path, keeping the original name when possible. */
async function uniqueDest(dir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let counter = 2;
  while (await fileExists(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

export interface IngestResult {
  filename: string;
  status: "ingested" | "irrelevant" | "duplicate" | "unsupported" | "error";
  markdownSuccess?: boolean;
  aiBlocked?: string;
  error?: string;
  /** Database id of the newly-ingested document (only on a fresh "ingested"). */
  docId?: number;
}

/**
 * A file that has been safely copied into the vault and is ready to process.
 * Intake (copy + dedup) is fast; the heavy Markdown/extraction work happens
 * later in `processIntake`, off the drop's critical path.
 */
export interface ProcessJob {
  filename: string;
  type: FileType;
  hash: string;
  rawDest: string;
  dateFolder: string;
  /** Set when the visible filename matched an earlier, different-content file. */
  filenameNote?: string | null;
}

export interface IntakeResult {
  filename: string;
  /** "accepted" means the original is safely copied and a job is queued. */
  status: "accepted" | "duplicate" | "unsupported" | "error";
  error?: string;
  job?: ProcessJob;
  /** For a duplicate: the document this file exactly matches, if still present. */
  duplicateOfDocId?: number | null;
}

/**
 * Phase 1 — intake: hash, dedupe, and copy the original into the vault. Fast and
 * safe; returns immediately so the UI can acknowledge receipt before the slow
 * AI processing runs. `inFlightHashes` guards against duplicate files within the
 * same burst of drops (before their records exist in the database). Never throws.
 */
export async function intakeFile(sourcePath: string, inFlightHashes: Set<string>): Promise<IntakeResult> {
  const filename = path.basename(sourcePath);
  const type = getFileType(filename);
  if (!type) return { filename, status: "unsupported" };

  try {
    const hash = await hashFile(sourcePath);

    // Exact duplicate: identical SHA-256 to an already-ingested document (or one
    // already accepted earlier in this same burst of drops). Don't reprocess —
    // log a lightweight duplicate event so the user can see/dismiss it, and
    // point them at the original document.
    const existing = findByHash(hash);
    if (existing) {
      const when = existing.dateIngested.slice(0, 10);
      insertDuplicateEvent({
        hash,
        filename,
        sourcePath,
        duplicateOfDocId: existing.id,
        reason: `Exact duplicate of “${existing.originalFilename}” already ingested on ${when}.`,
      });
      logger.info("vault", "Exact duplicate of an existing document", { filename, ofDocId: existing.id });
      return { filename, status: "duplicate", duplicateOfDocId: existing.id };
    }
    if (inFlightHashes.has(hash)) {
      insertDuplicateEvent({
        hash,
        filename,
        sourcePath,
        duplicateOfDocId: null,
        reason: "Exact duplicate of another file dropped in the same batch.",
      });
      logger.info("vault", "Duplicate within the same drop", { filename });
      return { filename, status: "duplicate", duplicateOfDocId: null };
    }
    inFlightHashes.add(hash);

    // Same visible filename but different content (hash differs): keep both.
    // uniqueDest below stores the new file under a safe unique path; we record a
    // note so the UI can explain that the original name was preserved.
    const sameName = findLatestByFilename(filename);
    const filenameNote = sameName
      ? "Filename matches an earlier file, but the content differs; stored separately."
      : null;

    const dateFolder = todayFolder();
    const rawDir = path.join(getRawRoot(), dateFolder);
    await fs.mkdir(rawDir, { recursive: true });
    const rawDest = await uniqueDest(rawDir, filename);
    await fs.copyFile(sourcePath, rawDest);

    logger.info("vault", "Received file", { filename });
    return { filename, status: "accepted", job: { filename, type, hash, rawDest, dateFolder, filenameNote } };
  } catch (error) {
    logger.error("vault", "Failed to receive file", { filename, error: String(error) });
    return { filename, status: "error", error: String(error) };
  }
}

/**
 * Phase 2 — process an already-received file: convert to Markdown, run the
 * unified extraction, record the document, and route uncertain fields to the
 * Review Queue. The original is already safe in the vault, so a failure here
 * surfaces as a processing failure, not a lost file. Never throws.
 */
export async function processIntake(job: ProcessJob): Promise<IngestResult> {
  const { filename, type, hash, rawDest, dateFolder, filenameNote } = job;
  try {
    // Cheap, deterministic first pass: pull the plain text once, then triage
    // relevance before spending any AI credits. Clearly non-financial files are
    // filed away into Irrelevant/ and recorded, but never deeply processed.
    const representation = await extractText(rawDest, type);
    const triage = classifyRelevance(type, filename, representation);
    if (!triage.relevant) {
      const irrelevantDir = path.join(getIrrelevantRoot(), dateFolder);
      await fs.mkdir(irrelevantDir, { recursive: true });
      const irrelevantDest = await uniqueDest(irrelevantDir, path.basename(rawDest));
      await fs.rename(rawDest, irrelevantDest).catch(async () => {
        // Cross-device rename can fail; fall back to copy + unlink.
        await fs.copyFile(rawDest, irrelevantDest);
        await fs.unlink(rawDest).catch(() => {});
      });
      const record = insertDocument({
        hash,
        originalFilename: filename,
        fileType: type,
        dateIngested: new Date().toISOString(),
        dateFolder,
        markdownSuccess: false,
        rawPath: irrelevantDest,
        markdownPath: "",
        lifecycleState: "irrelevant",
        triageReason: triage.reason,
      });
      logger.info("vault", "Filed irrelevant file", { filename });
      return { filename, status: "irrelevant", docId: record.id };
    }

    // Convert to Markdown under Markdown/<date>/, mirroring the filename.
    const { markdown, success, aiBlocked } = await polishToMarkdown(representation, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawDest, path.extname(rawDest))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    // One AI pass extracts the document's fields (type, vendor, date, amount,
    // currency) and computes the foreign-currency conversion. Best-effort.
    const { currency, extraction } = await extractDocument(markdown, filename);

    // Classify the document into a financial-year bucket as early as possible
    // (from its document date + the user's FY start month) and derive the
    // advisory accounting hint — both first-class, before deeper analysis.
    const fyStartMonth = getFinancePrefs().fyStartMonth;
    const documentDate = extraction.docDate.value;
    const financialYear = financialYearKey(documentDate, fyStartMonth);
    const accounting = deriveAccountingHint(extraction, fyStartMonth);

    const record = insertDocument({
      hash,
      originalFilename: filename,
      fileType: type,
      dateIngested: new Date().toISOString(),
      dateFolder,
      markdownSuccess: success,
      rawPath: rawDest,
      markdownPath: mdDest,
      currency,
      documentDate,
      financialYear,
      accounting,
      lifecycleState: "active",
      triageReason: filenameNote ?? null,
    });

    // Route any uncertain / missing / conflicting fields to the Review Queue.
    recordExtractionReviews({
      docId: record.id,
      filename,
      extraction,
      currency,
      financialYear,
      fyStartMonth,
      accounting,
      haystack: `${filename}\n${markdown}`,
    });

    logger.info("vault", "Processed file", { filename, markdownSuccess: success });
    return { filename, status: "ingested", markdownSuccess: success, aiBlocked, docId: record.id };
  } catch (error) {
    logger.error("vault", "Failed to process file", { filename, error: String(error) });
    return { filename, status: "error", error: String(error) };
  }
}

/**
 * Reprocess an existing document from its raw file (no re-drop needed): re-run
 * conversion + extraction and update the record in place, then set it active.
 * Used to rescue an irrelevant/excluded document the user wants analyzed. If the
 * raw file lives in Irrelevant/, it's moved back into Raw/ first. Never throws.
 */
export async function reprocessDocument(docId: number): Promise<IngestResult> {
  const doc = findDocumentById(docId);
  if (!doc) return { filename: "", status: "error", error: "Document not found" };
  const filename = doc.originalFilename;
  try {
    await ensureVaultDirs();
    if (!(await fileExists(doc.rawPath))) {
      return { filename, status: "error", error: "Original file is no longer on disk" };
    }

    const type = getFileType(filename) ?? (doc.fileType as FileType);
    const dateFolder = doc.dateFolder || todayFolder();

    // If the raw file was filed under Irrelevant/, move it back into Raw/.
    let rawPath = doc.rawPath;
    if (rawPath.startsWith(getIrrelevantRoot())) {
      const rawDir = path.join(getRawRoot(), dateFolder);
      await fs.mkdir(rawDir, { recursive: true });
      const rawDest = await uniqueDest(rawDir, path.basename(rawPath));
      await fs.rename(rawPath, rawDest).catch(async () => {
        await fs.copyFile(rawPath, rawDest);
        await fs.unlink(rawPath).catch(() => {});
      });
      rawPath = rawDest;
    }

    const representation = await extractText(rawPath, type);
    const { markdown, success } = await polishToMarkdown(representation, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawPath, path.extname(rawPath))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    const { currency, extraction } = await extractDocument(markdown, filename);
    const fyStartMonth = getFinancePrefs().fyStartMonth;
    const documentDate = extraction.docDate.value;
    const financialYear = financialYearKey(documentDate, fyStartMonth);
    const accounting = deriveAccountingHint(extraction, fyStartMonth);

    updateDocumentProcessing(docId, {
      markdownSuccess: success,
      markdownPath: mdDest,
      rawPath,
      dateFolder,
      currency,
      documentDate,
      financialYear,
      accounting,
      lifecycleState: "active",
      triageReason: null,
    });

    // Re-record field reviews from scratch (drop any that referenced the old pass).
    deleteFieldReviewsForDoc(docId);
    recordExtractionReviews({
      docId,
      filename,
      extraction,
      currency,
      financialYear,
      fyStartMonth,
      accounting,
      haystack: `${filename}\n${markdown}`,
    });

    logger.info("vault", "Reprocessed document", { docId, filename, markdownSuccess: success });
    return { filename, status: "ingested", markdownSuccess: success, docId };
  } catch (error) {
    logger.error("vault", "Failed to reprocess document", { docId, error: String(error) });
    return { filename, status: "error", error: String(error) };
  }
}

/** Ingest a single dropped file end-to-end (intake + process). Never throws. */
export async function ingestFile(sourcePath: string): Promise<IngestResult> {
  await ensureVaultDirs();
  const intake = await intakeFile(sourcePath, new Set());
  if (intake.status !== "accepted" || !intake.job) {
    return { filename: intake.filename, status: intake.status === "accepted" ? "error" : intake.status, error: intake.error };
  }
  return processIntake(intake.job);
}

/** Ingest a batch of dropped file paths, sequentially (intake + process each). */
export async function ingestFiles(sourcePaths: string[]): Promise<IngestResult[]> {
  await ensureVaultDirs();
  const inFlight = new Set<string>();
  const results: IngestResult[] = [];
  for (const sourcePath of sourcePaths) {
    const intake = await intakeFile(sourcePath, inFlight);
    if (intake.status !== "accepted" || !intake.job) {
      results.push({
        filename: intake.filename,
        status: intake.status === "accepted" ? "error" : intake.status,
        error: intake.error,
      });
      continue;
    }
    results.push(await processIntake(intake.job));
  }
  return results;
}
