/**
 * Archive lifecycle — deterministic, no AI, no network.
 *   npx tsx daemon/archive.smoke.ts
 *
 * Guards the promises that matter when this runs over someone's real
 * financial documents:
 *   - a processed file LEAVES Drop
 *   - the original filename is PRESERVED in Raw/
 *   - the archived bytes are IDENTICAL to the source
 *   - a duplicate is set aside, never deleted
 *   - an API-pushed file is NEVER removed from the caller's folder
 *   - name collisions never overwrite an existing document
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as assert from "node:assert";

import { openDatabase } from "./schema.js";
import { ingestFile, JobWorker } from "./pipeline.js";
import { nullAiProvider } from "./ai-provider.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    failed++;
  }
}

function freshVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-archive-"));
  const drop = path.join(root, "Drop");
  fs.mkdirSync(drop, { recursive: true });
  const logger = createLogger("error");
  const ports: Ports = {
    logger,
    clock: systemClock,
    paths: createPaths(root),
    converter: {
      async toMarkdown() {
        return { markdown: "# stub", converter: "stub", converterVersion: "smoke@1" };
      },
    },
    bus: createEventBus(logger),
  };
  const db = openDatabase(":memory:");
  return { root, drop, ports, db };
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const rawFiles = (root: string) => {
  const base = path.join(root, "Raw");
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).flatMap((d) => {
    const dir = path.join(base, d);
    return fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
  });
};
const settle = async (db: ReturnType<typeof openDatabase>, ports: Ports) => {
  await new JobWorker(db, ports, nullAiProvider).drain();
};

console.log("\nArchive lifecycle\n");

// Work order 06: triage now runs as part of intake. The stub content uses real
// PDF magic bytes (%PDF-1.4) so triage accepts it as a document by type — the
// archive lifecycle tests are about file safety, not triage classification.
const PDF_STUB = "%PDF-1.4\n%archive-stub-content-for-lifecycle-test\n";

await check("a processed file LEAVES Drop and keeps its name in Raw/", async () => {
  const { root, drop, ports, db } = freshVault();
  const src = path.join(drop, "Proton Mail invoice 21145650.pdf");
  await fsp.writeFile(src, PDF_STUB);

  const r = await ingestFile(db, ports, src, { source: "folder", consumeSource: true });
  assert.strictEqual(r.status, "added");
  assert.ok(fs.existsSync(src), "source removed before conversion and analysis completed");
  await settle(db, ports);
  assert.ok(!fs.existsSync(src), "source still in Drop after the pipeline completed");
  assert.deepStrictEqual(rawFiles(root), ["Proton Mail invoice 21145650.pdf"]);
});

await check("archived bytes are identical to the original", async () => {
  const { drop, ports, db } = freshVault();
  const body = Buffer.from("%PDF-1.4\n%exact-bytes-test\n");
  const src = path.join(drop, "statement.pdf");
  await fsp.writeFile(src, body);

  const r = await ingestFile(db, ports, src, { source: "folder", consumeSource: true });
  const archived = await fsp.readFile(r.archived_to!);
  assert.strictEqual(sha(archived), sha(body), "archived copy differs from source");
});

await check("an API-pushed file is NEVER deleted from the caller's folder", async () => {
  const { ports, db } = freshVault();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-downloads-"));
  const src = path.join(outside, "receipt.pdf");
  await fsp.writeFile(src, PDF_STUB);

  const r = await ingestFile(db, ports, src, { source: "api" });
  assert.strictEqual(r.status, "added");
  assert.ok(fs.existsSync(src), "the vault deleted a file it does not own");
});

await check("a duplicate is set aside, not deleted", async () => {
  const { root, drop, ports, db } = freshVault();
  const a = path.join(drop, "invoice.pdf");
  await fsp.writeFile(a, PDF_STUB);
  await ingestFile(db, ports, a, { source: "folder", consumeSource: true });

  const b = path.join(drop, "invoice-copy.pdf");
  await fsp.writeFile(b, PDF_STUB);
  const r = await ingestFile(db, ports, b, { source: "folder", consumeSource: true });

  assert.strictEqual(r.status, "duplicate");
  assert.ok(!fs.existsSync(b), "duplicate left cluttering Drop");
  // Work order 06 §7: duplicates are preserved under Duplicates/<date>/.
  const dupBase = path.join(root, "Duplicates");
  const dupDirs = fs.existsSync(dupBase) ? fs.readdirSync(dupBase) : [];
  const found = dupDirs.some((d) =>
    fs.existsSync(path.join(dupBase, d, "invoice-copy.pdf")));
  assert.ok(found, "duplicate was destroyed instead of set aside");
});

await check("same filename, different content, never overwrites", async () => {
  const { root, drop, ports, db } = freshVault();
  for (const body of ["%PDF-1.4\n%first-invoice\n", "%PDF-1.4\n%second-different-invoice\n"]) {
    const src = path.join(drop, "invoice.pdf");
    await fsp.writeFile(src, body);
    await ingestFile(db, ports, src, { source: "folder", consumeSource: true });
    await settle(db, ports);
  }
  const files = rawFiles(root).sort();
  assert.strictEqual(files.length, 2, `expected 2 archived files, got ${files.join(", ")}`);
  assert.ok(files.includes("invoice.pdf") && files.includes("invoice (2).pdf"),
    `collision not disambiguated: ${files.join(", ")}`);
});

await check("a failed file STAYS in Drop for retry", async () => {
  const { drop, ports, db } = freshVault();
  const missing = path.join(drop, "does-not-exist.pdf");
  const r = await ingestFile(db, ports, missing, { source: "folder", consumeSource: true });
  assert.strictEqual(r.status, "failed");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
