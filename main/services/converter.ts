/**
 * File -> Markdown conversion.
 *
 * Each supported file is first turned into a plain-text representation, then
 * Glaze AI polishes it into clean, well-structured Markdown. If AI is
 * unavailable/blocked, we fall back to the deterministic representation so the
 * user always gets a usable .md file.
 */
import * as fs from "node:fs/promises";

import { generateText, glaze, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

import { parseCsvBuffer, parseXlsx } from "./spreadsheet.js";

export type FileType = "pdf" | "xlsx" | "csv" | "txt" | "image";

const EXTENSION_MAP: Record<string, FileType> = {
  ".pdf": "pdf",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
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

/** Build a Markdown table from an array of rows. */
function rowsToMarkdownTable(rows: unknown[][]): string {
  const clean = rows.filter((r) => Array.isArray(r) && r.some((c) => c !== null && c !== ""));
  if (clean.length === 0) return "_(empty)_";

  const colCount = clean.reduce((max, r) => Math.max(max, r.length), 0);
  const cell = (v: unknown) =>
    String(v ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, " ")
      .trim();

  const header = clean[0];
  const headerCells = Array.from(
    { length: colCount },
    (_, i) => cell(header[i]) || `Column ${i + 1}`,
  );
  const lines = [
    `| ${headerCells.join(" | ")} |`,
    `| ${headerCells.map(() => "---").join(" | ")} |`,
  ];
  for (const row of clean.slice(1)) {
    const cells = Array.from({ length: colCount }, (_, i) => cell(row[i]));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/** Turn spreadsheet sections into Markdown tables. */
function spreadsheetSectionsToMarkdown(
  spreadsheetSections: Array<{ name: string; rows: unknown[][] }>,
): string {
  const sections: string[] = [];
  for (const { name, rows } of spreadsheetSections) {
    if (spreadsheetSections.length > 1) sections.push(`## ${name}`);
    sections.push(rowsToMarkdownTable(rows));
  }
  return sections.join("\n\n");
}

/**
 * Produce a plain, deterministic text representation of the file's content.
 * Images carry no extractable text (we don't OCR), so they return "". Exported
 * so intake can triage a file's relevance before any expensive AI step. Never
 * throws — returns "" when content can't be read.
 */
export async function extractText(filePath: string, type: FileType): Promise<string> {
  try {
    switch (type) {
      case "pdf": {
        const buffer = await fs.readFile(filePath);
        const parsed = await pdfParse(buffer);
        return parsed.text.trim();
      }
      case "xlsx": {
        const buffer = await fs.readFile(filePath);
        return spreadsheetSectionsToMarkdown(await parseXlsx(buffer));
      }
      case "csv": {
        const buffer = await fs.readFile(filePath);
        return spreadsheetSectionsToMarkdown(parseCsvBuffer(buffer));
      }
      case "txt": {
        return (await fs.readFile(filePath, "utf-8")).trim();
      }
      case "image":
        return "";
    }
  } catch (error) {
    logger.warn("converter", "Failed to extract file content", { filePath, error: String(error) });
    return "";
  }
}

function fallbackMarkdown(filename: string, representation: string): string {
  return `# ${filename}\n\n${representation || "_No extractable content._"}\n`;
}

const TYPE_LABEL: Record<FileType, string> = {
  pdf: "PDF document",
  xlsx: "spreadsheet",
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
