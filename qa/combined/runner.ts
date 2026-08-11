/** Clean-vault runner shared by the combined QA command and its contract tests. */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type Disposition = "accepted" | "duplicate" | "irrelevant" | "failed" | "password_needed";

export type FixtureManifest = {
  schemaVersion: 1;
  id: string;
  order: number;
  source: { filename: string; text?: string; fixturePath?: string };
  sources?: Array<{ filename: string; text?: string; fixturePath?: string }>;
  expectations: {
    disposition?: Disposition;
    sourcePolicy?: "retained" | "archived" | "until_complete" | "removed_on_complete";
    capabilities?: string[];
  };
  scenario?:
    | "ambiguous_alias"
    | "identity_collapse"
    | "reanalysis_preservation"
    | "password_needed"
    | "duplicate"
    | "cross_kind_collision";
};

export type ExtractionGolden = {
  schemaVersion: 1;
  fixtureId: "G" | "H";
  documentType: "tax_invoice" | "contract_note";
  confidenceAtLeast: number;
  fields: Record<string, unknown>;
};

export type Assertion = {
  fixtureId: string;
  name: string;
  status: "passed" | "failed" | "not_applicable";
  detail?: string;
};

export type RunContext = {
  root: string;
  vaultPath: string;
  sourceDir: string;
  sqlitePath: string;
  sourcePath(filename: string): string;
};

export interface HarnessAdapter {
  load(
    context: RunContext,
    fixture: FixtureManifest,
  ): Promise<{ disposition?: Disposition; assertions?: Assertion[] }>;
  close?(): Promise<void> | void;
}

export type RunResult = { exitCode: 0 | 1; vaultPath: string; assertions: Assertion[] };

const DISPOSITIONS = new Set<Disposition>([
  "accepted",
  "duplicate",
  "irrelevant",
  "failed",
  "password_needed",
]);
const SOURCE_POLICIES = new Set(["retained", "archived", "until_complete", "removed_on_complete"]);
const SCENARIOS = new Set([
  "ambiguous_alias",
  "identity_collapse",
  "reanalysis_preservation",
  "password_needed",
  "duplicate",
  "cross_kind_collision",
]);

function validateSource(source: FixtureManifest["source"], label: string): void {
  assert.equal(typeof source?.filename, "string", `${label}.filename must be a string`);
  assert.ok(
    source.filename.length > 0 &&
      !path.isAbsolute(source.filename) &&
      !source.filename.split(/[\\/]/).includes(".."),
    `${label}.filename must be a safe relative path`,
  );
  assert.ok(
    typeof source.text === "string" || typeof source.fixturePath === "string",
    `${label} requires text or fixturePath`,
  );
  assert.ok(
    !(source.text !== undefined && source.fixturePath !== undefined),
    `${label} cannot contain both text and fixturePath`,
  );
  if (source.fixturePath !== undefined)
    assert.ok(source.fixturePath.length > 0, `${label}.fixturePath must not be empty`);
}

export function validateManifest(input: unknown): asserts input is FixtureManifest {
  const m = input as Partial<FixtureManifest>;
  assert.equal(m?.schemaVersion, 1, "manifest.schemaVersion must be 1");
  assert.equal(typeof m.id, "string", "manifest.id must be a string");
  assert.ok(m.id!.length > 0, "manifest.id must not be empty");
  assert.ok(Number.isInteger(m.order), "manifest.order must be an integer");
  validateSource(m.source!, "manifest.source");
  assert.ok(
    m.expectations && typeof m.expectations === "object",
    "manifest.expectations is required",
  );
  if (m.expectations?.disposition !== undefined)
    assert.ok(DISPOSITIONS.has(m.expectations.disposition), "manifest disposition is invalid");
  if (m.expectations?.sourcePolicy !== undefined)
    assert.ok(SOURCE_POLICIES.has(m.expectations.sourcePolicy), "manifest sourcePolicy is invalid");
  if (m.expectations?.capabilities !== undefined) {
    assert.ok(
      Array.isArray(m.expectations.capabilities) &&
        m.expectations.capabilities.every((item) => typeof item === "string" && item.length > 0),
      "manifest capabilities must be non-empty strings",
    );
  }
  if (m.scenario !== undefined)
    assert.ok(SCENARIOS.has(m.scenario), "manifest scenario is invalid");
  if (m.sources !== undefined) {
    assert.ok(
      Array.isArray(m.sources) && m.sources.length > 0,
      "manifest.sources must be a non-empty array",
    );
    m.sources.forEach((source, index) => validateSource(source, `manifest.sources[${index}]`));
  }
}

export function validateGolden(input: unknown): asserts input is ExtractionGolden {
  const g = input as Partial<ExtractionGolden>;
  assert.equal(g?.schemaVersion, 1, "golden.schemaVersion must be 1");
  assert.ok(g.fixtureId === "G" || g.fixtureId === "H", "golden.fixtureId must be G or H");
  assert.ok(
    g.documentType === "tax_invoice" || g.documentType === "contract_note",
    "golden.documentType is invalid",
  );
  assert.equal(typeof g.confidenceAtLeast, "number", "golden.confidenceAtLeast must be a number");
  assert.ok(
    g.confidenceAtLeast! >= 0 && g.confidenceAtLeast! <= 1,
    "golden.confidenceAtLeast must be 0..1",
  );
  assert.ok(
    g.fields && typeof g.fields === "object" && !Array.isArray(g.fields),
    "golden.fields must be an object",
  );
  const verify = (value: unknown, key = "fields"): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") {
      assert.ok(
        Number.isInteger(value),
        `${key} numeric values must be integer minor units/counts`,
      );
      return;
    }
    if (Array.isArray(value))
      return value.forEach((item, index) => verify(item, `${key}[${index}]`));
    assert.ok(typeof value === "object", `${key} must be JSON data`);
    for (const [child, childValue] of Object.entries(value as Record<string, unknown>))
      verify(childValue, `${key}.${child}`);
  };
  verify(g.fields);
}

export async function readManifest(file: string): Promise<FixtureManifest> {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  validateManifest(parsed);
  return parsed;
}

export async function runCombined(options: {
  manifests: FixtureManifest[];
  adapter: HarnessAdapter;
  includeVisual: boolean;
  repoRoot?: string;
  keep?: boolean;
  visual?: (root: string) => Promise<Assertion[]>;
}): Promise<RunResult> {
  const manifests = [...options.manifests].sort(
    (a, b) => a.order - b.order || a.id.localeCompare(b.id),
  );
  const ids = new Set<string>();
  for (const manifest of manifests) {
    validateManifest(manifest);
    assert.ok(!ids.has(manifest.id), `duplicate manifest id: ${manifest.id}`);
    ids.add(manifest.id);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "quick2avault-combined-"));
  const context: RunContext = {
    root,
    vaultPath: path.join(root, "vault"),
    sourceDir: path.join(root, "drop"),
    sqlitePath: path.join(root, "vault", "vault.db"),
    sourcePath: (filename) => path.join(root, "drop", filename),
  };
  const repoRoot = options.repoRoot ?? process.cwd();
  const assertions: Assertion[] = [];
  await fs.mkdir(context.sourceDir, { recursive: true });
  await fs.mkdir(context.vaultPath, { recursive: true });
  try {
    for (const fixture of manifests) {
      try {
        for (const source of [fixture.source, ...(fixture.sources ?? [])]) {
          const file = context.sourcePath(source.filename);
          await fs.mkdir(path.dirname(file), { recursive: true });
          if (source.fixturePath) {
            await fs.copyFile(path.resolve(repoRoot, source.fixturePath), file);
          } else {
            await fs.writeFile(file, source.text!, "utf8");
          }
        }
        const result = await options.adapter.load(context, fixture);
        if (!fixture.expectations.disposition) {
          assertions.push({
            fixtureId: fixture.id,
            name: "expected disposition",
            status: "not_applicable",
          });
        } else if (result.disposition !== fixture.expectations.disposition) {
          assertions.push({
            fixtureId: fixture.id,
            name: "expected disposition",
            status: "failed",
            detail: `expected ${fixture.expectations.disposition}, got ${result.disposition ?? "none"}`,
          });
        } else {
          assertions.push({
            fixtureId: fixture.id,
            name: "expected disposition",
            status: "passed",
          });
        }
        assertions.push(...(result.assertions ?? []));
      } catch (error) {
        assertions.push({
          fixtureId: fixture.id,
          name: "fixture execution",
          status: "failed",
          detail: (error as Error).message,
        });
      }
    }
    if (options.includeVisual) {
      if (options.visual) assertions.push(...(await options.visual(root)));
      else
        assertions.push({
          fixtureId: "visual",
          name: "visual comparator configured",
          status: "failed",
          detail: "includeVisual requires a comparator",
        });
    }
  } finally {
    try {
      await options.adapter.close?.();
    } finally {
      if (!options.keep) await fs.rm(root, { recursive: true, force: true });
    }
  }
  return {
    exitCode: assertions.some((item) => item.status === "failed") ? 1 : 0,
    vaultPath: context.vaultPath,
    assertions,
  };
}
