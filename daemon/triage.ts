/**
 * Intelligent Intake Triage — work order 06 §5/§6.
 *
 * A PURE function. No filesystem, no database, no network, no AI. The daemon
 * hands it everything it needs (filename, mime, bytes, optional extracted
 * text) and it returns one of three dispositions plus a human-readable
 * reason. Duplicate detection is a SEPARATE deterministic hash step performed
 * by the pipeline before this runs; it produces the `duplicate` intake
 * disposition, which is not a TriageDisposition.
 *
 * Design rule (§6.2): medium/low-confidence inputs are ACCEPTED with a
 * `triage_review` flag rather than rejected. The system prefers a reviewable
 * false positive to silently losing a financial document. Irrelevant is
 * returned only when deterministic evidence is strong.
 */
export type TriageDisposition = "accepted" | "irrelevant" | "failed";

export type TriageConfidence = "high" | "medium" | "low";

export type TriageResult = {
  disposition: TriageDisposition;
  reasonCode: string;
  reason: string;
  confidence: TriageConfidence;
  signals: string[];
  /**
   * `true` when the item is accepted but the daemon should surface it for
   * human review rather than silently processing it. Set on medium/low
   * confidence accepts and on pending-OCR image accepts (§6.2, §6.3).
   */
  triage_review?: boolean;
};

/** Inputs the triage function needs. All derived BEFORE triage runs. */
export interface TriageInput {
  filename: string;
  mimeType: string;
  byteSize: number;
  /** Raw bytes — used for empty/near-empty detection and magic-byte sniffing. */
  bytes: Buffer;
  /**
   * Best-effort extracted text (plaintext path, .eml body, OCR output). May be
   * empty for images/PDFs that have not been converted yet — triage must not
   * require it (§6.3).
   */
  text?: string;
  /** Source channel: 'folder' | 'api' | 'gmail' | 'drag'. Used only for signals. */
  source?: string;
}

// ── Accepted signals (§6.1) ──────────────────────────────────────────────────
// Credible document/financial vocabulary. Matched case-insensitively on the
// filename AND any extracted text. The list is deliberately broad: a false
// positive costs one review click, a false negative loses a financial document.
const FINANCIAL_KEYWORDS =
  /\b(invoice|receipt|statement|payslip|pay slip|salary|tax|bank|card|broker|contract note|insurance|mutual fund|bond|fixed deposit|\bFD\b|rent|utility|subscription|reimbursement|GST|PAN|TDS|payment|UTR|RRN|account|amount|currency|total|due date|invoice number|bill|premium|emi|loan|deposit|withdrawal|cheque|upi|imps|neft|rtgs|settlement|ledger|folio|nav|scrip|dividend|interest|principal)\b/i;

// Gmail transaction-alert patterns (§6.1). Indian rails first because that is
// the vault's home market, but the structure is generic enough for any bank
// SMS-style alert.
const GMAIL_ALERT_PATTERN = new RegExp(
  "debited|credited|spent|received|sent|transaction|payment of|upi ref|utr|rrn|cheque no|imps ref|neft ref|rtgs ref|card ending|a/c|account\\s*\\*?\\d|x?xxx",
  "i",
);

// Currency / amount / date signals inside text. Totals and dates together are
// a strong document signal even without a keyword.
const CURRENCY_AMOUNT = /(?:₹|rs\.?|inr|usd|eur|gbp|\$|€|£)\s?\d|[0-9][0-9,]*\.[0-9]{2}/i;
const DATE_PATTERN = /\b\d{1,2}[-/.\s](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2})[-/.\s]\d{2,4}\b/i;
const INVOICE_NUMBER = /\b(invoice|bill|receipt|ref|reference|no\.?)\s*[:#]?\s*[A-Z0-9-]{4,}/i;

// Table-like financial content: rows of numbers aligned in columns.
const TABLE_LIKE = /(?:^|\n)\s*[-a-z ]+.{0,40}\d+[.,]\d{2}.{0,80}\n\s*[-a-z ]+.{0,40}\d+[.,]\d{2}/i;

// ── Irrelevant signals (§6.2) ────────────────────────────────────────────────
// Personal/non-financial content. Matched only when NO accepted signal fired.
// Plurals are tolerated (recipe/recipes, birthday/birthdays) because a contacts
// list or note is just as irrelevant in plural form.
const PERSONAL_NOTE_KEYWORDS =
  /\b(recipes?|ingredients?|shopping lists?|todos?|to-dos?|reminders?|birthdays?|anniversary|diary|journal|love|xx|happy birthdays?|congrats|get well|vacation itinerar(?:y|ies)|packing lists?)\b/i;

// Image-only family photo EXIF-ish signals are not available without a vision
// model, so for images we rely on filename + size + absence of any document
// signal. A "IMG_1234.HEIC" with no document keyword and a plausible photo
// size is the canonical irrelevant photo case.
const PHOTO_FILENAME = /^(img[_-]?\d|dsc[_-]?\d|photo|selfie|pic|camera|whatsapp image|screenshot)/i;

// Near-empty threshold (§6.2). Below this, a text file is junk.
const NEAR_EMPTY_BYTES = 16;

// Extensions that are document-like by type even before reading content.
const DOCUMENT_EXT = new Set([
  ".pdf", ".doc", ".docx", ".docm", ".ppt", ".pptx", ".xls", ".xlsx",
  ".odt", ".ods", ".odp", ".rtf", ".epub", ".csv", ".tsv",
  ".eml", ".msg",
]);
const TEXT_EXT = new Set([".txt", ".md", ".html", ".htm", ".json", ".log", ".text"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif"]);

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i).toLowerCase() : "";
}

/** True if the buffer's first bytes match a known document magic. */
function hasDocumentMagic(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  // PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return true; // %PDF
  // Office OOXML (zip) — weak but combined with extension is fine
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return true; // PK
  // RTF
  if (bytes.slice(0, 5).toString("ascii") === "{\\rtf") return true;
  return false;
}

/** True if the buffer looks like a raster image (JPEG/PNG/GIF/WEBP magic). */
function hasImageMagic(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  // GIF
  if (bytes.slice(0, 6).toString("ascii") === "GIF87a" || bytes.slice(0, 6).toString("ascii") === "GIF89a") return true;
  // WEBP
  if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP") return true;
  return false;
}

/**
 * The pure triage function. Deterministic, no I/O, no AI.
 *
 * Order of evaluation matters:
 *   1. Empty/near-empty → irrelevant (strong, deterministic).
 *   2. Strong accepted signals (keyword + amount/date, document magic + ext,
 *      gmail alert, table-like) → accepted, confidence high.
 *   3. Weaker accepted signals (keyword alone, document ext alone, image with
 *      document filename) → accepted with triage_review, confidence medium/low.
 *   4. Image with no text and no document signal → accepted pending_ocr
 *      (§6.3: never confidently irrelevant without reading the image).
 *   5. Strong irrelevant signals (personal note keywords, photo filename with
 *      no document signal) → irrelevant, confidence high/medium.
 *   6. Default: accept with triage_review (prefer reviewable false positive).
 */
export function triage(input: TriageInput): TriageResult {
  const { filename, mimeType, byteSize, bytes, text = "", source } = input;
  const ext = extOf(filename);
  const haystack = `${filename}\n${text}`;
  const signals: string[] = [];

  // ── 1. Empty / near-empty (§6.2) ──────────────────────────────────────────
  if (byteSize === 0) {
    return {
      disposition: "irrelevant",
      reasonCode: "empty_file",
      reason: "File is empty (0 bytes).",
      confidence: "high",
      signals: ["byte_size=0"],
    };
  }
  if (byteSize > 0 && byteSize <= NEAR_EMPTY_BYTES && !text.trim()) {
    return {
      disposition: "irrelevant",
      reasonCode: "near_empty_file",
      reason: `File is near-empty (${byteSize} bytes) with no readable text.`,
      confidence: "high",
      signals: [`byte_size=${byteSize}`, "no_text"],
    };
  }

  // ── 2. Strong accepted signals ────────────────────────────────────────────
  const kw = FINANCIAL_KEYWORDS.test(haystack);
  const amount = CURRENCY_AMOUNT.test(text) || CURRENCY_AMOUNT.test(filename);
  const date = DATE_PATTERN.test(text);
  const invoiceNo = INVOICE_NUMBER.test(text);
  const tableLike = TABLE_LIKE.test(text);
  const gmailAlert = source === "gmail" && GMAIL_ALERT_PATTERN.test(text);
  const docMagic = hasDocumentMagic(bytes);
  const imgMagic = hasImageMagic(bytes);

  if (gmailAlert) {
    signals.push("gmail_transaction_alert");
    return {
      disposition: "accepted",
      reasonCode: "gmail_alert",
      reason: "Recognised Gmail transaction-alert pattern.",
      confidence: "high",
      signals,
    };
  }
  if (kw && (amount || date || invoiceNo)) {
    signals.push("financial_keyword", amount ? "amount" : date ? "date" : "invoice_number");
    return {
      disposition: "accepted",
      reasonCode: "financial_signals",
      reason: "Filename or text contains financial keywords alongside amounts, dates, or invoice numbers.",
      confidence: "high",
      signals,
    };
  }
  if (tableLike) {
    signals.push("table_like_content");
    return {
      disposition: "accepted",
      reasonCode: "table_like",
      reason: "Text contains table-like financial content (aligned numeric rows).",
      confidence: "high",
      signals,
    };
  }
  if (docMagic && (DOCUMENT_EXT.has(ext) || mimeType.includes("pdf") || mimeType.includes("officedocument"))) {
    signals.push("document_magic", `ext=${ext || "none"}`);
    // A real PDF/Office file is a document by type; confidence depends on
    // whether we also saw a financial keyword.
    return {
      disposition: "accepted",
      reasonCode: kw ? "document_with_keyword" : "document_by_type",
      reason: kw
        ? "Document file with financial keyword in filename or text."
        : "Document file type (PDF/Office) — accepted pending content review.",
      confidence: kw ? "high" : "medium",
      signals,
      triage_review: !kw,
    };
  }

  // ── 3. Images / scans (§6.3) — BEFORE weak keyword so "receipt-scan.jpg" ──
  // hits the image/pending_ocr path rather than the financial_keyword path.
  // An image is a fundamentally different intake shape: it needs OCR before
  // text signals are available, and §6.3 forbids confidently calling an
  // unread image irrelevant.
  if (IMAGE_EXT.has(ext) || imgMagic || mimeType.startsWith("image/")) {
    // A document-like image filename (receipt, invoice, statement, scan) is
    // accepted even with no text yet.
    const docishName = /\b(receipt|invoice|bill|statement|scan|slip|ticket|voucher|memo|contract|payslip|salary|tax|gst|tds|pan|premium|emi|loan)\b/i.test(filename);
    if (docishName) {
      signals.push("image", "document_like_filename");
      return {
        disposition: "accepted",
        reasonCode: text.trim() ? "image_with_text" : "pending_ocr",
        reason: text.trim()
          ? "Image with document-like filename and extracted text."
          : "Document-like image — accepted pending OCR.",
        confidence: text.trim() ? "medium" : "low",
        signals,
        triage_review: !text.trim(),
      };
    }
    // An image with NO document signal and NO text. Per §6.3 we must NOT
    // confidently call this irrelevant without reading it; accept pending OCR.
    // OCR failure later routes to review and preserves the original.
    if (!text.trim()) {
      signals.push("image", "no_text");
      return {
        disposition: "accepted",
        reasonCode: "pending_ocr",
        reason: "Image with no readable text yet — accepted pending OCR. OCR failure will route to review.",
        confidence: "low",
        signals,
        triage_review: true,
      };
    }
    // Image WITH text but no financial signal — lean irrelevant only if the
    // text is clearly personal.
    if (PERSONAL_NOTE_KEYWORDS.test(text)) {
      signals.push("image", "personal_note_text");
      return {
        disposition: "irrelevant",
        reasonCode: "personal_image",
        reason: "Image with personal/non-financial text and no document signal.",
        confidence: "medium",
        signals,
      };
    }
    // Otherwise keep it reviewable.
    signals.push("image", "has_text");
    return {
      disposition: "accepted",
      reasonCode: "image_with_text",
      reason: "Image with extracted text — accepted pending review.",
      confidence: "low",
      signals,
      triage_review: true,
    };
  }

  // ── 4. Strong irrelevant signals (§6.2) — BEFORE weak text-file accept so ──
  // a recipe.txt or contacts.txt with personal keywords is classified
  // irrelevant rather than accepted as a "text file with content".
  if (PERSONAL_NOTE_KEYWORDS.test(haystack) && !kw && !amount) {
    signals.push("personal_note_keyword");
    return {
      disposition: "irrelevant",
      reasonCode: "personal_note",
      reason: "Personal/non-financial note content with no document signal.",
      confidence: "medium",
      signals,
    };
  }
  if (PHOTO_FILENAME.test(filename) && !kw && IMAGE_EXT.has(ext)) {
    // IMG_1234.jpg with no document keyword — the canonical family photo.
    signals.push("photo_filename", "no_document_keyword");
    return {
      disposition: "irrelevant",
      reasonCode: "family_photo",
      reason: "Family/personal photo filename with no document signal.",
      confidence: "medium",
      signals,
    };
  }

  // ── 5. Weaker accepted signals ────────────────────────────────────────────
  if (kw) {
    signals.push("financial_keyword_only");
    return {
      disposition: "accepted",
      reasonCode: "financial_keyword",
      reason: "Financial keyword present without corroborating amount/date — accepted for review.",
      confidence: "medium",
      signals,
      triage_review: true,
    };
  }
  if (DOCUMENT_EXT.has(ext) || mimeType.includes("pdf") || mimeType.includes("officedocument")) {
    signals.push(`ext=${ext || "none"}`, `mime=${mimeType || "none"}`);
    return {
      disposition: "accepted",
      reasonCode: "document_extension",
      reason: "Document file extension — accepted pending content review.",
      confidence: "low",
      signals,
      triage_review: true,
    };
  }
  if (TEXT_EXT.has(ext) && text.trim()) {
    // A text file with content but no financial signal — could be a note OR a
    // bank SMS export. Personal notes were already caught in step 4; anything
    // remaining here is ambiguous enough to accept with review.
    signals.push(`ext=${ext}`, "has_text");
    return {
      disposition: "accepted",
      reasonCode: "text_file",
      reason: "Text file with readable content — accepted pending review.",
      confidence: "low",
      signals,
      triage_review: true,
    };
  }

  // ── 6. Default: accept with review (§6.2 — prefer reviewable false positive) ─
  signals.push("no_strong_signal_either_way");
  return {
    disposition: "accepted",
    reasonCode: "uncertain_accept",
    reason: "No strong signal either way — accepted for human review rather than risk losing a financial document.",
    confidence: "low",
    signals,
    triage_review: true,
  };
}

/**
 * Map a TriageDisposition to the intake_events `kind` column. `duplicate` is
 * NOT a triage disposition — it is produced by the hash-lookup step in the
 * pipeline before triage runs. This helper exists so the pipeline has one
 * place that knows the full set of intake kinds.
 */
export function dispositionToIntakeKind(
  d: TriageDisposition | "duplicate",
): "accepted" | "irrelevant" | "failed" | "duplicate" {
  return d;
}
