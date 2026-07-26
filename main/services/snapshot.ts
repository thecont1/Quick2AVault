/**
 * Financial snapshot: read the vault's Markdown files and use Glaze AI to
 * produce a high-level, per-person summary (who appears in the documents, how
 * many belong to each person, the date range they span, and which categories of
 * document were found). The result is cached so the popup can open instantly.
 *
 * Never throws for AI/consent problems — blocked states are returned so the
 * renderer can show a friendly message alongside the raw ingestion stats.
 */
import * as fs from "node:fs/promises";

import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import { getSnapshotCache, listDocuments, saveSnapshotCache } from "./database.js";

export interface PersonSummary {
  name: string;
  documentCount: number;
  dateRange: { start: string; end: string } | null;
  categories: string[];
}

export interface SnapshotData {
  people: PersonSummary[];
  unidentified: { documentCount: number; categories: string[] } | null;
}

export interface FallbackStats {
  totalDocuments: number;
  documents: { filename: string; fileType: string; dateIngested: string }[];
  dateRange: { start: string; end: string } | null;
}

export interface SnapshotResponse {
  /** The AI summary (fresh, or the last cached one when a refresh is blocked). */
  snapshot: SnapshotData | null;
  /** ISO timestamp of when `snapshot` was generated. */
  generatedAt: string | null;
  /** GlazeAIError.state when the AI step was blocked. */
  aiBlocked?: string;
  /** Generic (non-AI-consent) failure message. */
  error?: string;
  /** Raw ingestion stats, always available without AI. */
  fallback: FallbackStats;
}

// Bound AI input so a large vault doesn't burn excess credits.
const MAX_TOTAL_CHARS = 24000;
const MAX_PER_DOC = 1800;
const MAX_DOCS = 60;

const snapshotSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().describe("The person's name exactly as it appears in the document content"),
        documentCount: z
          .number()
          .int()
          .describe("How many of the provided documents clearly belong to this person"),
        dateRange: z
          .object({
            start: z.string().describe("Earliest period the person's documents cover, e.g. 'Jan 2024'"),
            end: z.string().describe("Latest period the person's documents cover, e.g. 'Jun 2024'"),
          })
          .nullable()
          .describe("Date range inferred from document content, or null if unclear"),
        categories: z
          .array(z.string())
          .describe("Distinct document categories, e.g. 'bank statement', 'tax document', 'insurance'"),
      }),
    )
    .describe("One entry per distinct person identified from document content"),
  unidentified: z
    .object({
      documentCount: z.number().int(),
      categories: z.array(z.string()),
    })
    .nullable()
    .describe("Documents that could not be confidently attributed to a person, or null if there are none"),
});

function safeParse(json: string): SnapshotData | null {
  try {
    return JSON.parse(json) as SnapshotData;
  } catch {
    return null;
  }
}

function buildFallback(): FallbackStats {
  const docs = listDocuments(500);
  const documents = docs.map((d) => ({
    filename: d.originalFilename,
    fileType: d.fileType,
    dateIngested: d.dateIngested,
  }));
  let dateRange: { start: string; end: string } | null = null;
  if (docs.length > 0) {
    const dates = docs.map((d) => d.dateIngested).sort();
    dateRange = { start: dates[0], end: dates[dates.length - 1] };
  }
  return { totalDocuments: docs.length, documents, dateRange };
}

/** Read Markdown excerpts for the vault's documents, bounded for the AI. */
async function buildAiInput(): Promise<string> {
  const docs = listDocuments(MAX_DOCS);
  const blocks: string[] = [];
  let total = 0;
  let index = 0;
  for (const doc of docs) {
    let content = "";
    try {
      content = await fs.readFile(doc.markdownPath, "utf-8");
    } catch {
      content = "";
    }
    const excerpt = content.slice(0, MAX_PER_DOC).trim();
    index += 1;
    const block =
      `### Document ${index}\n` +
      `Filename: ${doc.originalFilename}\n` +
      `Type: ${doc.fileType}\n` +
      `Ingested: ${doc.dateIngested}\n` +
      `Content excerpt:\n${excerpt || "(no extractable content)"}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    blocks.push(block);
    total += block.length;
  }
  return blocks.join("\n");
}

/** Return the cached snapshot (if any) plus current fallback stats. No AI. */
export function getCachedSnapshot(): SnapshotResponse {
  const cache = getSnapshotCache();
  return {
    snapshot: cache ? safeParse(cache.json) : null,
    generatedAt: cache?.generatedAt ?? null,
    fallback: buildFallback(),
  };
}

/** Re-run the AI summary, update the cache, and return the fresh result. */
export async function refreshSnapshot(): Promise<SnapshotResponse> {
  const fallback = buildFallback();
  const cache = getSnapshotCache();
  const previous = cache ? safeParse(cache.json) : null;

  // Empty vault: nothing to summarize — don't spend AI credits.
  if (fallback.totalDocuments === 0) {
    const empty: SnapshotData = { people: [], unidentified: null };
    const now = new Date().toISOString();
    saveSnapshotCache(JSON.stringify(empty), now);
    return { snapshot: empty, generatedAt: now, fallback };
  }

  const documentsText = await buildAiInput();

  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema: snapshotSchema,
      system:
        "You analyze a collection of personal financial documents and produce a high-level, " +
        "factual snapshot grouped by person. Identify each distinct person by their name as it " +
        "appears in the document content (account holders, signatories, addressees) — never infer " +
        "a person from a filename. Only attribute a document to a person when the content clearly " +
        "names them; otherwise count it under 'unidentified'. Stay high-level: do not compute " +
        "balances or transaction-level detail. Never invent people, counts, dates, or categories.",
      prompt:
        `Below are ${fallback.totalDocuments} documents from a personal financial vault. ` +
        "For each identified person, report their name, how many of these documents belong to them, " +
        "the date range their documents span (from dates found in the content, or null if unclear), " +
        "and the categories of document found (e.g. bank statement, tax document, investment " +
        "statement, insurance, credit card). Group any documents you cannot confidently attribute " +
        `to a named person under 'unidentified'.\n\n${documentsText}`,
    });

    const snapshot = object as SnapshotData;
    const now = new Date().toISOString();
    saveSnapshotCache(JSON.stringify(snapshot), now);
    logger.info("snapshot", "Generated financial snapshot", {
      people: snapshot.people.length,
      unidentified: snapshot.unidentified?.documentCount ?? 0,
    });
    return { snapshot, generatedAt: now, fallback };
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("snapshot", "AI snapshot blocked", { state: error.state });
      return { snapshot: previous, generatedAt: cache?.generatedAt ?? null, aiBlocked: error.state, fallback };
    }
    logger.warn("snapshot", "AI snapshot failed", { error: String(error) });
    return { snapshot: previous, generatedAt: cache?.generatedAt ?? null, error: String(error), fallback };
  }
}
