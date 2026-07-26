/**
 * Financial snapshot: read the vault's Markdown files and use Glaze AI to
 * attribute each document to a person, then aggregate a high-level, per-person
 * summary (who appears, how many documents, the date range they span, and which
 * categories were found). The raw per-document attribution is cached, so manual
 * corrections (rename / merge / reassign) re-aggregate instantly without AI.
 *
 * Never throws for AI/consent problems — blocked states are returned so the
 * renderer can show a friendly message alongside the raw ingestion stats.
 */
import * as fs from "node:fs/promises";

import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import {
  getSnapshotCache,
  listDocumentOverrides,
  listDocuments,
  listPersons,
  saveSnapshotCache,
  type PersonRole,
} from "./database.js";
import {
  buildAliasIndex,
  consolidateCandidateDuplicates,
  resolveNameToPersonId,
  resolvePersonForName,
  seedPeopleFromExisting,
} from "./people.js";

export interface DocRef {
  docId: number;
  filename: string;
}

/** A confidently-converted foreign-currency invoice. */
export interface ForeignInvoice {
  docId: number;
  filename: string;
  amount: number;
  currency: string;
  inrValue: number;
  rateUsed: number;
  rateDate: string;
  rateIsNearest: boolean;
}

export interface PersonSummary {
  name: string;
  /** Canonical person id when this group resolved to a stored person, else null. */
  personId: number | null;
  roles: PersonRole[];
  isSelf: boolean;
  documentCount: number;
  dateRange: { start: string; end: string } | null;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

export interface UnidentifiedSummary {
  documentCount: number;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

/** A document with a detected foreign amount that couldn't be converted confidently. */
export interface NeedsReviewDoc {
  docId: number;
  filename: string;
  currency: string | null;
  amount: number | null;
}

export interface NeedsReviewSummary {
  documentCount: number;
  documents: NeedsReviewDoc[];
}

export interface SnapshotData {
  people: PersonSummary[];
  unidentified: UnidentifiedSummary | null;
  needsReview: NeedsReviewSummary | null;
}

export interface FallbackStats {
  totalDocuments: number;
  documents: { filename: string; fileType: string; dateIngested: string }[];
  dateRange: { start: string; end: string } | null;
}

export interface SnapshotResponse {
  /** The aggregated summary (fresh, or the last cached one when a refresh is blocked). */
  snapshot: SnapshotData | null;
  /** ISO timestamp of when the underlying attribution was generated. */
  generatedAt: string | null;
  /** GlazeAIError.state when the AI step was blocked. */
  aiBlocked?: string;
  /** Generic (non-AI-consent) failure message. */
  error?: string;
  /** Raw ingestion stats, always available without AI. */
  fallback: FallbackStats;
}

/** One document's AI attribution, resolved to a concrete database record. */
interface Attribution {
  docId: number;
  filename: string;
  fileType: string;
  /** Raw person name from the AI, or null when the AI couldn't attribute it. */
  person: string | null;
  category: string;
  /** ISO-ish period the document covers (YYYY / YYYY-MM / YYYY-MM-DD), or null. */
  periodStart: string | null;
  periodEnd: string | null;
}

interface CachedAttributions {
  version: 2;
  attributions: Attribution[];
}

// Bound AI input so a large vault doesn't burn excess credits.
const MAX_TOTAL_CHARS = 24000;
const MAX_PER_DOC = 1800;
const MAX_DOCS = 60;

const snapshotSchema = z.object({
  attributions: z
    .array(
      z.object({
        documentIndex: z
          .number()
          .int()
          .describe("The 'Document N' number from the input this attribution refers to"),
        person: z
          .string()
          .nullable()
          .describe(
            "The account holder / signatory's name exactly as it appears in the document content, " +
              "or null if the document can't be confidently attributed to a named person",
          ),
        category: z
          .string()
          .describe("Document category, e.g. 'bank statement', 'tax document', 'insurance', 'credit card'"),
        periodStart: z
          .string()
          .nullable()
          .describe("Earliest date the document covers, as YYYY, YYYY-MM, or YYYY-MM-DD; null if unclear"),
        periodEnd: z
          .string()
          .nullable()
          .describe("Latest date the document covers, as YYYY, YYYY-MM, or YYYY-MM-DD; null if unclear"),
      }),
    )
    .describe("Exactly one entry per provided document"),
});

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

// ── Override resolution + aggregation ───────────────────────────────────

/** Turn per-document attributions + manual overrides into a per-person summary. */
function aggregate(attributions: Attribution[]): SnapshotData {
  const docMap = new Map(listDocumentOverrides().map((o) => [o.docId, o.person]));
  // Currency data lives on the document record (computed at ingestion), so join
  // it in at read time rather than caching it in the attribution blob.
  const docMeta = new Map(listDocuments(500).map((d) => [d.id, d]));
  // Canonical person resolution: every raw name resolves to a stored person via
  // its alias index, so reorders/variants and user merges collapse instantly.
  const aliasIndex = buildAliasIndex();
  const personById = new Map(listPersons().map((p) => [p.id, p]));

  type Bucket = {
    key: string;
    name: string;
    personId: number | null;
    roles: PersonRole[];
    isSelf: boolean;
    categories: Set<string>;
    documents: DocRef[];
    starts: string[];
    ends: string[];
    foreignInvoices: ForeignInvoice[];
    foreignTotalInr: number;
  };
  const people = new Map<string, Bucket>();
  const unidentified: { categories: Set<string>; documents: DocRef[]; foreignInvoices: ForeignInvoice[]; foreignTotalInr: number } = {
    categories: new Set<string>(),
    documents: [],
    foreignInvoices: [],
    foreignTotalInr: 0,
  };
  const needsReview: NeedsReviewDoc[] = [];

  for (const attr of attributions) {
    // A manual per-document pin wins over the AI's attribution.
    const rawName = docMap.has(attr.docId) ? docMap.get(attr.docId)! : attr.person;
    const personId = resolveNameToPersonId(rawName, aliasIndex);
    const person = personId != null ? personById.get(personId) : undefined;
    // Display: canonical person name when resolved; else the raw name (transient).
    const effective = person ? person.displayName : rawName;

    const ref: DocRef = { docId: attr.docId, filename: attr.filename };
    const category = attr.category?.trim();

    let foreign: { foreignInvoices: ForeignInvoice[]; foreignTotalInr: number };
    if (effective == null) {
      if (category) unidentified.categories.add(category);
      unidentified.documents.push(ref);
      foreign = unidentified;
    } else {
      const key = personId != null ? `p${personId}` : `raw:${effective}`;
      let bucket = people.get(key);
      if (!bucket) {
        bucket = {
          key,
          name: effective,
          personId: personId ?? null,
          roles: person?.roles ?? [],
          isSelf: person?.isSelf ?? false,
          categories: new Set(),
          documents: [],
          starts: [],
          ends: [],
          foreignInvoices: [],
          foreignTotalInr: 0,
        };
        people.set(key, bucket);
      }
      if (category) bucket.categories.add(category);
      bucket.documents.push(ref);
      if (attr.periodStart) bucket.starts.push(attr.periodStart);
      if (attr.periodEnd) bucket.ends.push(attr.periodEnd);
      foreign = bucket;
    }

    // Attach foreign-currency conversion (or flag for review) to the same bucket.
    const meta = docMeta.get(attr.docId);
    if (meta?.currencyStatus === "needs_review") {
      needsReview.push({ docId: attr.docId, filename: attr.filename, currency: meta.foreignCurrency, amount: meta.foreignAmount });
    } else if (
      meta?.currencyStatus === "converted" &&
      meta.inrValue != null &&
      meta.foreignAmount != null &&
      meta.foreignCurrency &&
      meta.rateUsed != null &&
      meta.rateDate != null
    ) {
      foreign.foreignInvoices.push({
        docId: attr.docId,
        filename: attr.filename,
        amount: meta.foreignAmount,
        currency: meta.foreignCurrency,
        inrValue: meta.inrValue,
        rateUsed: meta.rateUsed,
        rateDate: meta.rateDate,
        rateIsNearest: meta.rateIsNearest,
      });
      foreign.foreignTotalInr += meta.inrValue;
    }
  }

  const peopleList: PersonSummary[] = Array.from(people.values())
    .map((b) => {
      const start = b.starts.length ? b.starts.slice().sort()[0] : null;
      const end = b.ends.length ? b.ends.slice().sort()[b.ends.length - 1] : null;
      return {
        name: b.name,
        personId: b.personId,
        roles: b.roles,
        isSelf: b.isSelf,
        documentCount: b.documents.length,
        dateRange: start || end ? { start: start ?? end!, end: end ?? start! } : null,
        categories: Array.from(b.categories),
        documents: b.documents,
        foreignInvoices: b.foreignInvoices,
        foreignTotalInr: Math.round(b.foreignTotalInr * 100) / 100,
      };
    })
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || b.documentCount - a.documentCount || a.name.localeCompare(b.name));

  return {
    people: peopleList,
    unidentified:
      unidentified.documents.length > 0
        ? {
            documentCount: unidentified.documents.length,
            categories: Array.from(unidentified.categories),
            documents: unidentified.documents,
            foreignInvoices: unidentified.foreignInvoices,
            foreignTotalInr: Math.round(unidentified.foreignTotalInr * 100) / 100,
          }
        : null,
    needsReview: needsReview.length > 0 ? { documentCount: needsReview.length, documents: needsReview } : null,
  };
}

function parseCache(json: string): Attribution[] | null {
  try {
    const parsed = JSON.parse(json) as Partial<CachedAttributions>;
    if (parsed && parsed.version === 2 && Array.isArray(parsed.attributions)) {
      return parsed.attributions;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read Markdown excerpts for the vault's documents, bounded for the AI. */
async function buildAiInput(): Promise<{ text: string; docs: ReturnType<typeof listDocuments> }> {
  const docs = listDocuments(MAX_DOCS);
  const used: typeof docs = [];
  const blocks: string[] = [];
  let total = 0;
  for (const doc of docs) {
    let content = "";
    try {
      content = await fs.readFile(doc.markdownPath, "utf-8");
    } catch {
      content = "";
    }
    const excerpt = content.slice(0, MAX_PER_DOC).trim();
    const index = used.length + 1;
    const block =
      `### Document ${index}\n` +
      `Filename: ${doc.originalFilename}\n` +
      `Type: ${doc.fileType}\n` +
      `Ingested: ${doc.dateIngested}\n` +
      `Content excerpt:\n${excerpt || "(no extractable content)"}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    blocks.push(block);
    total += block.length;
    used.push(doc);
  }
  return { text: blocks.join("\n"), docs: used };
}

/** Return the cached snapshot (if any) plus current fallback stats. No AI. */
export function getCachedSnapshot(): SnapshotResponse {
  seedPeopleFromExisting();
  consolidateCandidateDuplicates();
  const cache = getSnapshotCache();
  const attributions = cache ? parseCache(cache.json) : null;
  return {
    snapshot: attributions ? aggregate(attributions) : null,
    generatedAt: attributions ? (cache?.generatedAt ?? null) : null,
    fallback: buildFallback(),
  };
}

/** Re-run the AI attribution, update the cache, and return the fresh summary. */
export async function refreshSnapshot(): Promise<SnapshotResponse> {
  const fallback = buildFallback();
  const cache = getSnapshotCache();
  const previous = cache ? parseCache(cache.json) : null;

  // Empty vault: nothing to summarize — don't spend AI credits.
  if (fallback.totalDocuments === 0) {
    const now = new Date().toISOString();
    saveSnapshotCache(JSON.stringify({ version: 2, attributions: [] } satisfies CachedAttributions), now);
    return { snapshot: { people: [], unidentified: null, needsReview: null }, generatedAt: now, fallback };
  }

  const { text: documentsText, docs } = await buildAiInput();

  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema: snapshotSchema,
      system:
        "You analyze a collection of personal financial documents and attribute each one to a person. " +
        "Identify the person by their name as it appears in the document content (account holders, " +
        "signatories, addressees) — never infer a person from a filename. Only attribute a document to a " +
        "person when the content clearly names them; otherwise set person to null. Stay high-level: do not " +
        "compute balances or transaction-level detail. Never invent people, dates, or categories.",
      prompt:
        `Below are ${docs.length} documents from a personal financial vault. Return exactly one attribution ` +
        "per document (matched by its 'Document N' number), each with the person it belongs to (or null if " +
        "unattributable), a category (e.g. bank statement, tax document, investment statement, insurance, " +
        `credit card), and the period the document covers.\n\n${documentsText}`,
    });

    const raw = (object as z.infer<typeof snapshotSchema>).attributions;
    const byIndex = new Map<number, (typeof raw)[number]>();
    for (const a of raw) byIndex.set(a.documentIndex, a);

    // Resolve every input document to an attribution; anything the AI omitted
    // is kept as unidentified so per-person counts always cover the whole vault.
    const attributions: Attribution[] = docs.map((doc, i) => {
      const a = byIndex.get(i + 1);
      return {
        docId: doc.id,
        filename: doc.originalFilename,
        fileType: doc.fileType,
        person: a?.person?.trim() ? a.person.trim() : null,
        category: a?.category?.trim() ? a.category.trim() : "document",
        periodStart: a?.periodStart?.trim() || null,
        periodEnd: a?.periodEnd?.trim() || null,
      };
    });

    // Entity resolution: fold each detected name into the canonical Person
    // ontology (create/link + evidence) before caching and aggregating.
    seedPeopleFromExisting();
    for (const a of attributions) {
      if (a.person) resolvePersonForName(a.person, { docId: a.docId, filename: a.filename });
    }
    consolidateCandidateDuplicates();

    const now = new Date().toISOString();
    saveSnapshotCache(JSON.stringify({ version: 2, attributions } satisfies CachedAttributions), now);
    const snapshot = aggregate(attributions);
    logger.info("snapshot", "Generated financial snapshot", {
      people: snapshot.people.length,
      unidentified: snapshot.unidentified?.documentCount ?? 0,
    });
    return { snapshot, generatedAt: now, fallback };
  } catch (error) {
    const previousSnapshot = previous ? aggregate(previous) : null;
    if (error instanceof GlazeAIError) {
      logger.info("snapshot", "AI snapshot blocked", { state: error.state });
      return {
        snapshot: previousSnapshot,
        generatedAt: cache?.generatedAt ?? null,
        aiBlocked: error.state,
        fallback,
      };
    }
    logger.warn("snapshot", "AI snapshot failed", { error: String(error) });
    return { snapshot: previousSnapshot, generatedAt: cache?.generatedAt ?? null, error: String(error), fallback };
  }
}
