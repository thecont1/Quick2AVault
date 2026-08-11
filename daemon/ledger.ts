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
import { resolvePerson } from "./identity.js";

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
    // Trailing digits identify WHICH account at an institution: a savings
    // account and a credit card at one bank share the same name stem
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

  // 4. PERSON-ONLY name-order and identifier matching.
  //    One human is written many ways across documents: "Arun Kamath",
  //    "KAMATH ARUN" (surname-first, common on Indian statements), and
  //    an email address on a receipt. Kind-scoped exact matching sees three
  //    people. Sorting the name tokens makes word ORDER irrelevant, which is
  //    the single most common real-world variant.
  //
  //    Restricted to kind='person': for organisations, token-sorting would
  //    merge "Alpha Beta Foods" with "Beta Alpha Foods", which may be two
  //    genuinely different companies.
  if (kind === "person") {
    const tokens = (s: string) =>
      normaliseName(s).split(" ").filter((t) => t.length > 1).sort().join(" ");
    const myTokens = tokens(name);
    // An email or phone identifier is decisive on its own.
    const myIds = Object.values(opts.identifiers ?? {}).map((v) => String(v).toLowerCase());

    if (myTokens.length >= 4 || myIds.length) {
      for (const e of sameKind) {
        if (myTokens.length >= 4 && tokens(e.display_name) === myTokens) {
          db.prepare(
            "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
          ).run(e.id, kind, name, norm, "auto-person-tokens", ports.clock.isoNow());
          ports.logger.info("person alias merged", { alias: name, into: e.display_name });
          return e.id;
        }
        if (myIds.length) {
          const row = db
            .prepare("SELECT identifiers_json FROM entities WHERE id=?")
            .get(e.id) as { identifiers_json?: string } | undefined;
          if (row?.identifiers_json) {
            try {
              const theirs = Object.values(JSON.parse(row.identifiers_json) as Record<string, string>)
                .map((v) => String(v).toLowerCase());
              if (theirs.some((t) => myIds.includes(t))) {
                db.prepare(
                  "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
                ).run(e.id, kind, name, norm, "auto-person-identifier", ports.clock.isoNow());
                ports.logger.info("person matched on identifier", { alias: name, into: e.display_name });
                return e.id;
              }
            } catch {/* malformed identifiers, ignore */}
          }
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

/**
 * Reject "accounts" that are really counterparty ledgers, payment rails, or
 * prose. The extractor sometimes invents these, and the cost is severe: a
 * bogus owned-account turns a salary credit or a share sale into a TRANSFER,
 * silently removing it from Income/Spending.
 *
 * An account we accept must name an institution or carry an account number.
 */
const NOT_AN_ACCOUNT =
  /\b(client ledger|ledger balance|settlement account|net amount|receivable|payable|payroll|sale proceeds|proceeds|pay online|online payment|third party|payment link|trading\/ledger)\b/i;

const ACCOUNT_EVIDENCE =
  /(\d{4})|\b(bank|card|wallet|upi|savings|current|cash|a\/c)\b/i;

export function isPlausibleOwnedAccount(name: string): boolean {
  const s = name.trim();
  if (s.length < 3 || s.length > 90) return false;
  if (NOT_AN_ACCOUNT.test(s)) return false;
  if (!ACCOUNT_EVIDENCE.test(s)) return false;
  return true;
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
  //
  // GUARD: a transfer requires BOTH sides to be plausible owned accounts. The
  // extractor sometimes labels an employer's payroll or a broker's client
  // ledger as an "account"; without this check a salary credit or a share sale
  // becomes a transfer and vanishes from Income.
  const srcParty0 = x.parties.find((p) => p.role === "source_of_funds" && p.kind === "account");
  const srcName0 = srcParty0?.name ?? x.source_of_funds_text ?? null;
  const destName0 = x.destination_of_funds_text ?? null;
  const bothSidesOwned =
    !!srcName0 && !!destName0 &&
    isPlausibleOwnedAccount(srcName0) && isPlausibleOwnedAccount(destName0);

  const claimsTransfer =
    x.is_wallet_topup ||
    x.direction === "transfer" ||
    x.doc_type === "wallet_topup_confirmation";

  const isTransfer = claimsTransfer && bothSidesOwned;

  if (claimsTransfer && !isTransfer) {
    ports.logger.warn("rejected implausible transfer — booking by stated direction", {
      document_id: documentId,
      source: srcName0,
      destination: destName0,
    });
  }

  const direction = isTransfer
    ? "transfer"
    : x.direction === "transfer"
      ? "out" // claimed transfer but not between owned accounts
      : (x.direction ?? "out");

  // ── entities ──────────────────────────────────────────────────────────────
  const partyOf = (role: ExtractedParty["role"], kind?: Kind) =>
    x.parties.find((p) => p.role === role && (!kind || p.kind === kind));

  // Source of funds is an ACCOUNT I own — never a merchant, and never a
  // counterparty's internal ledger. Implausible names are dropped rather than
  // creating a fake account entity that pollutes every later match.
  const srcParty = partyOf("source_of_funds", "account");
  const srcNameRaw = srcParty?.name ?? x.source_of_funds_text ?? null;
  const srcName = srcNameRaw && isPlausibleOwnedAccount(srcNameRaw) ? srcNameRaw : null;
  if (srcNameRaw && !srcName) {
    ports.logger.warn("dropped implausible source account", { name: srcNameRaw, document_id: documentId });
  }
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

  // ── people (plan §3.1) ────────────────────────────────────────────────────
  // The extractor names a person on most documents ("Billed to: …"), and until
  // now that was discarded — 60 of 69 real documents carried a person the
  // ledger never recorded. People are WHO a document belongs to, not who was
  // paid, so they are linked via document_parties rather than as counterparty.
  //
  // The first person seen becomes the owner (member=true) — a single-user
  // vault, per plan §5 "zero setup". Everyone else is a candidate the user can
  // confirm or merge later.
  for (const party of x.parties.filter((pp) => pp.kind === "person")) {
    if (!party.name?.trim()) continue;
    try {
      // Work order 04 §Track D: full identity resolution (typed identifiers,
      // fuzzy-band questions, co-occurrence learning), not just the
      // kind-scoped name matching resolveEntity does for every other kind.
      const { id: personId } = resolvePerson(
        db,
        ports,
        party.name,
        party.identifiers,
        documentId,
        party.subtype,
      );

      // Promote the first ever person to member/owner status.
      const members = db
        .prepare("SELECT COUNT(*) n FROM entities WHERE kind='person' AND is_member=1")
        .get() as { n: number };
      if (members.n === 0 && party.role === "owner") {
        db.prepare("UPDATE entities SET is_member=1, status='confirmed' WHERE id=?").run(personId);
        ports.logger.info("vault owner detected", { name: party.name });
      }

      db.prepare(
        "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?,?)",
      ).run(documentId, personId, party.role);
    } catch (err) {
      ports.logger.warn("could not record person", {
        name: party.name,
        err: (err as Error)?.message,
      });
    }
  }

  // ── transaction ───────────────────────────────────────────────────────────
  // Work order 07 §A1: idempotent ledger writes. Before creating a new
  // transaction, check whether this document already produced one with the
  // same evidence_role. A retry, restart, or manual reprocess must upsert the
  // existing transaction, not insert a second economic event.
  const role = evidenceRole(x);
  const existing = db
    .prepare("SELECT transaction_id FROM transaction_documents WHERE document_id=? AND evidence_role=?")
    .get(documentId, role) as { transaction_id?: string } | undefined;
  const id = existing?.transaction_id ?? newId("txn");
  const now = ports.clock.isoNow();
  const isReanalysis = !!existing;

  // WO12 phase 2: refund linking. A refund_note (direction='in') that matches
  // an existing outbound transaction by amount and currency sets
  // reverses_transaction_id, so snapshot totals can net the pair instead of
  // counting the refund as separate income. The match is deliberately simple:
  // exact amount + same currency + direction='out'. The matcher's full scoring
  // is overkill here — a refund for the wrong amount is a partial refund, which
  // the plan defers to a future work order.
  let reversesTransactionId: string | null = null;
  if (x.doc_type === "refund_note" && !isReanalysis) {
    const original = db
      .prepare(
        `SELECT t.id FROM transactions t
         WHERE t.direction='out' AND t.amount_minor=? AND t.currency IS ?
           AND t.reverses_transaction_id IS NULL
         ORDER BY t.occurred_at DESC LIMIT 1`,
      )
      .get(x.amount_minor, x.currency?.trim() ? x.currency.trim().toUpperCase() : null) as
      | { id: string }
      | undefined;
    reversesTransactionId = original?.id ?? null;
  }

  if (isReanalysis) {
    // UPDATE the existing transaction in place. User-confirmed claims are NOT
    // touched — the resolver keeps them (§A3: user corrections survive
    // re-analysis). Only the transaction row itself is refreshed.
    db.prepare(
      `UPDATE transactions
          SET occurred_at=?, posted_at=?, fy_key=?, amount_minor=?, currency=?,
              direction=?, counterparty_entity_id=?, payment_rail=?,
              impact_bucket=?, purpose_text=?, confidence=?
        WHERE id=?`,
    ).run(
      occurred,
      x.posted_at ?? null,
      fyKey(occurred),
      x.amount_minor,
      x.currency?.trim() ? x.currency.trim().toUpperCase() : null,
      direction,
      isTransfer ? null : counterpartyId,
      x.payment_rail ?? null,
      isTransfer ? "transfer" : (x.category_hint ?? null),
      x.purpose_text ?? null,
      x.confidence,
      id,
    );
    // Clear old legs and holdings — they will be re-created from the new
    // extraction. Cascading delete handles dependent rows.
    db.prepare("DELETE FROM transaction_legs WHERE transaction_id=?").run(id);
    db.prepare("DELETE FROM holdings WHERE transaction_id=?").run(id);
    ports.logger.info("re-analysis: upserted existing transaction", {
      transaction_id: id,
      document_id: documentId,
    });
  } else {
    db.prepare(
      `INSERT INTO transactions
        (id, occurred_at, posted_at, fy_key, amount_minor, currency, direction,
         counterparty_entity_id, payment_rail, impact_bucket, purpose_text,
         status, confidence, reverses_transaction_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      occurred,
      x.posted_at ?? null,
      fyKey(occurred),
      x.amount_minor,
      // NULL when the document states no currency — a review state, not a
      // silent INR assumption (work order 05 §A.2).
      x.currency?.trim() ? x.currency.trim().toUpperCase() : null,
      direction,
      // CHECK constraint enforces this too, but be explicit: transfers have no counterparty.
      isTransfer ? null : counterpartyId,
      x.payment_rail ?? null,
      isTransfer ? "transfer" : (x.category_hint ?? null),
      x.purpose_text ?? null,
      "evidenced",
      x.confidence,
      reversesTransactionId,
      now,
    );
  }

  // ── legs ──────────────────────────────────────────────────────────────────
  const addLeg = (accountId: string, leg: "debit" | "credit") =>
    db
      .prepare("INSERT INTO transaction_legs (transaction_id, account_entity_id, leg, amount_minor) VALUES (?,?,?,?)")
      .run(id, accountId, leg, x.amount_minor!);

  // Leg type follows DIRECTION. Previously every transaction debited the
  // source account, so a ₹1,68,641 salary landing in your bank was recorded
  // as money LEAVING it — the ledger disagreed with itself, and any balance
  // derived from legs drifted by twice the value of every inbound payment.
  //
  //   in       -> the account I own is CREDITED (money arrived)
  //   out      -> the account I own is DEBITED  (money left)
  //   transfer -> debit source, credit destination (both mine)
  if (isTransfer) {
    if (sourceAccountId) addLeg(sourceAccountId, "debit");
    if (destAccountId) addLeg(destAccountId, "credit");
  } else if (sourceAccountId) {
    addLeg(sourceAccountId, direction === "in" ? "credit" : "debit");
  }

  // ── holdings (portfolio line items) ───────────────────────────────────────
  // A contract note's net amount says what left the bank; only these rows say
  // what is held. Each security becomes an `instrument` entity, so "Tata
  // Motors" bought across three notes resolves to ONE instrument.
  const holdings = Array.isArray(x.holdings) ? x.holdings : [];
  let holdingsWritten = 0;
  for (const h of holdings) {
    const name = typeof h?.name === "string" ? h.name.trim() : "";
    if (!name) continue;
    // ISIN is the strongest identity a security has — pass it as an
    // identifier so two spellings of the same scrip converge.
    const instrumentId = resolveEntity(db, ports, name, "instrument", {
      identifiers: h.isin ? { isin: String(h.isin) } : undefined,
    });
    // Side defaults to the transaction's own direction: money out = buy.
    const side = h.side === "sell" || h.side === "buy" ? h.side : direction === "in" ? "sell" : "buy";
    db.prepare(
      `INSERT INTO holdings
        (id, transaction_id, document_id, instrument_entity_id, side,
         quantity, price_minor, amount_minor, isin, occurred_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      newId("hld"),
      id,
      documentId,
      instrumentId,
      side,
      typeof h.quantity === "number" ? h.quantity : null,
      typeof h.price_minor === "number" ? Math.round(h.price_minor) : null,
      typeof h.amount_minor === "number" ? Math.round(h.amount_minor) : null,
      h.isin ?? null,
      occurred,
      now,
    );
    holdingsWritten++;
  }
  // A single-security trade also fills the transaction's own instrument
  // columns, so the simple case needs no join.
  if (holdingsWritten === 1) {
    const h = holdings.find((v) => typeof v?.name === "string" && v.name.trim());
    if (h) {
      db.prepare(
        "UPDATE transactions SET instrument_entity_id=(SELECT instrument_entity_id FROM holdings WHERE transaction_id=? LIMIT 1), quantity=?, price_minor=? WHERE id=?",
      ).run(
        id,
        typeof h.quantity === "number" ? h.quantity : null,
        typeof h.price_minor === "number" ? Math.round(h.price_minor) : null,
        id,
      );
    }
  }
  if (holdingsWritten) {
    ports.logger.info("holdings recorded", { transaction_id: id, securities: holdingsWritten });
  }

  // ── evidence ──────────────────────────────────────────────────────────────
  // INSERT OR IGNORE: on a first analysis this creates the link; on a
  // re-analysis the link already exists (same transaction_id) and this is a
  // no-op. The unique index on (document_id, evidence_role) is the backstop
  // that prevents a second transaction from ever being created.
  db.prepare(
    `INSERT OR IGNORE INTO transaction_documents
      (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, documentId, evidenceRole(x), 1.0, "ai", now);

  // ── provenance ────────────────────────────────────────────────────────────
  // AI claims enter as 'proposed'. They are the model's opinion until a human
  // confirms them, and the resolver treats them accordingly.
  //
  // Work order 07 §A3: on re-analysis, do NOT insert new AI claims. The
  // existing claims are either 'proposed' (the resolver will pick up the new
  // extraction values from the transaction row itself) or 'confirmed' (a user
  // correction that must survive re-analysis). Inserting fresh 'proposed'
  // claims would create duplicates and risk a 'confirmed' claim being
  // overshadowed by a stale 'proposed' one.
  const storedCurrency = x.currency?.trim() ? x.currency.trim().toUpperCase() : null;
  if (!isReanalysis) {
    const claim = db.prepare(
      "INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, status, created_at) VALUES ('transaction',?,?,?,'ai',?,'proposed',?)",
    );
    claim.run(id, "amount_minor", String(x.amount_minor), x.confidence, now);
    claim.run(id, "occurred_at", occurred, x.confidence, now);
    claim.run(id, "direction", direction, x.confidence, now);
    // The source currency is a claim like any other reading: provenance for
    // why the transaction is USD, overridable by a user correction.
    if (storedCurrency) claim.run(id, "currency", storedCurrency, x.confidence, now);
  }

  ports.bus.publish({
    type: "TransactionRecorded",
    transaction_id: id,
    direction,
    amount_minor: x.amount_minor,
    currency: storedCurrency,
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
