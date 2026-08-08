/**
 * Maintenance CLI (work order 03 §P0/§P1 backfill).
 *
 *   npx tsx daemon/cli-backfill.ts --provenance   fill converter/markdown_hash
 *   npx tsx daemon/cli-backfill.ts --search       drop and rebuild the FTS index
 *   npx tsx daemon/cli-backfill.ts --all
 *
 * Both operations are idempotent and safe to re-run. Neither regenerates
 * markdown: retention is keep_all, so a missing markdown file is a real
 * anomaly worth reporting rather than papering over with a fresh conversion
 * that might differ from the text the extraction actually read.
 */
import { createPorts } from "./adapters.js";
import { openDatabase } from "./schema.js";
import { backfillProvenance } from "./pipeline.js";
import { rebuildSearchIndex } from "./search.js";

const args = process.argv.slice(2);
const all = args.includes("--all");
const wantProvenance = all || args.includes("--provenance");
const wantSearch = all || args.includes("--search");

if (!wantProvenance && !wantSearch) {
  console.log("usage: cli-backfill.ts [--provenance] [--search] [--all]");
  process.exit(1);
}

const ports = createPorts({ vaultRoot: process.env.Q2AV_VAULT, logLevel: "info" });
const db = openDatabase(ports.paths.dbPath());

console.log(`\n  vault: ${ports.paths.dbPath()}\n`);

if (wantProvenance) {
  const r = await backfillProvenance(db, ports);
  console.log("  provenance");
  console.log("  ────────────────────────────────");
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.replace(/_/g, " ").padEnd(24)} ${v}`);
  console.log();
}

if (wantSearch) {
  const r = await rebuildSearchIndex(db, ports);
  console.log("  search index");
  console.log("  ────────────────────────────────");
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.replace(/_/g, " ").padEnd(24)} ${v}`);
  console.log();
}

db.close();
