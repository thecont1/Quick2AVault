/**
 * File -> Markdown conversion.
 *
 * Each supported file is first converted to Markdown by anydoc (Word, Excel,
 * PowerPoint, OpenDocument, RTF, EPUB, CSV, PDF), then Glaze AI polishes it
 * into clean, well-structured Markdown. If AI is
 * unavailable/blocked, we fall back to the deterministic representation so the
 * user always gets a usable .md file.
 */
import * as fs from "node:fs/promises";

import { generateText, glaze, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";
import { toMarkdownBytes } from "@firecrawl/anydoc";

// Canonical format names mirror anydoc's `Format` values (legacy .doc/.ppt are
// distinct parsers, while container variants like .docm/.xlsm/.ppsx map onto
// docx/xlsx/pptx), so FileType can be passed straight to the converter as the
// explicit format.
export type FileType =
  | "pdf"
  | "doc"
  | "docx"
  | "ppt"
  | "pptx"
  | "xlsx"
  | "odt"
  | "ods"
  | "odp"
  | "rtf"
  | "epub"
  | "csv"
  | "txt"
  | "image";

const EXTENSION_MAP: Record<string, FileType> = {
  ".pdf": "pdf",
  ".doc": "doc",
  ".docx": "docx",
  ".docm": "docx",
  ".ppt": "ppt",
  ".pps": "ppt",
  ".pot": "ppt",
  ".pptx": "pptx",
  ".pptm": "pptx",
  ".ppsx": "pptx",
  ".ppsm": "pptx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".xlsm": "xlsx",
  ".xlsb": "xlsx",
  ".odt": "odt",
  ".ods": "ods",
  ".odp": "odp",
  ".rtf": "rtf",
  ".epub": "epub",
  ".csv": "csv",
  ".txt": "txt",
  ".md": "txt",
  // Images are accepted into intake so casual/personal files (e.g. family
  // photos) can be triaged as irrelevant instead of being rejected outright.
  // We don't OCR them, so they carry no extractable financial text.
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".tiff": "image",
  ".tif": "image",
  ".heic": "image",
  ".heif": "image",
};

// Keep AI input bounded so a huge statement doesn't burn excess credits.
const MAX_AI_CHARS = 24000;

export function getFileType(filename: string): FileType | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = filename.slice(dot).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

export interface ConversionResult {
  markdown: string;
  success: boolean;
  /** GlazeAIError.state when the AI step was blocked, undefined otherwise. */
  aiBlocked?: string;
}

// Formats converted by anydoc into GitHub-Flavored Markdown. The explicit
// format is passed because CSV carries no content marker for auto-detection.
// (AnyDoc's Format is a declared const enum, so the value is cast, not
// imported — FileType string values match it exactly.)
type AnyDocFormat = Exclude<FileType, "txt" | "image">;
type AnyDocFormatParam = Parameters<typeof toMarkdownBytes>[1];

/**
 * Produce a plain, deterministic text representation of the file's content.
 * Images carry no extractable text (we don't OCR), so they return "". Exported
 * so intake can triage a file's relevance before any expensive AI step. Never
 * throws — returns "" when content can't be read.
 */
export async function extractText(filePath: string, type: FileType): Promise<string> {
  try {
    switch (type) {
      case "txt": {
        return (await fs.readFile(filePath, "utf-8")).trim();
      }
      case "image":
        return "";
      default: {
        const buffer = await fs.readFile(filePath);
        return (await toMarkdownBytes(buffer, type as AnyDocFormat as AnyDocFormatParam)).trim();
      }
    }
  } catch (error) {
    // anydoc rejects with a structured code ("unsupported", "malformed",
    // "encrypted", "resourceLimit", "missingPart"); log it for diagnosis while
    // keeping the never-throws contract so triage/OCR fallbacks still run.
    logger.warn("converter", "Failed to extract file content", {
      filePath,
      code: (error as { code?: string }).code ?? "unknown",
      error: String(error),
    });
    return "";
  }
}

function fallbackMarkdown(filename: string, representation: string): string {
  return `# ${filename}\n\n${representation || "_No extractable content._"}\n`;
}

const TYPE_LABEL: Record<FileType, string> = {
  pdf: "PDF document",
  doc: "Word document",
  docx: "Word document",
  ppt: "presentation",
  pptx: "presentation",
  xlsx: "spreadsheet",
  odt: "OpenDocument text",
  ods: "spreadsheet",
  odp: "presentation",
  rtf: "rich text document",
  epub: "e-book",
  csv: "CSV data",
  txt: "text document",
  image: "image",
};

/**
 * Polish a plain-text representation into clean Markdown via AI. Never throws —
 * falls back to the deterministic representation when AI is blocked/unavailable.
 * Split out from {@link convertToMarkdown} so intake can extract + triage a file
 * before deciding whether to spend AI credits on it.
 */
export async function polishToMarkdown(
  representation: string,
  filename: string,
  type: FileType,
): Promise<ConversionResult> {
  if (!representation.trim()) return { markdown: fallbackMarkdown(filename, ""), success: false };

  const truncated = representation.length > MAX_AI_CHARS;
  const aiInput = truncated ? representation.slice(0, MAX_AI_CHARS) : representation;

  try {
    const { text } = await generateText({
      model: glaze("fast"),
      system:
        "You convert extracted financial document content into clean, faithful Markdown. " +
        "Preserve every figure, date, and label exactly. Use Markdown tables for tabular data, " +
        "headings for sections, and lists where appropriate. Do not invent, summarize, or omit data. " +
        "Do not wrap the whole document in a code fence and add no commentary.",
      prompt:
        `Convert the following ${TYPE_LABEL[type]} named "${filename}" into Markdown.` +
        (truncated ? " (Content was truncated; convert what is provided.)" : "") +
        `\n\n---\n${aiInput}`,
    });

    const markdown = text.trim();
    if (!markdown) return { markdown: fallbackMarkdown(filename, representation), success: false };

    const body = truncated
      ? `${markdown}\n\n_Note: source content was truncated during conversion._\n`
      : `${markdown}\n`;
    return { markdown: body, success: true };
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("converter", "AI conversion blocked, using fallback", {
        filename,
        state: error.state,
      });
      return {
        markdown: fallbackMarkdown(filename, representation),
        success: false,
        aiBlocked: error.state,
      };
    }
    logger.warn("converter", "AI conversion failed, using fallback", {
      filename,
      error: String(error),
    });
    return { markdown: fallbackMarkdown(filename, representation), success: false };
  }
}

/**
 * Extract a file's content and polish it into Markdown in one call. Never throws.
 * Retained for the legacy end-to-end ingest path; the queue path extracts once
 * (for triage) and then calls {@link polishToMarkdown} directly.
 */
export async function convertToMarkdown(
  filePath: string,
  filename: string,
  type: FileType,
): Promise<ConversionResult> {
  const representation = await extractText(filePath, type);
  if (!representation) return { markdown: fallbackMarkdown(filename, ""), success: false };
  return polishToMarkdown(representation, filename, type);
}
