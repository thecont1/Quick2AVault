/**
 * Lexical search (work order 03 §P1).
 *
 * FTS5 over two texts per document:
 *
 *   markdown        — the READING SURFACE. What the document actually says.
 *   extraction_text — the READING. The six questions flattened into one line:
 *                     who paid whom, how much, why, when, how, with what
 *                     evidence.
 *
 * Both are indexed because they fail in opposite directions. Markdown alone
 * cannot answer "everything from Swiggy" when OCR mangled the merchant name
 * into the header; extraction alone cannot find an approval code the model
 * never bothered to record. Search scope is deliberately FINANCE-scoped:
 * prose outside the schema is indexed as markdown but never used to build
 * extraction_text, so relevance stays anchored to money.
 *
 * The index is derived data. It can always be dropped and rebuilt from
 * `documents` plus the markdown on disk — which is what rebuildSearchIndex
 * does, and why an FTS row going missing is a repairable annoyance rather
 * than data loss.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import type { ExtractionResult } from "./extraction-contract.js";

/** SHA-256 of a UTF-8 string, hex. The markdown_hash provenance primitive. */
export function hashText(s: string): string {
  return crypto.createHash("sha256").update(s, "utf-8").digest("hex");
}

/**
 * Flatten an extraction into the searchable finance line.
 *
 * Order is deliberate and matches the six questions, because this same
 * serialization is what P4 embeds — a stable field order keeps lexical and
 * semantic search describing the same thing.
 */
export function flattenExtraction(x: Partial<ExtractionResult> | null | undefined): string {
  if (!x) return "";
  const parts: string[] = [];

  const push = (v: unknown) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim();
    if (s) parts.push(s);
  };

  // who
  push(x.counterparty_descriptor);
  for (const p of x.parties ?? []) {
    push(p?.name);
    // Identifier VALUES are searchable (an email, a PAN, an account number);
    // the keys are schema noise and would pollute every document with the
    // same tokens.
    for (const v of Object.values(p?.identifiers ?? {})) push(v);
  }
  // how much
  if (typeof x.amount_minor === "number") {
    // Both forms: users type "643.72", the ledger stores 64372.
    push((x.amount_minor / 100).toFixed(2));
    push(x.amount_minor);
  }
  push(x.currency);
  // why
  push(x.purpose_text);
  push(x.category_hint);
  push(x.doc_type);
  // when
  push(x.occurred_at);
  push(x.posted_at);
  // how
  push(x.payment_rail);
  push(x.source_of_funds_text);
  push(x.destination_of_funds_text);
  push(x.direction);
  // with what evidence
  for (const v of Object.values(x.reference_ids ?? {})) push(v);
  // what is held
  for (const h of x.holdings ?? []) {
    push(h?.name);
    push(h?.isin);
  }
  push(x.notes);

  return parts.join(" · ");
}

/** Tolerant parse of a stored extraction blob. */
function parseExtraction(json: string | null | undefined): ExtractionResult | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ExtractionResult;
  } catch {
    return null;
  }
}

/**
 * Insert or replace one document's FTS row.
 *
 * FTS5 has no UPSERT, so this is delete-then-insert. Passing `undefined` for
 * a text keeps whatever is already indexed: conversion knows the markdown but
 * not the extraction, analysis knows the extraction but should not have to
 * re-read the markdown off disk.
 */
export function indexDocument(
  db: DatabaseSync,
  documentId: string,
  markdown?: string,
  extractionText?: string,
): void {
  const doc = db
    .prepare("SELECT id, original_filename, extraction_json FROM documents WHERE id=?")
    .get(documentId) as
    | { id: string; original_filename: string; extraction_json: string | null }
    | undefined;
  if (!doc) return;

  const existing = db
    .prepare("SELECT markdown, extraction_text FROM documents_fts WHERE doc_id=?")
    .get(documentId) as { markdown: string | null; extraction_text: string | null } | undefined;

  const md = markdown ?? existing?.markdown ?? "";
  const xt =
    extractionText ??
    (doc.extraction_json ? flattenExtraction(parseExtraction(doc.extraction_json)) : existing?.extraction_text ?? "");

  db.prepare("DELETE FROM documents_fts WHERE doc_id=?").run(documentId);
  db.prepare(
    "INSERT INTO documents_fts (doc_id, filename, markdown, extraction_text) VALUES (?,?,?,?)",
  ).run(documentId, doc.original_filename, md, xt);
}

export function removeFromIndex(db: DatabaseSync, documentId: string): void {
  db.prepare("DELETE FROM documents_fts WHERE doc_id=?").run(documentId);
}

export interface SearchHit {
  document_id: string;
  filename: string;
  doc_type: string | null;
  occurred_at: string | null;
  amount_minor: number | null;
  currency: string | null;
  transaction_id: string | null;
  snippet: string;
  /** FTS5 bm25 rank. More negative = better; exposed for hybrid blending. */
  rank: number;
}

/**
 * Escape a user query into a safe FTS5 MATCH expression.
 *
 * Raw user text is NOT valid FTS5 syntax: an apostrophe, a stray quote, or a
 * bare `*` raises "fts5: syntax error near ...", which would surface as a 500
 * on perfectly reasonable input like `O'Brien` or `swiggy (blr)`. Each token
 * is quoted, and a trailing `*` is added to the LAST token so search feels
 * incremental as the user types.
 */
export function toMatchQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}._@/-]+/u)
    .map((t) => t.replace(/^[._/-]+|[._/-]+$/g, ""))
    .filter(Boolean);
  if (!tokens.length) return null;
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 && t.length >= 2 ? `${quoted}*` : quoted;
    })
    .join(" AND ");
}

/**
 * Lexical search. Returns documents, each carrying the transaction it
 * evidences (when it has one) so a hit can jump straight to the evidence card.
 */
export function searchDocuments(db: DatabaseSync, q: string, limit = 25): SearchHit[] {
  const match = toMatchQuery(q);
  if (!match) return [];

  const rows = db
    .prepare(
      `SELECT f.doc_id                                   AS document_id,
              d.original_filename                        AS filename,
              d.doc_type                                 AS doc_type,
              snippet(documents_fts, 2, '«', '»', '…', 12) AS md_snippet,
              snippet(documents_fts, 3, '«', '»', '…', 12) AS x_snippet,
              rank                                       AS rank,
              (SELECT td.transaction_id FROM transaction_documents td
                WHERE td.document_id = f.doc_id LIMIT 1)  AS transaction_id
         FROM documents_fts f
         JOIN documents d ON d.id = f.doc_id
        WHERE documents_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, limit) as Array<{
    document_id: string;
    filename: string;
    doc_type: string | null;
    md_snippet: string | null;
    x_snippet: string | null;
    rank: number;
    transaction_id: string | null;
  }>;

  return rows.map((r) => {
    const txn = r.transaction_id
      ? (db
          .prepare("SELECT occurred_at, amount_minor, currency FROM transactions WHERE id=?")
          .get(r.transaction_id) as
          | { occurred_at: string; amount_minor: number; currency: string }
          | undefined)
      : undefined;
    // Prefer whichever field actually matched. A snippet with no highlight
    // marker is just the head of the text and tells the user nothing about
    // why the row is here.
    const md = r.md_snippet ?? "";
    const xt = r.x_snippet ?? "";
    const snippet = md.includes("«") ? md : xt.includes("«") ? xt : md || xt;
    return {
      document_id: r.document_id,
      filename: r.filename,
      doc_type: r.doc_type,
      occurred_at: txn?.occurred_at ?? null,
      amount_minor: txn?.amount_minor ?? null,
      currency: txn?.currency ?? null,
      transaction_id: r.transaction_id,
      snippet,
      rank: r.rank,
    };
  });
}

export interface RebuildResult {
  indexed: number;
  markdown_missing: number;
  documents: number;
}

/**
 * Drop and rebuild the whole index from `documents` + markdown on disk.
 *
 * Maintenance command AND the P1 backfill: a vault predating search has no FTS
 * rows at all, and the fix is the same operation. Markdown is NOT regenerated
 * here — retention is keep_all, so a missing file is a real anomaly worth
 * reporting rather than silently papering over with a fresh conversion that
 * might differ from the text the extraction read.
 */
export async function rebuildSearchIndex(db: DatabaseSync, ports: Ports): Promise<RebuildResult> {
  const docs = db
    .prepare("SELECT id, original_filename, markdown_path, extraction_json FROM documents")
    .all() as Array<{
    id: string;
    original_filename: string;
    markdown_path: string | null;
    extraction_json: string | null;
  }>;

  db.exec("DELETE FROM documents_fts");
  const insert = db.prepare(
    "INSERT INTO documents_fts (doc_id, filename, markdown, extraction_text) VALUES (?,?,?,?)",
  );

  let indexed = 0;
  let missing = 0;
  for (const d of docs) {
    let md = "";
    if (d.markdown_path) {
      try {
        md = await fsp.readFile(d.markdown_path, "utf-8");
      } catch {
        missing++;
        ports.logger.warn("search rebuild: markdown missing", {
          document_id: d.id,
          expected_at: d.markdown_path,
        });
      }
    }
    insert.run(d.id, d.original_filename, md, flattenExtraction(parseExtraction(d.extraction_json)));
    indexed++;
  }

  ports.logger.info("search index rebuilt", { indexed, markdown_missing: missing });
  return { indexed, markdown_missing: missing, documents: docs.length };
}
