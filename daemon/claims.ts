/**
 * Claims + resolver (work order 03 §P2) — the editing unblock.
 *
 * THE MODEL
 *
 * A claim is a statement that some FIELD of some SUBJECT has some VALUE,
 * made by someone (ai | rule | user | import) at some time. Subjects come in
 * three scopes:
 *
 *   document     what the paper says     (issuer, printed amount, doc date)
 *   transaction  what the ledger holds   (direction, counterparty, category)
 *   entity       who someone is          (display name, kind, identifiers)
 *
 * Editing in the document browser writes DOCUMENT-scope claims, and the
 * resolver propagates them into linked transactions. The obvious alternative —
 * resolve doc→txn at edit time, write only transaction claims — breaks in two
 * places that both exist in a real vault:
 *
 *   1. ORPHAN DOCUMENTS have no transaction to write to. The correction would
 *      be silently dropped, and re-linking later could not recover it.
 *   2. STATEMENTS (one document, many transactions) have no single target.
 *
 * AUTHORITY
 *
 *   user > rule > ai, and a `confirmed` claim is NEVER overwritten.
 *
 * That invariant existed in prose across three files. It lives here now, in
 * one function, because a precedence rule enforced in three places is a
 * precedence rule that will eventually disagree with itself.
 *
 * DERIVATION
 *
 * Transaction canonical values derive from linked evidence by ROLE, not by
 * recency:
 *
 *   amount_minor  txn user claim → settlement doc → invoice doc → null+review
 *   occurred_at   invoice/document date (the ECONOMIC date)
 *   posted_at     settlement date
 *   counterparty  invoice/merchant role; a statement descriptor only via rules
 *
 * The settlement-wins rule is the one with teeth: when a card confirmation and
 * an invoice disagree, the money that actually moved is what the bank says
 * moved. Editing the invoice corrects the DOCUMENT and surfaces a mismatch,
 * but it does not move the ledger.
 */
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import type { ClaimSource, ClaimStatus, ClaimSubject } from "./schema.js";
import { resolveEntity } from "./ledger.js";
import { fyKeyFor, loadPack } from "./jurisdiction.js";

/** Fields a user may correct on a DOCUMENT (what the paper says). */
export const DOCUMENT_FIELDS = new Set([
  "doc_type",
  "issuer",
  "vendor",
  "counterparty",
  "document_date",
  "amount_minor",
  "currency",
  "reference_ids",
  "purpose_text",
  // Work order 05 §Track C: who the human on this document is. Edits stay
  // document-scoped (claims.ts) and the identity resolver relinks parties
  // only for confirmed corrections (identity.ts applyPersonCorrection).
  "person",
  "documentType",
  "documentNumber",
  "documentDate",
  "financialYear",
  "category",
  "currencyConversion",
  "financialImpact",
  "lineItems",
  "trades",
]);

/** Fields a user may correct on a TRANSACTION (what the ledger holds). */
export const TRANSACTION_FIELDS = new Set([
  "direction",
  "occurred_at",
  "posted_at",
  "amount_minor",
  "currency",
  "counterparty",
  "category_id",
  "impact_bucket",
  "status",
  "purpose_text",
]);

/** Fields a user may correct on an ENTITY (who someone is). */
export const ENTITY_FIELDS = new Set(["display_name", "kind", "identifiers", "relationship"]);
/** Claims whose subject is a document party key: `${documentId}:${entityId}:${role}`. */
export const DOCUMENT_PARTY_FIELDS = new Set(["counterparty", "issuer", "owner", "sourceOfFunds", "relationship"]);

export function allowedFields(subject: ClaimSubject): Set<string> {
  return subject === "document"
    ? DOCUMENT_FIELDS
    : subject === "transaction"
      ? TRANSACTION_FIELDS
      : subject === "entity"
        ? ENTITY_FIELDS
        : DOCUMENT_PARTY_FIELDS;
}

const AUTHORITY: Record<ClaimSource, number> = { user: 3, rule: 2, import: 1, ai: 0 };

export interface Claim {
  id: number;
  subject_type: ClaimSubject;
  subject_id: string;
  field: string;
  value: string | null;
  source: ClaimSource;
  confidence: number | null;
  status: ClaimStatus;
  created_at: string;
  provenance_ref?: string | null;
  edited_at?: string | null;
  edited_by?: string | null;
}

/**
 * The winning claim for one field: highest authority, then highest
 * confidence, then most recent. Rejected and superseded claims are excluded —
 * they are history, not opinion.
 */
export function winningClaim(
  db: DatabaseSync,
  subject: ClaimSubject,
  subjectId: string,
  field: string,
): Claim | null {
  const rows = db
    .prepare(
      `SELECT * FROM field_claims
        WHERE subject_type=? AND subject_id=? AND field=?
          AND status NOT IN ('rejected','superseded')
        ORDER BY id DESC`,
    )
    .all(subject, subjectId, field) as unknown as Claim[];
  if (!rows.length) return null;

  let best = rows[0];
  for (const c of rows) {
    const a = AUTHORITY[c.source] ?? 0;
    const b = AUTHORITY[best.source] ?? 0;
    if (a > b) best = c;
    else if (a === b && (c.confidence ?? 0) > (best.confidence ?? 0)) best = c;
    // Equal authority AND equal confidence: rows are ordered newest-first, so
    // `best` already holds the most recent. Doing nothing IS the tiebreak.
  }
  return best;
}

/** Every live field → winning claim, for the provenance badges on a card. */
export function claimsFor(
  db: DatabaseSync,
  subject: ClaimSubject,
  subjectId: string,
): Record<string, Claim> {
  const fields = db
    .prepare(
      `SELECT DISTINCT field FROM field_claims
        WHERE subject_type=? AND subject_id=? AND status NOT IN ('rejected','superseded')`,
    )
    .all(subject, subjectId) as { field: string }[];
  const out: Record<string, Claim> = {};
  for (const f of fields) {
    const c = winningClaim(db, subject, subjectId, f.field);
    if (c) out[f.field] = c;
  }
  return out;
}

export class ClaimRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClaimRefused";
  }
}

/**
 * Write a claim, honouring authority.
 *
 * Refuses rather than silently losing an edit: a UI that thinks it saved when
 * it did not is worse than one that reports a conflict. A user claim always
 * supersedes lower-authority claims for the same field, which is what makes
 * "user > rule > ai" hold after the edit as well as during it.
 */
export function writeClaim(
  db: DatabaseSync,
  ports: Ports,
  input: {
    subject: ClaimSubject;
    subjectId: string;
    field: string;
    value: string | null;
    source: ClaimSource;
    confidence?: number;
    status?: ClaimStatus;
    provenanceRef?: string;
    editedAt?: string;
    editedBy?: string;
  },
): { claim_id: number; superseded: number; previous: string | null } {
  const { subject, subjectId, field, value, source } = input;

  if (!allowedFields(subject).has(field)) {
    throw new ClaimRefused(`field "${field}" is not ${subject}-scope`, "field_out_of_scope", {
      subject,
      field,
      allowed: [...allowedFields(subject)],
    });
  }

  const current = winningClaim(db, subject, subjectId, field);

  // A confirmed claim is never overwritten by anything with less authority.
  // Re-running extraction over a corrected document must not undo the
  // correction — that is the single most damaging failure this table exists
  // to prevent.
  if (
    current &&
    current.status === "confirmed" &&
    (AUTHORITY[source] ?? 0) < (AUTHORITY[current.source] ?? 0)
  ) {
    throw new ClaimRefused(
      `refusing to overwrite a confirmed ${current.source} claim with a ${source} claim`,
      "confirmed_claim_protected",
      { field, current_value: current.value, current_source: current.source },
    );
  }

  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new ClaimRefused("confidence must be between 0 and 1", "invalid_confidence");
  }
  const now = input.editedAt ?? ports.clock.isoNow();
  const status: ClaimStatus = input.status ?? (source === "user" ? "confirmed" : "proposed");

  // Supersede everything this claim outranks OR ties with, so the losing rows
  // stop competing in winningClaim rather than lingering as live opinion.
  //
  // The tie case matters: correcting the same field twice must retire the
  // first correction. Without `<=` the table accumulates several live
  // 'confirmed' user claims for one field, and the winner is then decided by
  // recency alone — which happens to be right today, and silently stops being
  // right the moment ordering or confidence changes. This runs BEFORE the
  // INSERT, so the incoming row is never caught by it.
  const sup = db
    .prepare(
      `UPDATE field_claims SET status='superseded'
        WHERE subject_type=? AND subject_id=? AND field=?
          AND status NOT IN ('rejected','superseded')
          AND source IN (${Object.entries(AUTHORITY)
            .filter(([, rank]) => rank <= (AUTHORITY[source] ?? 0))
            .map(([s]) => `'${s}'`)
            .join(",") || "''"})`,
    )
    .run(subject, subjectId, field);

  const info = db
    .prepare(
      `INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, provenance_ref, edited_at, edited_by, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(subject, subjectId, field, value, source, input.confidence ?? (source === "user" ? 1.0 : null), input.provenanceRef ?? null, now, input.editedBy ?? (source === "user" ? "user" : "daemon"), status, now);

  // Passive learning is independent of the questioning master switch. A
  // correction is durable evidence even when the user has disabled prompts.
  if (source === "user") {
    const matchKey = `${subject}:${subjectId}:${field}`;
    db.prepare(
      `INSERT INTO learned_rules(kind,match_key,match_kind,value,source,confidence,active,created_at)
       VALUES('field_correction',?,?,?,'passive-correction',1,0,?)
       ON CONFLICT(kind,match_key,COALESCE(match_kind,'')) DO UPDATE SET
         value=excluded.value, source='passive-correction', confidence=1, created_at=excluded.created_at`,
    ).run(matchKey, subject, value ?? "", now);
  }

  return {
    claim_id: Number(info.lastInsertRowid),
    superseded: Number(sup.changes ?? 0),
    previous: current?.value ?? null,
  };
}

export type DocumentPartyRole = "owner" | "counterparty" | "issuer" | "source_of_funds";
export type PartyProvenance = "ai-derived" | "user-confirmed" | "rule-derived";

export function documentPartyClaimId(documentId: string, entityId: string, role: DocumentPartyRole): string {
  return `${documentId}:${entityId}:${role}`;
}

/**
 * Replace one role assignment without allowing an entity to occupy two roles
 * on a document. The database protects the latter too; the checks here return
 * actionable errors and protect old databases before their migration runs.
 */
export function setDocumentParty(
  db: DatabaseSync,
  ports: Ports,
  input: { documentId: string; entityId: string; role: DocumentPartyRole; confidence?: number; provenance?: PartyProvenance; editedBy?: string },
): void {
  if (!Number.isFinite(input.confidence ?? 1) || (input.confidence ?? 1) < 0 || (input.confidence ?? 1) > 1) {
    throw new ClaimRefused("confidence must be between 0 and 1", "invalid_confidence");
  }
  const entity = db.prepare("SELECT kind FROM entities WHERE id=?").get(input.entityId) as { kind: string } | undefined;
  if (!entity) throw new ClaimRefused("entity not found", "entity_not_found");
  if (entity.kind === "instrument" || (input.role === "source_of_funds" && entity.kind !== "account") || (input.role === "owner" && entity.kind !== "person")) {
    throw new ClaimRefused("entity kind is not valid for this document-party role", "invalid_party_role", { role: input.role, kind: entity.kind });
  }
  const currentRole = db.prepare("SELECT role FROM document_parties WHERE document_id=? AND entity_id=?").get(input.documentId, input.entityId) as { role: string } | undefined;
  if (currentRole && currentRole.role !== input.role) {
    throw new ClaimRefused("an entity cannot have two roles on one document", "entity_already_has_role", { existing_role: currentRole.role });
  }
  if (input.role === "owner") db.prepare("DELETE FROM document_parties WHERE document_id=? AND role='owner'").run(input.documentId);
  db.prepare(
    `INSERT INTO document_parties(document_id,entity_id,role,confidence,provenance) VALUES(?,?,?,?,?)
     ON CONFLICT(document_id,entity_id,role) DO UPDATE SET confidence=excluded.confidence, provenance=excluded.provenance`,
  ).run(input.documentId, input.entityId, input.role, input.confidence ?? 1, input.provenance ?? "user-confirmed");
  writeClaim(db, ports, {
    subject: "document_party", subjectId: documentPartyClaimId(input.documentId, input.entityId, input.role),
    field: input.role === "source_of_funds" ? "sourceOfFunds" : input.role,
    value: input.entityId, source: "user", confidence: input.confidence ?? 1, editedBy: input.editedBy,
  });
}

export function audit(
  db: DatabaseSync,
  ports: Ports,
  row: {
    subject: ClaimSubject;
    subjectId: string;
    field: string;
    action: string;
    oldValue: string | null;
    newValue: string | null;
    source?: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_audit (subject_type, subject_id, field, action, old_value, new_value, source, at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    row.subject,
    row.subjectId,
    row.field,
    row.action,
    row.oldValue,
    row.newValue,
    row.source ?? "user",
    ports.clock.isoNow(),
  );
}

/** Documents backing a transaction, with their evidence role. */
interface EvidenceRow {
  document_id: string;
  evidence_role: string;
  extraction_json: string | null;
}

/**
 * Evidence roles that prove SETTLEMENT — money actually moved. These outrank
 * invoices for the canonical amount, because an invoice states what was asked
 * for and a settlement states what was paid.
 */
const SETTLEMENT_ROLES = new Set(["card_confirmation", "bank_slip", "statement_line", "payment_receipt"]);
const INVOICE_ROLES = new Set(["merchant_invoice", "contract_note", "refund_note"]);

function evidenceOf(db: DatabaseSync, transactionId: string): EvidenceRow[] {
  return db
    .prepare(
      `SELECT td.document_id, td.evidence_role, d.extraction_json
         FROM transaction_documents td
         JOIN documents d ON d.id = td.document_id
        WHERE td.transaction_id = ?
        ORDER BY td.linked_at`,
    )
    .all(transactionId) as unknown as EvidenceRow[];
}

function extractionOf(row: EvidenceRow): Record<string, unknown> | null {
  if (!row.extraction_json) return null;
  try {
    return JSON.parse(row.extraction_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * A document's value for a field: the winning CLAIM if one exists, otherwise
 * whatever the extraction said. Claims are the correction layer over the
 * model's opinion; the extraction JSON is never rewritten.
 */
function documentValue(
  db: DatabaseSync,
  docId: string,
  field: string,
  extraction: Record<string, unknown> | null,
): { value: string | null; source: ClaimSource } | null {
  const claim = winningClaim(db, "document", docId, field);
  if (claim && claim.value !== null) return { value: claim.value, source: claim.source };

  if (!extraction) return null;
  const key =
    field === "document_date" ? "occurred_at" : field === "vendor" || field === "issuer" ? "counterparty" : field;

  if (key === "counterparty") {
    const parties = Array.isArray(extraction.parties) ? extraction.parties : [];
    const cp = parties.find(
      (p) => (p as { role?: string }).role === "counterparty" && (p as { kind?: string }).kind === "organisation",
    ) as { name?: string } | undefined;
    const name = cp?.name ?? (extraction.counterparty_descriptor as string | null);
    return name ? { value: String(name), source: "ai" } : null;
  }

  const v = extraction[key];
  return v === null || v === undefined ? null : { value: String(v), source: "ai" };
}

export interface ResolvedTransaction {
  transaction_id: string;
  /** Fields whose stored value actually changed. */
  changed: string[];
  /** field → why this value won, for the review queue and the evidence card. */
  reasons: Record<string, string>;
  /** Documents that disagree with the canonical value, per field. */
  mismatches: Array<{ field: string; document_id: string; document_value: string; canonical: string }>;
}

/**
 * Recompute one transaction's canonical fields from claims + linked evidence,
 * and write back anything that moved.
 *
 * Idempotent: running it twice with no new claims changes nothing. That is
 * what makes it safe to call from an edit, a link, a re-extraction, or a
 * maintenance sweep without reasoning about ordering.
 */
export function resolveTransaction(
  db: DatabaseSync,
  ports: Ports,
  transactionId: string,
): ResolvedTransaction | null {
  const txn = db
    .prepare(
      `SELECT t.*, e.display_name AS counterparty_name
         FROM transactions t
         LEFT JOIN entities e ON e.id = t.counterparty_entity_id
        WHERE t.id = ?`,
    )
    .get(transactionId) as Record<string, unknown> | undefined;
  if (!txn) return null;

  const evidence = evidenceOf(db, transactionId);
  const parsed = evidence.map((e) => ({ row: e, x: extractionOf(e) }));
  const settlement = parsed.filter((p) => SETTLEMENT_ROLES.has(p.row.evidence_role));
  const invoices = parsed.filter((p) => INVOICE_ROLES.has(p.row.evidence_role));

  const changed: string[] = [];
  const reasons: Record<string, string> = {};
  const mismatches: ResolvedTransaction["mismatches"] = [];

  // ── amount_minor ──────────────────────────────────────────────────────────
  // A transaction-scope user claim is final. Otherwise settlement beats
  // invoice: what the bank moved beats what the vendor asked for.
  const amountClaim = winningClaim(db, "transaction", transactionId, "amount_minor");
  let amount: string | null = null;
  // The document whose amount won, so the currency can follow it (below).
  let amountWinnerDoc: { documentId: string; x: Record<string, unknown> | null } | null = null;
  if (amountClaim?.value != null && amountClaim.source === "user") {
    amount = amountClaim.value;
    reasons.amount_minor = "user claim on the transaction";
  } else {
    // ROLE CLASS is the primary key, authority only the tiebreak WITHIN a
    // class. Sorting by authority across both classes would let a
    // user-corrected invoice outrank the bank's own settlement record — which
    // inverts the rule this whole branch exists to enforce. Correcting an
    // invoice states what the vendor asked for; it cannot restate what the
    // bank moved.
    const ranked = [
      ...settlement.map((p) => ({ p, roleRank: 1 })),
      ...invoices.map((p) => ({ p, roleRank: 0 })),
    ]
      .map((r) => ({ ...r, v: documentValue(db, r.p.row.document_id, "amount_minor", r.p.x) }))
      .filter((r) => r.v?.value != null)
      .sort(
        (a, b) =>
          b.roleRank - a.roleRank ||
          (AUTHORITY[b.v!.source] ?? 0) - (AUTHORITY[a.v!.source] ?? 0),
      );

    const winner = ranked[0];
    if (winner) {
      amount = winner.v!.value;
      amountWinnerDoc = { documentId: winner.p.row.document_id, x: winner.p.x };
      const role = winner.p.row.evidence_role;
      reasons.amount_minor = `${winner.roleRank === 1 ? "settlement" : "invoice"} document (${role}), ${winner.v!.source} value`;
      for (const other of ranked.slice(1)) {
        if (other.v!.value !== amount) {
          mismatches.push({
            field: "amount_minor",
            document_id: other.p.row.document_id,
            document_value: other.v!.value!,
            canonical: amount!,
          });
        }
      }
    }
  }
  if (amount !== null && Number.isFinite(Number(amount)) && Number(amount) !== Number(txn.amount_minor)) {
    db.prepare("UPDATE transactions SET amount_minor=? WHERE id=?").run(Math.round(Number(amount)), transactionId);
    changed.push("amount_minor");
  }

  // ── currency (work order 05 §A.2) ─────────────────────────────────────────
  // The source currency travels WITH the source amount: the document whose
  // amount won is also the authority on the currency, and a user claim
  // outranks both. This is the fix for a USD invoice displaying as ₹597 —
  // the amount resolved from the document but the currency silently stayed
  // at the ledger default.
  const currencyClaim = winningClaim(db, "transaction", transactionId, "currency");
  let currency: string | null = null;
  if (currencyClaim?.value != null && currencyClaim.source === "user") {
    currency = currencyClaim.value;
    reasons.currency = "user claim on the transaction";
  } else if (amountWinnerDoc) {
    const v = documentValue(db, amountWinnerDoc.documentId, "currency", amountWinnerDoc.x);
    if (v?.value) {
      currency = v.value;
      reasons.currency = `${v.source === "user" ? "user-corrected document" : "amount-winning document"} currency`;
    }
  }
  if (currency !== null) {
    const normalisedCurrency = currency.trim().toUpperCase();
    const stored = typeof txn.currency === "string" ? txn.currency : null;
    if (normalisedCurrency !== stored) {
      db.prepare("UPDATE transactions SET currency=? WHERE id=?").run(normalisedCurrency, transactionId);
      changed.push("currency");
    }
  }

  // ── occurred_at / posted_at ───────────────────────────────────────────────
  // The ECONOMIC date is the invoice/document date. The settlement date is
  // when it cleared, which is posted_at — conflating them makes a card payment
  // land in the wrong month.
  const dateClaim = winningClaim(db, "transaction", transactionId, "occurred_at");
  let occurred: string | null = dateClaim?.source === "user" ? dateClaim.value : null;
  if (occurred) {
    reasons.occurred_at = "user claim on the transaction";
  } else {
    const src = invoices[0] ?? settlement[0];
    const v = src ? documentValue(db, src.row.document_id, "document_date", src.x) : null;
    if (v?.value) {
      occurred = v.value;
      reasons.occurred_at = `${INVOICE_ROLES.has(src!.row.evidence_role) ? "invoice" : "settlement"} document date`;
    }
  }
  if (occurred && occurred !== txn.occurred_at) {
    db.prepare("UPDATE transactions SET occurred_at=?, fy_key=? WHERE id=?")
      .run(occurred, fyKeyOf(db, occurred), transactionId);
    changed.push("occurred_at");
  }

  const settleDate = settlement.length
    ? documentValue(db, settlement[0].row.document_id, "document_date", settlement[0].x)?.value
    : null;
  if (settleDate && settleDate !== txn.posted_at) {
    db.prepare("UPDATE transactions SET posted_at=? WHERE id=?").run(settleDate, transactionId);
    reasons.posted_at = "settlement document date";
    changed.push("posted_at");
  }

  // ── counterparty ──────────────────────────────────────────────────────────
  // Invoice/merchant naming is preferred. A statement descriptor
  // ("SWIGGY*BLR 080") is a machine string, not a name, and is only allowed to
  // set the counterparty through the normalisation + rules path.
  const cpClaim = winningClaim(db, "transaction", transactionId, "counterparty");
  let counterparty: string | null = cpClaim?.source === "user" ? cpClaim.value : null;
  if (counterparty) {
    reasons.counterparty = "user claim on the transaction";
  } else {
    const src = invoices[0];
    const v = src ? documentValue(db, src.row.document_id, "counterparty", src.x) : null;
    if (v?.value && v.source === "user") {
      counterparty = v.value;
      reasons.counterparty = "user-corrected invoice";
    }
  }
  if (counterparty && txn.direction !== "transfer") {
    const entityId = resolveCounterpartyEntity(db, ports, counterparty);
    if (entityId && entityId !== txn.counterparty_entity_id) {
      db.prepare("UPDATE transactions SET counterparty_entity_id=? WHERE id=?").run(entityId, transactionId);
      changed.push("counterparty");
    }
  }

  // ── category / impact bucket ──────────────────────────────────────────────
  for (const field of ["category_id", "impact_bucket", "direction", "status", "purpose_text"] as const) {
    const c = winningClaim(db, "transaction", transactionId, field);
    if (c?.source === "user" && c.value !== null && c.value !== txn[field]) {
      db.prepare(`UPDATE transactions SET ${field}=? WHERE id=?`).run(c.value, transactionId);
      reasons[field] = "user claim on the transaction";
      changed.push(field);
    }
  }

  if (changed.length) {
    ports.logger.info("transaction re-resolved", { transaction_id: transactionId, changed });
  }
  return { transaction_id: transactionId, changed, reasons, mismatches };
}

/** Transactions a document is evidence for. Empty for an orphan. */
export function linkedTransactions(db: DatabaseSync, documentId: string): string[] {
  return (
    db
      .prepare("SELECT transaction_id FROM transaction_documents WHERE document_id=?")
      .all(documentId) as { transaction_id: string }[]
  ).map((r) => r.transaction_id);
}

/**
 * Re-resolve every transaction a document backs, and announce it.
 *
 * An orphan document resolves nothing and that is not a failure: the claim is
 * stored, and linking the document later runs this same path and applies it.
 */
export function propagateFromDocument(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  fields: string[],
): ResolvedTransaction[] {
  const txns = linkedTransactions(db, documentId);
  const results: ResolvedTransaction[] = [];
  for (const t of txns) {
    const r = resolveTransaction(db, ports, t);
    if (r) results.push(r);
  }

  if (txns.length) {
    ports.bus.publish({
      type: "TransactionReResolved",
      transaction_ids: txns,
      document_id: documentId,
      fields,
      at: ports.clock.isoNow(),
    });
  }
  return results;
}

/**
 * Resolve a counterparty NAME to an organisation entity, creating one if
 * needed. Deliberately kind-scoped to 'organisation': the anti-pollution
 * invariant means a counterparty correction can never reach into accounts,
 * people, or instruments.
 */
function resolveCounterpartyEntity(db: DatabaseSync, ports: Ports, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  try {
    return resolveEntity(db, ports, trimmed, "organisation", { subtype: "merchant" });
  } catch (err) {
    ports.logger.warn("could not resolve corrected counterparty", {
      name: trimmed,
      err: (err as Error)?.message,
    });
    return null;
  }
}

/**
 * FY key for a date, honouring the active jurisdiction pack's start month.
 *
 * occurred_at and fy_key must move together: fy_key is DERIVED and STORED, so
 * an edit that changes the economic date without recomputing it puts the
 * transaction in one month's list and another year's total.
 */
function fyKeyOf(db: DatabaseSync, isoDate: string): string {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key='jurisdiction.id'")
    .get() as { value?: string } | undefined;
  const day = isoDate.slice(0, 10);
  try {
    return fyKeyFor(loadPack(row?.value || "IN"), day);
  } catch {
    return fyKeyFor(loadPack("IN"), day);
  }
}
