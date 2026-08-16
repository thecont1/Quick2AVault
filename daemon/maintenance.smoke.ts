/**
 * Duplicate-flush maintenance tests.
 *   npx tsx daemon/maintenance.smoke.ts
 *
 * Pins the post-resync housekeeping contract:
 *   - duplicates are grouped by content sha256, matched on disk by CONTENT
 *     (filenames may carry uniquePath " (2)" suffixes)
 *   - keep_originals deletes archived copies + intake rows, never touches
 *     documents, and creates no jobs
 *   - promote_newest additionally re-enqueues conversion (-> analysis) for
 *     every affected document
 */
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { listDuplicateGroups, flushDuplicates } from "./maintenance.js";

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

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const shaA = sha("AAA");
const shaB = sha("BBB");
const shaC = sha("CCC");

function seedDoc(db: DatabaseSync, id: string, fileSha: string, filename: string): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, fileSha, filename, `/tmp/${id}.pdf`, "merchant_invoice", "2026-08-01T00:00:00.000Z");
}

function addDup(db: DatabaseSync, filename: string, fileSha: string, when: string): void {
  db.prepare(
    `INSERT INTO intake_events (kind, filename, sha256, source, created_at, processing_state, reason_code)
     VALUES ('duplicate',?,?,?,?, 'archived', 'duplicate')`,
  ).run(filename, fileSha, when, when);
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-maint-"));
const db = openDatabase(path.join(vault, "vault.db"));
const ports = testPorts(vault);
const dupDir = path.join(vault, "Duplicates", "2026-08-10");
fs.mkdirSync(dupDir, { recursive: true });
const file = (name: string, content: string) => fs.writeFileSync(path.join(dupDir, name), content);

console.log("\n── maintenance: duplicate flush");

seedDoc(db, "doc_a", shaA, "orig-a.pdf");
seedDoc(db, "doc_b", shaB, "orig-b.pdf");
// Two copies of A (one with the uniquePath suffix), one of B, one unrelated file.
addDup(db, "fileA.pdf", shaA, "2026-08-10T00:00:00.000Z");
addDup(db, "fileA (2).pdf", shaA, "2026-08-12T00:00:00.000Z");
addDup(db, "fileB.pdf", shaB, "2026-08-13T00:00:00.000Z");
file("fileA.pdf", "AAA");
file("fileA (2).pdf", "AAA");
file("fileB.pdf", "BBB");
file("keep.pdf", "CCC");

await check("preview groups duplicates by content sha256", () => {
  const groups = listDuplicateGroups(db);
  assert.equal(groups.length, 2);
  const gA = groups.find((g) => g.sha256 === shaA)!;
  const gB = groups.find((g) => g.sha256 === shaB)!;
  assert.equal(gA.copies, 2);
  assert.equal(gB.copies, 1);
  assert.equal(gA.document_id, "doc_a");
  assert.equal(gA.original_filename, "orig-a.pdf");
});

{
  const result = await flushDuplicates(db, ports, "keep_originals");
  await check("keep_originals deletes matching files by content, keeps unrelated", async () => {
    assert.equal(result.groups, 2);
    assert.equal(result.copies, 3);
    assert.equal(result.deleted_files, 3);
    assert.ok(!fs.existsSync(path.join(dupDir, "fileA.pdf")));
    assert.ok(!fs.existsSync(path.join(dupDir, "fileA (2).pdf")));
    assert.ok(!fs.existsSync(path.join(dupDir, "fileB.pdf")));
    assert.ok(fs.existsSync(path.join(dupDir, "keep.pdf")), "unrelated file must survive");
  });
  await check("keep_originals drops duplicate intake rows but no documents/jobs", () => {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM intake_events WHERE kind='duplicate'").get()!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM documents").get()!.n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM jobs").get()!.n, 0, "no reprocessing under keep_originals");
  });
}

// Re-seed duplicates for the promote_newest pass.
addDup(db, "fileA.pdf", shaA, "2026-08-14T00:00:00.000Z");
addDup(db, "fileB.pdf", shaB, "2026-08-14T00:00:00.000Z");
file("fileA.pdf", "AAA");
file("fileB.pdf", "BBB");
{
  const result = await flushDuplicates(db, ports, "promote_newest");
  await check("promote_newest flushes copies and re-enqueues conversion for affected docs", () => {
    assert.equal(result.copies, 2);
    assert.equal(result.deleted_files, 2);
    assert.equal(result.reprocessed, 2);
    assert.ok(!fs.existsSync(path.join(dupDir, "fileA.pdf")));
    assert.ok(!fs.existsSync(path.join(dupDir, "fileB.pdf")));
    const jobs = db.prepare("SELECT document_id, phase, state FROM jobs ORDER BY id").all() as { document_id: string; phase: string; state: string }[];
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((j) => j.phase === "convert" && j.state === "pending"));
    assert.deepEqual(new Set(jobs.map((j) => j.document_id)), new Set(["doc_a", "doc_b"]));
  });
  await check("a second flush is a clean no-op", async () => {
    const again = await flushDuplicates(db, ports, "promote_newest");
    assert.equal(again.groups, 0);
    assert.equal(again.copies, 0);
    assert.equal(again.reprocessed, 0);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
