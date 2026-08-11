/**
 * WO11 Track B — lifecycle filtering acceptance tests.
 *   npx tsx daemon/lifecycle-filter.smoke.ts
 *
 * Pins the schema contract end-to-end over HTTP: a removed or deleted
 * document stops contributing to every transaction-derived surface.
 *
 * The invariants these lock:
 *   - /v1/snapshot totals, document counts and evidence counts exclude it
 *   - /v1/treemap buckets exclude it
 *   - /v1/transactions hides a transaction whose evidence is entirely
 *     removed/deleted (an evidence-less transaction stays visible)
 *   - /v1/portfolio drops a holding backed only by a removed document
 *   - /v1/documents/:id/detail answers 404 (removed) / 410 (deleted)
 *   - /v1/documents omits removed/deleted by default; ?include=removed
 *     lists the soft-hidden set
 *   - reprocess reactivates a removed document and every surface shows
 *     it again within the same refresh cycle
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openDatabase } from "./schema.js";
import { createApi } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { nullAiProvider, type MutableAiProvider } from "./ai-provider.js";

const noAi: MutableAiProvider = { ...nullAiProvider, reconfigure: () => false };

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-lifecycle-filter-"));
const rawDir = path.join(vault, "Raw");
fs.mkdirSync(rawDir, { recursive: true });
const db = openDatabase(path.join(vault, "vault.db"));
const ports: Ports = {
  logger: createLogger("error"),
  clock: systemClock,
  paths: createPaths(vault),
  converter: {
    async toMarkdown() {
      return { markdown: "# Reprocessed\n\nTotal: 100.00", converter: "plaintext", converterVersion: "test" };
    },
  },
  bus: createEventBus(createLogger("error")),
};

function seedDoc(id: string): void {
  const rawPath = path.join(rawDir, `${id}.pdf`);
  fs.writeFileSync(rawPath, `bytes-of-${id}`);
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, ".pdf", rawPath, null, null, "merchant_invoice", "2026-08-09T00:00:00.000Z");
}

function seedTxn(id: string, opts: { direction: string; amount: number; bucket?: string }) {
  db.prepare(
    `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, impact_bucket, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, "2026-08-09", "2026-27", opts.amount, "INR", opts.direction, opts.bucket ?? "groceries", "evidenced", "2026-08-09T00:00:00.000Z");
}

function link(txnId: string, docId: string, role: string) {
  db.prepare(
    `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_by, linked_at)
     VALUES (?,?,?,?,?)`,
  ).run(txnId, docId, role, "ai", "2026-08-09T00:00:00.000Z");
}

const TOKEN = "test-token-lifecycle-filter";
const PORT = 47952;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault, ai: noAi });
await api.listen();
const hdr = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function req(method: string, p: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: hdr });
  const body = await r.text();
  return { status: r.status, json: body ? JSON.parse(body) : null };
}

console.log("\n── WO11 Track B: lifecycle filtering");

// One spend backed by a document, one evidence-less transaction (a manual
// entry — it must survive filtering), and one holding backed by a document.
seedDoc("doc_spend");
seedDoc("doc_trade");
seedTxn("txn_evidenced", { direction: "out", amount: 50000 });
seedTxn("txn_manual", { direction: "out", amount: 70000 });
link("txn_evidenced", "doc_spend", "merchant_invoice");
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_sec', 'instrument', 'Test Security', 'confirmed', 1.0, '2026-08-09T00:00:00.000Z')`,
).run();
seedTxn("txn_trade", { direction: "out", amount: 90000, bucket: "investment_purchase" });
link("txn_trade", "doc_trade", "merchant_invoice");
db.prepare(
  `INSERT INTO holdings (id, transaction_id, document_id, instrument_entity_id, side, quantity, price_minor, amount_minor, occurred_at, created_at)
   VALUES ('hld_1', 'txn_trade', 'doc_trade', 'ent_sec', 'buy', 3, 3000000, 9000000, '2026-08-09', '2026-08-09T00:00:00.000Z')`,
).run();

await check("baseline: the evidenced spend is in the snapshot", async () => {
  const r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.spending_minor, 50000 + 70000, "evidenced + manual spend");
  assert.equal(r.json.spending_documents, 1);
});
await check("baseline: the treemap bucket includes the evidenced spend", async () => {
  const r = await req("GET", "/v1/treemap?period=all");
  const groceries = (r.json.nodes ?? []).find((n: { id?: string; name?: string }) => (n.id ?? n.name) === "groceries");
  assert.ok(groceries, `groceries node missing: ${JSON.stringify(r.json.nodes)}`);
  assert.equal(groceries.amount_minor, 50000 + 70000);
});
await check("baseline: both transactions are listed with evidence", async () => {
  const r = await req("GET", "/v1/transactions?limit=100");
  const ids = (r.json.transactions ?? []).map((t: { id: string }) => t.id);
  assert.ok(ids.includes("txn_evidenced") && ids.includes("txn_manual"), ids.join(","));
  const evidenced = r.json.transactions.find((t: { id: string }) => t.id === "txn_evidenced");
  assert.equal(evidenced.evidence.length, 1);
});
await check("baseline: the portfolio shows the holding", async () => {
  const r = await req("GET", "/v1/portfolio");
  assert.equal(r.json.holdings.length, 1);
});
await check("baseline: the detail endpoint serves the active document", async () => {
  const r = await req("GET", "/v1/documents/doc_spend/detail");
  assert.equal(r.status, 200);
});

// ── remove the spending evidence ────────────────────────────────────────────
await req("POST", "/v1/documents/doc_spend/remove-from-active");

await check("snapshot: removed document's transaction no longer counts", async () => {
  const r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.json.spending_minor, 70000, "only the evidence-less manual entry remains");
  assert.equal(r.json.spending_documents, 0);
  assert.equal(r.json.counts.evidence_links, 1, "the trade's link is untouched");
});
await check("treemap: the bucket shrinks by the removed document's amount", async () => {
  const r = await req("GET", "/v1/treemap?period=all");
  const groceries = (r.json.nodes ?? []).find((n: { id?: string; name?: string }) => (n.id ?? n.name) === "groceries");
  assert.equal(groceries?.amount_minor, 70000);
});
await check("transactions: the fully-removed-evidence transaction is hidden", async () => {
  const r = await req("GET", "/v1/transactions?limit=100");
  const ids = (r.json.transactions ?? []).map((t: { id: string }) => t.id);
  assert.ok(!ids.includes("txn_evidenced"), "evidence entirely removed → hidden");
  assert.ok(ids.includes("txn_manual"), "evidence-less transactions stay visible");
});
await check("detail: a removed document answers 404 document_not_available", async () => {
  const r = await req("GET", "/v1/documents/doc_spend/detail");
  assert.equal(r.status, 404);
  assert.equal(r.json?.error, "document_not_available");
  assert.equal(r.json?.lifecycle, "removed");
});
await check("list: removed is hidden by default, visible via ?include=removed", async () => {
  const plain = await req("GET", "/v1/documents?limit=100");
  const plainIds = (plain.json.documents ?? []).map((d: { id: string }) => d.id);
  assert.ok(!plainIds.includes("doc_spend"));
  const withRemoved = await req("GET", "/v1/documents?limit=100&include=removed");
  const allIds = (withRemoved.json.documents ?? []).map((d: { id: string }) => d.id);
  assert.ok(allIds.includes("doc_spend"));
});

// ── mixed evidence: some active, some removed → the transaction survives ───
seedDoc("doc_mixed_a");
seedDoc("doc_mixed_b");
seedTxn("txn_mixed", { direction: "out", amount: 30000 });
link("txn_mixed", "doc_mixed_a", "merchant_invoice");
// A document may only be evidence for ONE transaction per role — the second
// link uses a corroborating role.
db.prepare(
  `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_by, linked_at)
   VALUES ('txn_mixed', 'doc_mixed_b', 'payment_receipt', 'ai', '2026-08-09T00:00:00.000Z')`,
).run();
await req("POST", "/v1/documents/doc_mixed_b/remove-from-active");
await check("mixed evidence: the transaction stays visible and still counts", async () => {
  const txns = await req("GET", "/v1/transactions?limit=100");
  const mixed = (txns.json.transactions ?? []).find((t: { id: string }) => t.id === "txn_mixed");
  assert.ok(mixed, "a transaction with SOME active evidence must survive");
  assert.deepEqual(
    (mixed.evidence as Array<{ id: string }>).map((e) => e.id),
    ["doc_mixed_a"],
    "the evidence list shows only the active document",
  );
  const snap = await req("GET", "/v1/snapshot?period=all");
  assert.equal(snap.json.spending_minor, 70000 + 30000, "the mixed-evidence spend still counts");
});

// ── remove the trade evidence → the holding drops out of the portfolio ─────
await req("POST", "/v1/documents/doc_trade/remove-from-active");
await check("portfolio: a holding backed only by a removed document is gone", async () => {
  const r = await req("GET", "/v1/portfolio");
  assert.equal(r.json.holdings.length, 0);
  assert.equal(r.json.closed.length, 0);
});

// ── reprocess brings a removed document back, everywhere ────────────────────
await req("POST", "/v1/documents/doc_trade/reprocess");
await check("reprocess reactivates the document and its holding returns", async () => {
  const detail = await req("GET", "/v1/documents/doc_trade/detail");
  assert.equal(detail.status, 200);
  const portfolio = await req("GET", "/v1/portfolio");
  assert.equal(portfolio.json.holdings.length, 1);
  const txns = await req("GET", "/v1/transactions?limit=100");
  const ids = (txns.json.transactions ?? []).map((t: { id: string }) => t.id);
  assert.ok(ids.includes("txn_trade"), ids.join(","));
});

// ── delete permanently → 410, tombstone stays out of every surface ─────────
await req("DELETE", "/v1/documents/doc_trade");
await check("detail: a deleted document answers 410 document_deleted", async () => {
  const r = await req("GET", "/v1/documents/doc_trade/detail");
  assert.equal(r.status, 410);
  assert.equal(r.json?.error, "document_deleted");
  assert.equal(r.json?.lifecycle, "deleted");
});
await check("deleted documents never list, even with ?include=removed", async () => {
  const r = await req("GET", "/v1/documents?limit=100&include=removed");
  const ids = (r.json.documents ?? []).map((d: { id: string }) => d.id);
  assert.ok(!ids.includes("doc_trade"));
});
await check("portfolio stays empty after the delete", async () => {
  const r = await req("GET", "/v1/portfolio");
  assert.equal(r.json.holdings.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
