/**
 * Vault ingestion: copy dropped files into a dated Raw/ folder, convert them to
 * Markdown under a mirrored Markdown/ folder, dedupe by content hash, and record
 * everything in the local database.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app, logger } from "@glaze/core/backend";

import { convertToMarkdown, getFileType } from "./converter.js";
import { findByHash, insertDocument } from "./database.js";

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
}

/** Ingest a single dropped file. Ensures the vault exists first. Never throws. */
export async function ingestFile(sourcePath: string): Promise<IngestResult> {
  await ensureVaultDirs();
  return ingestOne(sourcePath);
}

async function ingestOne(sourcePath: string): Promise<IngestResult> {
  const filename = path.basename(sourcePath);
  const type = getFileType(filename);

  if (!type) {
    return { filename, status: "unsupported" };
  }

  try {
    const hash = await hashFile(sourcePath);
    if (findByHash(hash)) {
      logger.info("vault", "Skipping duplicate file", { filename });
      return { filename, status: "duplicate" };
    }

    const dateFolder = todayFolder();

    // Copy the original into Raw/<date>/
    const rawDir = path.join(getRawRoot(), dateFolder);
    await fs.mkdir(rawDir, { recursive: true });
    const rawDest = await uniqueDest(rawDir, filename);
    await fs.copyFile(sourcePath, rawDest);

    // Convert to Markdown under Markdown/<date>/, mirroring the filename.
    const { markdown, success, aiBlocked } = await convertToMarkdown(rawDest, filename, type);
    const mdDir = path.join(getMarkdownRoot(), dateFolder);
    await fs.mkdir(mdDir, { recursive: true });
    const mdName = `${path.basename(rawDest, path.extname(rawDest))}.md`;
    const mdDest = path.join(mdDir, mdName);
    await fs.writeFile(mdDest, markdown, "utf-8");

    insertDocument({
      hash,
      originalFilename: filename,
      fileType: type,
      dateIngested: new Date().toISOString(),
      dateFolder,
      markdownSuccess: success,
      rawPath: rawDest,
      markdownPath: mdDest,
    });

    logger.info("vault", "Ingested file", { filename, markdownSuccess: success });
    return { filename, status: "ingested", markdownSuccess: success, aiBlocked };
  } catch (error) {
    logger.error("vault", "Failed to ingest file", { filename, error: String(error) });
    return { filename, status: "error", error: String(error) };
  }
}

/** Ingest a batch of dropped file paths, sequentially. */
export async function ingestFiles(sourcePaths: string[]): Promise<IngestResult[]> {
  await ensureVaultDirs();
  const results: IngestResult[] = [];
  for (const sourcePath of sourcePaths) {
    results.push(await ingestOne(sourcePath));
  }
  return results;
}
