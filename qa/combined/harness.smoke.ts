/** Harness contract tests. Run with: bun run qa:combined:test */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  runCombined,
  validateGolden,
  validateManifest,
  type FixtureManifest,
  type HarnessAdapter,
} from "./runner.js";
import { compareVisualCaptures } from "./visual.js";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
  }
}

const manifest = (id: string, order: number): FixtureManifest => ({
  schemaVersion: 1,
  id,
  order,
  source: { filename: `${id}.txt`, text: "Invoice total USD 10.00" },
  expectations: { disposition: "accepted" },
});

const golden = {
  schemaVersion: 1,
  fixtureId: "G",
  documentType: "tax_invoice",
  confidenceAtLeast: 0.9,
  fields: { amountMinor: 169131, currency: "USD" },
};

function adapter(seen: string[], failId?: string): HarnessAdapter {
  return {
    async load(ctx, fixture) {
      seen.push(fixture.id);
      if (fixture.id === failId) throw new Error(`intentional ${failId} failure`);
      assert.equal(
        await fs.readFile(ctx.sourcePath(fixture.source.filename), "utf8"),
        fixture.source.text,
      );
      return { disposition: "accepted" };
    },
  };
}

console.log("── combined QA harness contract\n");

await check("loads manifests in deterministic order", async () => {
  const seen: string[] = [];
  const result = await runCombined({
    manifests: [manifest("B", 20), manifest("A", 10)],
    adapter: adapter(seen),
    includeVisual: false,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, ["A", "B"]);
});

await check("removes isolated vault after both success and failure", async () => {
  const success = await runCombined({
    manifests: [manifest("A", 10)],
    adapter: adapter([]),
    includeVisual: false,
  });
  assert.equal(
    await fs.stat(success.vaultPath).then(
      () => true,
      () => false,
    ),
    false,
  );
  const failure = await runCombined({
    manifests: [manifest("A", 10)],
    adapter: adapter([], "A"),
    includeVisual: false,
  });
  assert.equal(failure.exitCode, 1);
  assert.equal(
    await fs.stat(failure.vaultPath).then(
      () => true,
      () => false,
    ),
    false,
  );
});

await check("keeps the isolated vault when requested", async () => {
  const result = await runCombined({
    manifests: [],
    adapter: adapter([]),
    includeVisual: false,
    keep: true,
  });
  try {
    assert.equal(
      await fs.stat(result.vaultPath).then(
        () => true,
        () => false,
      ),
      true,
    );
  } finally {
    await fs.rm(path.dirname(result.vaultPath), { recursive: true, force: true });
  }
});

await check("returns nonzero for an assertion or adapter failure", async () => {
  const result = await runCombined({
    manifests: [manifest("A", 10)],
    adapter: adapter([], "A"),
    includeVisual: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.assertions[0]?.status, "failed");
});

await check("does not collapse duplicate fixture inputs", async () => {
  const seen: string[] = [];
  const result = await runCombined({
    manifests: [manifest("E-original", 10), manifest("E-duplicate", 11)],
    adapter: adapter(seen),
    includeVisual: false,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(seen, ["E-original", "E-duplicate"]);
});

await check("rejects duplicate manifest ids before creating a vault", async () => {
  await assert.rejects(
    () =>
      runCombined({
        manifests: [manifest("A", 1), manifest("A", 2)],
        adapter: adapter([]),
        includeVisual: false,
      }),
    /duplicate manifest id/,
  );
});

await check("rejects malformed manifests and golden shapes", () => {
  assert.throws(() => validateManifest({ ...manifest("A", 1), order: "first" }));
  assert.throws(() =>
    validateManifest({ ...manifest("A", 1), source: { filename: "../escape.txt", text: "bad" } }),
  );
  assert.throws(() =>
    validateManifest({ ...manifest("A", 1), expectations: { disposition: "mystery" } }),
  );
  assert.throws(() => validateGolden({ ...golden, fields: { amountMinor: 1.5 } }));
  assert.doesNotThrow(() => validateManifest(manifest("A", 1)));
  assert.doesNotThrow(() => validateGolden(golden));
});

await check("fails closed when visual comparison is requested without a comparator", async () => {
  const result = await runCombined({ manifests: [], adapter: adapter([]), includeVisual: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.assertions[0]?.status, "failed");
});

await check(
  "visual comparator passes captures and fails missing or mismatched inputs",
  async () => {
    const goldenDir = path.resolve(import.meta.dirname, "../../fixtures/glaze_golden");
    const captureDir = await fs.mkdtemp(path.join(os.tmpdir(), "q2av-visual-test-"));
    const names = (await fs.readdir(goldenDir)).filter((name) => name.endsWith(".png"));
    try {
      await Promise.all(
        names.map((name) => fs.copyFile(path.join(goldenDir, name), path.join(captureDir, name))),
      );
      const identical = await compareVisualCaptures({ goldenDir, captureDir, maxDistance: 0 });
      assert.ok(identical.every((item) => item.status === "passed"));

      await fs.rm(path.join(captureDir, names[0]));
      const missing = await compareVisualCaptures({ goldenDir, captureDir });
      assert.ok(
        missing.some(
          (item) => item.status === "failed" && item.detail?.includes("missing rendered capture"),
        ),
      );

      await fs.copyFile(path.join(goldenDir, names[0]), path.join(captureDir, names[0]));
      const forcedMismatch = await compareVisualCaptures({
        goldenDir,
        captureDir,
        maxDistance: -1,
      });
      assert.ok(forcedMismatch.every((item) => item.status === "failed"));
    } finally {
      await fs.rm(captureDir, { recursive: true, force: true });
    }
  },
);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
