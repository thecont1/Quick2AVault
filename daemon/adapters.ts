/**
 * Adapters — concrete Port implementations for the standalone daemon.
 * No Glaze, no Electron. Everything here is plain Node.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

import { toMarkdownBytes } from "@firecrawl/anydoc";

import type { Clock, Converter, DomainEvent, EventBus, Logger, Paths, Ports } from "./ports.js";

// ── Logger ───────────────────────────────────────────────────────────────────
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export function createLogger(minLevel: keyof typeof LEVEL_ORDER = "info"): Logger {
  const emit = (level: keyof typeof LEVEL_ORDER, msg: string, meta?: unknown) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const ts = new Date().toISOString().slice(11, 23);
    const tail = meta === undefined ? "" : ` ${typeof meta === "string" ? meta : JSON.stringify(meta)}`;
    const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`;
    (level === "error" || level === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
  };
}

// ── Clock ────────────────────────────────────────────────────────────────────
export const systemClock: Clock = {
  now: () => new Date(),
  isoNow: () => new Date().toISOString(),
};

// ── Paths ────────────────────────────────────────────────────────────────────
export function createPaths(root?: string): Paths {
  const vaultRoot = root ?? path.join(os.homedir(), "Documents", "Quick2AVault");
  const ensure = (p: string) => {
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  ensure(vaultRoot);
  return {
    vaultRoot: () => vaultRoot,
    rawDir: (dateKey) => ensure(path.join(vaultRoot, "Raw", dateKey)),
    markdownDir: (dateKey) => ensure(path.join(vaultRoot, "Markdown", dateKey)),
    dbPath: () => path.join(vaultRoot, "vault.db"),
  };
}

// ── Converter (anydoc) ───────────────────────────────────────────────────────
// anydoc's Format is a positional STRING argument, not an options object.
// Passing {format,filename} throws:
//   "Failed to convert napi value into enum `Format`. StringExpected"
const EXT_TO_FORMAT: Record<string, string> = {
  ".pdf": "pdf", ".doc": "doc", ".docx": "docx", ".docm": "docx",
  ".ppt": "ppt", ".pptx": "pptx", ".xlsx": "xlsx", ".xls": "xlsx",
  ".odt": "odt", ".ods": "ods", ".odp": "odp", ".rtf": "rtf",
  ".epub": "epub", ".csv": "csv",
};
const PLAINTEXT_EXT = new Set([".txt", ".md", ".eml", ".html", ".htm", ".json"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif"]);

export function createAnydocConverter(logger: Logger): Converter {
  return {
    async toMarkdown(filePath: string, ext: string): Promise<string | null> {
      const e = ext.toLowerCase();
      try {
        if (PLAINTEXT_EXT.has(e)) {
          const raw = await fsp.readFile(filePath, "utf-8");
          return e === ".eml" ? emlToMarkdown(raw) : raw.trim();
        }
        if (IMAGE_EXT.has(e)) {
          // No OCR in this build — image intake still produces a document row
          // with empty markdown so it appears in the feed and can be reviewed.
          return "";
        }
        const fmt = EXT_TO_FORMAT[e];
        if (!fmt) {
          logger.warn("converter: unsupported extension", { ext: e });
          return null;
        }
        const buf = await fsp.readFile(filePath);
        const out = await toMarkdownBytes(buf, fmt as never);
        return typeof out === "string" ? out.trim() : String(out ?? "").trim();
      } catch (err) {
        logger.error("converter failed", { filePath, ext: e, err: (err as Error)?.message });
        return null;
      }
    },
  };
}

/**
 * Minimal MIME → markdown for .eml. Bank alerts are multipart/alternative;
 * we take the text/plain part when present (never both — that would create two
 * competing texts for one document) and fall back to a tag-stripped HTML part.
 */
export function emlToMarkdown(raw: string): string {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerEnd > 0 ? raw.slice(0, headerEnd) : "";
  const pick = (name: string) =>
    headerBlock.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() ?? "";

  const subject = pick("Subject");
  const from = pick("From");
  const date = pick("Date");

  let body = headerEnd > 0 ? raw.slice(headerEnd) : raw;
  const boundary = headerBlock.match(/boundary="?([^";\r\n]+)"?/i)?.[1];
  if (boundary) {
    const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    const textPart = parts.find((p) => /content-type:\s*text\/plain/i.test(p));
    const htmlPart = parts.find((p) => /content-type:\s*text\/html/i.test(p));
    const chosen = textPart ?? htmlPart ?? "";
    body = chosen.replace(/^[\s\S]*?\r?\n\r?\n/, "");
    if (!textPart && htmlPart) body = stripHtml(body);
  } else if (/<html/i.test(body)) {
    body = stripHtml(body);
  }

  body = decodeQuotedPrintable(body).trim();
  const head = [
    subject && `# ${subject}`,
    from && `**From:** ${from}`,
    date && `**Date:** ${date}`,
  ].filter(Boolean).join("\n\n");
  return `${head}\n\n${body}`.trim();
}

function decodeQuotedPrintable(s: string): string {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8377;|&rupee;/g, "₹")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

// ── EventBus ─────────────────────────────────────────────────────────────────
export function createEventBus(logger: Logger, ring = 500): EventBus {
  const subs = new Set<(e: DomainEvent) => void>();
  const log: DomainEvent[] = [];
  return {
    publish(e) {
      log.push(e);
      if (log.length > ring) log.splice(0, log.length - ring);
      for (const fn of subs) {
        try {
          fn(e);
        } catch (err) {
          logger.error("event subscriber threw", { err: (err as Error)?.message });
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    recent(limit = 50) {
      return log.slice(-limit);
    },
  };
}

// ── Composition root ─────────────────────────────────────────────────────────
export function createPorts(opts: { vaultRoot?: string; logLevel?: "debug" | "info" | "warn" | "error" } = {}): Ports {
  const logger = createLogger(opts.logLevel ?? "info");
  return {
    logger,
    clock: systemClock,
    paths: createPaths(opts.vaultRoot),
    converter: createAnydocConverter(logger),
    bus: createEventBus(logger),
  };
}
