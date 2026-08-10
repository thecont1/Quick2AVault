/**
 * Learning (plan §5) — the curiosity engine.
 *
 * The vault asks questions only on NOVELTY, and every answer becomes a rule
 * that is applied before the AI's own guess. A lesson learned once is never
 * re-asked.
 *
 * Budget decays as rule coverage grows; ignored questions back off. This is
 * the difference between an app that learns and an app that nags.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { normaliseName, normaliseDescriptor } from "./schema.js";

export type RuleKind =
  | "descriptor_to_entity"
  | "vendor_to_account"
  | "doctype_to_category"
  | "load_vs_spend"
  | "entity_alias";

export interface LearnedRule {
  id: number;
  kind: RuleKind;
  match_key: string;
  match_kind: string | null;
  value: string;
  confidence: number;
  times_applied: number;
}

/** Default questions-per-batch ceiling before any decay. */
const BASE_BUDGET = 3;

export function isLearningEnabled(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key='learning.enabled'")
    .get() as { value?: string } | undefined;
  // ON at install, per plan §5. Only an explicit "false" disables it.
  return row?.value !== "false";
}

/**
 * How many questions we may ask right now.
 *
 * Coverage: the more rules exist, the less we need to ask. Fatigue: every
 * unanswered question already waiting reduces the budget, so an ignored queue
 * goes quiet instead of growing.
 */
export function questionBudget(db: DatabaseSync): number {
  if (!isLearningEnabled(db)) return 0;

  const rules = (db.prepare("SELECT COUNT(*) n FROM learned_rules WHERE active=1").get() as { n: number }).n;
  const open = (
    db
      .prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NULL AND dismissed=0")
      .get() as { n: number }
  ).n;
  const answered = (
    db.prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NOT NULL").get() as { n: number }
  ).n;

  let budget = BASE_BUDGET;
  budget -= Math.floor(rules / 10); // coverage decay
  budget -= Math.floor(open / 2); // fatigue: don't pile on
  if (answered > 0) budget += 1; // engaged users get asked a little more
  return Math.max(0, Math.min(BASE_BUDGET + 1, budget));
}

/** Ask a question, if the budget allows. Returns the review id, or null. */
export function ask(
  db: DatabaseSync,
  ports: Ports,
  q: {
    question: string;
    trigger: string;
    context?: Record<string, unknown>;
    options?: string[];
  },
): number | null {
  if (questionBudget(db) <= 0) return null;

  // Never ask the same question twice while it is still open.
  const dupe = db
    .prepare(
      "SELECT id FROM training_reviews WHERE question=? AND answered_at IS NULL AND dismissed=0",
    )
    .get(q.question) as { id: number } | undefined;
  if (dupe) return dupe.id;

  const info = db
    .prepare(
      `INSERT INTO training_reviews (question, context, trigger, options, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      q.question,
      q.context ? JSON.stringify(q.context) : null,
      q.trigger,
      q.options ? JSON.stringify(q.options) : null,
      ports.clock.isoNow(),
    );
  ports.logger.info("learning: asked", { question: q.question, trigger: q.trigger });
  return Number(info.lastInsertRowid);
}

/** Record an answer and turn it into a rule. */
export function answer(
  db: DatabaseSync,
  ports: Ports,
  reviewId: number,
  chosen: string,
  rule?: { kind: RuleKind; match_key: string; match_kind?: string; value: string },
): { rule_id: number | null } {
  const now = ports.clock.isoNow();
  let ruleId: number | null = null;

  if (rule) {
    const info = db
      .prepare(
        `INSERT INTO learned_rules (kind, match_key, match_kind, value, source, created_at)
         VALUES (?,?,?,?, 'user', ?)
         ON CONFLICT(kind, match_key, COALESCE(match_kind,''))
         DO UPDATE SET value=excluded.value, active=1, confidence=1.0`,
      )
      .run(rule.kind, rule.match_key, rule.match_kind ?? null, rule.value, now);
    ruleId = Number(info.lastInsertRowid);
    ports.logger.info("learning: rule created", { kind: rule.kind, key: rule.match_key });
  }

  db.prepare("UPDATE training_reviews SET answer=?, answered_at=?, rule_id=? WHERE id=?")
    .run(chosen, now, ruleId, reviewId);
  if (ruleId !== null) {
    ports.bus.publish({ type: "learning.rule.applied", ruleId, at: now });
  }
  ports.bus.publish({
    type: "learning.answer",
    questionId: String(reviewId),
    answeredAt: now,
    answer: chosen,
  });
  return { rule_id: ruleId };
}

export function dismiss(db: DatabaseSync, reviewId: number): void {
  db.prepare("UPDATE training_reviews SET dismissed=1 WHERE id=?").run(reviewId);
}

/** Look up an applicable rule. Returns its value, or null. */
export function applyRule(
  db: DatabaseSync,
  ports: Ports,
  kind: RuleKind,
  rawKey: string,
  matchKind?: string,
): string | null {
  const key = kind === "descriptor_to_entity" ? normaliseDescriptor(rawKey) : normaliseName(rawKey);
  if (!key) return null;

  const rule = db
    .prepare(
      `SELECT id, value FROM learned_rules
       WHERE kind=? AND match_key=? AND COALESCE(match_kind,'')=COALESCE(?,'') AND active=1`,
    )
    .get(kind, key, matchKind ?? null) as { id: number; value: string } | undefined;
  if (!rule) return null;

  db.prepare(
    "UPDATE learned_rules SET times_applied=times_applied+1, last_applied_at=? WHERE id=?",
  ).run(ports.clock.isoNow(), rule.id);
  return rule.value;
}

/**
 * A vendor correction is evidence for a rule (work order 03 §P2).
 *
 * When the user fixes "SHANTARAM MAHESH" to "Petasight Inc." on an invoice,
 * the interesting fact is not that one document was wrong — it is that the
 * DESCRIPTOR maps to that entity, and will keep arriving. This proposes the
 * descriptor→entity rule so the same correction stops recurring.
 *
 * PROPOSES, never auto-applies. The rule lands inactive with source='user'
 * and must be confirmed before it can rewrite anything: a rule derived from a
 * single document is a hypothesis, and silently applying it to every future
 * document that shares a descriptor is how one typo becomes a hundred.
 *
 * Returns null when there is nothing worth learning (no descriptor to key on,
 * no such entity, or the rule already exists) rather than inventing a rule
 * from a value the vault cannot resolve.
 */
export function proposeDescriptorRule(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  correctedName: string,
): { rule_id: number; match_key: string; value: string; active: boolean } | null {
  const name = correctedName.trim();
  if (!name) return null;

  // The descriptor is what the MODEL read — the raw string that was wrong.
  // Keying the rule on the corrected name would be circular: it would only
  // fire on documents that are already right.
  const doc = db.prepare("SELECT extraction_json, original_filename FROM documents WHERE id=?").get(documentId) as
    | { extraction_json: string | null; original_filename: string }
    | undefined;
  if (!doc?.extraction_json) return null;

  let descriptor: string | null = null;
  try {
    const x = JSON.parse(doc.extraction_json) as {
      counterparty_descriptor?: string | null;
      parties?: Array<{ role?: string; kind?: string; name?: string }>;
    };
    const party = (x.parties ?? []).find((pp) => pp.role === "counterparty" && pp.kind === "organisation");
    descriptor = x.counterparty_descriptor ?? party?.name ?? null;
  } catch {
    return null;
  }

  const key = normaliseDescriptor(descriptor ?? "");
  if (!key) return null;

  // Don't learn a rule that maps a descriptor to itself.
  if (key === normaliseDescriptor(name)) return null;

  const entity = db
    .prepare("SELECT id FROM entities WHERE kind='organisation' AND lower(display_name)=lower(?)")
    .get(name) as { id: string } | undefined;
  if (!entity) return null;

  const existing = db
    .prepare(
      `SELECT id, active FROM learned_rules
        WHERE kind='descriptor_to_entity' AND match_key=? AND COALESCE(match_kind,'')='organisation'`,
    )
    .get(key) as { id: number; active: number } | undefined;
  if (existing) return null;

  const info = db
    .prepare(
      `INSERT INTO learned_rules (kind, match_key, match_kind, value, source, confidence, active, created_at)
       VALUES ('descriptor_to_entity', ?, 'organisation', ?, 'user', 0.8, 0, ?)`,
    )
    .run(key, entity.id, ports.clock.isoNow());

  ports.logger.info("rule proposed from correction", {
    document_id: documentId,
    descriptor: key,
    entity: name,
  });

  return { rule_id: Number(info.lastInsertRowid), match_key: key, value: entity.id, active: false };
}

/**
 * Near-duplicate entities WITHIN one kind.
 *
 * OCR truncates merchant names differently per document — one real vault
 * produced "VizChitra", "VIZCHITRA 2026" and "VizChitra (The Org of Fine &
 * Curious Individuals)" as three separate organisations. These are PROPOSALS
 * only: "Imperial Restaurant 151" and "185" could genuinely be two branches,
 * so the user decides. Auto-merging would silently corrupt the ledger.
 */
export function findNearDuplicates(
  db: DatabaseSync,
  kind: string,
  limit = 20,
): { a: { id: string; name: string }; b: { id: string; name: string }; score: number; reason: string }[] {
  const rows = db
    .prepare("SELECT id, display_name FROM entities WHERE kind=? ORDER BY display_name")
    .all(kind) as { id: string; display_name: string }[];

  const out: { a: { id: string; name: string }; b: { id: string; name: string }; score: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i];
      const B = rows[j];
      const na = normaliseName(A.display_name);
      const nb = normaliseName(B.display_name);
      if (!na || !nb) continue;

      let score = 0;
      let reason = "";

      if (na === nb) {
        score = 0.98;
        reason = "identical after normalisation";
      } else if (na.startsWith(nb) || nb.startsWith(na)) {
        // "vizchitra" vs "vizchitra 2026" — one is a truncation of the other.
        const shorter = Math.min(na.length, nb.length);
        const longer = Math.max(na.length, nb.length);
        if (shorter >= 5) {
          score = 0.75 + 0.2 * (shorter / longer);
          reason = "one name is a prefix of the other";
        }
      } else {
        // Shared leading words, e.g. "imperial restaurant since 151/185".
        const wa = na.split(" ");
        const wb = nb.split(" ");
        let shared = 0;
        while (shared < wa.length && shared < wb.length && wa[shared] === wb[shared]) shared++;
        if (shared >= 2 && shared >= Math.min(wa.length, wb.length) - 1) {
          score = 0.62 + 0.05 * shared;
          reason = `${shared} leading words in common`;
        }
      }

      if (score >= 0.6) {
        out.push({
          a: { id: A.id, name: A.display_name },
          b: { id: B.id, name: B.display_name },
          score: Math.min(0.99, score),
          reason,
        });
      }
    }
  }

  return out.sort((x, y) => y.score - x.score).slice(0, limit);
}
