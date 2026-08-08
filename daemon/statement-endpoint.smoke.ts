/**
 * Statement summary + drill-down HTTP endpoint (work order 04 §A.6).
 *   npx tsx daemon/statement-endpoint.smoke.ts
 *
 * statements.smoke.ts and statements-pipeline.smoke.ts test the LIBRARY and
 * the analyse job. This tests the actual HTTP route a Flutter client calls —
 * GET /v1/documents/:id/statement — against a real server, following the
 * document-file.smoke.ts pattern (createApi + fetch, not a direct db call).
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "./schema.js";
import { createApi } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";

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

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-stmt-endpoint-"));
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

const now = ports.clock.isoNow();

// A normal document (control case) — the endpoint must refuse it, not crash.
db.prepare(
  `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
   VALUES ('doc_invoice','sha1','a.pdf','/tmp/a.pdf','merchant_invoice',?)`,
).run(now);

// The statement document + two staged lines: one linked, one a gap.
db.prepare(
  `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
   VALUES ('doc_stmt','sha2','july.pdf','/tmp/july.pdf','bank_statement',?)`,
).run(now);

db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_acct','account','Test Bank ...1234','confirmed',1.0,?)`,
).run(now);
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_swiggy','organisation','Swiggy Limited','confirmed',1.0,?)`,
).run(now);

db.prepare(
  `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, counterparty_entity_id, status, confidence, created_at)
   VALUES ('txn_linked','2026-07-01','FY 2026-27',50000,'INR','out','ent_swiggy','evidenced',0.9,?)`,
).run(now);
db.prepare(
  `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, confidence, created_at)
   VALUES ('txn_gap','2026-07-05','FY 2026-27',99900,'INR','out','no_invoice',0.9,?)`,
).run(now);

db.prepare(
  `INSERT INTO statement_lines
    (id, document_id, line_no, occurred_at, raw_descriptor, amount_minor, direction, currency,
     status, transaction_id, account_entity_id, idempotency_key, created_at)
   VALUES ('stln_1','doc_stmt',1,'2026-07-01','SWIGGY BLR 080',50000,'out','INR','linked','txn_linked','ent_acct','k1',?)`,
).run(now);
db.prepare(
  `INSERT INTO statement_lines
    (id, document_id, line_no, occurred_at, raw_descriptor, amount_minor, direction, currency,
     status, transaction_id, account_entity_id, idempotency_key, created_at)
   VALUES ('stln_2','doc_stmt',2,'2026-07-05','UNKNOWN MERCHANT',99900,'out','INR','created','txn_gap','ent_acct','k2',?)`,
).run(now);

const TOKEN = "test-token-statement-endpoint";
const PORT = 47935;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault });
await api.listen();
const base = `http://127.0.0.1:${PORT}`;
const hdr = { Authorization: `Bearer ${TOKEN}` };

async function get(p: string) {
  const r = await fetch(`${base}${p}`, { headers: hdr });
  const body = await r.text();
  return { status: r.status, json: body ? JSON.parse(body) : null };
}

const normal = await get("/v1/documents/doc_invoice/statement");
check("a non-statement document is refused with 400 not_a_statement", normal.status === 400, `got ${normal.status}`);
check("the refusal names the actual doc_type", normal.json?.message?.includes("merchant_invoice") ?? false);

const missing = await get("/v1/documents/does_not_exist/statement");
check("an unknown document id is 404", missing.status === 404, `got ${missing.status}`);

const stmt = await get("/v1/documents/doc_stmt/statement");
check("a real statement document returns 200", stmt.status === 200, `got ${stmt.status}`);
check("doc_type is echoed back", stmt.json?.doc_type === "bank_statement");
check("total counts both staged lines", stmt.json?.summary?.total === 2);
check("linked count reflects the linked line", stmt.json?.summary?.linked === 1);
check("created count reflects the promoted line", stmt.json?.summary?.created === 1);
check(
  "gaps counts ONLY the created line whose transaction is no_invoice — not every 'created' line",
  stmt.json?.summary?.gaps === 1,
);
check("both lines are present in the drill-down array, in line order", stmt.json?.lines?.length === 2);
check("line 1 shows its resolved counterparty name, not just the raw descriptor", stmt.json?.lines?.[0]?.counterparty_name === "Swiggy Limited");
check("line 2 (the gap) carries its transaction_status so the client can compute isGap", stmt.json?.lines?.[1]?.transaction_status === "no_invoice");

console.log(`\n${passed} passed, ${failed} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (failed > 0) process.exit(1);
