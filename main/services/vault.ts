/**
 * Vault ingestion: copy dropped files into a dated Raw/ folder, convert them to
 * Markdown under a mirrored Markdown/ folder, dedupe by content hash, and record
 * everything in the local database.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app, logger } from "@glaze/core/backend";

import { convertToMarkdown, getFileType, type FileType } from "./converter.js";
import { findByHash, insertDocument } from "./database.js";
import { extractDocument } from "./extraction.js";
import { recordExtractionReviews } from "./reviews.js";

export function getVaultRoot(): string {
  return path.join(app.getPath("documents"), "Quick2Afvault");
}

function getRawRoot(): string {
  return path.join(getVaultRoot(), "Raw");
}

function getMarkdownRoot(): string {
  return path.join(getVaultRoot(), "Markdown");
}

/** Ensure the top-level vault folders exist. */
export async function ensureVaultDirs(): Promise<void> {
  await fs.mkdir(getRawRoot(), { recursive: true });
  await fs.mkdir(getMarkdownRoot(), { recursive: true });
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
  status: "ingested" | "duplicate" | "unsupported" | "error";
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
}

export interface IntakeResult {
  filename: string;
  /** "accepted" means the original is safely copied and a job is queued. */
  status: "accepted" | "duplicate" | "unsupported" | "error";
  error?: string;
  job?: ProcessJob;
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
    if (findByHash(hash) || inFlightHashes.has(hash)) {
      logger.info("vault", "Skipping duplicate file", { filename });
      return { filename, status: "duplicate" };
    }
    inFlightHashes.add(hash);

    const dateFolder = todayFolder();
    const rawDir = path.join(getRawRoot(), dateFolder);
    await fs.mkdir(rawDir, { recursive: true });
    const rawDest = await uniqueDest(rawDir, filename);
    await fs.copyFile(sourcePath, rawDest);

    logger.info("vault", "Received file", { filename });
    return { filename, status: "accepted", job: { filename, type, hash, rawDest, dateFolder } };
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
  const { filename, type, hash, rawDest, dateFolder } = job;
  try {
    // Convert to Markdown under Markdown/<date>/, mirroring the filename.
    const { markdown, success, aiBlocked } = await convertToMarkdown(rawDest, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawDest, path.extname(rawDest))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    // One AI pass extracts the document's fields (type, vendor, date, amount,
    // currency) and computes the foreign-currency conversion. Best-effort.
    const { currency, extraction } = await extractDocument(markdown, filename);

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
    });

    // Route any uncertain / missing / conflicting fields to the Review Queue.
    recordExtractionReviews({
      docId: record.id,
      filename,
      extraction,
      currency,
      haystack: `${filename}\n${markdown}`,
    });

    logger.info("vault", "Processed file", { filename, markdownSuccess: success });
    return { filename, status: "ingested", markdownSuccess: success, aiBlocked, docId: record.id };
  } catch (error) {
    logger.error("vault", "Failed to process file", { filename, error: String(error) });
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
