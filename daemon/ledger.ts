/**
 * Ledger — turn an ExtractionResult into entities, a transaction, and legs.
 * Plan §3. This is where the two thesis rules become code:
 *
 *   1. Entity resolution is KIND-SCOPED. "Swiggy" as a merchant, as a wallet,
 *      and as an equity are three rows that can never merge (anti-pollution).
 *   2. Wallet loads are TRANSFERS: two legs across accounts I own, no
 *      counterparty, excluded from Income/Spending.
 */
import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { fyKey, normaliseName, type Kind } from "./schema.js";
import type { ExtractionResult, ExtractedParty } from "./extraction-contract.js";

const newId = (p: string) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

/**
 * Resolve a name to an entity WITHIN a kind. Never matches across kinds — that
 * invariant is what stops a merchant absorbing a wallet or an instrument.
 */
export function resolveEntity(
  db: DatabaseSync,
  ports: Ports,
  name: string,
  kind: Kind,
  opts: { subtype?: string; identifiers?: Record<string, string>; institutionEntityId?: string } = {},
): string {
  const norm = normaliseName(name);
  if (!norm) throw new Error(`cannot resolve empty name for kind=${kind}`);

  // 1. exact (kind, normalised name)
  const direct = db
    .prepare("SELECT id FROM entities WHERE kind=? AND lower(display_name)=lower(?)")
    .get(kind, name) as { id: string } | undefined;
  if (direct) return direct.id;

  // 2. kind-scoped alias table
  const viaAlias = db
    .prepare("SELECT entity_id FROM entity_aliases WHERE kind=? AND normalised=?")
    .get(kind, norm) as { entity_id: string } | undefined;
  if (viaAlias) return viaAlias.entity_id;

  // 3. normalised-name match against existing rows OF THE SAME KIND
  const sameKind = db.prepare("SELECT id, display_name FROM entities WHERE kind=?").all(kind) as unknown as {
    id: string;
    display_name: string;
  }[];
  for (const e of sameKind) {
    if (normaliseName(e.display_name) === norm) {
      db.prepare(
        "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
      ).run(e.id, kind, name, norm, "auto", ports.clock.isoNow());
      return e.id;
    }
  }

  // 4. ACCOUNT-ONLY containment match.
  //    Documents name the same stored-value account inconsistently: a top-up
  //    receipt says "Swiggy Money Wallet", the order invoice says "Swiggy
  //    Money". Left unmerged these become two accounts and wallet balance can
  //    never reconcile (load credits one, spend debits the other).
  //    Deliberately restricted to kind='account': for organisations,
  //    containment would wrongly merge distinct merchants sharing a word, and
  //    it must NEVER be allowed to cross kinds (the anti-pollution invariant).
  if (kind === "account") {
    const filler = /\b(wallet|account|a\/c|balance|card|savings|current|upi|money)\b/g;
    const core = (s: string) => normaliseName(s).replace(filler, " ").replace(/\s+/g, " ").trim();
    // Trailing digits identify WHICH account at an institution: "HDFC ...1767"
    // (savings) and "HDFC ...1668" (credit card) share the stem "hdfc bank"
    // but are different accounts. If both sides carry digits they must agree,
    // or we merge a card into a savings account and legs point at the wrong one.
    const digits = (s: string) => (s.match(/\d{3,}/g) ?? []).join("");
    // Account TYPE is a hard discriminator even when digits are absent: a
    // savings account and a credit card at the same bank are never the same
    // store of funds, however similar their names look.
    const acctType = (s: string): string | null => {
      const t = s.toLowerCase();
      if (/credit card/.test(t)) return "credit_card";
      if (/debit card/.test(t)) return "debit_card";
      if (/wallet|money/.test(t)) return "wallet";
      if (/savings|current|savings account/.test(t)) return "bank";
      return null;
    };
    const myCore = core(name);
    const myDigits = digits(name);
    const myType = acctType(name);
    // Require a meaningful stem so two accounts named only "wallet" don't merge.
    if (myCore.length >= 4) {
      for (const e of sameKind) {
        const theirCore = core(e.display_name);
        if (theirCore.length < 4) continue;
        const theirDigits = digits(e.display_name);
        if (myDigits && theirDigits && myDigits !== theirDigits) continue;
        const theirType = acctType(e.display_name);
        if (myType && theirType && myType !== theirType) continue;
        if (myCore === theirCore || myCore.includes(theirCore) || theirCore.includes(myCore)) {
          db.prepare(
            "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
          ).run(e.id, kind, name, norm, "auto-account-core", ports.clock.isoNow());
          ports.logger.info("account alias merged", { alias: name, into: e.display_name, core: myCore });
          return e.id;
        }
      }
    }
  }

  // 5. create
  const id = newId("ent");
  db.prepare(
    `INSERT INTO entities (id, kind, subtype, display_name, identifiers_json, institution_entity_id, confidence, status, created_at)
     VALUES (?,?,?,?,?,?,?,'candidate',?)`,
  ).run(
    id,
    kind,
    opts.subtype ?? null,
    name,
    opts.identifiers ? JSON.stringify(opts.identifiers) : null,
    opts.institutionEntityId ?? null,
    0.8,
    ports.clock.isoNow(),
  );
  db.prepare(
    "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
  ).run(id, kind, name, norm, "auto", ports.clock.isoNow());
  ports.logger.info("entity created", { kind, name, id });
  return id;
}

/** Heuristic: does this text name an account I own rather than a counterparty? */
function looksLikeOwnedAccount(text: string): boolean {
  return /\b(wallet|balance|savings|current|credit card|debit card|a\/c|account|money)\b/i.test(text);
}

export interface RecordResult {
  transaction_id: string;
  direction: string;
  amount_minor: number;
  created_entities: number;
}

/**
 * Write one transaction (+ legs + evidence link) from an extraction.
 * Returns null when the extraction has no usable money movement.
 */
export function recordTransaction(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  x: ExtractionResult,
): RecordResult | null {
  if (x.doc_type === "irrelevant" || x.amount_minor === null || x.amount_minor <= 0) return null;

  const before = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  const occurred = x.occurred_at ?? ports.clock.isoNow().slice(0, 10);

  // ── the wallet rule ───────────────────────────────────────────────────────
  // A top-up moves money between two accounts I own. There is no counterparty
  // and it must never touch Income/Spending. Detection uses the model's
  // is_wallet_topup plus corroborating structural signals.
  const isTransfer =
    x.is_wallet_topup ||
    x.direction === "transfer" ||
    x.doc_type === "wallet_topup_confirmation" ||
    (!!x.destination_of_funds_text && looksLikeOwnedAccount(x.destination_of_funds_text) && !!x.source_of_funds_text);

  const direction = isTransfer ? "transfer" : (x.direction ?? "out");

  // ── entities ──────────────────────────────────────────────────────────────
  const partyOf = (role: ExtractedParty["role"], kind?: Kind) =>
    x.parties.find((p) => p.role === role && (!kind || p.kind === kind));

  // Source of funds is an ACCOUNT I own — never a merchant.
  const srcParty = partyOf("source_of_funds", "account");
  const srcName = srcParty?.name ?? x.source_of_funds_text ?? null;
  const sourceAccountId = srcName
    ? resolveEntity(db, ports, srcName, "account", { subtype: srcParty?.subtype ?? guessAccountSubtype(srcName) })
    : null;

  let counterpartyId: string | null = null;
  let destAccountId: string | null = null;

  if (isTransfer) {
    // Destination is another account I own. Resolving it as kind='account'
    // is what keeps "Swiggy UPI Wallet" separate from "Swiggy Limited".
    const destName = x.destination_of_funds_text ?? partyOf("counterparty")?.name ?? null;
    if (destName) {
      destAccountId = resolveEntity(db, ports, destName, "account", { subtype: "wallet" });
    }
  } else {
    // Prefer the specific merchant over the platform when both are present.
    const cp = x.parties.filter((p) => p.role === "counterparty" && p.kind === "organisation");
    const chosen = cp[0];
    const name = chosen?.name ?? x.counterparty_descriptor;
    if (name) {
      counterpartyId = resolveEntity(db, ports, name, "organisation", {
        subtype: chosen?.subtype ?? "merchant",
        identifiers: chosen?.identifiers,
      });
    }
  }

  // ── transaction ───────────────────────────────────────────────────────────
  const id = newId("txn");
  const now = ports.clock.isoNow();
  db.prepare(
    `INSERT INTO transactions
      (id, occurred_at, posted_at, fy_key, amount_minor, currency, direction,
       counterparty_entity_id, payment_rail, impact_bucket, purpose_text,
       status, confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    occurred,
    x.posted_at ?? null,
    fyKey(occurred),
    x.amount_minor,
    x.currency || "INR",
    direction,
    // CHECK constraint enforces this too, but be explicit: transfers have no counterparty.
    isTransfer ? null : counterpartyId,
    x.payment_rail ?? null,
    isTransfer ? "transfer" : (x.category_hint ?? null),
    x.purpose_text ?? null,
    "evidenced",
    x.confidence,
    now,
  );

  // ── legs ──────────────────────────────────────────────────────────────────
  const addLeg = (accountId: string, leg: "debit" | "credit") =>
    db
      .prepare("INSERT INTO transaction_legs (transaction_id, account_entity_id, leg, amount_minor) VALUES (?,?,?,?)")
      .run(id, accountId, leg, x.amount_minor!);

  if (sourceAccountId) addLeg(sourceAccountId, "debit");
  if (isTransfer && destAccountId) addLeg(destAccountId, "credit");

  // ── evidence ──────────────────────────────────────────────────────────────
  db.prepare(
    `INSERT OR IGNORE INTO transaction_documents
      (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, documentId, evidenceRole(x), 1.0, "ai", now);

  // ── provenance ────────────────────────────────────────────────────────────
  const claim = db.prepare(
    "INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, created_at) VALUES ('transaction',?,?,?,'ai',?,?)",
  );
  claim.run(id, "amount_minor", String(x.amount_minor), x.confidence, now);
  claim.run(id, "occurred_at", occurred, x.confidence, now);
  claim.run(id, "direction", direction, x.confidence, now);

  ports.bus.publish({
    type: "TransactionRecorded",
    transaction_id: id,
    direction,
    amount_minor: x.amount_minor,
    at: now,
  });

  const after = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  return { transaction_id: id, direction, amount_minor: x.amount_minor, created_entities: after - before };
}

function guessAccountSubtype(name: string): string {
  const s = name.toLowerCase();
  if (/wallet|money\b/.test(s)) return "wallet";
  if (/credit card/.test(s)) return "credit_card";
  if (/debit card/.test(s)) return "debit_card";
  if (/savings|current|bank/.test(s)) return "bank";
  return "bank";
}

export function evidenceRole(x: ExtractionResult): string {
  switch (x.doc_type) {
    case "merchant_invoice": return "merchant_invoice";
    case "card_confirmation": return "card_confirmation";
    case "bank_slip": return "bank_slip";
    case "wallet_topup_confirmation":
    case "payment_receipt": return "payment_receipt";
    case "statement_line": return "statement_line";
    case "refund_note": return "refund_note";
    case "contract_note": return "contract_note";
    default: return "payment_receipt";
  }
}
