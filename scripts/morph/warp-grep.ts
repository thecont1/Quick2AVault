#!/usr/bin/env tsx
/**
 * WarpGrep — Morph's codebase search subagent.
 *
 * Searches the local repo for a natural-language query in a separate context
 * window, keeping your main dev session clean. Requires ripgrep.
 *
 * Usage:
 *   npm run morph:search -- --query "how does X work"
 *   npx tsx scripts/morph/warp-grep.ts --query "where is OAuth configured"
 *
 * Requires: MORPH_API_KEY env var. `brew install ripgrep` if not present.
 */
import { MorphClient } from "@morphllm/morphsdk";
import * as path from "node:path";
import * as process from "node:process";

function parseArgs(argv: string[]): { query?: string; repoRoot: string } {
  const out: { query?: string; repoRoot: string } = { repoRoot: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--query" || argv[i] === "-q") out.query = argv[++i];
    else if (argv[i] === "--repo" || argv[i] === "-r") out.repoRoot = argv[++i];
  }
  return out;
}

async function main() {
  const { query, repoRoot } = parseArgs(process.argv);
  if (!query) {
    console.error("Usage: tsx scripts/morph/warp-grep.ts --query <question>");
    process.exit(1);
  }

  const morph = new MorphClient({ apiKey: process.env.MORPH_API_KEY });
  const absRepo = path.resolve(repoRoot);

  const result = await morph.warpGrep.execute({
    searchTerm: query,
    repoRoot: absRepo,
  });

  if (!result.success) {
    console.error("WarpGrep failed:", result.error);
    process.exit(1);
  }

  if (result.summary) console.log(result.summary);

  for (const ctx of result.contexts ?? []) {
    console.log(`\n📄 ${ctx.file}`);
    for (const line of ctx.content.split("\n")) {
      console.log(`  ${line}`);
    }
  }
}

main();
