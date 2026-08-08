/**
 * Page rasterisation — turn a document into a magnifiable image.
 *
 * The Review tab shows documents as images so fine print can be inspected with
 * a hover magnifier. Images are served as-is; PDFs must be rendered. Emails
 * with no attachment have no page at all and are markdown-only.
 *
 * Two backends, deliberately ordered:
 *
 *   pdftoppm (poppler)  — can render ANY page. Preferred.
 *   sips (macOS)        — built-in, zero dependency, but renders page 1 ONLY.
 *
 * 28% of a real vault's PDFs turned out to be multi-page, so a page-1-only
 * implementation is not sufficient on its own — but sips still matters as the
 * fallback on a machine without homebrew, where the alternative is no preview.
 * When only sips is available we serve page 1 and SAY the pager is unavailable
 * rather than silently returning page 1 for every request.
 */
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Formats a browser can display directly, so no rasterisation is needed. */
export const NATIVE_IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic",
]);

/** Formats we can rasterise into a page image. */
export const RASTERISABLE_EXTS = new Set(["pdf"]);

export type PageKind = "native" | "rasterised" | "none";

export interface PageCapability {
  /** How a page image is obtained, or 'none' when there is no page to show. */
  kind: PageKind;
  /** Total pages. 1 for an image, N for a PDF, 0 when there is no page. */
  pages: number;
  /** True when arbitrary pages can be rendered (pdftoppm present). */
  pagerAvailable: boolean;
  /** Why there is no page, for the client to display verbatim. */
  reason?: string;
}

function normaliseExt(ext: string | null | undefined): string {
  return String(ext ?? "").toLowerCase().replace(/^\./, "");
}

let cachedTools: { pdftoppm: boolean; pdfinfo: boolean; sips: boolean } | null = null;

/** Warn once per process about the degraded backend, not once per render. */
let warnedAboutSips = false;

/** Probe once per process — these do not appear or vanish mid-run. */
export async function detectTools() {
  if (cachedTools) return cachedTools;
  const has = async (bin: string) => {
    try {
      await exec("command", ["-v", bin], { shell: "/bin/sh" } as never);
      return true;
    } catch {
      return false;
    }
  };
  cachedTools = {
    pdftoppm: await has("pdftoppm"),
    pdfinfo: await has("pdfinfo"),
    sips: await has("sips"),
  };
  return cachedTools;
}

/** Reset the tool probe. Tests only. */
export function resetToolCache() {
  cachedTools = null;
}

/**
 * How (and whether) this document can be shown as a page image.
 *
 * `hasAttachments` matters for emails: an .eml carrying a PDF invoice is
 * ingested as its attachment, but a bare notification email has nothing to
 * render and must not offer an image view.
 */
export async function pageCapability(
  ext: string | null | undefined,
  rawPath: string,
): Promise<PageCapability> {
  const e = normaliseExt(ext);
  const tools = await detectTools();

  if (NATIVE_IMAGE_EXTS.has(e)) {
    return { kind: "native", pages: 1, pagerAvailable: false };
  }

  if (RASTERISABLE_EXTS.has(e)) {
    if (!tools.pdftoppm && !tools.sips) {
      return {
        kind: "none",
        pages: 0,
        pagerAvailable: false,
        reason: "no PDF rasteriser available on this machine",
      };
    }
    const pages = tools.pdfinfo ? await pdfPageCount(rawPath) : 1;
    return {
      kind: "rasterised",
      pages,
      // Only poppler can render page N. With sips alone the viewer must not
      // offer a pager it cannot honour.
      pagerAvailable: tools.pdftoppm,
    };
  }

  // Emails without attachments land here, as does anything exotic. Markdown is
  // the only view, which is honest rather than an empty image pane.
  return {
    kind: "none",
    pages: 0,
    pagerAvailable: false,
    reason: e ? `no page image for .${e} documents` : "no page image available",
  };
}

/** Page count via poppler. Falls back to 1 rather than throwing. */
export async function pdfPageCount(file: string): Promise<number> {
  try {
    const { stdout } = await exec("pdfinfo", [file]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Math.max(1, Number(m[1])) : 1;
  } catch {
    return 1;
  }
}

export interface RenderRequest {
  rawPath: string;
  ext: string | null | undefined;
  /** 1-based page number. */
  page: number;
  /** Target width in pixels. */
  width: number;
  /** Where rendered pages are cached. */
  cacheDir: string;
  /** Content hash, so the cache key changes when the file does. */
  sha256: string;
}

export interface RenderResult {
  /** Absolute path to a PNG on disk. */
  file: string;
  /** True when served from cache rather than freshly rendered. */
  cached: boolean;
  /** Which backend produced it. */
  via: "pdftoppm" | "sips" | "cache";
}

/**
 * Render a page to PNG, caching the result.
 *
 * The cache is keyed on the CONTENT hash, not the document id or path: two rows
 * pointing at identical bytes share a render, and editing a file in place
 * invalidates it. Rendering is ~130ms (sips) to ~500ms (pdftoppm) per page,
 * which is far too slow to repeat on every hover.
 */
export async function renderPage(req: RenderRequest): Promise<RenderResult> {
  const { rawPath, page, width, cacheDir, sha256 } = req;
  const e = normaliseExt(req.ext);
  if (!RASTERISABLE_EXTS.has(e)) {
    throw new Error(`cannot rasterise .${e}`);
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new Error(`page must be a positive integer, got ${page}`);
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const key = `${sha256}-p${page}-w${width}.png`;
  const out = path.join(cacheDir, key);

  try {
    await fsp.access(out);
    return { file: out, cached: true, via: "cache" };
  } catch {
    // Not cached — render below.
  }

  const tools = await detectTools();

  if (tools.pdftoppm) {
    // pdftoppm appends '-<n>' to the prefix, so render into a temp dir and move
    // the result to the deterministic cache name.
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "q2v-ras-"));
    try {
      const prefix = path.join(tmp, "p");
      await exec("pdftoppm", [
        "-png",
        "-f", String(page),
        "-l", String(page),
        "-scale-to-x", String(width),
        "-scale-to-y", "-1",
        rawPath,
        prefix,
      ]);
      const produced = (await fsp.readdir(tmp)).find((f) => f.endsWith(".png"));
      if (!produced) throw new Error("pdftoppm produced no page");
      await fsp.rename(path.join(tmp, produced), out);
      return { file: out, cached: false, via: "pdftoppm" };
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  if (tools.sips) {
    // sips cannot select a page. Refuse anything but page 1 rather than
    // returning the wrong page with a 200.
    if (page !== 1) {
      throw new Error("only page 1 can be rendered without pdftoppm");
    }
    // Loud, once per process: pdftoppm is the intended backend and its absence
    // silently caps a multi-page document at its first page. A warning in the
    // log is how an operator discovers that, rather than wondering why the
    // pager never appears.
    if (!warnedAboutSips) {
      warnedAboutSips = true;
      console.warn(
        "[rasterise] pdftoppm not found — falling back to sips, which renders " +
          "page 1 ONLY. Install poppler (brew install poppler) for multi-page " +
          "documents.",
      );
    }
    await exec("sips", [
      "-s", "format", "png",
      "--resampleWidth", String(width),
      rawPath,
      "--out", out,
    ]);
    return { file: out, cached: false, via: "sips" };
  }

  throw new Error("no PDF rasteriser available");
}
