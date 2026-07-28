/**
 * Photo / image OCR — treat photographed invoices and receipts as first-class
 * inputs, not edge cases.
 *
 * Many users capture documents with their phone, so we run vision extraction on
 * image files (and image-based / scanned PDFs) the same way we handle text
 * documents. A single vision pass both transcribes the readable text and decides
 * whether the image is actually a financial document — so a clearly personal
 * photo (family snapshot, meme, chat screenshot) is routed to the irrelevant
 * lane instead of being force-OCR'd and analyzed.
 *
 * Real-world photos are messy (skew, shadows, uneven light). We lean on the
 * native macOS image stack for decoding + EXIF auto-rotation and on the vision
 * model's robustness rather than hand-rolled deskew/denoise. We never
 * over-promise: a poor read comes back with `legible: false` so the caller can
 * route it into review gracefully rather than failing silently. Never throws.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger, nativeImage } from "@glaze/core/backend";

import type { FileType } from "./converter.js";

/** Longest edge (px) we send to the model — bounds payload while keeping text legible. */
const MAX_EDGE = 1600;

/** Image extensions the model accepts directly (others are transcoded to PNG). */
const DIRECT_MEDIA: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface OcrResult {
  /** Transcribed text (Markdown-ish), empty when nothing readable was found. */
  text: string;
  /** True when the image genuinely shows a financial document. */
  isFinancialDocument: boolean;
  /** False when the photo was blurry / dark / skewed enough to be uncertain. */
  legible: boolean;
  /** True when the vision step itself was blocked/unavailable. */
  aiBlocked: boolean;
}

const schema = z.object({
  isFinancialDocument: z
    .boolean()
    .describe(
      "true if this image shows a financial document — an invoice, receipt, bill, bank/card statement, tax " +
        "document, insurance/premium notice, or broker contract note. false for personal photos (people, pets, " +
        "food, scenery), memes, chat/app screenshots, or casual notes.",
    ),
  legible: z
    .boolean()
    .describe(
      "true if the document text was clearly readable; false if the photo is blurry, dark, skewed, or low-contrast.",
    ),
  text: z
    .string()
    .describe(
      "All readable text transcribed from the image as clean plain text / Markdown. Preserve amounts, dates, " +
        "line items, and vendor names exactly. Use a Markdown table for tabular data. Empty string if there is no " +
        "readable document text.",
    ),
});

/** Decode + normalize an image file to a model-ready buffer (native EXIF rotation, bounded size). */
async function toModelImage(filePath: string): Promise<{ data: Buffer; mediaType: string } | null> {
  const ext = path.extname(filePath).toLowerCase();
  const direct = DIRECT_MEDIA[ext];
  try {
    let img = nativeImage.createFromPath(filePath);
    if (!img.isEmpty()) {
      const { width, height } = img.getSize();
      const longEdge = Math.max(width, height);
      if (longEdge > MAX_EDGE) {
        img = await img.resize(width >= height ? { width: MAX_EDGE } : { height: MAX_EDGE });
      }
      return { data: img.toPNG(), mediaType: "image/png" };
    }
  } catch (error) {
    logger.warn("ocr", "Native image decode failed, trying raw bytes", {
      filePath,
      error: String(error),
    });
  }
  // Fallback to the original bytes for directly-supported formats.
  if (direct) {
    try {
      return { data: await fs.readFile(filePath), mediaType: direct };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * OCR an image (or image-based PDF) with the vision model. Returns transcribed
 * text plus whether it's a financial document. Never throws.
 */
export async function ocrDocument(
  filePath: string,
  type: FileType,
  filename: string,
): Promise<OcrResult> {
  const empty: OcrResult = {
    text: "",
    isFinancialDocument: false,
    legible: false,
    aiBlocked: false,
  };

  let content: Array<Record<string, unknown>>;
  if (type === "image") {
    const image = await toModelImage(filePath);
    if (!image) return empty;
    content = [{ type: "image", image: image.data, mediaType: image.mediaType }];
  } else if (type === "pdf") {
    // Scanned / image-based PDF: hand the raw PDF to the vision model.
    try {
      const data = await fs.readFile(filePath);
      content = [{ type: "file", data, mediaType: "application/pdf" }];
    } catch {
      return empty;
    }
  } else {
    return empty;
  }

  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema,
      system:
        "You read financial documents from photos and scans. Transcribe faithfully — never invent figures, " +
        "dates, or vendors. Cope with skew, shadows, and uneven lighting as best you can, and if the image is " +
        "too poor to read confidently, say so via the legible flag instead of guessing.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `This is a photographed or scanned document named "${filename}". First decide whether it is a ` +
                "financial document, then transcribe all readable text.",
            },
            ...content,
          ],
        },
      ] as never,
    });

    return {
      text: object.text?.trim() ?? "",
      isFinancialDocument: object.isFinancialDocument,
      legible: object.legible,
      aiBlocked: false,
    };
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("ocr", "Vision OCR blocked", { filename, state: error.state });
    } else {
      logger.warn("ocr", "Vision OCR failed", { filename, error: String(error) });
    }
    return { ...empty, aiBlocked: true };
  }
}
