/**
 * Semantic search (work order 04 §Track B — "P4").
 *
 * Design constraints:
 *
 *   1. Corpus is SMALL (this is a personal vault, not a web index). 72 docs
 *      × 1536 dims × 8 bytes = 944KB. We load all vectors into memory and
 *      compute cosine in JS — no vector DB, no SQLite extension, no ANN
 *      index. The linear scan is O(n) and n is measured in the hundreds.
 *
 *   2. The embedding provider is OpenAI-compatible (/v1/embeddings). This
 *      is the de-facto standard: OpenRouter, Google's OpenAI-compat layer,
 *      Ollama, local models all speak it. The daemon already uses an
 *      Anthropic-compatible chat endpoint for extraction; embeddings are a
 *      DIFFERENT endpoint and often a different provider, so the config
 *      namespace is `embed.*` not `ai.*`.
 *
 *   3. Hybrid rank, not semantic-only. Lexical FTS5 catches exact reference
 *      numbers (UTR, RRN, amount strings) that embeddings blur; semantic
 *      catches "swiggy food delivery" when the document says "MEGHANA
 *      FOODS". Scores are min-max normalised within each method, then
 *      blended with a configurable α (default 0.5 = equal weight).
 *
 *   4. The text embedded is the SAME text FTS indexes: markdown (the reading
 *      surface) + flattenExtraction (the six-question summary). Same corpus,
 *      two retrieval signals — by design, not coincidence.
 */
import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { flattenExtraction, hashText, searchDocuments, type SearchHit } from "./search.js";

// ── BLOB ↔ Float64Array ────────────────────────────────────────────────────

function toBlob(vec: Float64Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function fromBlob(blob: Buffer, dims: number): Float64Array {
  // A view, not a copy — callers must not mutate.
  return new Float64Array(blob.buffer, blob.byteOffset, dims);
}

// ── Embedding provider port ────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly available: boolean;
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float64Array[]>;
}

export interface EmbedConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
export const DEFAULT_EMBED_DIMS = 1536;

/** No-op provider so the daemon runs without embeddings configured. */
export const nullEmbeddingProvider: EmbeddingProvider = {
  available: false,
  model: "(none)",
  dims: 0,
  async embed() {
    return [];
  },
};

/**
 * OpenAI-compatible embedding provider. The request/response shape is the
 * same whether the endpoint is OpenAI, OpenRouter, Google's OpenAI-compat
 * layer, or a local model — that's why a single adapter covers all of them.
 */
export function createEmbeddingProvider(cfg: EmbedConfig, logger: Ports["logger"]): EmbeddingProvider {
  const apiKey = cfg.apiKey || process.env.Q2AV_EMBED_KEY || "";
  if (!apiKey) {
    return nullEmbeddingProvider;
  }

  const baseUrl = (cfg.baseUrl || process.env.Q2AV_EMBED_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = cfg.model || process.env.Q2AV_EMBED_MODEL || DEFAULT_EMBED_MODEL;
  const dims = model.includes("3-large") ? 3072 : DEFAULT_EMBED_DIMS;

  return {
    available: true,
    model,
    dims,
    async embed(texts: string[]): Promise<Float64Array[]> {
      if (!texts.length) return [];
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          logger.error("embedding API error", { status: res.status, body: body.slice(0, 200) });
          return [];
        }
        const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
        return j.data.map((d) => Float64Array.from(d.embedding));
      } catch (err) {
        logger.error("embedding request failed", { err: (err as Error)?.message });
        return [];
      }
    },
  };
}

// ── Indexing ───────────────────────────────────────────────────────────────

/**
 * The text we embed for one document. Same two surfaces FTS indexes:
 * markdown (reading surface) + flattenExtraction (six-question summary).
 * Capped at 8000 chars to stay within typical token limits cheaply — the
 * extraction line is high-signal and fits in the first 500 chars anyway.
 */
export function embedText(markdown: string, extractionText: string): string {
  const md = markdown.slice(0, 6000);
  const xt = extractionText.slice(0, 2000);
  return `${md}\n\n---\n${xt}`;
}

/**
 * Embed one document and persist. Idempotent: if the text hash hasn't
 * changed since the last embedding for this model, skip the API call.
 */
export async function embedDocument(
  db: DatabaseSync,
  ports: Ports,
  provider: EmbeddingProvider,
  documentId: string,
  markdown: string,
  extractionText: string,
): Promise<boolean> {
  if (!provider.available) return false;

  const text = embedText(markdown, extractionText);
  const textHash = hashText(text);

  // Skip if already embedded with the same model + text hash.
  const existing = db
    .prepare("SELECT text_hash FROM document_embeddings WHERE document_id=? AND model=?")
    .get(documentId, provider.model) as { text_hash: string } | undefined;
  if (existing?.text_hash === textHash) return true;

  const vectors = await provider.embed([text]);
  if (!vectors.length) return false;

  const vec = vectors[0];
  if (vec.length !== provider.dims) {
    ports.logger.warn("embedding dimension mismatch — model changed?", {
      document_id: documentId,
      expected: provider.dims,
      got: vec.length,
    });
    return false;
  }

  const now = ports.clock.isoNow();
  db.prepare(
    `INSERT OR REPLACE INTO document_embeddings (document_id, model, dims, text_hash, embedding, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(documentId, provider.model, vec.length, textHash, toBlob(vec), now);
  return true;
}

/**
 * Backfill embeddings for all documents that have markdown but no embedding
 * for the current model. Called once after configuration, or manually via the
 * rebuild endpoint.
 */
export async function backfillEmbeddings(
  db: DatabaseSync,
  ports: Ports,
  provider: EmbeddingProvider,
): Promise<{ embedded: number; skipped: number; failed: number }> {
  if (!provider.available) return { embedded: 0, skipped: 0, failed: 0 };

  const docs = db
    .prepare(
      `SELECT d.id, d.markdown_path, d.extraction_json
         FROM documents d
        WHERE d.markdown_path IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM document_embeddings e
             WHERE e.document_id = d.id AND e.model = ?
          )`,
    )
    .all(provider.model) as Array<{
    id: string;
    markdown_path: string | null;
    extraction_json: string | null;
  }>;

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    let markdown = "";
    if (doc.markdown_path) {
      try {
        markdown = await import("node:fs/promises").then((fsp) => fsp.readFile(doc.markdown_path!, "utf-8"));
      } catch {
        failed++;
        continue;
      }
    }
    let extractionText = "";
    if (doc.extraction_json) {
      try {
        extractionText = flattenExtraction(JSON.parse(doc.extraction_json));
      } catch {
        // extraction_json is corrupt — still embed on markdown alone
      }
    }

    const ok = await embedDocument(db, ports, provider, doc.id, markdown, extractionText);
    if (ok) embedded++;
    else {
      failed++;
    }
  }

  // Count docs that had matching embeddings already as "skipped"
  const totalDocs = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE markdown_path IS NOT NULL").get() as { n: number };
  skipped = totalDocs.n - embedded - failed;

  ports.logger.info("embedding backfill complete", { embedded, skipped, failed, model: provider.model });
  return { embedded, skipped, failed };
}

// ── Semantic search ────────────────────────────────────────────────────────

/** Cosine similarity in pure JS. O(d) per pair, d=1536. */
function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Min-max normalise scores to [0, 1]. Returns a map of id → normalised score. */
function normalise(scores: Map<string, number>): Map<string, number> {
  if (scores.size === 0) return scores;
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) {
    // All identical — give them all 1.0 so they survive dedup.
    for (const [k] of scores) scores.set(k, 1);
    return scores;
  }
  for (const [k, v] of scores) scores.set(k, (v - min) / range);
  return scores;
}

export interface SemanticHit {
  document_id: string;
  score: number; // normalised cosine, [0,1]
}

/**
 * Semantic search: embed the query, cosine against all document vectors in
 * memory, return top-N. Returns [] if no embeddings exist for the model.
 */
export async function semanticSearch(
  db: DatabaseSync,
  provider: EmbeddingProvider,
  query: string,
  limit = 25,
): Promise<SemanticHit[]> {
  if (!provider.available) return [];

  const qVec = (await provider.embed([query]))[0];
  if (!qVec) return [];

  const rows = db
    .prepare("SELECT document_id, dims, embedding FROM document_embeddings WHERE model=?")
    .all(provider.model) as Array<{ document_id: string; dims: number; embedding: Buffer }>;

  if (!rows.length) return [];

  const scored: Array<{ document_id: string; score: number }> = [];
  for (const r of rows) {
    if (r.dims !== qVec.length) continue; // stale vector from a different model
    const vec = fromBlob(r.embedding, r.dims);
    scored.push({ document_id: r.document_id, score: cosine(qVec, vec) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({ document_id: s.document_id, score: s.score }));
}

// ── Hybrid search ──────────────────────────────────────────────────────────

/**
 * Hybrid search: merge lexical (FTS5 bm25) and semantic (cosine) results.
 *
 * Both score sets are min-max normalised to [0,1], then blended with α
 * (default 0.5 = equal weight). A document that appears in only one set
 * gets a 0 from the other — so a pure-lexical hit is not excluded, just
 * downweighted relative to a hit that both methods agree on.
 *
 * Returns the same SearchHit shape as lexicalSearch, enriched with the
 * hybrid score and a `methods` field showing which signals matched.
 */
export async function hybridSearch(
  db: DatabaseSync,
  ports: Ports,
  provider: EmbeddingProvider,
  query: string,
  limit = 25,
  alpha = 0.5,
): Promise<(SearchHit & { semantic_score: number; hybrid_score: number; methods: string[] })[]> {
  // Run both retrievers in parallel.
  const lexicalHits = searchDocuments(db, query, limit * 2);
  const semanticHits = await semanticSearch(db, provider, query, limit * 2);

  // Build score maps.
  const lexScores = new Map<string, number>();
  const lexHits = lexicalHits as SearchHit[];
  for (const h of lexHits) {
    // bm25 rank is negative (more negative = better). Negate so higher = better,
    // then normalise.
    lexScores.set(h.document_id, -h.rank);
  }

  const semScores = new Map<string, number>();
  for (const h of semanticHits) {
    semScores.set(h.document_id, h.score);
  }

  // Normalise both to [0,1].
  normalise(lexScores);
  normalise(semScores);

  // Merge: all document_ids seen by either method.
  const allIds = new Set<string>([...lexScores.keys(), ...semScores.keys()]);

  // For each id, look up the SearchHit (from lexical if present) and compute
  // the hybrid score.
  const lexByDoc = new Map(lexHits.map((h) => [h.document_id, h]));

  // Semantic-only hits need to be materialised from the DB.
  const semOnlyIds = [...allIds].filter((id) => !lexByDoc.has(id));
  const semOnlyDocs = semOnlyIds.length
    ? (db
        .prepare(
          `SELECT d.id AS document_id,
                  d.original_filename AS filename,
                  d.doc_type AS doc_type,
                  (SELECT td.transaction_id FROM transaction_documents td
                    WHERE td.document_id = d.id LIMIT 1) AS transaction_id
             FROM documents d
            WHERE d.id IN (${semOnlyIds.map(() => "?").join(",")})`,
        )
        .all(...semOnlyIds) as Array<{
          document_id: string;
          filename: string;
          doc_type: string | null;
          transaction_id: string | null;
        }>)
    : [];

  for (const d of semOnlyDocs) {
    const txn = d.transaction_id
      ? (db
          .prepare("SELECT occurred_at, amount_minor, currency FROM transactions WHERE id=?")
          .get(d.transaction_id) as
          | { occurred_at: string; amount_minor: number; currency: string }
          | undefined)
      : undefined;
    lexByDoc.set(d.document_id, {
      document_id: d.document_id,
      filename: d.filename,
      doc_type: d.doc_type,
      occurred_at: txn?.occurred_at ?? null,
      amount_minor: txn?.amount_minor ?? null,
      currency: txn?.currency ?? null,
      transaction_id: d.transaction_id,
      snippet: "", // no lexical snippet for semantic-only hits
      rank: 0,
    });
  }

  const results = [...allIds].map((id) => {
    const lex = lexScores.get(id) ?? 0;
    const sem = semScores.get(id) ?? 0;
    const hybrid = alpha * sem + (1 - alpha) * lex;
    const methods: string[] = [];
    if (lexScores.has(id)) methods.push("lexical");
    if (semScores.has(id)) methods.push("semantic");
    const hit = lexByDoc.get(id)!;
    return {
      ...hit,
      semantic_score: sem,
      hybrid_score: hybrid,
      methods,
    };
  });

  results.sort((a, b) => b.hybrid_score - a.hybrid_score);
  return results.slice(0, limit);
}
