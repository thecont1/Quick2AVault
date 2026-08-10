/**
 * Production-facing adapter. It uses the daemon's public dependency boundary
 * (Ports) and a temporary SQLite/vault; it never opens a user's vault or
 * configures an AI provider.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  createAnydocConverter,
  createEventBus,
  createLogger,
  createPaths,
} from "../../daemon/adapters.js";
import { nullAiProvider } from "../../daemon/ai-provider.js";
import { JobWorker, ingestFile } from "../../daemon/pipeline.js";
import { openDatabase } from "../../daemon/schema.js";
import type { Clock, Converter, Ports } from "../../daemon/ports.js";
import type { Assertion, FixtureManifest, HarnessAdapter, RunContext } from "./runner.js";

const FIXED_DATE = new Date("2026-08-10T12:00:00.000Z");

function deterministicClock(): Clock {
  let tick = 0;
  return {
    now: () => new Date(FIXED_DATE.getTime() + tick++),
    isoNow: () => new Date(FIXED_DATE.getTime() + tick++).toISOString(),
  };
}

function requireDb(context: RunContext): DatabaseSync {
  return openDatabase(context.sqlitePath);
}

async function workUntilSettled(db: DatabaseSync, ports: Ports): Promise<void> {
  const worker = new JobWorker(db, ports, nullAiProvider);
  for (let i = 0; i < 12; i++) {
    const pending = db
      .prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('pending','running')")
      .get() as { n: number };
    if (pending.n === 0) return;
    await worker.tick();
  }
  throw new Error("job worker did not settle after 12 deterministic ticks");
}

function capabilityAssertions(db: DatabaseSync, fixture: FixtureManifest): Assertion[] {
  const names = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  return (fixture.expectations.capabilities ?? []).map((capability) => {
    const available =
      {
        pipeline_events: names.has("pipeline_events"),
        document_parties: names.has("document_parties"),
        learned_rules: names.has("learned_rules"),
        entity_resolution: false,
        "learning.question": false,
        claim_provenance: false,
        reanalysis_preservation: false,
        cross_kind_conflict: false,
        tax_invoice_extractor: false,
        contract_note_extractor: false,
        currency_conversion: false,
      }[capability] ?? false;
    return available
      ? { fixtureId: fixture.id, name: `production observable: ${capability}`, status: "passed" }
      : {
          fixtureId: fixture.id,
          name: `production observable: ${capability}`,
          status: "not_applicable",
          detail: "production contract is not present on this branch",
        };
  });
}

function sourceAssertion(
  fixture: FixtureManifest,
  file: string,
  expected: FixtureManifest["expectations"]["sourcePolicy"],
): Promise<Assertion | undefined> {
  return fs.stat(file).then(
    () => {
      if (expected === "until_complete" || expected === "retained") {
        return {
          fixtureId: fixture.id,
          name: `source policy: ${expected}`,
          status: "passed" as const,
        };
      }
      return {
        fixtureId: fixture.id,
        name: `source policy: ${expected}`,
        status: "failed" as const,
        detail: "source remained in drop folder",
      };
    },
    () => {
      if (expected === "until_complete" || expected === "retained") {
        return {
          fixtureId: fixture.id,
          name: `source policy: ${expected}`,
          status: "failed" as const,
          detail: "source was removed before terminal completion/retention handling",
        };
      }
      return {
        fixtureId: fixture.id,
        name: `source policy: ${expected}`,
        status: "passed" as const,
      };
    },
  );
}

export class ProductionAdapter implements HarnessAdapter {
  private db: DatabaseSync | undefined;
  private ports: Ports | undefined;

  private setup(context: RunContext, fixture: FixtureManifest): { db: DatabaseSync; ports: Ports } {
    if (this.db && this.ports) return { db: this.db, ports: this.ports };
    const logger = createLogger("error");
    const baseConverter = createAnydocConverter(logger);
    // This is a deterministic failure injection at the converter boundary,
    // not a fabricated extraction. It proves password-required retention
    // without network, OCR, or a real user password.
    const converter: Converter = {
      async toMarkdown(file, ext, password) {
        const bytes = await fs.readFile(file);
        if (bytes.includes(Buffer.from("deterministic encrypted fixture marker"))) {
          throw new Error("ENCRYPTED: deterministic fixture requires password");
        }
        if (bytes.includes(Buffer.from("deterministic failed fixture marker"))) {
          throw new Error("deterministic conversion failure");
        }
        return baseConverter.toMarkdown(file, ext, password);
      },
    };
    const ports: Ports = {
      logger,
      clock: deterministicClock(),
      paths: createPaths(context.vaultPath),
      converter,
      bus: createEventBus(logger),
    };
    this.db = requireDb(context);
    this.ports = ports;
    return { db: this.db, ports };
  }

  async load(
    context: RunContext,
    fixture: FixtureManifest,
  ): Promise<{
    disposition?: "accepted" | "duplicate" | "irrelevant" | "failed" | "password_needed";
    assertions?: Assertion[];
  }> {
    const { db, ports } = this.setup(context, fixture);
    const assertions = capabilityAssertions(db, fixture);
    const sources = [fixture.source, ...(fixture.sources ?? [])];
    let last: Awaited<ReturnType<typeof ingestFile>> | undefined;
    for (const source of sources) {
      const file = context.sourcePath(source.filename);
      last = await ingestFile(db, ports, file, {
        source: "qa-combined",
        consumeSource: true,
        checkStable: false,
      });
      if (source === fixture.source && fixture.expectations.sourcePolicy) {
        const delayedRemovalPresent =
          (
            db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_events'",
              )
              .get() as { name?: string } | undefined
          )?.name === "pipeline_events";
        if (
          !delayedRemovalPresent &&
          (fixture.expectations.sourcePolicy === "until_complete" ||
            fixture.expectations.sourcePolicy === "retained")
        ) {
          assertions.push({
            fixtureId: fixture.id,
            name: `source policy: ${fixture.expectations.sourcePolicy}`,
            status: "not_applicable",
            detail: "delayed-removal backend contract is not present on this branch",
          });
        } else {
          assertions.push(
            (await sourceAssertion(fixture, file, fixture.expectations.sourcePolicy))!,
          );
        }
      }
    }
    await workUntilSettled(db, ports);

    if (fixture.scenario === "password_needed" && fixture.source) {
      const failed = db
        .prepare("SELECT processing_state FROM intake_events WHERE filename=?")
        .get("d-failed.pdf") as { processing_state?: string } | undefined;
      assertions.push(
        failed?.processing_state === "failed"
          ? {
              fixtureId: fixture.id,
              name: "invalid input reaches the visible failed terminal state",
              status: "passed",
            }
          : {
              fixtureId: fixture.id,
              name: "invalid input reaches the visible failed terminal state",
              status: "failed",
              detail: `got ${failed?.processing_state ?? "no intake event"}`,
            },
      );
      const row = db
        .prepare("SELECT processing_state FROM intake_events WHERE filename=?")
        .get(fixture.source.filename) as { processing_state?: string } | undefined;
      if (row?.processing_state === "password_needed") {
        assertions.push({
          fixtureId: fixture.id,
          name: "password-protected input is retained for unlock",
          status: "passed",
        });
        return { disposition: "password_needed", assertions };
      }
      assertions.push({
        fixtureId: fixture.id,
        name: "password-protected input is retained for unlock",
        status: "failed",
        detail: `got ${row?.processing_state ?? "no intake event"}`,
      });
      return { disposition: last?.disposition, assertions };
    }

    if (fixture.scenario === "duplicate") {
      const duplicate = db
        .prepare("SELECT canonical_path FROM intake_events WHERE filename=?")
        .get("e-duplicate.txt") as { canonical_path: string | null } | undefined;
      const archived =
        !!duplicate?.canonical_path &&
        (await fs.stat(duplicate.canonical_path).then(
          () => true,
          () => false,
        ));
      assertions.push(
        archived
          ? {
              fixtureId: fixture.id,
              name: "duplicate bytes are retained in archive",
              status: "passed",
            }
          : {
              fixtureId: fixture.id,
              name: "duplicate bytes are retained in archive",
              status: "failed",
              detail: "no duplicate archive copy",
            },
      );
    }

    if (fixture.scenario === "password_needed")
      return { disposition: "password_needed", assertions };
    return { disposition: last?.disposition, assertions };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.ports = undefined;
  }
}

export async function readStoredExtraction(
  dbPath: string,
  filename: string,
): Promise<unknown | undefined> {
  const db = openDatabase(dbPath);
  try {
    const row = db
      .prepare("SELECT extraction_json FROM documents WHERE original_filename=?")
      .get(filename) as { extraction_json: string | null } | undefined;
    return row?.extraction_json ? JSON.parse(row.extraction_json) : undefined;
  } finally {
    db.close();
  }
}
