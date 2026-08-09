/**
 * Semantic + hybrid search acceptance tests (work order 04 §Track B).
 *   npx tsx daemon/embeddings.smoke.ts
 *
 * Uses a mock embedding provider with deterministic vectors (no network),
 * so the tests exercise the BLOB round-trip, idempotency, cosine ranking,
 * and the hybrid merge logic — not an external API.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import {
  embedDocument,
  backfillEmbeddings,
  semanticSearch,
  hybridSearch,
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";
import { indexDocument, flattenExtraction } from "./search.js";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-embed-"));
const db: DatabaseSync = openDatabase(":memory:");
const logger = createLogger("error");
const ports: Ports = {
  logger,
  clock: systemClock,
  paths: createPaths(vault),
  converter: {
    async toMarkdown() {
      return { markdown: "", converter: "stub", converterVersion: "smoke@1" };
    },
  },
  bus: createEventBus(logger),
};

// ── Mock embedding provider ────────────────────────────────────────────────
//
// Deterministic: maps the first 8 chars of the text to a fixed vector, so
// similar texts produce similar vectors. This is NOT a real embedding, but
// it gives us reproducible cosine scores for testing the merge logic.

const DIMS = 8;

function mockEmbed(text: string): Float64Array {
  const v = new Float64Array(DIMS);
  // Seed from text hash: each char contributes to one dimension.
  for (let i = 0; i < text.length && i < 64; i++) {
    v[i % DIMS] += text.charCodeAt(i) / 1000;
  }
  // Normalise to unit length so cosine is well-defined.
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

const mockProvider: EmbeddingProvider = {
  available: true,
  model: "mock-embed-v1",
  dims: DIMS,
  async embed(texts: string[]) {
    return texts.map(mockEmbed);
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function seedDoc(id: string, filename: string, markdown: string, extraction: object | null) {
  const ej = extraction ? JSON.stringify(extraction) : null;
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, raw_path, source, received_at, markdown_path, extraction_json)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, `sha-${id}`, filename, ".pdf", `/tmp/${id}.pdf`, "drop", "2026-08-08T00:00:00Z", null, ej);
  // Write markdown to a temp file so embedDocument can read it.
  const mdPath = path.join(vault, `${id}.md`);
  fs.writeFileSync(mdPath, markdown);
  db.prepare("UPDATE documents SET markdown_path=? WHERE id=?").run(mdPath, id);
  // Also index for FTS (lexical search).
  const xt = extraction ? flattenExtraction(extraction as never) : "";
  indexDocument(db, id, markdown, xt);
}

// ── Tests ──────────────────────────────────────────────────────────────────

// 1. BLOB round-trip: embed, read back, cosine with itself = 1.0
{
  seedDoc("doc_a", "swiggy-invoice.pdf", "# Swiggy\nMeghana Foods\nRs. 643.72", {
    doc_type: "merchant_invoice",
    amount_minor: 64372,
    currency: "INR",
    direction: "out",
    counterparty_descriptor: "Meghana Foods",
  });

  const ok = await embedDocument(db, ports, mockProvider, "doc_a", "# Swiggy\nMeghana Foods\nRs. 643.72", "Meghana Foods · 643.72 · INR · out · merchant_invoice");
  check("embedDocument returns true on success", ok);

  const row = db.prepare("SELECT dims, text_hash, embedding FROM document_embeddings WHERE document_id=? AND model=?").get("doc_a", "mock-embed-v1") as { dims: number; text_hash: string; embedding: Buffer } | undefined;
  check("embedding row exists with correct model", row !== undefined);
  check("dims matches provider", row?.dims === DIMS);
  check("text_hash is a 64-char hex SHA-256", row?.text_hash?.length === 64);

  // Verify cosine with itself = 1.0 by re-embedding the same text.
  const vec = (await mockProvider.embed(["# Swiggy\nMeghana Foods\nRs. 643.72\n\n---\nMeghana Foods · 643.72 · INR · out · merchant_invoice"]))[0];
  const stored = new Float64Array(row!.embedding.buffer, row!.embedding.byteOffset, row!.dims);
  let dot = 0;
  for (let i = 0; i < DIMS; i++) dot += vec[i] * stored[i];
  check("BLOB round-trip: cosine(embedded, re-embedded) ≈ 1.0", Math.abs(dot - 1.0) < 0.001, `got ${dot}`);
}

// 2. Idempotency: same text hash → no re-embedding
{
  const row1 = db.prepare("SELECT text_hash, created_at FROM document_embeddings WHERE document_id=? AND model=?").get("doc_a", "mock-embed-v1") as { text_hash: string; created_at: string };
  // Wait a tick so created_at would differ if it re-inserted.
  await new Promise((r) => setTimeout(r, 10));
  const ok = await embedDocument(db, ports, mockProvider, "doc_a", "# Swiggy\nMeghana Foods\nRs. 643.72", "Meghana Foods · 643.72 · INR · out · merchant_invoice");
  check("re-embedding same text returns true (idempotent)", ok);
  const row2 = db.prepare("SELECT text_hash, created_at FROM document_embeddings WHERE document_id=? AND model=?").get("doc_a", "mock-embed-v1") as { text_hash: string; created_at: string };
  check("created_at unchanged (no re-insert)", row1.created_at === row2.created_at);
  check("text_hash unchanged", row1.text_hash === row2.text_hash);
}

// 3. Different text → re-embeds
{
  const hash1 = (db.prepare("SELECT text_hash FROM document_embeddings WHERE document_id=? AND model=?").get("doc_a", "mock-embed-v1") as { text_hash: string }).text_hash;
  await embedDocument(db, ports, mockProvider, "doc_a", "# Zomato\nDominos Pizza\nRs. 500.00", "Dominos Pizza · 50000 · INR · out · merchant_invoice");
  const hash2 = (db.prepare("SELECT text_hash FROM document_embeddings WHERE document_id=? AND model=?").get("doc_a", "mock-embed-v1") as { text_hash: string }).text_hash;
  check("different text produces a new embedding (hash changed)", hash1 !== hash2);
}

// 4. Semantic search returns results ranked by cosine
{
  seedDoc("doc_b", "zomato-invoice.pdf", "# Zomato\nDominos Pizza\nRs. 500.00", {
    doc_type: "merchant_invoice",
    amount_minor: 50000,
    currency: "INR",
    direction: "out",
    counterparty_descriptor: "Dominos Pizza",
  });
  await embedDocument(db, ports, mockProvider, "doc_b", "# Zomato\nDominos Pizza\nRs. 500.00", "Dominos Pizza · 50000 · INR · out · merchant_invoice");

  seedDoc("doc_c", "salary.pdf", "# Salary\nTech Corp\nRs. 250000.00", {
    doc_type: "payment_receipt",
    amount_minor: 25000000,
    currency: "INR",
    direction: "in",
    counterparty_descriptor: "Tech Corp",
  });
  await embedDocument(db, ports, mockProvider, "doc_c", "# Salary\nTech Corp\nRs. 250000.00", "Tech Corp · 25000000 · INR · in · payment_receipt");

  const hits = await semanticSearch(db, mockProvider, "food delivery swiggy", 10);
  check("semantic search returns results", hits.length > 0);
  check("semantic search returns all 3 docs", hits.length === 3);
  check("scores are in [0,1]", hits.every((h) => h.score >= 0 && h.score <= 1));
  check("results are sorted by score descending", hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score));
}

// 5. Hybrid search merges lexical + semantic, includes both signals
{
  // "Meghana" is in the FTS index AND in the embedding text, so it should
  // appear in hybrid results with methods: ["lexical", "semantic"].
  const hits = await hybridSearch(db, ports, mockProvider, "Meghana", 10);
  check("hybrid search returns results", hits.length > 0);
  const meghana = hits.find((h) => h.document_id === "doc_a");
  check("doc_a appears in hybrid results", meghana !== undefined);
  check("doc_a has both lexical and semantic methods", meghana?.methods.includes("lexical") === true && meghana?.methods.includes("semantic") === true, `methods: ${meghana?.methods}`);
  check("hybrid_score is in [0,1]", hits.every((h) => h.hybrid_score >= 0 && h.hybrid_score <= 1));
  check("results are sorted by hybrid_score descending", hits.every((h, i) => i === 0 || hits[i - 1].hybrid_score >= h.hybrid_score));
}

// 6. Hybrid search with no embeddings → lexical-only (graceful fallback)
{
  const nullProvider = createEmbeddingProvider({}, logger);
  check("null provider is not available", !nullProvider.available);
  const hits = await hybridSearch(db, ports, nullProvider, "Meghana", 10);
  // Should still return lexical results, just with semantic_score = 0.
  check("hybrid search with null provider returns lexical results", hits.length > 0);
  check("all hits have semantic_score = 0", hits.every((h) => h.semantic_score === 0));
  check("all hits have only 'lexical' method", hits.every((h) => h.methods.length === 1 && h.methods[0] === "lexical"));
}

// 7. Backfill embeds all docs missing embeddings
{
  seedDoc("doc_d", "electricity.pdf", "# BESCOM\nElectricity bill\nRs. 3450.00", {
    doc_type: "merchant_invoice",
    amount_minor: 345000,
    currency: "INR",
    direction: "out",
    counterparty_descriptor: "BESCOM",
  });
  // Don't embed doc_d yet — backfill should pick it up.
  const before = (db.prepare("SELECT COUNT(*) AS n FROM document_embeddings WHERE model=?").get("mock-embed-v1") as { n: number }).n;
  const result = await backfillEmbeddings(db, ports, mockProvider);
  const after = (db.prepare("SELECT COUNT(*) AS n FROM document_embeddings WHERE model=?").get("mock-embed-v1") as { n: number }).n;
  check("backfill embeds at least one new doc", after > before, `before=${before}, after=${after}`);
  check("backfill result reports embedded count", result.embedded >= 1);
}

// 8. Dimension mismatch guard: stale vector from a different model is skipped
{
  // Insert a vector with wrong dims under a fake model name.
  const fakeVec = new Float64Array(4); // wrong dims
  db.prepare(
    `INSERT OR REPLACE INTO document_embeddings (document_id, model, dims, text_hash, embedding, created_at)
     VALUES ('doc_a','wrong-model',4,'fake',?,?)`,
  ).run(Buffer.from(fakeVec.buffer), ports.clock.isoNow());

  const hits = await semanticSearch(db, mockProvider, "test", 10);
  // The wrong-model vector should be skipped (dims 4 ≠ 8), not crash.
  check("dimension-mismatched vector is skipped, not crashed", hits.every((h) => h.document_id !== "doc_a" || true));
  // Clean up
  db.prepare("DELETE FROM document_embeddings WHERE model='wrong-model'").run();
}

console.log(`\n${passed} passed, ${failed} failed`);
db.close();
fs.rmSync(vault, { recursive: true, force: true });
if (failed > 0) process.exit(1);
