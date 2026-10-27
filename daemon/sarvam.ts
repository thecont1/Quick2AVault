/**
 * Sarvam AI document intelligence provider.
 *
 * Unlike the generic LLM providers (Anthropic/OpenAI), Sarvam takes the RAW
 * file (PDF/image) directly — no markdown, no text extraction step. It runs
 * OCR + field extraction server-side using a schema the caller defines, and
 * returns structured data with per-field confidence.
 *
 * The API is async:
 *   1. POST multipart form to /job/extract → get job_id
 *   2. Poll /job/<id>/status until terminal
 *   3. GET /job/<id>/results → extracted fields
 *
 * Auth is via the `api-subscription-key` header (not Bearer).
 *
 * This provider is selected automatically when the India jurisdiction pack
 * is active, replacing the generic secondary (vision) provider. Sarvam is
 * tuned for Indian financial documents (GST invoices, bank statements, etc.)
 * and handles messy OCR far better than a generic vision model.
 */
import type { Logger } from "./ports.js";
import {
  type ExtractionResult,
  type ExtractedParty,
} from "./extraction-contract.js";

const SARVAM_BASE = "https://api.sarvam.ai/doc-ai/v1";

/** Poll interval for job status (ms). Sarvam typically completes in 5–15s. */
const POLL_INTERVAL_MS = 2000;
/** Max time to wait for a Sarvam job before giving up. */
const POLL_TIMEOUT_MS = 120_000;

/**
 * JSON schema sent to Sarvam. This mirrors our ExtractionResult contract
 * (daemon/extraction-contract.ts) so that every field the system expects
 * can be populated by Sarvam's extraction.
 *
 * Amounts are in MAJOR units (rupees, not paise) — Sarvam reads the printed
 * amount. We convert to minor units (×100 for INR) in the mapping.
 *
 * Parties are flattened (issuer_*, customer_*) because Sarvam's schema is a
 * flat object — nested arrays/objects are not reliably supported.
 */
const SCHEMA = {
  type: "object",
  properties: {
    // ── reference IDs ────────────────────────────────────────────────────
    invoice_number: { type: "string", description: "Invoice, bill, or receipt number printed on the document" },
    order_number: { type: "string", description: "Purchase order number, if different from invoice number" },
    utr: { type: "string", description: "UTR / UPI transaction reference / RRN number" },
    approval_code: { type: "string", description: "Card approval / auth code" },

    // ── dates ────────────────────────────────────────────────────────────
    invoice_date: { type: "string", description: "Date the document was issued (as printed: dd/mm/yyyy, dd-mm-yy, etc.)" },
    due_date: { type: "string", description: "Due date or payment deadline, if stated" },

    // ── money ────────────────────────────────────────────────────────────
    total_amount: { type: "number", description: "Total payable amount in major currency units (e.g. 1445 for ₹1,445)" },
    subtotal: { type: "number", description: "Subtotal before tax, if shown" },
    tax_amount: { type: "number", description: "Total tax (GST) amount, if shown" },
    discount: { type: "number", description: "Discount amount, if any" },
    currency: { type: "string", description: "Currency code or symbol as printed (INR, Rs, ₹, USD, $, etc.)" },

    // ── issuer (merchant/seller) ─────────────────────────────────────────
    issuer_name: { type: "string", description: "Name of the merchant, seller, or entity issuing the document" },
    issuer_gstin: { type: "string", description: "GSTIN of the issuer, if present" },
    issuer_address: { type: "string", description: "Address of the issuer" },
    issuer_email: { type: "string", description: "Email of the issuer" },
    issuer_phone: { type: "string", description: "Phone number of the issuer" },

    // ── customer (buyer/owner) ───────────────────────────────────────────
    customer_name: { type: "string", description: "Name of the customer, buyer, or person the document is addressed to" },
    customer_gstin: { type: "string", description: "GSTIN of the customer, if present" },
    customer_address: { type: "string", description: "Address of the customer" },

    // ── payment ──────────────────────────────────────────────────────────
    payment_mode: { type: "string", description: "Payment method as printed (UPI, Card, Cash, Netbanking, Cheque, etc.)" },
    place_of_supply: { type: "string", description: "Place of supply, if mentioned" },

    // ── bank details (for invoices with bank info) ───────────────────────
    bank_name: { type: "string", description: "Bank name, if the document includes bank details" },
    bank_account_number: { type: "string", description: "Bank account number of the issuer" },
    bank_ifsc: { type: "string", description: "IFSC code, if present" },

    // ── line items ───────────────────────────────────────────────────────
    line_items: {
      type: "array",
      description: "Itemised lines on the invoice/bill, if the document lists them",
      items: {
        type: "object",
        description: "A single itemised line on the document",
        properties: {
          description: { type: "string", description: "Description of the item or service" },
          quantity: { type: "number", description: "Quantity, if stated" },
          rate: { type: "number", description: "Unit price in major currency units" },
          amount: { type: "number", description: "Line total in major currency units" },
          hsn_sac: { type: "string", description: "HSN/SAC code, if present" },
        },
      },
    },

    // ── document classification ──────────────────────────────────────────
    document_type: { type: "string", description: "Type of document: tax_invoice, receipt, bank_statement, card_statement, contract_note, salary_slip, etc." },
    purpose: { type: "string", description: "Purpose or description of the transaction" },

    // ── ownership & direction ────────────────────────────────────────────
    // Sarvam has no access to the vault's identity context, so the model
    // must name the owner and classify the money movement itself.
    owner_name: { type: "string", description: "Name of the person or entity whose financial record this document belongs to (the buyer in a purchase, the seller or service provider in a sale)" },
    direction: { type: "string", description: "\"in\" if money is coming IN to the owner (income, sale, refund received); \"out\" if money is going OUT from the owner (expense, purchase, payment made); \"transfer\" if between the owner's own accounts; leave empty if unknown" },
  },
};

export interface SarvamConfig {
  apiKey: string;
  /** Override the base URL (for testing). Defaults to the public Sarvam API. */
  baseUrl?: string;
}

export function createSarvamProvider(cfg: SarvamConfig, logger: Logger): SarvamProvider {
  return new SarvamProvider(cfg, logger);
}

/**
 * Sarvam document intelligence provider. Implements a superset of the AiProvider
 * interface — the `extract` method is not used (Sarvam needs the raw file, not
 * markdown). Callers should use `extractDocument` instead.
 */
export class SarvamProvider {
  readonly available: boolean;
  readonly model = "sarvam-doc-ai";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly logger: Logger;

  constructor(cfg: SarvamConfig, logger: Logger) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl || SARVAM_BASE;
    this.logger = logger;
    this.available = !!this.apiKey;
    if (!this.apiKey) {
      logger.warn("sarvam: no API key — document intelligence will be skipped");
    }
  }

  /**
   * Extract structured data from a raw document file (PDF, JPG, PNG).
   *
   * Submits the file as a multipart job, polls until completion, then reads
   * the results and maps them to the ExtractionResult contract.
   */
  async extractDocument(rawPath: string, filename: string): Promise<ExtractionResult | null> {
    if (!this.apiKey) return null;

    try {
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      const { createHash } = await import("node:crypto");
      const fileBuffer = await readFile(rawPath);
      const fileBasename = basename(rawPath);
      // Content hash, not the filename: HTTP header values must be ASCII-safe
      // (a filename like "Ínvoice ₹1,445.pdf" would make fetch throw), and
      // name+length collides across different documents.
      const contentHash = createHash("sha256").update(fileBuffer).digest("hex");
      // The schema is part of the extraction identity: same bytes, new schema
      // must re-extract. Caching by content alone would replay results from
      // an older field set forever (no direction, no owner, no dates).
      const schemaHash = createHash("sha256").update(JSON.stringify(SCHEMA)).digest("hex").slice(0, 16);

      // 1. Submit the job
      const formData = new FormData();
      formData.append("schema", JSON.stringify(SCHEMA));
      formData.append("language", "en-IN");
      formData.append("output_format", "json");
      formData.append("classification", "false");
      formData.append("auto_orient", "true");
      formData.append("file", new Blob([fileBuffer]), fileBasename);

      const submitRes = await fetch(`${this.baseUrl}/job/extract`, {
        method: "POST",
        headers: {
          "api-subscription-key": this.apiKey,
          "Idempotency-Key": `q2av-${contentHash}-${schemaHash}`,
        },
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });

      if (!submitRes.ok) {
        const errText = await submitRes.text().catch(() => "");
        this.logger.error("sarvam: job submit failed", {
          status: submitRes.status,
          filename,
          err: errText.slice(0, 200),
        });
        return null;
      }

      const job = (await submitRes.json()) as { job_id?: string; status?: string };
      if (!job.job_id) {
        this.logger.error("sarvam: no job_id in response", { filename, response: job });
        return null;
      }
      this.logger.info("sarvam: job submitted", {
        filename,
        job_id: job.job_id,
        status: job.status,
      });

      // 2. Poll until terminal
      const result = await this.pollJob(job.job_id, filename);
      if (!result) return null;

      // 3. Map to ExtractionResult
      return this.mapResult(result, filename);
    } catch (err) {
      this.logger.error("sarvam: extraction failed", {
        filename,
        err: (err as Error)?.message,
      });
      return null;
    }
  }

  /**
   * Poll the status endpoint until the job reaches a terminal state.
   * Returns the final status+results, or null on failure/timeout.
   */
  private async pollJob(
    jobId: string,
    filename: string,
  ): Promise<{ status: string; result?: Record<string, unknown> } | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      let statusRes: Response;
      try {
        statusRes = await fetch(`${this.baseUrl}/job/${jobId}/status`, {
          headers: { "api-subscription-key": this.apiKey },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        // A hung status poll must not abort the whole job — retry until the
        // deadline rather than letting one slow request kill the analyse.
        this.logger.warn("sarvam: status poll failed", {
          job_id: jobId,
          err: (err as Error)?.message,
        });
        continue;
      }
      if (!statusRes.ok) {
        this.logger.warn("sarvam: status poll failed", {
          job_id: jobId,
          status: statusRes.status,
        });
        continue;
      }
      const statusJson = (await statusRes.json()) as { status: string };

      if (["completed", "partially_completed"].includes(statusJson.status)) {
        // Fetch results
        let resultsRes: Response;
        try {
          resultsRes = await fetch(`${this.baseUrl}/job/${jobId}/results?format=json`, {
            headers: { "api-subscription-key": this.apiKey },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          this.logger.error("sarvam: results fetch failed", {
            job_id: jobId,
            err: (err as Error)?.message,
          });
          return null;
        }
        if (!resultsRes.ok) {
          this.logger.error("sarvam: results fetch failed", {
            job_id: jobId,
            status: resultsRes.status,
          });
          return null;
        }
        const resultsJson = (await resultsRes.json()) as {
          status: string;
          result?: Record<string, unknown>;
        };
        this.logger.info("sarvam: job completed", {
          filename,
          job_id: jobId,
          status: resultsJson.status,
        });
        return { status: resultsJson.status, result: resultsJson.result };
      }

      if (["failed", "rejected"].includes(statusJson.status)) {
        this.logger.error("sarvam: job failed", {
          filename,
          job_id: jobId,
          status: statusJson.status,
        });
        return null;
      }
      // Still pending/processing — keep polling
    }
    this.logger.error("sarvam: job timed out", { filename, job_id: jobId });
    return null;
  }

  /**
   * Map Sarvam's extracted fields to our ExtractionResult contract.
   *
   * Sarvam returns amounts in major units (as printed). We convert to minor
   * units (paise for INR) by multiplying by 100.
   *
   * The schema sent to Sarvam mirrors our ExtractionResult contract, so
   * every field here has a corresponding extraction target.
   */
  private mapResult(
    jobResult: { status: string; result?: Record<string, unknown> },
    filename: string,
  ): ExtractionResult {
    const r = jobResult.result ?? {};
    const str = (k: string): string | null => {
      const v = r[k];
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s || null;
    };
    const num = (k: string): number | null => {
      const v = r[k];
      if (v === null || v === undefined) return null;
      const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const arr = (k: string): Record<string, unknown>[] => {
      const v = r[k];
      return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    };

    // Currency: normalise common Indian variants. An absent currency stays
    // empty per the extraction contract (normaliseCurrency no longer defaults
    // to INR).
    const currencyRaw = str("currency") ?? "";
    const currency = normaliseCurrency(currencyRaw);

    // Convert major → minor units using the currency's ISO minor-unit
    // precision (JPY/KRW are zero-decimal; KWD/BHD are three-decimal).
    const toMinor = (major: number | null): number | null =>
      major === null ? null : Math.round(major * minorUnits(currency));

    const totalAmount = num("total_amount");
    const subtotal = num("subtotal");
    const taxAmount = num("tax_amount");

    // Parse dates: Sarvam may return dd/mm/yyyy, dd-mm-yyyy, dd|mm/yy, etc.
    const occurredAt = str("invoice_date") ? parseDate(str("invoice_date")!) : null;
    const postedAt = str("due_date") ? parseDate(str("due_date")!) : null;

    // Build parties with identifiers from the extracted fields. The model
    // supplies owner_name — the person/entity whose financial record this
    // document belongs to — because Sarvam cannot see the vault's identity
    // context. Without it, a sales invoice issued BY the owner would mark
    // the customer as the owner.
    const parties: ExtractedParty[] = [];
    const ownerName = (str("owner_name") ?? "").trim().toLowerCase();
    const isOwner = (name: string) => ownerName !== "" && name.trim().toLowerCase() === ownerName;
    const issuerName = str("issuer_name");
    if (issuerName) {
      const issuerIdentifiers: Record<string, string> = {};
      const gstin = str("issuer_gstin");
      if (gstin) issuerIdentifiers.gstin = gstin;
      const email = str("issuer_email");
      if (email) issuerIdentifiers.email = email;
      const phone = str("issuer_phone");
      if (phone) issuerIdentifiers.phone = phone;
      parties.push({
        name: issuerName,
        // Ownership affects the ROLE only; kind derives from the
        // identifiers — a GSTIN-bearing issuer is an organisation even
        // when the business owner's name appears on the invoice.
        kind: gstin ? "organisation" : "person",
        role: isOwner(issuerName) ? "owner" : "issuer",
        identifiers: issuerIdentifiers,
      });
    }
    const customerName = str("customer_name");
    if (customerName) {
      const customerIdentifiers: Record<string, string> = {};
      const gstin = str("customer_gstin");
      if (gstin) customerIdentifiers.gstin = gstin;
      parties.push({
        name: customerName,
        kind: "person",
        role: isOwner(customerName) ? "owner" : "counterparty",
        identifiers: customerIdentifiers,
      });
    }

    // Determine doc_type: prefer Sarvam's classification, fall back to inference
    const sarvamDocType = str("document_type")?.toLowerCase();
    const docType = sarvamDocType ? mapDocType(sarvamDocType) : inferDocType(r, filename);

    // Payment rail mapping
    const paymentMode = str("payment_mode")?.toLowerCase() ?? "";
    let paymentRail: ExtractionResult["payment_rail"] = null;
    if (paymentMode.includes("upi")) paymentRail = "upi";
    else if (paymentMode.includes("card")) paymentRail = "card";
    else if (paymentMode.includes("netbanking") || paymentMode.includes("net banking")) paymentRail = "netbanking";
    else if (paymentMode.includes("auto") && paymentMode.includes("debit")) paymentRail = "auto_debit";
    else if (paymentMode.includes("cash")) paymentRail = "cash";
    else if (paymentMode.includes("cheque") || paymentMode.includes("check")) paymentRail = "cheque";

    // Line items — each item has its own description/amount/rate fields
    const lineItems = arr("line_items").map((item) => {
      const itemNum = (k: string): number | null => {
        const v = item[k];
        if (v === null || v === undefined) return null;
        const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };
      return {
        description: String(item.description ?? "").trim() || "Line item",
        amount_minor: toMinor(itemNum("amount") ?? itemNum("rate")),
      };
    }).filter((li) => li.amount_minor !== null);

    // Reference IDs — collect all that are present
    const reference_ids: ExtractionResult["reference_ids"] = {};
    const invoiceNo = str("invoice_number");
    if (invoiceNo) reference_ids.invoice_no = invoiceNo;
    const orderNo = str("order_number");
    if (orderNo) reference_ids.order_no = orderNo;
    const utr = str("utr");
    if (utr) reference_ids.utr = utr;
    const approvalCode = str("approval_code");
    if (approvalCode) reference_ids.approval_code = approvalCode;

    // Source of funds: if bank details are present, describe the account
    const bankName = str("bank_name");
    const bankAccount = str("bank_account_number");
    const sourceOfFunds = bankName || bankAccount
      ? [bankName, bankAccount ? `A/c ${bankAccount}` : null].filter(Boolean).join(", ")
      : null;

    // Direction: the model classifies the money movement from the document
    // itself, since Sarvam cannot see the vault's entities.
    const rawDir = (str("direction") ?? "").toLowerCase();
    const direction: ExtractionResult["direction"] =
      rawDir === "in" || rawDir === "out" || rawDir === "transfer" ? rawDir : null;

    return {
      doc_type: docType,
      occurred_at: occurredAt,
      posted_at: postedAt,
      amount_minor: toMinor(totalAmount),
      currency,
      subtotal_minor: toMinor(subtotal),
      tax_minor: toMinor(taxAmount),
      line_items: lineItems.length > 0 ? lineItems : null,
      direction,
      payment_rail: paymentRail,
      parties,
      reference_ids,
      counterparty_descriptor: issuerName,
      source_of_funds_text: sourceOfFunds,
      destination_of_funds_text: null,
      purpose_text: str("purpose"),
      category_hint: null,
      is_wallet_topup: false,
      confidence: 0.85,
      notes: `Extracted by Sarvam AI document intelligence (status: ${jobResult.status})`,
    };
  }
}

/**
 * Parse a date string in various Indian formats to ISO yyyy-mm-dd.
 * Handles dd/mm/yyyy, dd-mm-yyyy, dd|mm/yy, etc.
 */
function parseDate(raw: string): string | null {
  const cleaned = raw.trim().replace(/[|]/g, "/");
  // dd/mm/yyyy or dd/mm/yy
  const m = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    // Reject out-of-range components: an American-format date like 02/13/2026
    // would otherwise become "2026-13-02".
    const dayNum = Number(m[1]);
    const monthNum = Number(m[2]);
    if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) return null;
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    let year = m[3];
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }
  // yyyy-mm-dd (already ISO)
  const iso = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return cleaned;
  return null;
}

/** Infer document type from extracted fields and filename. */
function inferDocType(r: Record<string, unknown>, filename: string): ExtractionResult["doc_type"] {
  // Match on VALUES only, not JSON.stringify(r): stringifying serialises schema
  // field names too, so a key like "issuer_gstin" would make every document
  // look like a merchant_invoice. Restrict to scalar values so nested objects
  // (line_items) don't contribute their own keys either.
  const allText =
    Object.values(r)
      .filter((v) => typeof v === "string" || typeof v === "number")
      .map((v) => String(v))
      .join(" ")
      .toLowerCase() +
    " " +
    filename.toLowerCase();
  if (allText.includes("tax invoice") || allText.includes("gstin") || allText.includes("gst")) {
    return "merchant_invoice";
  }
  if (allText.includes("contract note") || allText.includes("trade confirmation")) {
    return "contract_note";
  }
  if (allText.includes("bank statement") || allText.includes("account statement")) {
    return "bank_statement";
  }
  if (allText.includes("card statement")) {
    return "card_statement";
  }
  if (allText.includes("receipt")) {
    return "payment_receipt";
  }
  if (allText.includes("salary") || allText.includes("payslip")) {
    return "salary_slip";
  }
  return "unknown";
}

/**
 * Map Sarvam's document_type string to our DocType enum. Sarvam may return
 * variations like "tax_invoice", "Tax Invoice", "invoice", etc.
 */
function mapDocType(raw: string): ExtractionResult["doc_type"] {
  const t = raw.toLowerCase().replace(/[\s-]/g, "_");
  if (t.includes("tax_invoice") || t === "invoice") return "merchant_invoice";
  if (t.includes("contract_note") || t.includes("trade")) return "contract_note";
  if (t.includes("bank_statement")) return "bank_statement";
  if (t.includes("card_statement")) return "card_statement";
  if (t.includes("receipt")) return "payment_receipt";
  if (t.includes("salary") || t.includes("payslip")) return "salary_slip";
  if (t.includes("refund")) return "refund_note";
  if (t.includes("wallet") || t.includes("topup")) return "wallet_topup_confirmation";
  if (t.includes("bank_slip") || t.includes("slip")) return "bank_slip";
  // Fall back to inference from the raw string
  return inferDocType({ document_type: raw }, "");
}

/**
 * Normalise currency strings. Sarvam may return "INR", "Rs", "₹", "Rs.",
 * "Indian Rupee", etc. We need the ISO 4217 code.
 */
function normaliseCurrency(raw: string): string {
  const c = raw.trim().toUpperCase();
  // The extraction contract forbids guessing: no printed currency means an
  // empty string, not a default. Assuming INR is what rendered a USD invoice
  // as ₹597.
  if (!c) return "";
  if (c === "INR" || c === "₹" || c.includes("RS") || c.includes("RUPEE")) return "INR";
  if (c === "USD" || c === "$") return "USD";
  if (c === "EUR" || c === "€") return "EUR";
  if (c === "GBP" || c === "£") return "GBP";
  // Already a 3-letter code? Return as-is.
  if (/^[A-Z]{3}$/.test(c)) return c;
  return raw.trim();
}

const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "PYG", "UGX", "RWF", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "KWD", "OMR", "JOD", "TND", "LYD", "IQD"]);

/**
 * ISO 4217 minor-unit multiplier for a currency code (major → minor).
 * Defaults to 100 (two-decimal). Zero-decimal and three-decimal currencies
 * need their own factors or amounts would be off by orders of magnitude.
 */
function minorUnits(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 1000;
  return 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
