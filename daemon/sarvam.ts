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
 * JSON schema sent to Sarvam. The field names are ours; Sarvam extracts
 * whatever the schema describes. We map these to ExtractionResult after.
 *
 * `total_amount` is a number in MAJOR units (rupees, not paise) — Sarvam
 * reads the printed amount. We convert to minor units in the mapping.
 */
const SCHEMA = {
  type: "object",
  properties: {
    invoice_number: { type: "string", description: "Invoice, bill, or receipt number" },
    invoice_date: { type: "string", description: "Date the document was issued (dd/mm/yyyy or as printed)" },
    total_amount: { type: "number", description: "Total payable amount in major currency units" },
    subtotal: { type: "number", description: "Subtotal before tax, if shown" },
    tax_amount: { type: "number", description: "Total tax (GST) amount, if shown" },
    currency: { type: "string", description: "Currency code or symbol (INR, Rs, etc.)" },
    issuer_name: { type: "string", description: "Name of the merchant/seller/issuer" },
    issuer_gstin: { type: "string", description: "GSTIN of the issuer, if present" },
    customer_name: { type: "string", description: "Name of the customer/buyer" },
    payment_mode: { type: "string", description: "Payment method (UPI, Card, Cash, etc.)" },
    place_of_supply: { type: "string", description: "Place of supply, if mentioned" },
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
      const fileBuffer = await readFile(rawPath);
      const fileBasename = basename(rawPath);

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
          "Idempotency-Key": `q2av-${filename}-${fileBuffer.length}`,
        },
        body: formData,
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

      const statusRes = await fetch(`${this.baseUrl}/job/${jobId}/status`, {
        headers: { "api-subscription-key": this.apiKey },
      });
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
        const resultsRes = await fetch(`${this.baseUrl}/job/${jobId}/results?format=json`, {
          headers: { "api-subscription-key": this.apiKey },
        });
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

    // Convert major → minor units (INR: ×100)
    const toMinor = (major: number | null): number | null =>
      major === null ? null : Math.round(major * 100);

    const totalAmount = num("total_amount");
    const subtotal = num("subtotal");
    const taxAmount = num("tax_amount");

    // Parse date: Sarvam may return dd/mm/yyyy, dd-mm-yyyy, etc.
    const rawDate = str("invoice_date");
    const occurredAt = rawDate ? parseDate(rawDate) : null;

    // Build parties
    const parties: ExtractedParty[] = [];
    const issuerName = str("issuer_name");
    if (issuerName) {
      parties.push({
        name: issuerName,
        kind: "organisation",
        role: "issuer",
        identifiers: {},
      });
    }
    const customerName = str("customer_name");
    if (customerName) {
      parties.push({
        name: customerName,
        kind: "person",
        role: "owner",
        identifiers: {},
      });
    }

    // Determine doc_type from the document content
    const docType = inferDocType(r, filename);

    // Payment rail mapping
    const paymentMode = str("payment_mode")?.toLowerCase() ?? "";
    let paymentRail: ExtractionResult["payment_rail"] = null;
    if (paymentMode.includes("upi")) paymentRail = "upi";
    else if (paymentMode.includes("card")) paymentRail = "card";
    else if (paymentMode.includes("netbanking") || paymentMode.includes("bank")) paymentRail = "netbanking";
    else if (paymentMode.includes("cash")) paymentRail = "cash";
    else if (paymentMode.includes("cheque")) paymentRail = "cheque";

    const currencyRaw = str("currency")?.toUpperCase() ?? "";
    const currency = currencyRaw || (currencyRaw.includes("RS") || currencyRaw.includes("₹") ? "INR" : "INR");

    return {
      doc_type: docType,
      occurred_at: occurredAt,
      posted_at: null,
      amount_minor: toMinor(totalAmount),
      currency,
      subtotal_minor: toMinor(subtotal),
      tax_minor: toMinor(taxAmount),
      direction: null,
      payment_rail: paymentRail,
      parties,
      reference_ids: {
        invoice_no: str("invoice_number") ?? undefined,
      },
      counterparty_descriptor: issuerName,
      source_of_funds_text: null,
      destination_of_funds_text: null,
      purpose_text: null,
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
  const allText = JSON.stringify(r).toLowerCase() + " " + filename.toLowerCase();
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
