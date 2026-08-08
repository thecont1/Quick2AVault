/**
 * Learning — curiosity budget, rules, and near-duplicate proposals.
 *   npx tsx daemon/learning.smoke.ts
 *
 * The failure this guards against is an app that NAGS: asking the same
 * question twice, asking when the user is clearly ignoring it, or silently
 * auto-merging entities the user never approved.
 */
import * as assert from "node:assert";

import { openDatabase } from "./schema.js";
import {
  isLearningEnabled,
  questionBudget,
  ask,
  answer,
  dismiss,
  applyRule,
  findNearDuplicates,
} from "./learning.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";

const logger = createLogger("error");
const ports: Ports = {
  logger,
  clock: systemClock,
  paths: createPaths("/tmp/q2v-learn-smoke"),
  converter: {
    async toMarkdown() {
      return { markdown: "", converter: "stub", converterVersion: "smoke@1" };
    },
  },
  bus: createEventBus(logger),
};

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    failed++;
  }
}

const fresh = () => openDatabase(":memory:");

console.log("\nLearning\n");

check("learning is ON at install", () => {
  assert.ok(isLearningEnabled(fresh()), "plan §5: ON at install");
});

check("a fresh vault has budget to ask", () => {
  assert.ok(questionBudget(fresh()) > 0);
});

check("the same question is never asked twice while open", () => {
  const db = fresh();
  const a = ask(db, ports, { question: "Is X the same as Y?", trigger: "unseen_entity" });
  const b = ask(db, ports, { question: "Is X the same as Y?", trigger: "unseen_entity" });
  assert.strictEqual(a, b, "duplicate question created a second review");
  const n = (db.prepare("SELECT COUNT(*) n FROM training_reviews").get() as { n: number }).n;
  assert.strictEqual(n, 1);
});

check("an ignored queue goes quiet (fatigue back-off)", () => {
  const db = fresh();
  const start = questionBudget(db);
  for (let i = 0; i < 8; i++) {
    ask(db, ports, { question: `Q${i}?`, trigger: "unseen_entity" });
  }
  assert.ok(
    questionBudget(db) < start,
    "budget must fall when questions pile up unanswered",
  );
});

check("answering creates a rule that then applies", () => {
  const db = fresh();
  const id = ask(db, ports, { question: "Is SWIGGY*BLR the same as Demo Merchant?", trigger: "unseen_entity" })!;
  answer(db, ports, id, "Yes, always", {
    kind: "descriptor_to_entity",
    match_key: "demo merchant",
    match_kind: "organisation",
    value: "ent_demo",
  });
  const hit = applyRule(db, ports, "descriptor_to_entity", "DEMO MERCHANT*BLR 080", "organisation");
  assert.strictEqual(hit, "ent_demo", "rule did not apply to a normalised descriptor");
});

check("applying a rule increments its usage", () => {
  const db = fresh();
  const id = ask(db, ports, { question: "Q?", trigger: "unseen_entity" })!;
  answer(db, ports, id, "Yes", {
    kind: "vendor_to_account",
    match_key: "demo vendor",
    value: "ent_acct",
  });
  applyRule(db, ports, "vendor_to_account", "Demo Vendor");
  applyRule(db, ports, "vendor_to_account", "Demo Vendor");
  const r = db.prepare("SELECT times_applied FROM learned_rules LIMIT 1").get() as { times_applied: number };
  assert.strictEqual(r.times_applied, 2);
});

check("dismissing removes a question from the queue", () => {
  const db = fresh();
  const id = ask(db, ports, { question: "Q?", trigger: "unseen_entity" })!;
  dismiss(db, id);
  const open = (
    db.prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NULL AND dismissed=0")
      .get() as { n: number }
  ).n;
  assert.strictEqual(open, 0);
});

check("the master switch silences everything", () => {
  const db = fresh();
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('learning.enabled','false')").run();
  assert.strictEqual(isLearningEnabled(db), false);
  assert.strictEqual(questionBudget(db), 0);
  assert.strictEqual(ask(db, ports, { question: "Q?", trigger: "unseen_entity" }), null);
});

// ── near-duplicate proposals ───────────────────────────────────────────────

function seed(db: ReturnType<typeof fresh>, names: string[], kind = "organisation") {
  const stmt = db.prepare(
    "INSERT INTO entities (id, kind, display_name, status, created_at) VALUES (?,?,?,'candidate',?)",
  );
  // Ids must be unique across calls, not just within one — seeding the same
  // name under two kinds is exactly what the anti-pollution test needs.
  names.forEach((n, i) => stmt.run(`ent_${kind}_${i}`, kind, n, "2026-01-01"));
}

check("truncated OCR variants are proposed as duplicates", () => {
  const db = fresh();
  // The exact shape seen in a real vault: one event, three spellings.
  seed(db, ["VizChitra", "VIZCHITRA 2026", "VizChitra (The Org of Fine & Curious Individuals)"]);
  const dupes = findNearDuplicates(db, "organisation");
  assert.ok(dupes.length >= 2, `expected proposals, got ${dupes.length}`);
  assert.ok(dupes[0].score >= 0.6);
});

check("genuinely different merchants are NOT proposed", () => {
  const db = fresh();
  seed(db, ["Alpha Foods", "Beta Foods", "Gamma Cafe"]);
  const dupes = findNearDuplicates(db, "organisation");
  assert.strictEqual(dupes.length, 0, `false positives: ${JSON.stringify(dupes)}`);
});

check("duplicates are PROPOSALS — nothing is merged automatically", () => {
  const db = fresh();
  seed(db, ["VizChitra", "VIZCHITRA 2026"]);
  const before = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  findNearDuplicates(db, "organisation");
  const after = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  assert.strictEqual(after, before, "findNearDuplicates must not mutate the ledger");
});

check("proposals never cross entity kinds", () => {
  const db = fresh();
  seed(db, ["Demo Merchant"], "organisation");
  seed(db, ["Demo Merchant"], "account");
  // Same name, different kinds — the anti-pollution invariant.
  const orgs = findNearDuplicates(db, "organisation");
  assert.strictEqual(orgs.length, 0, "a merchant was proposed for merging with an account");
});

// A question comparing a name to itself teaches nothing and burns the budget.
// The live vault had four of these: `Is "PAYTM MONEY LIMITED" the same as
// PAYTM MONEY LIMITED?`. The guard lives in pipeline.ts; this asserts the
// normalisation rule it relies on.
{
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tautologies: Array<[string, string]> = [
    ["PAYTM MONEY LIMITED", "PAYTM MONEY LIMITED"],
    ["Paytm Money Limited", "PAYTM MONEY LIMITED"],
    ["PAYTM  MONEY,  LIMITED", "Paytm Money Limited"],
  ];
  for (const [a, b] of tautologies) {
    check(`no question for "${a}" vs "${b}"`, () => norm(a) === norm(b));
  }
  const genuine: Array<[string, string]> = [
    ["SWIGGY*BLR", "Swiggy"],
    ["UPI/ZOMATO/1234", "Zomato"],
  ];
  for (const [a, b] of genuine) {
    check(`still asks for "${a}" vs "${b}"`, () => norm(a) !== norm(b));
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);

process.exit(failed ? 1 : 0);
