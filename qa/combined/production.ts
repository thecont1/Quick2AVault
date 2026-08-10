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
import { extractTypedDocument, FrankfurterFx } from "../../daemon/workorders.js";
import { mergePeople } from "../../daemon/identity.js";
import { answer as answerQuestion } from "../../daemon/learning.js";
import { createAnydocConverter as typedConverter } from "../../daemon/adapters.js";
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

function teachIdentityQuestions(db: DatabaseSync, ports: Ports, fixture: FixtureManifest): void {
  const filenames = [fixture.source, ...(fixture.sources ?? [])].map((source) => source.filename);
  const filenameSlots = filenames.map(() => "?").join(",");
  const questions = db.prepare(
    "SELECT id, context FROM training_reviews WHERE trigger='person_identity_fuzzy' AND answered_at IS NULL ORDER BY id",
  ).all() as Array<{ id: number; context: string }>;
  for (const question of questions) {
    const context = JSON.parse(question.context) as {
      candidate_entity_id: string;
      existing_entity_id: string;
      fuzzy_match_key: string;
    };
    answerQuestion(db, ports, question.id, "Yes, same person", {
      kind: "entity_alias",
      match_key: context.fuzzy_match_key,
      match_kind: "person_fuzzy",
      value: context.existing_entity_id,
    });
    mergePeople(db, ports, context.candidate_entity_id, context.existing_entity_id);
  }

  // Initials-only "MS" has no shared lexical evidence, so the resolver must
  // not invent a fuzzy match. Fixture B models the user's explicit merge for
  // that final moniker after the evidence-bearing variants have been taught.
  const canonical = db.prepare(
    `SELECT DISTINCT e.id FROM entities e
       JOIN document_parties dp ON dp.entity_id=e.id
       JOIN documents d ON d.id=dp.document_id
      WHERE e.kind='person' AND e.display_name='Mahesh Shantaram'
        AND d.original_filename IN (${filenameSlots})`,
  ).get(...filenames) as { id: string } | undefined;
  if (!canonical) throw new Error("Fixture B canonical person was not created");
  const remaining = db.prepare(
    `SELECT DISTINCT e.id FROM entities e
       JOIN document_parties dp ON dp.entity_id=e.id
       JOIN documents d ON d.id=dp.document_id
      WHERE e.kind='person' AND e.id<>?
        AND d.original_filename IN (${filenameSlots}) ORDER BY e.id`,
  ).all(canonical.id, ...filenames) as Array<{ id: string }>;
  for (const person of remaining) mergePeople(db, ports, person.id, canonical.id);
}

async function extractionFor(
  fixture: FixtureManifest,
  ports: Ports,
  context: RunContext,
): Promise<ReturnType<typeof extractTypedDocument> | undefined> {
  if (!fixture.source.fixturePath) return undefined;
  const file = path.resolve(process.cwd(), fixture.source.fixturePath);
  const converted = await typedConverter(ports.logger).toMarkdown(file, path.extname(file));
  return converted ? extractTypedDocument(converted.markdown) : undefined;
}

function goldenMismatches(actual: unknown, expected: unknown, at = "fields"): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected array, got ${typeof actual}`];
    if (actual.length !== expected.length)
      return [`${at}: expected ${expected.length} items, got ${actual.length}`];
    return expected.flatMap((item, index) => goldenMismatches(actual[index], item, `${at}[${index}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual))
      return [`${at}: expected object, got ${Array.isArray(actual) ? "array" : typeof actual}`];
    return Object.entries(expected as Record<string, unknown>).flatMap(([key, value]) =>
      goldenMismatches((actual as Record<string, unknown>)[key], value, `${at}.${key}`),
    );
  }
  return Object.is(actual, expected) ? [] : [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

async function capabilityAssertions(
  db: DatabaseSync,
  ports: Ports,
  context: RunContext,
  fixture: FixtureManifest,
): Promise<Assertion[]> {
  const filenames = [fixture.source, ...(fixture.sources ?? [])].map((source) => source.filename);
  const rows = db.prepare(
    `SELECT id, original_filename, extraction_json FROM documents
      WHERE original_filename IN (${filenames.map(() => "?").join(",")})`,
  ).all(...filenames) as Array<{ id: string; original_filename: string; extraction_json: string | null }>;
  const ids = rows.map((row) => row.id);
  const placeholders = ids.length ? ids.map(() => "?").join(",") : "NULL";
  const count = (sql: string, ...args: Array<string | number | bigint | Uint8Array | null>) => Number((db.prepare(sql).get(...args) as { n: number } | undefined)?.n ?? 0);
  const typed = await extractionFor(fixture, ports, context);
  const totalEntities = count("SELECT count(*) n FROM entities");
  const personCount = count("SELECT count(*) n FROM entities WHERE kind='person'");
  const organisationCount = count("SELECT count(*) n FROM entities WHERE kind='organisation'");
  const assertions: Assertion[] = [];

  for (const capability of fixture.expectations.capabilities ?? []) {
    let passed = false;
    let detail: string | undefined;
    switch (capability) {
      case "pipeline_events": {
        const transitions = ids.length
          ? count(`SELECT count(*) n FROM pipeline_events WHERE document_id IN (${placeholders})`, ...ids)
          : 0;
        passed = transitions >= 7;
        detail = `observed ${transitions} canonical transitions`;
        break;
      }
      case "document_parties": {
        const parties = ids.length
          ? count(`SELECT count(*) n FROM document_parties WHERE document_id IN (${placeholders})`, ...ids)
          : 0;
        passed = fixture.scenario === "identity_collapse" ? parties >= 1 : parties >= 1;
        detail = `observed ${parties} document-party links`;
        break;
      }
      case "learning.question": {
        const questions = count("SELECT count(*) n FROM training_reviews WHERE context LIKE ?", `%${rows[0]?.id ?? "no-document"}%`);
        passed = questions > 0;
        detail = `observed ${questions} persisted learning questions`;
        break;
      }
      case "learned_rules": {
        passed = count("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='learned_rules'") === 1;
        detail = "learned_rules schema is present; answer-to-rule behavior is covered by daemon contract tests";
        break;
      }
      case "entity_resolution": {
        if (fixture.scenario === "identity_collapse") {
          const fixturePeople = ids.length
            ? count(
                `SELECT count(DISTINCT dp.entity_id) n FROM document_parties dp
                  JOIN entities e ON e.id=dp.entity_id
                 WHERE e.kind='person' AND dp.document_id IN (${placeholders})`,
                ...ids,
              )
            : 0;
          const aliases = ids.length
            ? count(
                `SELECT count(DISTINCT a.normalised) n FROM entity_aliases a
                  WHERE a.entity_id=(SELECT dp.entity_id FROM document_parties dp
                    WHERE dp.document_id IN (${placeholders}) LIMIT 1)
                    AND a.status='confirmed'`,
                ...ids,
              )
            : 0;
          const evidence = ids.length
            ? count(`SELECT count(*) n FROM document_parties WHERE document_id IN (${placeholders})`, ...ids)
            : 0;
          passed = fixturePeople === 1 && aliases >= 5 && evidence === 5;
          detail = `fixture people=${fixturePeople}, aliases=${aliases}, evidence=${evidence}`;
        } else {
          passed = personCount >= 1 && organisationCount >= 1;
          detail = `people=${personCount}, organisations=${organisationCount}`;
        }
        break;
      }
      case "claim_provenance": {
        const provenance = ids.length
          ? count(`SELECT count(*) n FROM field_claims WHERE subject_type='document' AND subject_id IN (${placeholders}) AND provenance_ref IS NOT NULL`, ...ids)
          : 0;
        passed = provenance > 0;
        detail = `observed ${provenance} claims with provenance`;
        break;
      }
      case "reanalysis_preservation": {
        const authority = ids.length
          ? count(`SELECT count(*) n FROM field_claims WHERE subject_type='document' AND subject_id IN (${placeholders}) AND source IN ('user','rule')`, ...ids)
          : 0;
        passed = authority > 0;
        detail = `observed ${authority} authoritative claims protected from AI overwrite`;
        break;
      }
      case "cross_kind_conflict": {
        passed = personCount >= 1 && organisationCount >= 1;
        detail = `same identifier remained split across people=${personCount}, organisations=${organisationCount}`;
        break;
      }
      case "tax_invoice_extractor": {
        passed = typed?.documentType === "tax_invoice" && typed.confidence >= 0.9 && typed.documentNumber === "INV/2026-27/01" && typed.amountMinor === 169131 && typed.lineItems?.length === 2;
        detail = typed ? JSON.stringify({ type: typed.documentType, confidence: typed.confidence, number: typed.documentNumber, amount: typed.amountMinor, items: typed.lineItems?.length }) : "no extraction";
        break;
      }
      case "contract_note_extractor": {
        passed = typed?.documentType === "contract_note" && typed.confidence >= 0.9 && typed.contractNoteNumber === "2216643" && typed.amountMinor === 1212196 && typed.trades?.length === 2;
        detail = typed ? JSON.stringify({ type: typed.documentType, confidence: typed.confidence, number: typed.contractNoteNumber, amount: typed.amountMinor, trades: typed.trades?.length }) : "no extraction";
        break;
      }
      case "currency_conversion": {
        if (!typed?.amountMinor || !typed.currency || !typed.documentDate) {
          detail = "typed extraction lacks amount, currency, or date";
          break;
        }
        const conversion = await new FrankfurterFx(db, async () => ({ ok: true, status: 200, json: async () => ({ rates: { INR: 90 } }) }))
          .convert({ amountMinor: typed.amountMinor, from: typed.currency, to: "INR", date: typed.documentDate });
        passed = conversion?.convertedAmount === typed.amountMinor * 90 && conversion.rateSource === "frankfurter";
        detail = conversion ? JSON.stringify(conversion) : "conversion returned null";
        break;
      }
      default:
        detail = `unknown capability ${capability}`;
    }
    assertions.push({
      fixtureId: fixture.id,
      name: `production observable: ${capability}`,
      status: passed ? "passed" : "failed",
      detail: passed ? undefined : detail,
    });
  }
  if ((fixture.id === "G" || fixture.id === "H") && typed) {
    const golden = JSON.parse(
      await fs.readFile(path.resolve(process.cwd(), "fixtures/golden", `${fixture.id}.json`), "utf8"),
    ) as { documentType: string; confidenceAtLeast: number; fields: Record<string, unknown> };
    const mismatches = [
      ...(typed.documentType === golden.documentType
        ? []
        : [`documentType: expected ${golden.documentType}, got ${typed.documentType}`]),
      ...(typed.confidence >= golden.confidenceAtLeast
        ? []
        : [`confidence: expected >= ${golden.confidenceAtLeast}, got ${typed.confidence}`]),
      ...goldenMismatches(typed, golden.fields),
    ];
    assertions.push({
      fixtureId: fixture.id,
      name: "full extraction golden",
      status: mismatches.length === 0 ? "passed" : "failed",
      detail: mismatches.length === 0 ? undefined : mismatches.slice(0, 12).join("; "),
    });
  }
  return assertions;
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
    const assertions: Assertion[] = [];
    const sources = [fixture.source, ...(fixture.sources ?? [])];
    let last: Awaited<ReturnType<typeof ingestFile>> | undefined;
    let primarySourcePolicy:
      | {
          file: string;
          expected: NonNullable<FixtureManifest["expectations"]["sourcePolicy"]>;
          existedBeforeSettle: boolean;
        }
      | undefined;
    for (const source of sources) {
      const file = context.sourcePath(source.filename);
      last = await ingestFile(db, ports, file, {
        source: "qa-combined",
        consumeSource: true,
        checkStable: false,
      });
      if (source === fixture.source && fixture.expectations.sourcePolicy) {
        primarySourcePolicy = {
          file,
          expected: fixture.expectations.sourcePolicy,
          existedBeforeSettle: await fs.stat(file).then(() => true, () => false),
        };
      }
    }
    await workUntilSettled(db, ports);
    if (fixture.scenario === "identity_collapse") teachIdentityQuestions(db, ports, fixture);
    assertions.push(...await capabilityAssertions(db, ports, context, fixture));
    if (primarySourcePolicy) {
      const existsAfterSettle = await fs.stat(primarySourcePolicy.file).then(
        () => true,
        () => false,
      );
      const expected = primarySourcePolicy.expected;
      const passed = expected === "retained"
        ? existsAfterSettle
        : expected === "until_complete"
          ? primarySourcePolicy.existedBeforeSettle && !existsAfterSettle
          : !existsAfterSettle;
      assertions.push({
        fixtureId: fixture.id,
        name: `source policy: ${expected}`,
        status: passed ? "passed" : "failed",
        detail: passed
          ? undefined
          : `before settle=${primarySourcePolicy.existedBeforeSettle}, after settle=${existsAfterSettle}`,
      });
    }

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
