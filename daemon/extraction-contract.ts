/**
 * P2 extraction contract (plan §2).
 *
 * Claude's ONLY product is this JSON. It never rewrites markdown v1 — that
 * stays the canonical text and the audit trail for every claim below.
 *
 * The schema is deliberately shaped around the six questions from plan §3:
 * who paid whom, for what, when, where, how, how much — plus evidence.
 */

export const EXTRACTION_VERSION = 1;

export type DocType =
  | "merchant_invoice"
  | "card_confirmation"
  | "bank_slip"
  | "payment_receipt"
  | "wallet_topup_confirmation"
  | "statement_line"
  | "refund_note"
  | "contract_note"
  | "salary_slip"
  // Work order 04 §Track A: the whole statement document, as opposed to
  // "statement_line" above (one row lifted out of a larger document by an
  // upstream job). A bank/card statement produces MANY staged rows via
  // statement.lines below — doc_type on the DOCUMENT stays "bank_statement"
  // or "card_statement" throughout; individual promoted transactions each
  // carry their own evidence_role of "statement_line".
  | "bank_statement"
  | "card_statement"
  | "irrelevant"
  | "unknown";

export interface ExtractedParty {
  name: string;
  /** Which of the four kinds this party is. Kind-scoped resolution depends on it. */
  kind: "person" | "organisation" | "account" | "instrument";
  subtype?: string;
  role: "owner" | "counterparty" | "issuer" | "source_of_funds";
  identifiers?: Record<string, string>;
}

export interface ExtractionResult {
  doc_type: DocType;
  /** Economic date (when the thing happened), ISO yyyy-mm-dd. */
  occurred_at: string | null;
  /** Settlement date if the document states one separately. */
  posted_at: string | null;
  /** Integer MINOR units. 643.72 INR -> 64372. Never a float. */
  amount_minor: number | null;
  currency: string;
  direction: "out" | "in" | "transfer" | null;
  payment_rail: "upi" | "card" | "netbanking" | "auto_debit" | "cheque" | "cash" | "broker" | null;
  parties: ExtractedParty[];
  /**
   * Join keys for reconciliation. The matcher scores on these, so recall here
   * matters more than precision — a spurious key costs little, a missing one
   * costs a match.
   */
  reference_ids: {
    order_no?: string;
    invoice_no?: string;
    approval_code?: string;
    utr?: string;
    wallet_ref?: string;
    auth_code?: string;
    [k: string]: string | undefined;
  };
  /** Raw merchant descriptor as printed (e.g. "SWIGGY*BLR 080"). */
  counterparty_descriptor: string | null;
  /**
   * Securities traded, when the document is a contract note or trade
   * confirmation. One entry per SECURITY, not per document: a single note
   * often settles a dozen different scrips, and collapsing them into one
   * rupee figure loses the portfolio entirely.
   */
  holdings?: Array<{
    name: string;
    isin?: string | null;
    quantity?: number | null;
    price_minor?: number | null;
    amount_minor?: number | null;
    side?: "buy" | "sell" | null;
  }> | null;
  /** Account the money moved FROM, as printed (e.g. "Example Bank Credit Card ending 4242"). */
  source_of_funds_text: string | null;
  /** For transfers: the account money moved INTO. */
  destination_of_funds_text: string | null;
  purpose_text: string | null;
  category_hint: string | null;
  /**
   * TRUE only for a wallet/prepaid top-up: money moving from an account I own
   * into another account I own. Never true for a purchase.
   */
  is_wallet_topup: boolean;
  confidence: number;
  notes: string | null;
  /**
   * Present only for doc_type IN ('bank_statement', 'card_statement').
   *
   * Deterministic-first (work order 04 §A.2): the daemon parses the
   * markdown table itself (column mapping, row extraction, running-balance
   * continuity) BEFORE any AI call. This field is what AI contributes when
   * the layout is unfamiliar or a line needs classification — never the sole
   * source of the line data. See daemon/statements.ts.
   *
   * The 21-security holdings truncation (max_tokens=2048 silently dropping
   * the array) is the reason `lines` is chunked per response rather than
   * requested as one array for a 100+ row statement: a single truncated
   * response would ship this feature broken exactly the same way.
   */
  statement?: {
    institution: string | null;
    account_ref: string | null;
    period_from: string | null;
    period_to: string | null;
    opening_balance_minor: number | null;
    closing_balance_minor: number | null;
    currency: string;
    lines: StatementLineExtraction[];
  } | null;
}

export interface StatementLineExtraction {
  line_no: number;
  occurred_at: string | null;
  raw_descriptor: string;
  amount_minor: number;
  direction: "out" | "in";
  balance_after_minor?: number | null;
  currency?: string;
  /** Present only when the line states an amount in a currency other than the statement's own. */
  fx_original?: { amount_minor: number; currency: string } | null;
  /** UTR/RRN/cheque/UPI ref — what lets this line cross AUTO_LINK against a matching invoice reference id. */
  reference_id?: string | null;
}

/** JSON Schema handed to Claude as a tool definition for strict output. */
export const EXTRACTION_TOOL_SCHEMA = {
  name: "record_extraction",
  description:
    "Record the structured financial extraction for one document. Every monetary amount MUST be an integer in minor units (paise for INR): 643.72 -> 64372.",
  input_schema: {
    type: "object",
    properties: {
      doc_type: {
        type: "string",
        enum: [
          "merchant_invoice", "card_confirmation", "bank_slip", "payment_receipt",
          "wallet_topup_confirmation", "statement_line", "refund_note",
          "contract_note", "salary_slip", "bank_statement", "card_statement",
          "irrelevant", "unknown",
        ],
      },
      occurred_at: { type: ["string", "null"], description: "Economic date, ISO yyyy-mm-dd. Source dates are DD-MM-YYYY." },
      posted_at: { type: ["string", "null"], description: "Settlement date if stated separately, ISO yyyy-mm-dd." },
      amount_minor: { type: ["integer", "null"], description: "Total in MINOR units. 643.72 INR -> 64372." },
      currency: { type: "string", description: "ISO 4217, default INR." },
      direction: { type: ["string", "null"], enum: ["out", "in", "transfer", null] },
      payment_rail: {
        type: ["string", "null"],
        enum: ["upi", "card", "netbanking", "auto_debit", "cheque", "cash", "broker", null],
      },
      parties: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            kind: {
              type: "string",
              enum: ["person", "organisation", "account", "instrument"],
              description:
                "person=a human; organisation=a counterparty we transact with; account=a store of funds I OWN (bank/card/wallet/cash); instrument=something held or bought (equity, fund, FD).",
            },
            subtype: { type: "string" },
            role: { type: "string", enum: ["owner", "counterparty", "issuer", "source_of_funds"] },
            identifiers: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["name", "kind", "role"],
        },
      },
      reference_ids: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "order_no, invoice_no, approval_code, utr, wallet_ref, auth_code. Include every ID present.",
      },
      counterparty_descriptor: { type: ["string", "null"] },
      holdings: {
        type: ["array", "null"],
        description:
          "Securities traded. ONE ENTRY PER SECURITY — a contract note settling 18 scrips must return 18 entries, not 1. Omit entirely for non-trade documents.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Security name exactly as printed." },
            isin: { type: ["string", "null"], description: "ISIN when printed (INE... / INF...)." },
            quantity: { type: ["number", "null"], description: "Number of shares/units." },
            price_minor: { type: ["integer", "null"], description: "Per-unit price in paise." },
            amount_minor: { type: ["integer", "null"], description: "Line value in paise." },
            side: { type: ["string", "null"], enum: ["buy", "sell", null] },
          },
          required: ["name"],
        },
      },
      source_of_funds_text: { type: ["string", "null"] },
      destination_of_funds_text: { type: ["string", "null"] },
      purpose_text: { type: ["string", "null"] },
      category_hint: { type: ["string", "null"] },
      is_wallet_topup: {
        type: "boolean",
        description:
          "TRUE only when money moves from an account I own into another account I own (wallet load / top-up / ADD MONEY). FALSE for any purchase, even one paid from a wallet balance.",
      },
      confidence: { type: "number" },
      notes: { type: ["string", "null"] },
    },
    // `holdings` is REQUIRED even though it is nullable. Left optional, the
    // model simply omitted it on every contract note — the securities are the
    // most expensive part of the document to read, so an optional field is an
    // invitation to skip the work. Required-and-nullable forces a decision:
    // return the line items, or explicitly return null for a non-trade doc.
    required: ["doc_type", "currency", "parties", "reference_ids", "is_wallet_topup", "confidence", "holdings"],
  },
} as const;

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured financial facts from a document's canonical markdown.

Rules that matter more than anything else:

1. AMOUNTS ARE INTEGER MINOR UNITS. INR 643.72 becomes 64372. Never emit a float.
   Indian digit grouping is lakh/crore: "Rs.1,42,356.28" is 14235628 minor units
   (one lakh forty-two thousand), NOT 142356280.

2. DATES ARE DD-MM-YYYY in these documents. "06-08-2026" is 6 August 2026.
   Emit ISO yyyy-mm-dd.

3. THE FOUR ENTITY KINDS ARE DISTINCT AND MUST NOT BE CONFLATED:
   - organisation : a counterparty you transact WITH (merchant, employer, broker, bank as issuer)
   - account      : a store of funds YOU OWN (bank account, credit card, wallet, cash)
   - instrument   : something you HOLD or BUY (equity, mutual fund, FD, bond)
   - person       : a human
   The same brand name can appear as several kinds. "Swiggy Limited" the
   restaurant-delivery merchant, "Swiggy Ltd" the listed equity, and "Swiggy
   Money"/"Swiggy UPI Wallet" the stored-value account you own are THREE
   DIFFERENT ENTITIES. Label each occurrence by what it is in THIS document.

   AN "account" MUST BE A REAL, NAMEABLE STORE OF FUNDS YOU OWN — something
   with an institution and ideally an identifying number, like "Example Bank
   Savings ...9876" or "Example Bank Credit Card ending 4242". It is NOT:
     - a counterparty's internal ledger ("client ledger balance with X",
       "settlement account with broker Y", "net amount receivable")
     - a payment method or rail ("card/online payment", "pay online link",
       "third party online payment", "UPI")
     - an employer's payroll ("employer payroll", "salary account of company")
     - a description of where money came from ("sale proceeds of equity")
   If you cannot name the institution AND say the user owns it, DO NOT emit an
   account party. Leave source_of_funds_text as the printed text instead. A
   wrong account invents a fake transfer and removes the money from the
   user's real income or spending totals.

4. DIRECTION IS ABOUT THE USER'S MONEY, AND "transfer" IS NARROW.
   - direction="in"       money ARRIVES for the user: salary/payslip, a refund,
                          interest, a sale credited to them, a client paying an
                          invoice the user ISSUED.
   - direction="out"      the user pays someone: purchases, bills, fees.
   - direction="transfer" ONLY when money moves between TWO accounts THE USER
                          OWNS and the total the user holds is unchanged
                          (bank -> own wallet top-up, savings -> own card
                          payment). If the money comes from or goes to anyone
                          else, it is NOT a transfer.
   A SALARY CREDIT OR PAYSLIP IS direction="in", never a transfer — the
   employer is an organisation, not an account you own.

5. INVESTMENTS ARE NOT SPENDING.
   A broker contract note or trade confirmation is not a purchase of goods.
     - BUY  of shares/units  -> direction="out", doc_type="contract_note",
       and the security is an INSTRUMENT party (kind="instrument"), with the
       broker as the organisation counterparty.
     - SELL of shares/units  -> direction="in".
   Report the trade's net amount, and set category_hint="investment" so it can
   be separated from consumption. Never label a security as an "account".

   ALSO fill the holdings array, ONE ENTRY PER SECURITY. A contract note that
   settles eighteen different scrips must return eighteen entries — each with
   the security name as printed, ISIN if shown, quantity, per-unit price in
   paise, and side ("buy" or "sell"). The net rupee figure alone is not a
   portfolio: without the line items there is no way to know what is held.
   For a single-security note, return one entry.

6. WALLET TOP-UPS ARE NOT PURCHASES. If the document shows money moving from
   your bank/card INTO a wallet balance ("ADD MONEY", "load", "top-up", balance
   before/after), set is_wallet_topup=true and direction="transfer". The
   counterparty is NOT the wallet brand — there is no counterparty, because the
   money is still yours. Conversely, an order PAID FROM a wallet balance is a
   normal purchase: is_wallet_topup=false, direction="out", and the
   source_of_funds is the wallet.

7. CAPTURE EVERY REFERENCE ID you can see — order number, invoice number,
   approval/auth code, UTR, wallet transaction ref. These are how two documents
   describing one payment get matched. A missing ID costs a match.

8. If the document is not financial, set doc_type="irrelevant" and leave
   monetary fields null.

9. A BANK OR CARD STATEMENT (many transactions, one document) is
   doc_type="bank_statement" or "card_statement" — never "statement_line".
   These are handled by a SEPARATE deterministic table parser
   (daemon/statements.ts), not by amount_minor/direction/parties on this
   extraction. If you are asked to extract one, your job is narrower than
   usual: confirm the column mapping (which column is the date, the
   descriptor, debit/credit) when the deterministic parser could not
   determine it with confidence — never invent transaction totals across
   the whole statement.

Report what the document says. Do not infer amounts that are not printed.`;
