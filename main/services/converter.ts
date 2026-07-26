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
import * as XLSX from "xlsx";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type FileType = "pdf" | "xlsx" | "csv" | "txt";

const EXTENSION_MAP: Record<string, FileType> = {
  ".pdf": "pdf",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".csv": "csv",
  ".txt": "txt",
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
  const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();

  const header = clean[0];
  const headerCells = Array.from({ length: colCount }, (_, i) => cell(header[i]) || `Column ${i + 1}`);
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

/** Turn a spreadsheet/CSV buffer into Markdown tables (one per sheet). */
function spreadsheetToMarkdown(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sections: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
    if (workbook.SheetNames.length > 1) sections.push(`## ${name}`);
    sections.push(rowsToMarkdownTable(rows));
  }
  return sections.join("\n\n");
}

/** Produce a plain, deterministic representation of the file's content. */
async function extractRepresentation(filePath: string, type: FileType): Promise<string> {
  switch (type) {
    case "pdf": {
      const buffer = await fs.readFile(filePath);
      const parsed = await pdfParse(buffer);
      return parsed.text.trim();
    }
    case "xlsx":
    case "csv": {
      const buffer = await fs.readFile(filePath);
      return spreadsheetToMarkdown(buffer);
    }
    case "txt": {
      return (await fs.readFile(filePath, "utf-8")).trim();
    }
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
};

/**
 * Convert a file to Markdown. Never throws — always returns something writable.
 */
export async function convertToMarkdown(filePath: string, filename: string, type: FileType): Promise<ConversionResult> {
  let representation = "";
  try {
    representation = await extractRepresentation(filePath, type);
  } catch (error) {
    logger.warn("converter", "Failed to extract file content", { filename, error: String(error) });
    return { markdown: fallbackMarkdown(filename, ""), success: false };
  }

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

    const body = truncated ? `${markdown}\n\n_Note: source content was truncated during conversion._\n` : `${markdown}\n`;
    return { markdown: body, success: true };
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("converter", "AI conversion blocked, using fallback", { filename, state: error.state });
      return { markdown: fallbackMarkdown(filename, representation), success: false, aiBlocked: error.state };
    }
    logger.warn("converter", "AI conversion failed, using fallback", { filename, error: String(error) });
    return { markdown: fallbackMarkdown(filename, representation), success: false };
  }
}
