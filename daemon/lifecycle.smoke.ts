/**
 * WO09/WO10 P4.5 — document lifecycle acceptance tests.
 *   npx tsx daemon/lifecycle.smoke.ts
 *
 * Pins the three verbs behind the Glaze detail footer end-to-end over HTTP:
 *   POST   /v1/documents/:id/reprocess          re-converts then re-analyses, reactivates
 *   POST   /v1/documents/:id/remove-from-active  soft-hide, file + claims kept
 *   DELETE /v1/documents/:id                     permanent, bytes unlinked, tombstoned
 *
 * The invariants these lock:
 *   - the Review list (/v1/documents) shows ONLY active documents
 *   - remove is reversible and preserves the original file on disk
 *   - delete unlinks the raw bytes but the sha256 dedupe guard still holds
 *   - reprocess drains through the real JobWorker without a second economic event
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createApi } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { nullAiProvider, type MutableAiProvider } from "./ai-provider.js";
import { JobWorker } from "./pipeline.js";

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
    // A converter that always yields a little markdown, so the reprocess
    // chain's convert leg succeeds deterministically.
    converter: { async toMarkdown() { return { markdown: "# Reprocessed\n\nTotal: 100.00", converter: "plaintext", converterVersion: "test" }; } },
    bus: createEventBus(logger),
  };
}

// A deterministic AI that produces one simple invoice extraction, so the
// analyse leg of a reprocess exercises the real job path without a network call.
const fakeAi: MutableAiProvider = {
  available: true,
  model: "test",
  reconfigure() { return true; },
  async extract() {
    return {
      doc_type: "merchant_invoice",
      occurred_at: "2026-08-01",
      posted_at: "2026-08-01",
      amount_minor: 10000,
      currency: "INR",
      direction: "out",
      payment_rail: null,
      parties: [],
    } as never;
  },
};

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-lifecycle-"));
const rawDir = path.join(vault, "Raw");
fs.mkdirSync(rawDir, { recursive: true });
const db = openDatabase(path.join(vault, "vault.db"));
const ports = testPorts(vault);

function seedDoc(id: string, opts: { markdown?: boolean } = {}): { rawPath: string; mdPath: string | null } {
  const rawPath = path.join(rawDir, `${id}.pdf`);
  fs.writeFileSync(rawPath, `bytes-of-${id}`);
  let mdPath: string | null = null;
  if (opts.markdown) {
    mdPath = path.join(rawDir, `${id}.md`);
    fs.writeFileSync(mdPath, "# Doc\n\nTotal: 100.00");
  }
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    `sha_${id}`,
    `${id}.pdf`,
    ".pdf",
    rawPath,
    mdPath,
    mdPath ? 20 : null,
    "merchant_invoice",
    "2026-08-09T00:00:00.000Z",
  );
  return { rawPath, mdPath };
}

const TOKEN = "test-token-lifecycle";
const PORT = 47951;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault, ai: fakeAi });
await api.listen();
const hdr = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function req(method: string, p: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: hdr });
  const body = await r.text();
  return { status: r.status, json: body ? JSON.parse(body) : null };
}
async function listIds(): Promise<string[]> {
  const r = await req("GET", "/v1/documents?limit=200");
  return (r.json?.documents ?? []).map((d: { id: string }) => d.id);
}

console.log("\n── P4.5: document lifecycle (Glaze manage footer)");

const a = seedDoc("doc_active_A", { markdown: true });
seedDoc("doc_remove_B", { markdown: true });
const c = seedDoc("doc_delete_C", { markdown: true });

await check("all three seeded documents start active and are listed", async () => {
  const ids = await listIds();
  assert.ok(ids.includes("doc_active_A") && ids.includes("doc_remove_B") && ids.includes("doc_delete_C"), ids.join(","));
});

// ── remove-from-active ──────────────────────────────────────────────────────
const removeRes = await req("POST", "/v1/documents/doc_remove_B/remove-from-active");
await check("remove-from-active returns 200 {removed:true}", () => {
  assert.equal(removeRes.status, 200);
  assert.equal(removeRes.json?.removed, true);
});
await check("a removed document disappears from the Review list", async () => {
  const ids = await listIds();
  assert.ok(!ids.includes("doc_remove_B"), ids.join(","));
});
await check("remove preserves the original file and the row (soft state)", () => {
  const row = db.prepare("SELECT lifecycle, raw_path FROM documents WHERE id=?").get("doc_remove_B") as { lifecycle: string; raw_path: string };
  assert.equal(row.lifecycle, "removed");
  assert.ok(fs.existsSync(row.raw_path), "the original file must remain on disk");
});

// ── reprocess reactivates a removed document ────────────────────────────────
const reproRes = await req("POST", "/v1/documents/doc_remove_B/reprocess");
await check("reprocess of a removed doc returns 200 and reactivates it", async () => {
  assert.equal(reproRes.status, 200);
  assert.equal(reproRes.json?.reprocessing, true);
  assert.equal(reproRes.json?.phase, "convert");
  const row = db.prepare("SELECT lifecycle FROM documents WHERE id=?").get("doc_remove_B") as { lifecycle: string };
  assert.equal(row.lifecycle, "active");
});
await check("reprocess enqueues a convert job, never analyse-only", async () => {
  const job = db
    .prepare("SELECT phase, state FROM jobs WHERE document_id=? ORDER BY id DESC LIMIT 1")
    .get("doc_remove_B") as { phase: string; state: string } | undefined;
  assert.ok(job, "a job row must exist after reprocess");
  assert.equal(job!.phase, "convert", "reprocess must start from the original bytes");
  assert.equal(job!.state, "pending");
});
await check("reprocess drains the full convert→analyse chain to done", async () => {
  const worker = new JobWorker(db, ports, nullAiProvider);
  for (let i = 0; i < 6; i++) {
    const job = db
      .prepare("SELECT state FROM jobs WHERE document_id=? ORDER BY id DESC LIMIT 1")
      .get("doc_remove_B") as { state: string } | undefined;
    if (job?.state === "done") break;
    await worker.tick();
  }
  const jobs = db
    .prepare("SELECT phase, state FROM jobs WHERE document_id=? ORDER BY id DESC")
    .all("doc_remove_B") as { phase: string; state: string }[];
  assert.ok(jobs.length >= 2, "convert and analyse jobs must both exist");
  assert.equal(jobs[0]!.phase, "analyse", "analysis must be the last leg of the chain");
  assert.ok(jobs.every((j) => j.state === "done"), jobs.map((j) => `${j.phase}:${j.state}`).join(","));
});
await check("reprocess re-converts the markdown from the original bytes", () => {
  const row = db.prepare("SELECT markdown_path FROM documents WHERE id=?").get("doc_remove_B") as { markdown_path: string };
  assert.ok(row.markdown_path, "markdown_path must exist after re-conversion");
  assert.ok(fs.readFileSync(row.markdown_path, "utf-8").includes("Reprocessed"), "the converter must have re-run");
});
await check("a reactivated document is listed again", async () => {
  const ids = await listIds();
  assert.ok(ids.includes("doc_remove_B"), ids.join(","));
});

// ── delete permanently ──────────────────────────────────────────────────────
await check("the file to be deleted exists before deletion", () => {
  assert.ok(fs.existsSync(c.rawPath));
});
const delRes = await req("DELETE", "/v1/documents/doc_delete_C");
await check("DELETE returns 200 {deleted:true}", () => {
  assert.equal(delRes.status, 200);
  assert.equal(delRes.json?.deleted, true);
});
await check("delete unlinks the raw bytes from disk", () => {
  assert.ok(!fs.existsSync(c.rawPath), "raw file should be gone");
});
await check("delete tombstones the row but keeps the sha256 dedupe guard", () => {
  const row = db.prepare("SELECT lifecycle, sha256, raw_path FROM documents WHERE id=?").get("doc_delete_C") as { lifecycle: string; sha256: string; raw_path: string };
  assert.equal(row.lifecycle, "deleted");
  assert.equal(row.sha256, "sha_doc_delete_C", "sha256 must survive so a re-drop is still rejected");
  assert.equal(row.raw_path, "", "disk pointer cleared");
});
await check("a deleted document is not listed", async () => {
  const ids = await listIds();
  assert.ok(!ids.includes("doc_delete_C"), ids.join(","));
});
await check("deleting an already-deleted document is idempotent", async () => {
  const again = await req("DELETE", "/v1/documents/doc_delete_C");
  assert.equal(again.status, 200);
  assert.equal(again.json?.deleted, true);
});
await check("reprocess of a deleted document is refused (409)", async () => {
  const r = await req("POST", "/v1/documents/doc_delete_C/reprocess");
  assert.equal(r.status, 409);
});

// ── reprocess restores a deleted document whose bytes survived on disk ──
// DELETE unlinks the vault bytes, but documents deleted before that guard
// (or with a file restored manually) still have the original on disk.
// Reprocessing such a document must restore it from those bytes; the 409
// guard above only applies when the bytes are genuinely gone.
const survivorPath = path.join(rawDir, "doc_delete_C.pdf");
fs.writeFileSync(survivorPath, "bytes-of-doc_delete_C-survivor");
// The restore now VERIFIES the candidate's sha256 against the document —
// align the document's hash with the surviving bytes so the restore is
// provable, exactly like a real legacy deletion whose bytes match.
db.prepare("UPDATE documents SET sha256=? WHERE id=?").run(
  crypto.createHash("sha256").update("bytes-of-doc_delete_C-survivor").digest("hex"),
  "doc_delete_C",
);
const restoreRes = await req("POST", "/v1/documents/doc_delete_C/reprocess");
await check("reprocess of a deleted doc with surviving bytes restores it", () => {
  assert.equal(restoreRes.status, 200);
  assert.equal(restoreRes.json?.reprocessing, true);
  assert.equal(restoreRes.json?.restored, true);
  const row = db.prepare("SELECT lifecycle, raw_path FROM documents WHERE id=?").get("doc_delete_C") as { lifecycle: string; raw_path: string };
  assert.equal(row.lifecycle, "active");
  assert.equal(row.raw_path, survivorPath, "the raw pointer must be repointed at the recovered file");
});
await check("a restored document is listed again", async () => {
  const ids = await listIds();
  assert.ok(ids.includes("doc_delete_C"), ids.join(","));
});

// ── unknown ids ─────────────────────────────────────────────────────────────
await check("lifecycle verbs 404 on an unknown document", async () => {
  const r1 = await req("POST", "/v1/documents/nope/remove-from-active");
  const r2 = await req("POST", "/v1/documents/nope/reprocess");
  const r3 = await req("DELETE", "/v1/documents/nope");
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
  assert.equal(r3.status, 404);
});

await check("the untouched active document is still listed throughout", async () => {
  const ids = await listIds();
  assert.ok(ids.includes("doc_active_A"), ids.join(","));
  assert.ok(fs.existsSync(a.rawPath));
});

console.log(`\n${pass} passed, ${fail} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
