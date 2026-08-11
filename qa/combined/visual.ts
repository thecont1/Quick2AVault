/** Layout-level PNG comparison for the Glaze document-detail captures. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { inflateSync } from "node:zlib";

import type { Assertion } from "./runner.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_MAX_DISTANCE = 0.025;

type Image = { width: number; height: number; channels: number; pixels: Uint8Array };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Buffer): Image {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      assertPng(bitDepth === 8, "only 8-bit PNG captures are supported");
      assertPng(
        data[10] === 0 && data[11] === 0 && data[12] === 0,
        "interlaced or non-standard PNG is unsupported",
      );
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colorType] ?? 0;
      assertPng(channels > 0, `unsupported PNG colour type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  assertPng(width > 0 && height > 0 && idat.length > 0, "PNG is missing IHDR or IDAT data");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  assertPng(raw.length === height * (stride + 1), "PNG scanline data has an unexpected size");
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assertPng(filter <= 4, `unsupported PNG filter ${filter}`);
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + x + 1];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upperLeft)
                : 0;
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

function assertPng(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rgb(image: Image, x: number, y: number): [number, number, number] {
  const i = (y * image.width + x) * image.channels;
  if (image.channels === 1 || image.channels === 2)
    return [image.pixels[i], image.pixels[i], image.pixels[i]];
  return [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
}

/**
 * Compare coarse colour blocks and edge density. Text glyph changes affect only
 * a small part of each block, while panel positions, spacing, borders and badge
 * styles materially change the score.
 */
export function structuralDistance(reference: Image, capture: Image, grid = 32): number {
  assertPng(
    reference.width === capture.width && reference.height === capture.height,
    "capture dimensions differ from the golden",
  );
  const cols = Math.min(grid, reference.width);
  const rows = Math.min(grid, reference.height);
  let colourDistance = 0;
  let edgeDistance = 0;
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * reference.height) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * reference.height) / rows));
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * reference.width) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * reference.width) / cols));
      const metrics = (image: Image): [number, number, number, number] => {
        let r = 0,
          g = 0,
          b = 0,
          edges = 0,
          count = 0;
        const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 8));
        for (let y = y0; y < y1; y += step) {
          for (let x = x0; x < x1; x += step) {
            const [pr, pg, pb] = rgb(image, x, y);
            r += pr;
            g += pg;
            b += pb;
            count++;
            if (x + step < x1) {
              const [nr, ng, nb] = rgb(image, x + step, y);
              edges += (Math.abs(pr - nr) + Math.abs(pg - ng) + Math.abs(pb - nb)) / 3;
            }
            if (y + step < y1) {
              const [nr, ng, nb] = rgb(image, x, y + step);
              edges += (Math.abs(pr - nr) + Math.abs(pg - ng) + Math.abs(pb - nb)) / 3;
            }
          }
        }
        return [r / count, g / count, b / count, edges / (count * 2)];
      };
      const a = metrics(reference);
      const b = metrics(capture);
      colourDistance +=
        (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / (3 * 255);
      edgeDistance += Math.abs(a[3] - b[3]) / 255;
    }
  }
  const cells = cols * rows;
  return (0.7 * colourDistance) / cells + (0.3 * edgeDistance) / cells;
}

export async function compareVisualCaptures(options: {
  goldenDir: string;
  captureDir: string;
  maxDistance?: number;
}): Promise<Assertion[]> {
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const names = [
    "01-pet_asight_tax_invoice_detail.png",
    "02-pet_asight_tax_invoice_fields.png",
    "03-paytm_contract_note_detail.png",
    "04-paytm_contract_note_fields.png",
  ];
  return Promise.all(
    names.map(async (name): Promise<Assertion> => {
      const fixtureId = name.startsWith("01-") || name.startsWith("02-") ? "G" : "H";
      const capture = path.join(options.captureDir, name);
      try {
        const [referenceBytes, captureBytes] = await Promise.all([
          fs.readFile(path.join(options.goldenDir, name)),
          fs.readFile(capture),
        ]);
        const reference = decodePng(referenceBytes);
        const actual = decodePng(captureBytes);
        const distance = structuralDistance(reference, actual);
        return distance <= maxDistance
          ? {
              fixtureId,
              name: `layout: ${name}`,
              status: "passed",
              detail: `structural distance ${distance.toFixed(4)} (max ${maxDistance})`,
            }
          : {
              fixtureId,
              name: `layout: ${name}`,
              status: "failed",
              detail: `structural distance ${distance.toFixed(4)} exceeds ${maxDistance}`,
            };
      } catch (error) {
        const detail =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `missing rendered capture: ${capture}`
            : (error as Error).message;
        return { fixtureId, name: `layout: ${name}`, status: "failed", detail };
      }
    }),
  );
}

export const VISUAL_DEFAULT_MAX_DISTANCE = DEFAULT_MAX_DISTANCE;
export type { Image };
