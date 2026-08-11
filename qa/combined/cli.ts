import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ProductionAdapter } from "./production.js";
import { readManifest, runCombined, validateGolden } from "./runner.js";
import { compareVisualCaptures } from "./visual.js";

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
const keep = process.argv.includes("--keep") || process.env.Q2AV_KEEP === "1";
const captureArg = valueAfter("--captures") ?? process.env.Q2AV_VISUAL_CAPTURES;
const captureDir = captureArg ? path.resolve(captureArg) : undefined;
const includeVisual = process.argv.includes("--visual");

if (includeVisual && !captureDir) {
  console.error(
    "Visual QA requires rendered Flutter captures. Pass --visual --captures <directory> or set Q2AV_VISUAL_CAPTURES with --visual.",
  );
  process.exit(2);
}

const manifests = await Promise.all(
  "ABCDEFGH"
    .split("")
    .map((id) => readManifest(path.join(repoRoot, "fixtures/manifests", `${id}.json`))),
);
for (const id of ["G", "H"] as const) {
  const golden = JSON.parse(
    await fs.readFile(path.join(repoRoot, "fixtures/golden", `${id}.json`), "utf8"),
  );
  validateGolden(golden);
}

const result = await runCombined({
  manifests,
  adapter: new ProductionAdapter(repoRoot),
  includeVisual,
  repoRoot,
  keep,
  visual: captureDir
    ? () =>
        compareVisualCaptures({
          goldenDir: path.join(repoRoot, "fixtures/glaze_golden"),
          captureDir,
        })
    : undefined,
});

for (const assertion of result.assertions) {
  const marker =
    assertion.status === "passed"
      ? "ok  "
      : assertion.status === "not_applicable"
        ? "skip"
        : "FAIL";
  console.log(
    `${marker} [${assertion.fixtureId}] ${assertion.name}${assertion.detail ? ` — ${assertion.detail}` : ""}`,
  );
}
console.log(
  `\n${result.assertions.filter((item) => item.status === "passed").length} passed, ${result.assertions.filter((item) => item.status === "not_applicable").length} integration-boundary skips, ${result.assertions.filter((item) => item.status === "failed").length} failed`,
);
if (keep) console.log(`isolated vault retained at ${result.vaultPath}`);
process.exit(result.exitCode);
