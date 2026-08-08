const GMAIL_DOMAIN = "gmail.com";
const GMAIL_LOCAL_PART = /^[a-z0-9](?:[a-z0-9.]{4,28}[a-z0-9])$/;

export type GmailLocalPartResult = { ok: true; localPart: string } | { ok: false; error: string };

/** Gmail consumer addresses allow letters, digits, and dots; 6–30 chars. */
export function normalizeGmailLocalPart(value: unknown): GmailLocalPartResult {
  const localPart = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (localPart.includes("@")) {
    return { ok: false, error: "Enter only the part before @gmail.com." };
  }
  if (!GMAIL_LOCAL_PART.test(localPart) || localPart.includes("..")) {
    return {
      ok: false,
      error: "Use 6–30 letters, numbers, or single dots; dots cannot be first, last, or repeated.",
    };
  }
  return { ok: true, localPart };
}

export function deriveGmailAddress(localPart: string): string {
  return `${localPart}@${GMAIL_DOMAIN}`;
}

export function gmailAccountsMatch(actual: string, configured: string): boolean {
  const canonical = (value: string): string | null => {
    const [localPart, domain, ...rest] = value.trim().toLowerCase().split("@");
    if (rest.length > 0 || !localPart || domain !== GMAIL_DOMAIN) return null;
    return `${localPart.replace(/\./g, "")}@${domain}`;
  };
  const actualCanonical = canonical(actual);
  return actualCanonical != null && actualCanonical === canonical(configured);
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message?: { id?: string } }>;
}

export interface GmailAttachmentArtifact {
  filename: string;
  attachmentId: string;
  mimeType: string;
}

export interface GmailBodyArtifact {
  filename: string;
  content: string;
}

export interface GmailArtifacts {
  relevant: boolean;
  attachments: GmailAttachmentArtifact[];
  bodyEvent: GmailBodyArtifact | null;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".xlsx",
  ".xls",
  ".csv",
  ".txt",
  ".md",
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
]);
const FINANCIAL_SIGNAL =
  /\b(invoice|receipt|paid|payment|upi|transaction|debited|credited|subscription|renewal|broker|contract note|utility|bill|fare|booking|refund|amount|inr|rs\.?|₹)\b/i;

function header(part: GmailMessagePart | undefined, name: string): string {
  return part?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenParts(part: GmailMessagePart | undefined): GmailMessagePart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(flattenParts)];
}

function safeStem(value: string): string {
  const stem = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return stem || "financial-email";
}

/** Extract supported attachments, or one body artifact when no attachment can represent the message. */
export function extractGmailArtifacts(message: GmailMessage): GmailArtifacts {
  const parts = flattenParts(message.payload);
  const attachments = parts.flatMap((part): GmailAttachmentArtifact[] => {
    const filename = (part.filename ?? "").trim();
    const attachmentId = part.body?.attachmentId;
    const dot = filename.lastIndexOf(".");
    const extension = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
    if (!filename || !attachmentId || !SUPPORTED_EXTENSIONS.has(extension)) return [];
    return [{ filename, attachmentId, mimeType: part.mimeType ?? "application/octet-stream" }];
  });

  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data);
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  const body = plain?.body?.data
    ? decodeBase64Url(plain.body.data)
    : html?.body?.data
      ? htmlToText(decodeBase64Url(html.body.data))
      : "";
  const subject = header(message.payload, "Subject");
  const sender = header(message.payload, "From");
  const sentAt = header(message.payload, "Date");
  const bodyRelevant = FINANCIAL_SIGNAL.test(`${subject}\n${body}`);
  const relevant = attachments.length > 0 || bodyRelevant;
  if (!relevant) return { relevant: false, attachments: [], bodyEvent: null };

  const content = [
    `Financial email: ${subject || "(no subject)"}`,
    sender ? `From: ${sender}` : "",
    sentAt ? `Date: ${sentAt}` : "",
    "",
    body.trim(),
  ]
    .filter((line, index) => line || index >= 3)
    .join("\n")
    .trim();
  return {
    relevant: true,
    attachments,
    bodyEvent: bodyRelevant
      ? {
          filename: `gmail-${safeStem(subject)}-${message.id}.txt`,
          content,
        }
      : null,
  };
}

export function collectIncrementalMessageIds(history: GmailHistoryRecord[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const record of history) {
    for (const addition of record.messagesAdded ?? []) {
      const id = addition.message?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
