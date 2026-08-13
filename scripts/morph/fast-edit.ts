#!/usr/bin/env tsx
/**
 * Fast Apply — Morph's AI-powered code editing at 10,500 tok/s.
 *
 * Sends only the changed lines (with `// ... existing code ...` markers) and
 * Morph merges them into the full file, avoiding wasteful full-file rewrites.
 *
 * Usage:
 *   npm run morph:edit -- --file daemon/ai-provider.ts \
 *     --instruction "Add a comment above the model default" \
 *     --edit "// ... existing code ...\n// Poolside Laguna S2.1 is the default model.\nconst model = ..."
 */
import { MorphClient } from "@morphllm/morphsdk";
import * as process from "node:process";

function parseArgs(argv: string[]): {
  file?: string;
  instruction?: string;
  edit?: string;
} {
  const out: { file?: string; instruction?: string; edit?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--file":
      case "-f":
        out.file = argv[++i];
        break;
      case "--instruction":
      case "-i":
        out.instruction = argv[++i];
        break;
      case "--edit":
      case "-e":
        out.edit = argv[++i];
        break;
    }
  }
  return out;
}

async function main() {
  const { file, instruction, edit } = parseArgs(process.argv);
  if (!file || !instruction || !edit) {
    console.error(
      "Usage: tsx scripts/morph/fast-edit.ts --file <path> --instruction <what you're changing> --edit <lazy snippet>",
    );
    console.error(
      "Use // ... existing code ... to mark unchanged sections.",
    );
    process.exit(1);
  }

  const morph = new MorphClient({ apiKey: process.env.MORPH_API_KEY });

  const result = await morph.fastApply.execute({
    target_filepath: file,
    instruction,
    code_edit: edit,
  });

  if (!result.success) {
    console.error("Fast Apply failed:", result.error);
    process.exit(1);
  }

  const { linesAdded, linesRemoved, linesModified } = result.changes;
  console.log(
    `✅ ${result.filepath}: +${linesAdded} -${linesRemoved} ~${linesModified}`,
  );
}

main();
