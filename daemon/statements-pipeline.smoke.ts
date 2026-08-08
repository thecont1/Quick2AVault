/**
 * Pipeline integration test for statement imports (work order 04 §Track A).
 *   npx tsx daemon/statements-pipeline.smoke.ts
 *
 * Everything in statements.smoke.ts exercises the library functions directly.
 * This test exercises runAnalyseJob() itself — the actual code path a
 * dropped statement file goes through in production — with a fake AI
 * provider that returns doc_type='bank_statement' the way the real Claude
 * call eventually would, proving the pipeline wiring (not just the library)
 * takes a statement from "just analysed" to "reconciled transactions".
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import type { AiProvider } from "./ai-provider.js";
import type { ExtractionResult } from "./extraction-contract.js";
import { runAnalyseJob } from "./pipeline.js";

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

function freshDb(): DatabaseSync {
  return openDatabase(":memory:");
}
function testPorts(): Ports {
  const logger = createLogger("error");
  return {
    logger,
    clock: systemClock,
    paths: createPaths("/tmp/q2v-pipeline-stmt-test"),
    converter: { async toMarkdown() { throw new Error("not used by these tests"); } },
    bus: createEventBus(logger),
  };
}

const STATEMENT_MARKDOWN = `
# Example Bank — Savings Statement

Account Number: XXXX-XXXX-9876
Statement Period: 01-07-2026 to 31-07-2026
Opening Balance: Rs. 1,00,000.00
Closing Balance: Rs. 99,356.28

| Date | Narration | Debit | Credit | Balance |
|---|---|---|---|---|
| 01-07-2026 | SWIGGY BLR 080 | 643.72 |  | 99356.28 |
`;

async function seedAnalysableDoc(db: DatabaseSync, id: string, markdown: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q2v-stmt-pipeline-"));
  const mdPath = path.join(dir, `${id}.md`);
  await fs.writeFile(mdPath, markdown, "utf-8");
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, mdPath, markdown.length, "unknown", "2026-08-09T00:00:00.000Z");
  return mdPath;
}

function fakeStatementAi(): AiProvider {
  return {
    available: true,
    model: "fake-test-model",
    async extract(): Promise<ExtractionResult> {
      // What the real Claude call eventually returns for a statement: the
      // document-level fields are null (no single amount), doc_type
      // classifies it, and the `statement` payload is left null because
      // runAnalyseJob's statement branch re-parses the MARKDOWN itself
      // (deterministic-first) rather than trusting an AI-populated array.
      return {
        doc_type: "bank_statement",
        occurred_at: null,
        posted_at: null,
        amount_minor: null,
        currency: "INR",
        direction: null,
        payment_rail: null,
        parties: [],
        reference_ids: {},
        counterparty_descriptor: null,
        source_of_funds_text: "Example Bank Savings ...9876",
        destination_of_funds_text: null,
        purpose_text: null,
        category_hint: null,
        is_wallet_topup: false,
        confidence: 0.9,
        notes: null,
        statement: null,
      };
    },
  };
}

console.log("── runAnalyseJob() statement branch (pipeline wiring, not just the library)");

await check("a bank_statement document is staged and reconciled via the real analyse job", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeStatementAi();

  const docId = "doc_stmt_pipeline";
  await seedAnalysableDoc(db, docId, STATEMENT_MARKDOWN);

  await runAnalyseJob(db, ports, ai, docId);

  const doc = db.prepare("SELECT doc_type, analysed_at FROM documents WHERE id=?").get(docId) as {
    doc_type: string;
    analysed_at: string | null;
  };
  assert.equal(doc.doc_type, "bank_statement", "doc_type recorded on the document");
  assert.ok(doc.analysed_at, "document is marked analysed");

  const lines = db.prepare("SELECT COUNT(*) n FROM statement_lines WHERE document_id=?").get(docId) as {
    n: number;
  };
  assert.equal(lines.n, 1, "the one line in the fixture markdown was staged by the PIPELINE, not a direct library call");

  const txns = (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
  assert.equal(txns, 1, "the unmatched line was promoted — the gap case, since nothing else exists yet");

  const txn = db.prepare("SELECT status, amount_minor, direction FROM transactions").get() as {
    status: string;
    amount_minor: number;
    direction: string;
  };
  assert.equal(txn.status, "no_invoice");
  assert.equal(txn.amount_minor, 64372);
  assert.equal(txn.direction, "out");
});

await check("re-running the analyse job on the SAME document does not double-stage or double-count", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeStatementAi();

  const docId = "doc_stmt_rerun";
  await seedAnalysableDoc(db, docId, STATEMENT_MARKDOWN);

  await runAnalyseJob(db, ports, ai, docId);
  await runAnalyseJob(db, ports, ai, docId);

  const lines = (db.prepare("SELECT COUNT(*) n FROM statement_lines WHERE document_id=?").get(docId) as {
    n: number;
  }).n;
  assert.equal(lines, 1, "idempotency key prevents the second analyse pass from staging a duplicate");

  const txns = (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
  assert.equal(txns, 1, "still exactly one transaction — no double-count from re-analysis");
});

await check("a merchant_invoice document (the normal, non-statement path) is completely unaffected", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai: AiProvider = {
    available: true,
    model: "fake",
    async extract(): Promise<ExtractionResult> {
      return {
        doc_type: "merchant_invoice",
        occurred_at: "2026-07-01",
        posted_at: null,
        amount_minor: 64372,
        currency: "INR",
        direction: "out",
        payment_rail: "card",
        parties: [{ name: "Swiggy Limited", kind: "organisation", role: "counterparty" }],
        reference_ids: {},
        counterparty_descriptor: "SWIGGY BLR 080",
        source_of_funds_text: null,
        destination_of_funds_text: null,
        purpose_text: "food delivery",
        category_hint: "food_delivery",
        is_wallet_topup: false,
        confidence: 0.95,
        notes: null,
      };
    },
  };

  const docId = "doc_invoice_control";
  await seedAnalysableDoc(db, docId, "# irrelevant markdown for a normal invoice\n");
  await runAnalyseJob(db, ports, ai, docId);

  const txns = (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
  assert.equal(txns, 1, "the ordinary single-document path still records exactly one transaction");
  const lines = (db.prepare("SELECT COUNT(*) n FROM statement_lines").get() as { n: number }).n;
  assert.equal(lines, 0, "the statement branch must never fire for a normal document");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
