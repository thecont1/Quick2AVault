/**
 * Document file serving must never escape the vault.
 *
 * /v1/documents/<id>/file reads bytes off disk using raw_path from the DB. That
 * column is normally written by our own intake, but it must not be TRUSTED: a
 * restored backup from another machine, a poisoned extraction, or a hand-edited
 * row would otherwise turn this route into an arbitrary-file-read primitive
 * against anything the daemon's uid can read.
 *
 * These tests write hostile raw_path values directly and assert the route
 * refuses them.
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

// A throwaway vault with one real file inside and one secret outside.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-traversal-"));
const vault = path.join(root, "vault");
const raw = path.join(vault, "raw");
fs.mkdirSync(raw, { recursive: true });

const inside = path.join(raw, "legit.pdf");
fs.writeFileSync(inside, "%PDF-1.4\nlegit\n%%EOF\n");

// The thing an attacker wants. Outside the vault, readable by this uid.
const secret = path.join(root, "SECRET.txt");
fs.writeFileSync(secret, "sk-live-do-not-leak\n");

const db: DatabaseSync = openDatabase(":memory:");
const logger = createLogger("error");
const ports: Ports = {
  logger,
  clock: systemClock,
  paths: createPaths(vault),
  converter: { async toMarkdown() { return ""; } },
  bus: createEventBus(logger),
};

function seedDoc(id: string, rawPath: string) {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, raw_path, source,
                            received_at, byte_size)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, `sha-${id}`, path.basename(rawPath), ".pdf", rawPath, "drop",
    "2026-08-08T00:00:00.000Z", 20);
}

seedDoc("doc-inside", inside);
seedDoc("doc-absolute", secret);
seedDoc("doc-dotdot", path.join(vault, "raw", "..", "..", "SECRET.txt"));
// A path that merely STARTS with the vault string but is a different directory:
// naive `startsWith(vaultRoot)` without the separator lets this through.
const sibling = `${vault}-evil`;
fs.mkdirSync(sibling, { recursive: true });
const siblingFile = path.join(sibling, "SECRET.txt");
fs.writeFileSync(siblingFile, "also-secret\n");
seedDoc("doc-sibling", siblingFile);

const TOKEN = "test-token";
// A fixed high port: api.listen() resolves void, so an ephemeral port cannot
// be read back from the server handle.
const PORT = 47931;
const api = createApi(db, ports, {
  port: PORT,
  token: TOKEN,
  version: "test",
  vaultDir: vault,
});

await api.listen();
const base = `http://127.0.0.1:${PORT}`;
const hdr = { Authorization: `Bearer ${TOKEN}` };

async function get(p: string) {
  const r = await fetch(`${base}${p}`, { headers: hdr });
  const body = await r.text();
  return { status: r.status, body };
}

// 1. The legitimate case must still work, or the guard is useless.
const okRes = await get("/v1/documents/doc-inside/file");
check("a document inside the vault is served", okRes.status === 200,
  `got ${okRes.status}`);
check("the served bytes are the file's", okRes.body.includes("legit"),
  JSON.stringify(okRes.body.slice(0, 40)));

// 2. Absolute path outside the vault.
const abs = await get("/v1/documents/doc-absolute/file");
check("an absolute path outside the vault is refused", abs.status === 403,
  `got ${abs.status}`);
check("the secret never appears in the response",
  !abs.body.includes("sk-live-do-not-leak"));

// 3. Traversal via '..' that resolves outside.
const dots = await get("/v1/documents/doc-dotdot/file");
check("a '..' traversal is refused", dots.status === 403, `got ${dots.status}`);
check("the secret never leaks via traversal",
  !dots.body.includes("sk-live-do-not-leak"));

// 4. Sibling directory sharing the vault's name prefix.
const sib = await get("/v1/documents/doc-sibling/file");
check("a sibling dir with the vault's name prefix is refused",
  sib.status === 403,
  `got ${sib.status} — startsWith() without a separator lets this through`);
check("the sibling secret never leaks", !sib.body.includes("also-secret"));

// 5. Unknown id is a 404, distinct from a 403.
const missing = await get("/v1/documents/no-such-doc/file");
check("an unknown document id is 404", missing.status === 404,
  `got ${missing.status}`);

// 6. A row whose file has been deleted is 410, not 500 — different remedy.
const gone = path.join(raw, "deleted.pdf");
fs.writeFileSync(gone, "x");
seedDoc("doc-gone", gone);
fs.unlinkSync(gone);
const goneRes = await get("/v1/documents/doc-gone/file");
check("a missing file is 410, not a crash", goneRes.status === 410,
  `got ${goneRes.status}`);

await api.close();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
