/**
 * Work order 07 §C2 — route contract smoke test.
 *   npx tsx daemon/route-contract.smoke.ts
 *
 * Exercises every route the Flutter client calls against a real createApi()
 * server. The goal is to catch daemon/client contract drift BEFORE it reaches
 * a user: a 404 on a route the client expects is a stale daemon, not an empty
 * vault.
 *
 * This is not a deep behaviour test — it verifies that each route EXISTS,
 * accepts the expected method, and returns a structurally valid response
 * (correct status code and JSON shape). Deep behaviour is covered by the
 * per-feature smoke tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { createApi } from "./api.js";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
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
function testPorts(vault: string): Ports {
  const logger = createLogger("error");
  return {
    logger,
    clock: systemClock,
    paths: createPaths(vault),
    converter: { async toMarkdown() { throw new Error("not used"); } },
    bus: createEventBus(logger),
  };
}

// ── seed a minimal vault so routes have something to return ──────────────
function seedVault(db: DatabaseSync, vault: string) {
  const now = "2026-08-10T00:00:00.000Z";
  // A document with a markdown file so /markdown and /pageinfo work.
  const rawDir = path.join(vault, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const mdPath = path.join(rawDir, "doc_test.md");
  fs.writeFileSync(mdPath, "# Test Invoice\n\nAmount: 1,000.00", "utf-8");
  const rawPath = path.join(rawDir, "doc_test.pdf");
  fs.writeFileSync(rawPath, "%PDF-1.4 fake", "utf-8");

  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("doc_test", "sha_doc_test", "test.pdf", rawPath, mdPath, 30, "merchant_invoice", now);

  // A person + entity so /v1/people and /v1/people/:id work.
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, is_member, is_owner, status, created_at)
     VALUES ('ent_person','person','Test Owner',1,1,'confirmed',?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO document_parties (document_id, entity_id, role) VALUES ('doc_test','ent_person','owner')`,
  ).run();

  // A transaction so /v1/transactions and /v1/transactions/:id/evidence work.
  db.prepare(
    `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, created_at)
     VALUES ('txn_test','2026-08-10','FY2026-27',100000,'INR','out','evidenced',?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_at)
     VALUES ('txn_test','doc_test','merchant_invoice',?)`,
  ).run(now);

  // An intake event so /v1/intake/recent and /v1/irrelevant work.
  db.prepare(
    `INSERT INTO intake_events (kind, filename, source, created_at, processing_state)
     VALUES ('accepted','test.pdf','folder',?,'complete')`,
  ).run(now);
  db.prepare(
    `INSERT INTO intake_events (kind, filename, source, created_at, processing_state, reason_code, reason)
     VALUES ('irrelevant','junk.txt','folder',?,'triaged','no_financial_signals','no financial-document signals')`,
  ).run(now);

  // An account entity for the statement line FK.
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, is_member, is_owner, status, created_at)
     VALUES ('ent_acct','account','Test Account',0,0,'confirmed',?)`,
  ).run(now);

  // A staged statement line so /v1/documents/:id/statement works.
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES ('doc_stmt','sha_stmt','stmt.pdf',?,?,100,'bank_statement',?)`,
  ).run(mdPath, rawPath, now);
  db.prepare(
    `INSERT INTO statement_lines (id, document_id, line_no, occurred_at, raw_descriptor, amount_minor, direction, currency, status, account_entity_id, idempotency_key, created_at)
     VALUES ('stln_1','doc_stmt',1,'2026-07-01','TEST MERCHANT',50000,'out','INR','pending','ent_acct','k1',?)`,
  ).run(now);
}

// ── start the server ─────────────────────────────────────────────────────
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-route-contract-"));
const db = freshDb();
const ports = testPorts(vault);
seedVault(db, vault);

const TOKEN = "test-token-route-contract";
const PORT = 47940;
const api = createApi(db, ports, {
  port: PORT,
  token: TOKEN,
  version: "test-2.0.0",
  buildId: "test-build-abc123",
  vaultDir: vault,
});
await api.listen();
const base = `http://127.0.0.1:${PORT}`;
const hdr = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" as const };

async function get(p: string) {
  const r = await fetch(`${base}${p}`, { headers: hdr });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: hdr,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

console.log("── Work order 07 §C2: route contract smoke test\n");

// ── health (unauthenticated) ─────────────────────────────────────────────
{
  const r = await fetch(`${base}/v1/health`);
  const j = (await r.json()) as Record<string, unknown>;
  check("GET /v1/health returns 200 with capability handshake", () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(j.api_version, "1");
    assert.strictEqual(j.build_id, "test-build-abc123");
    assert.strictEqual(typeof j.schema_version, "number");
    assert.ok(j.capabilities && typeof j.capabilities === "object");
  });
  check("health advertises the irrelevant capability (WO06 drift fix)", () => {
    assert.strictEqual((j.capabilities as Record<string, boolean>).irrelevant, true);
  });
}

// ── snapshot / periods / treemap ─────────────────────────────────────────
{
  const snap = await get("/v1/snapshot?period=fy&fy=FY2026-27");
  check("GET /v1/snapshot returns 200", () => assert.strictEqual(snap.status, 200));
}
{
  const periods = await get("/v1/periods");
  check("GET /v1/periods returns 200", () => assert.strictEqual(periods.status, 200));
}
{
  const tm = await get("/v1/treemap?period=fy&fy=FY2026-27");
  check("GET /v1/treemap returns 200", () => assert.strictEqual(tm.status, 200));
}

// ── documents ────────────────────────────────────────────────────────────
{
  const docs = await get("/v1/documents?limit=10");
  check("GET /v1/documents returns 200", () => assert.strictEqual(docs.status, 200));
}
{
  const detail = await get("/v1/documents/doc_test/detail");
  check("GET /v1/documents/:id/detail returns 200", () => assert.strictEqual(detail.status, 200));
}
{
  const md = await get("/v1/documents/doc_test/markdown");
  check("GET /v1/documents/:id/markdown returns 200", () => assert.strictEqual(md.status, 200));
}
{
  const pi = await get("/v1/documents/doc_test/pageinfo");
  check("GET /v1/documents/:id/pageinfo returns 200 or 409", () => {
    assert.ok(pi.status === 200 || pi.status === 409, `got ${pi.status}`);
  });
}
{
  const stmt = await get("/v1/documents/doc_stmt/statement");
  check("GET /v1/documents/:id/statement returns 200 for a statement doc", () => {
    assert.strictEqual(stmt.status, 200);
  });
}

// ── transactions ─────────────────────────────────────────────────────────
{
  const txns = await get("/v1/transactions?period=fy&fy=FY2026-27");
  check("GET /v1/transactions returns 200", () => assert.strictEqual(txns.status, 200));
}
{
  const ev = await get("/v1/transactions/txn_test/evidence");
  check("GET /v1/transactions/:id/evidence returns 200", () => assert.strictEqual(ev.status, 200));
}

// ── intake (WO06 routes — the drift that prompted this test) ─────────────
{
  const feed = await get("/v1/intake-feed");
  check("GET /v1/intake-feed returns 200", () => assert.strictEqual(feed.status, 200));
}
{
  const recent = await get("/v1/intake/recent?limit=50");
  check("GET /v1/intake/recent returns 200", () => assert.strictEqual(recent.status, 200));
}
{
  const irr = await get("/v1/irrelevant?limit=50");
  check("GET /v1/irrelevant returns 200 (WO06 drift fix)", () => assert.strictEqual(irr.status, 200));
}
{
  const st = await get("/v1/intake/status?limit=50");
  check("GET /v1/intake/status returns 200 (WO07 §B2)", () => assert.strictEqual(st.status, 200));
}

// ── people / aliases ─────────────────────────────────────────────────────
{
  const people = await get("/v1/people");
  check("GET /v1/people returns 200", () => assert.strictEqual(people.status, 200));
}
{
  const person = await get("/v1/people/ent_person");
  check("GET /v1/people/:id returns 200", () => assert.strictEqual(person.status, 200));
}
{
  const aliases = await get("/v1/people/ent_person/aliases");
  check("GET /v1/people/:id/aliases returns 200", () => assert.strictEqual(aliases.status, 200));
}

// ── entities / reviews ───────────────────────────────────────────────────
{
  const ent = await get("/v1/entities");
  check("GET /v1/entities returns 200", () => assert.strictEqual(ent.status, 200));
}
{
  const rev = await get("/v1/reviews");
  check("GET /v1/reviews returns 200", () => assert.strictEqual(rev.status, 200));
}

// ── search ───────────────────────────────────────────────────────────────
{
  const s = await get("/v1/search?q=test&limit=10");
  check("GET /v1/search returns 200", () => assert.strictEqual(s.status, 200));
}

// ── claims ───────────────────────────────────────────────────────────────
{
  const c = await get("/v1/transactions/txn_test/claims");
  check("GET /v1/transactions/:id/claims returns 200", () => assert.strictEqual(c.status, 200));
}
{
  const c = await get("/v1/documents/doc_test/claims");
  check("GET /v1/documents/:id/claims returns 200", () => assert.strictEqual(c.status, 200));
}

// ── audit ────────────────────────────────────────────────────────────────
{
  const a = await get("/v1/audit?subject_id=txn_test&limit=10");
  check("GET /v1/audit returns 200", () => assert.strictEqual(a.status, 200));
}

// ── settings ─────────────────────────────────────────────────────────────
{
  const s = await get("/v1/settings");
  check("GET /v1/settings returns 200", () => assert.strictEqual(s.status, 200));
}

// ── learning ─────────────────────────────────────────────────────────────
{
  const l = await get("/v1/learning");
  check("GET /v1/learning returns 200", () => assert.strictEqual(l.status, 200));
}

// ── POST routes (smoke only — just verify they exist and accept the method)
{
  const r = await call("POST", "/v1/settings", { settings: {} });
  check("POST /v1/settings returns 200", () => assert.strictEqual(r.status, 200));
}
{
  // Work order 07 §D4: provider test endpoint. With no key configured, it
  // should return 200 with a structured error, not a 500 or 404.
  const r = await call("POST", "/v1/settings/provider-test", { which: "primary" });
  check("POST /v1/settings/provider-test returns 200", () => assert.strictEqual(r.status, 200));
  check("provider-test response has structured fields", () => {
    assert.ok(r.json?.reachable !== undefined, "should have reachable field");
    assert.ok(r.json?.error, "should have error field (no key configured)");
  });
}
{
  const r = await call("POST", "/v1/learning/toggle", { enabled: false });
  check("POST /v1/learning/toggle returns 200", () => assert.strictEqual(r.status, 200));
}
{
  const r = await call("POST", "/v1/people", { display_name: "New Person" });
  check("POST /v1/people returns 200", () => assert.strictEqual(r.status, 200));
}
{
  const r = await call("POST", "/v1/intake", { filename: "test_drop.pdf" });
  check("POST /v1/intake returns 200 or 400", () => {
    assert.ok(r.status === 200 || r.status === 400, `got ${r.status}`);
  });
}

// ── authentication: a missing token must get 401, not a 404 or 500 ───────
{
  const r = await fetch(`${base}/v1/snapshot`);
  check("unauthenticated request returns 401 (not 404 or 500)", () => {
    assert.strictEqual(r.status, 401);
  });
}

// ── 404 on a truly unknown route must be a clean JSON 404 ────────────────
{
  const r = await fetch(`${base}/v1/nonexistent`, { headers: hdr });
  const j = (await r.json()) as Record<string, unknown>;
  check("unknown route returns 404 with JSON error", () => {
    assert.strictEqual(r.status, 404);
    assert.ok(j.error || j.message, "should have an error or message field");
  });
}

await api.close();
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
