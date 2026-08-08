/**
 * One-time migration: Glaze-era corrections → daemon claims (work order 03 §P2).
 *
 *   node --experimental-strip-types daemon/migrate-glaze.ts --dry-run
 *   node --experimental-strip-types daemon/migrate-glaze.ts --apply
 *
 * WHY THIS EXISTS
 *
 * The retired Glaze app accumulated 1109 field reviews, 73 learned rules and 19
 * person aliases — a year of the user teaching the app things the model got
 * wrong. The daemon vault shares 67 of those documents BY CONTENT HASH, so the
 * corrections are still true statements about documents the daemon holds.
 * Throwing them away would mean re-teaching the vault everything.
 *
 * WHAT IT DELIBERATELY DOES **NOT** IMPORT
 *
 * Most of the Glaze `learned_rules` table is not rule data. It stored free-text
 * answers to curiosity questions in the same column as rule values, so it
 * contains rows like `swiggy => Yes`, `vidya rao => Forwarding only` and
 * `payslip => Yes`. Importing those would inject nonsense the resolver would
 * then apply to real money. They are skipped, loudly and by count.
 *
 * Two whole field families are also skipped because the vocabularies do not
 * mean the same thing:
 *
 *   impact      Glaze: income | business_expense | personal_expense (an
 *               ACCOUNTING classification). Daemon impact_bucket: food_delivery
 *               | groceries | telecom_bill (a SPEND CATEGORY). Mapping one onto
 *               the other would be invention, not migration.
 *   accounting  prepaid_expense / accrued_expense / recognized_revenue — an
 *               accrual layer the daemon does not model at all. There is
 *               nowhere honest to put it.
 *
 * The archived Glaze DB keeps both, so nothing is lost — they are simply not
 * claims the daemon can make truthfully today. If an accrual layer is ever
 * built, the archive is the source to re-import from.
 *
 * IDEMPOTENT: re-running writes nothing new. Every claim carries source
 * 'import' and is matched on (subject, field, value) before insert.
 */
import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import * as os from "node:os";

import { createPorts } from "./adapters.js";
import { openDatabase, normaliseName } from "./schema.js";
import { writeClaim, audit, propagateFromDocument, ClaimRefused } from "./claims.js";
import type { Ports } from "./ports.js";

const GLAZE_DB =
  process.env.Q2AV_GLAZE_DB ??
  path.join(
    os.homedir(),
    "Library/Application Support/app.glaze.macos.v18ju915-local/quick2afvault.db",
  );

/**
 * Glaze stored doc_type as a display string typed by the user; the daemon uses
 * the extraction-contract enum. Anything not in this table is skipped rather
 * than guessed — a wrong doc_type changes which document wins the settlement
 * role in the resolver, and therefore changes the canonical amount.
 */
const DOC_TYPE_MAP: Record<string, string> = {
  "tax invoice": "merchant_invoice",
  invoice: "merchant_invoice",
  "contract note": "contract_note",
  "contract note cum tax invoice": "contract_note",
  receipt: "payment_receipt",
  "payment receipt": "payment_receipt",
  payslip: "salary_slip",
  "salary slip": "salary_slip",
  "bank statement": "statement_line",
  "credit card statement": "statement_line",
};

/** Glaze field name → daemon document-scope field. Omitted = not portable. */
const FIELD_MAP: Record<string, string> = {
  vendor: "vendor",
  doc_type: "doc_type",
  doc_date: "document_date",
  amount: "amount_minor",
};

interface Stats {
  shared_documents: number;
  claims_written: number;
  claims_skipped_unmappable: number;
  claims_already_present: number;
  parties_linked: number;
  parties_no_such_person: number;
  aliases_written: number;
  rules_written: number;
  rules_rejected_freetext: number;
  transactions_reresolved: number;
}

/**
 * A Glaze "rule value" is only usable when it looks like a VALUE rather than a
 * conversational answer. The curiosity UI wrote both into the same column.
 */
function isFreeTextAnswer(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.length < 2) return true;
  return /^(yes|no|maybe|none|n\/a|ok|okay|your account|forwarding only|shared household|business|personal( subscription)?)$/.test(
    v,
  );
}

/** A person-variant value is usable only when it reads like a human name. */
function looksLikePersonName(value: string): boolean {
  const v = value.trim();
  if (isFreeTextAnswer(v)) return false;
  if (v.includes("@")) return false; // an address is an alias key, not a name
  return /^[\p{L}][\p{L}.'-]*(\s+[\p{L}][\p{L}.'-]*)+$/u.test(v);
}

export function migrateGlaze(
  daemonDb: DatabaseSync,
  ports: Ports,
  glazeDbPath: string,
  apply: boolean,
): Stats {
  const g = new DatabaseSync(glazeDbPath, { readOnly: true });
  const stats: Stats = {
    shared_documents: 0,
    claims_written: 0,
    claims_skipped_unmappable: 0,
    claims_already_present: 0,
    parties_linked: 0,
    parties_no_such_person: 0,
    aliases_written: 0,
    rules_written: 0,
    rules_rejected_freetext: 0,
    transactions_reresolved: 0,
  };

  // ── documents shared by CONTENT HASH ──────────────────────────────────────
  // sha256 is the only identity both databases agree on: Glaze used integer
  // ids, the daemon uses doc_<hex>, and the two vault directories differ in
  // case ("Quick2Afvault" vs "Quick2AVault"), so paths cannot be joined on.
  const glazeDocs = g.prepare("SELECT id, hash, original_filename FROM documents").all() as Array<{
    id: number;
    hash: string;
    original_filename: string;
  }>;
  const daemonByHash = new Map(
    (
      daemonDb.prepare("SELECT id, sha256 FROM documents").all() as Array<{
        id: string;
        sha256: string;
      }>
    ).map((r) => [r.sha256, r.id]),
  );
  const glazeIdToDaemonId = new Map<number, string>();
  for (const d of glazeDocs) {
    const daemonId = daemonByHash.get(d.hash);
    if (daemonId) glazeIdToDaemonId.set(d.id, daemonId);
  }
  stats.shared_documents = glazeIdToDaemonId.size;

  const touchedDocs = new Set<string>();

  // ── field corrections → document-scope claims ─────────────────────────────
  // Only status='corrected' with a final_value: a 'confirmed' row means the
  // user agreed with the model, which the daemon's own extraction already
  // captured. Importing agreement as a user claim would fabricate authority
  // the user never actually exercised.
  const corrections = g
    .prepare(
      `SELECT doc_id, field, extracted_value, final_value, updated_at
         FROM document_field_reviews
        WHERE status='corrected' AND final_value IS NOT NULL`,
    )
    .all() as Array<{
    doc_id: number;
    field: string;
    extracted_value: string | null;
    final_value: string;
    updated_at: string;
  }>;

  for (const c of corrections) {
    const daemonDocId = glazeIdToDaemonId.get(c.doc_id);
    if (!daemonDocId) continue;

    const field = FIELD_MAP[c.field];
    if (!field) {
      stats.claims_skipped_unmappable++;
      continue;
    }

    let value: string | null = c.final_value.trim();

    if (field === "doc_type") {
      const mapped = DOC_TYPE_MAP[value.toLowerCase()];
      if (!mapped) {
        stats.claims_skipped_unmappable++;
        continue;
      }
      value = mapped;
    }

    if (field === "amount_minor") {
      // Glaze stored MAJOR units ("812" = ₹812). The daemon stores minor units
      // and treats a float as a corruption, so this conversion is the whole
      // reason amount cannot be copied across verbatim.
      const major = Number(value.replace(/[^0-9.-]/g, ""));
      if (!Number.isFinite(major)) {
        stats.claims_skipped_unmappable++;
        continue;
      }
      value = String(Math.round(major * 100));
    }

    if (field === "document_date") {
      if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
        stats.claims_skipped_unmappable++;
        continue;
      }
      value = value.slice(0, 10);
    }

    // Idempotency: an identical imported claim already present means this
    // migration has run before.
    const existing = daemonDb
      .prepare(
        `SELECT id FROM field_claims
          WHERE subject_type='document' AND subject_id=? AND field=? AND value=? AND source='import'`,
      )
      .get(daemonDocId, field, value);
    if (existing) {
      stats.claims_already_present++;
      continue;
    }

    if (apply) {
      try {
        // source='import', NOT 'user'. The user did make this correction, but
        // they made it in a different app against a different schema. Import
        // authority sits below user so a correction made in the Flutter client
        // today always wins over a migrated one.
        writeClaim(daemonDb, ports, {
          subject: "document",
          subjectId: daemonDocId,
          field,
          value,
          source: "import",
          confidence: 0.9,
          status: "confirmed",
        });
        audit(daemonDb, ports, {
          subject: "document",
          subjectId: daemonDocId,
          field,
          action: "edit",
          oldValue: c.extracted_value,
          newValue: value,
          source: "import:glaze",
        });
        touchedDocs.add(daemonDocId);
        stats.claims_written++;
      } catch (err) {
        if (err instanceof ClaimRefused) {
          ports.logger.warn("import refused", { document_id: daemonDocId, field, reason: err.code });
          stats.claims_skipped_unmappable++;
        } else {
          throw err;
        }
      }
    } else {
      stats.claims_written++;
    }
  }

  // ── person corrections → document_parties ─────────────────────────────────
  // "Who does this document belong to" is document-scope in the daemon too,
  // but it is expressed as a LINK (document_parties) rather than a claim,
  // because a person is an entity and the join carries the role.
  //
  // Never creates a person. If the corrected name is not already an entity in
  // this vault, the link is skipped and counted: inventing a person from
  // another app's database would put someone in the ledger that no document
  // here actually names.
  const personCorrections = g
    .prepare(
      `SELECT doc_id, extracted_value, final_value
         FROM document_field_reviews
        WHERE field='person' AND status='corrected' AND final_value IS NOT NULL`,
    )
    .all() as Array<{ doc_id: number; extracted_value: string | null; final_value: string }>;

  for (const pc of personCorrections) {
    const daemonDocId = glazeIdToDaemonId.get(pc.doc_id);
    if (!daemonDocId) continue;

    const name = pc.final_value.trim();
    if (!name) continue;

    const person = daemonDb
      .prepare("SELECT id FROM entities WHERE kind='person' AND lower(display_name)=lower(?)")
      .get(name) as { id: string } | undefined;
    if (!person) {
      stats.parties_no_such_person++;
      continue;
    }

    const present = daemonDb
      .prepare("SELECT 1 FROM document_parties WHERE document_id=? AND entity_id=? AND role='owner'")
      .get(daemonDocId, person.id);
    if (present) {
      stats.claims_already_present++;
      continue;
    }

    if (apply) {
      daemonDb
        .prepare("INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?,'owner')")
        .run(daemonDocId, person.id);
      audit(daemonDb, ports, {
        subject: "document",
        subjectId: daemonDocId,
        field: "parties",
        action: "edit",
        oldValue: pc.extracted_value,
        newValue: name,
        source: "import:glaze",
      });
    }
    stats.parties_linked++;
  }

  // ── person aliases → kind-scoped entity aliases ───────────────────────────
  // The highest-value import: "SHANTARAM MAHESH", "Mahesh Shantaram" and
  // "ms@thecontrarian.in" are the SAME human, and the daemon relearning that
  // from scratch requires the same documents to arrive in the same order.
  const aliases = g
    .prepare(
      `SELECT pa.alias, pa.normalized, pa.source, p.display_name, p.is_self
         FROM person_aliases pa JOIN persons p ON p.id = pa.person_id
        WHERE pa.source = 'user_confirmed'`,
    )
    .all() as Array<{
    alias: string;
    normalized: string;
    source: string;
    display_name: string;
    is_self: number;
  }>;

  for (const a of aliases) {
    const person = daemonDb
      .prepare("SELECT id FROM entities WHERE kind='person' AND lower(display_name)=lower(?)")
      .get(a.display_name) as { id: string } | undefined;
    // Never CREATE a person here. An alias is a statement about an entity that
    // already exists; inventing the entity would put a person in the ledger
    // that no document in this vault actually names.
    if (!person) continue;

    const norm = normaliseName(a.alias);
    if (!norm) continue;
    const present = daemonDb
      .prepare("SELECT 1 FROM entity_aliases WHERE kind='person' AND normalised=?")
      .get(norm);
    if (present) continue;

    if (apply) {
      daemonDb
        .prepare(
          `INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at)
           VALUES (?, 'person', ?, ?, 'import:glaze', ?)`,
        )
        .run(person.id, a.alias, norm, ports.clock.isoNow());
    }
    stats.aliases_written++;
  }

  // ── learned rules → descriptor_to_entity, filtered hard ───────────────────
  const personVariants = g
    .prepare("SELECT match_key, value FROM learned_rules WHERE rule_type='person_variant'")
    .all() as Array<{ match_key: string; value: string }>;

  for (const r of personVariants) {
    if (!looksLikePersonName(r.value)) {
      stats.rules_rejected_freetext++;
      continue;
    }
    const key = normaliseName(r.match_key);
    if (!key) continue;
    const present = daemonDb
      .prepare(
        "SELECT 1 FROM learned_rules WHERE kind='entity_alias' AND match_key=? AND COALESCE(match_kind,'')='person'",
      )
      .get(key);
    if (present) continue;

    if (apply) {
      daemonDb
        .prepare(
          `INSERT INTO learned_rules (kind, match_key, match_kind, value, source, confidence, created_at)
           VALUES ('entity_alias', ?, 'person', ?, 'import', 0.9, ?)
           ON CONFLICT(kind, match_key, COALESCE(match_kind,'')) DO NOTHING`,
        )
        .run(key, r.value.trim(), ports.clock.isoNow());
    }
    stats.rules_written++;
  }

  // Count what we refused across the noisy rule families, so the report is
  // honest about how much of that "73 learned rules" was actually usable.
  const noisy = g
    .prepare(
      `SELECT value FROM learned_rules
        WHERE rule_type IN ('vendor_category','keyword_doctype','source_scope')`,
    )
    .all() as Array<{ value: string }>;
  stats.rules_rejected_freetext += noisy.length;

  // ── re-resolve every transaction a migrated claim touches ─────────────────
  if (apply) {
    for (const docId of touchedDocs) {
      const results = propagateFromDocument(daemonDb, ports, docId, ["import:glaze"]);
      stats.transactions_reresolved += results.length;
    }
  }

  g.close();
  return stats;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith("migrate-glaze.ts");
if (isMain) {
  const apply = process.argv.includes("--apply");
  const ports = createPorts({ vaultRoot: process.env.Q2AV_VAULT, logLevel: "info" });
  const db = openDatabase(ports.paths.dbPath());

  ports.logger.info(apply ? "MIGRATING (writes enabled)" : "DRY RUN (no writes)", {
    glaze_db: GLAZE_DB,
    daemon_db: ports.paths.dbPath(),
  });

  const stats = migrateGlaze(db, ports, GLAZE_DB, apply);

  console.log("\n  Glaze → daemon migration" + (apply ? "" : " (DRY RUN)"));
  console.log("  ────────────────────────────────────────────");
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k.replace(/_/g, " ").padEnd(28)} ${v}`);
  }
  console.log(
    apply
      ? "\n  Applied. Re-run to confirm idempotency (all counts should drop to 0).\n"
      : "\n  Nothing written. Re-run with --apply to commit.\n",
  );
  db.close();
}
