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
  saveContractNote,
  updateDocumentProcessing,
  type FinancialImpact,
} from "./database.js";
import { extractDocument } from "./extraction.js";
import { extractContractNote } from "./contract-note.js";
import { buildImpactSummary, deriveImpact, getImpactPrefs } from "./impact.js";
import { ocrDocument } from "./ocr.js";
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
  /** Plain-language "what this means" summary of the document's financial impact. */
  impactSummary?: string;
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
export async function intakeFile(
  sourcePath: string,
  inFlightHashes: Set<string>,
): Promise<IntakeResult> {
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
      logger.info("vault", "Exact duplicate of an existing document", {
        filename,
        ofDocId: existing.id,
      });
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
    return {
      filename,
      status: "accepted",
      job: { filename, type, hash, rawDest, dateFolder, filenameNote },
    };
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
    // Read the document's text. Photos (and scanned/image-based PDFs) are run
    // through vision OCR — which also decides whether the image is a financial
    // document at all, so a personal photo is filed as irrelevant, not analyzed.
    const read = await readForProcessing(rawDest, type, filename);
    if (!read.relevant) {
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
        triageReason: read.reason,
      });
      logger.info("vault", "Filed irrelevant file", { filename });
      return { filename, status: "irrelevant", docId: record.id };
    }

    // Convert to Markdown under Markdown/<date>/, mirroring the filename. OCR'd
    // content is already clean text, so we skip a second AI polish pass for it.
    const { markdown, success, aiBlocked } = read.usedOcr
      ? {
          markdown: `# ${filename}\n\n${read.representation}\n`,
          success: read.legible && !!read.representation,
          aiBlocked: undefined as string | undefined,
        }
      : await polishToMarkdown(read.representation, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawDest, path.extname(rawDest))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    // Extract fields, classify FY, derive accounting hint + financial impact, and
    // (for broker contract notes) pull the structured trades.
    const analysis = await analyzeDocument(markdown, filename);

    const record = insertDocument({
      hash,
      originalFilename: filename,
      fileType: type,
      dateIngested: new Date().toISOString(),
      dateFolder,
      markdownSuccess: success,
      rawPath: rawDest,
      markdownPath: mdDest,
      currency: analysis.currency,
      documentDate: analysis.documentDate,
      financialYear: analysis.financialYear,
      accounting: analysis.accounting,
      impact: analysis.impact,
      isContractNote: analysis.isContractNote,
      lifecycleState: "active",
      triageReason: filenameNote ?? read.reason ?? null,
    });

    if (analysis.contractNote) saveContractNote({ ...analysis.contractNote, docId: record.id });

    // Route any uncertain / missing / conflicting fields to the Review Queue.
    recordExtractionReviews({
      docId: record.id,
      filename,
      extraction: analysis.extraction,
      currency: analysis.currency,
      financialYear: analysis.financialYear,
      fyStartMonth: getFinancePrefs().fyStartMonth,
      accounting: analysis.accounting,
      impact: analysis.impact,
      haystack: `${filename}\n${markdown}`,
    });

    logger.info("vault", "Processed file", { filename, markdownSuccess: success });
    return {
      filename,
      status: "ingested",
      markdownSuccess: success,
      aiBlocked,
      docId: record.id,
      impactSummary: analysis.impact ? buildImpactSummary(analysis.impact) : undefined,
    };
  } catch (error) {
    logger.error("vault", "Failed to process file", { filename, error: String(error) });
    return { filename, status: "error", error: String(error) };
  }
}

/** How a file's text was obtained and whether it should be processed. */
interface ReadResult {
  representation: string;
  relevant: boolean;
  reason: string | null;
  usedOcr: boolean;
  legible: boolean;
}

/**
 * Obtain a document's text for processing. For photos (and empty/scanned PDFs)
 * this uses vision OCR, which also decides relevance; for text documents it uses
 * the deterministic extractor plus the keyword triage.
 */
async function readForProcessing(
  rawDest: string,
  type: FileType,
  filename: string,
): Promise<ReadResult> {
  if (type === "image") {
    const ocr = await ocrDocument(rawDest, "image", filename);
    if (ocr.aiBlocked) {
      // Can't read the photo right now — keep it safe and active; review will flag it.
      return {
        representation: "",
        relevant: true,
        reason: "Photo received — it couldn’t be read automatically yet, so it’s kept for review.",
        usedOcr: true,
        legible: false,
      };
    }
    if (!ocr.isFinancialDocument) {
      return {
        representation: ocr.text,
        relevant: false,
        reason: "Looks like a personal photo, not a financial document.",
        usedOcr: true,
        legible: ocr.legible,
      };
    }
    return {
      representation: ocr.text,
      relevant: true,
      reason: ocr.legible
        ? "Read from a photo."
        : "Read from a photo that was hard to read — some fields may need a quick check.",
      usedOcr: true,
      legible: ocr.legible,
    };
  }

  let representation = await extractText(rawDest, type);
  let usedOcr = false;
  let legible = true;
  // A scanned / image-based PDF yields no extractable text — try vision OCR.
  if (type === "pdf" && !representation) {
    const ocr = await ocrDocument(rawDest, "pdf", filename);
    if (!ocr.aiBlocked && ocr.text) {
      representation = ocr.text;
      usedOcr = true;
      legible = ocr.legible;
    }
  }
  const triage = classifyRelevance(type, filename, representation);
  return { representation, relevant: triage.relevant, reason: triage.reason, usedOcr, legible };
}

/** The classification results for a document's Markdown (shared by ingest + reprocess). */
interface DocumentAnalysis {
  currency: Awaited<ReturnType<typeof extractDocument>>["currency"];
  extraction: Awaited<ReturnType<typeof extractDocument>>["extraction"];
  documentDate: string | null;
  financialYear: string | null;
  accounting: ReturnType<typeof deriveAccountingHint>;
  impact: FinancialImpact | null;
  isContractNote: boolean;
  contractNote: Awaited<ReturnType<typeof extractContractNote>>;
}

/**
 * Run the full intelligence pass over a document's Markdown: field extraction,
 * financial-year classification, accounting hint, financial-impact derivation,
 * and (for broker contract notes) structured trade extraction.
 */
async function analyzeDocument(markdown: string, filename: string): Promise<DocumentAnalysis> {
  const { currency, extraction } = await extractDocument(markdown, filename);
  const fyStartMonth = getFinancePrefs().fyStartMonth;
  const documentDate = extraction.docDate.value;
  const financialYear = financialYearKey(documentDate, fyStartMonth);
  const accounting = deriveAccountingHint(extraction, fyStartMonth);

  const contractNote = extraction.isContractNote
    ? await extractContractNote(markdown, filename, 0)
    : null;
  const impact = deriveImpact({
    extraction,
    currency,
    contractNote: contractNote
      ? { netAmount: contractNote.netAmount, side: contractNote.side }
      : null,
    impactPrefs: getImpactPrefs(),
  });

  return {
    currency,
    extraction,
    documentDate,
    financialYear,
    accounting,
    impact,
    isContractNote: contractNote != null,
    contractNote,
  };
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

    // Rescue path: the user explicitly asked to (re)analyze this file, so read
    // its text (via OCR for photos / scanned PDFs) without re-triaging it away.
    let representation = "";
    let usedOcr = false;
    let legible = true;
    if (type === "image") {
      const ocr = await ocrDocument(rawPath, "image", filename);
      representation = ocr.text;
      usedOcr = true;
      legible = ocr.legible;
    } else {
      representation = await extractText(rawPath, type);
      if (type === "pdf" && !representation) {
        const ocr = await ocrDocument(rawPath, "pdf", filename);
        if (!ocr.aiBlocked && ocr.text) {
          representation = ocr.text;
          usedOcr = true;
          legible = ocr.legible;
        }
      }
    }
    const { markdown, success } = usedOcr
      ? { markdown: `# ${filename}\n\n${representation}\n`, success: legible && !!representation }
      : await polishToMarkdown(representation, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawPath, path.extname(rawPath))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    const analysis = await analyzeDocument(markdown, filename);

    updateDocumentProcessing(docId, {
      markdownSuccess: success,
      markdownPath: mdDest,
      rawPath,
      dateFolder,
      currency: analysis.currency,
      documentDate: analysis.documentDate,
      financialYear: analysis.financialYear,
      accounting: analysis.accounting,
      impact: analysis.impact,
      isContractNote: analysis.isContractNote,
      lifecycleState: "active",
      triageReason: null,
    });

    if (analysis.contractNote) saveContractNote({ ...analysis.contractNote, docId });

    // Re-record field reviews from scratch (drop any that referenced the old pass).
    deleteFieldReviewsForDoc(docId);
    recordExtractionReviews({
      docId,
      filename,
      extraction: analysis.extraction,
      currency: analysis.currency,
      financialYear: analysis.financialYear,
      fyStartMonth: getFinancePrefs().fyStartMonth,
      accounting: analysis.accounting,
      impact: analysis.impact,
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
    return {
      filename: intake.filename,
      status: intake.status === "accepted" ? "error" : intake.status,
      error: intake.error,
    };
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
