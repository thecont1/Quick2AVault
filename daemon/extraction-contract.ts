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
  /** Account the money moved FROM, as printed (e.g. "HDFC Bank Credit Card ending 1668"). */
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
          "contract_note", "salary_slip", "irrelevant", "unknown",
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
    required: ["doc_type", "currency", "parties", "reference_ids", "is_wallet_topup", "confidence"],
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

4. WALLET TOP-UPS ARE NOT PURCHASES. If the document shows money moving from
   your bank/card INTO a wallet balance ("ADD MONEY", "load", "top-up", balance
   before/after), set is_wallet_topup=true and direction="transfer". The
   counterparty is NOT the wallet brand — there is no counterparty, because the
   money is still yours. Conversely, an order PAID FROM a wallet balance is a
   normal purchase: is_wallet_topup=false, direction="out", and the
   source_of_funds is the wallet.

5. CAPTURE EVERY REFERENCE ID you can see — order number, invoice number,
   approval/auth code, UTR, wallet transaction ref. These are how two documents
   describing one payment get matched. A missing ID costs a match.

6. If the document is not financial, set doc_type="irrelevant" and leave
   monetary fields null.

Report what the document says. Do not infer amounts that are not printed.`;
