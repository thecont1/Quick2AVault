/**
 * Page rasterisation rules.
 *
 * The spec: an image document (including PDF, which the daemon renders) is
 * magnifiable; everything else — notably an email with no attachment — is
 * markdown-only. These tests pin that classification and the cache behaviour
 * that makes hovering affordable.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  NATIVE_IMAGE_EXTS,
  RASTERISABLE_EXTS,
  pageCapability,
  pdfPageCount,
  renderPage,
  detectTools,
} from "./rasterise.js";

const exec = promisify(execFile);

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(e as Error).message.split("\n")[0]}`);
  }
}

/** A real multi-page PDF, built with the tools already on the machine. */
async function makePdf(dir: string, pages: number): Promise<string> {
  const txt = path.join(dir, `src${pages}.txt`);
  // One page per form-feed. cupsfilter honours them.
  await fsp.writeFile(
    txt,
    Array.from({ length: pages }, (_, i) => `PAGE ${i + 1} CONTENT`).join("\n\f"),
  );
  const pdf = path.join(dir, `p${pages}.pdf`);
  // encoding: "buffer" is REQUIRED. execFile decodes stdout as UTF-8 by
  // default, and writing that string back out corrupts every non-ASCII byte —
  // producing a PDF whose page count still reads correctly but whose page
  // CONTENT streams are damaged, so every page renders identically. That cost
  // a wrong "the pager is broken" conclusion; the pager was fine.
  const { stdout } = await exec(
    "/usr/sbin/cupsfilter",
    ["-o", "media=Letter", txt],
    { maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
  );
  await fsp.writeFile(pdf, stdout as unknown as Buffer);
  return pdf;
}

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "q2v-ras-test-"));
  const tools = await detectTools();
  console.log(
    `\n  tools: pdftoppm=${tools.pdftoppm} pdfinfo=${tools.pdfinfo} sips=${tools.sips}\n`,
  );

  // ---- classification ----------------------------------------------------

  await check("a PNG is a native image, no rendering needed", async () => {
    const f = path.join(tmp, "x.png");
    await fsp.writeFile(f, "not-really-a-png");
    const cap = await pageCapability(".png", f);
    assert.equal(cap.kind, "native");
    assert.equal(cap.pages, 1);
  });

  await check("extension matching ignores case and a leading dot", async () => {
    const f = path.join(tmp, "y.PNG");
    await fsp.writeFile(f, "x");
    assert.equal((await pageCapability(".PNG", f)).kind, "native");
    assert.equal((await pageCapability("PNG", f)).kind, "native");
    assert.equal((await pageCapability("JpEg", f)).kind, "native");
  });

  await check("an email with no attachment has NO page image", async () => {
    // The rule Mahesh specified: emails sans attachments are markdown-only.
    const f = path.join(tmp, "mail.eml");
    await fsp.writeFile(f, "From: a@b\n\nbody");
    const cap = await pageCapability(".eml", f);
    assert.equal(cap.kind, "none");
    assert.equal(cap.pages, 0);
    assert.match(cap.reason ?? "", /eml/);
  });

  await check("the reason for 'no page' is stated, not left null", async () => {
    // The client displays this verbatim, so an empty reason means an unexplained
    // pane.
    const f = path.join(tmp, "thing.xyz");
    await fsp.writeFile(f, "x");
    const cap = await pageCapability(".xyz", f);
    assert.equal(cap.kind, "none");
    assert.ok((cap.reason ?? "").length > 0, "reason must be non-empty");
  });

  await check("a missing extension does not crash the classifier", async () => {
    const f = path.join(tmp, "noext");
    await fsp.writeFile(f, "x");
    assert.equal((await pageCapability(null, f)).kind, "none");
    assert.equal((await pageCapability(undefined, f)).kind, "none");
    assert.equal((await pageCapability("", f)).kind, "none");
  });

  await check("PDF is rasterisable, and NOT a native image", () => {
    // The distinction matters: native means 'serve the bytes', rasterised means
    // 'render first'. Conflating them serves a PDF as image/png.
    assert.ok(RASTERISABLE_EXTS.has("pdf"));
    assert.ok(!NATIVE_IMAGE_EXTS.has("pdf"));
  });

  // ---- real PDFs ---------------------------------------------------------

  if (!tools.pdftoppm && !tools.sips) {
    console.log("\n  (no rasteriser available — skipping render tests)\n");
  } else {
    const pdf1 = await makePdf(tmp, 1);
    const pdf3 = await makePdf(tmp, 3);

    await check("a PDF reports kind=rasterised with a real page count", async () => {
      const cap = await pageCapability(".pdf", pdf3);
      assert.equal(cap.kind, "rasterised");
      if (tools.pdfinfo) assert.equal(cap.pages, 3);
    });

    await check("pdfPageCount reads the real count", async () => {
      if (!tools.pdfinfo) return;
      assert.equal(await pdfPageCount(pdf1), 1);
      assert.equal(await pdfPageCount(pdf3), 3);
    });

    await check("pdfPageCount returns 1 rather than throwing on a non-PDF", async () => {
      const junk = path.join(tmp, "junk.pdf");
      await fsp.writeFile(junk, "definitely not a pdf");
      assert.equal(await pdfPageCount(junk), 1);
    });

    await check("rendering produces a real PNG", async () => {
      const cache = path.join(tmp, "cache1");
      const out = await renderPage({
        rawPath: pdf1,
        ext: ".pdf",
        page: 1,
        width: 800,
        cacheDir: cache,
        sha256: "hash-a",
      });
      assert.equal(out.cached, false);
      const bytes = await fsp.readFile(out.file);
      // PNG magic number — proves we produced an image, not an empty file.
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    });

    await check("a second identical request is served from cache", async () => {
      // Rendering is 130-500ms. Repeating it on every hover would make the
      // magnifier unusable.
      const cache = path.join(tmp, "cache2");
      const req = {
        rawPath: pdf1,
        ext: ".pdf",
        page: 1,
        width: 800,
        cacheDir: cache,
        sha256: "hash-b",
      };
      const first = await renderPage(req);
      assert.equal(first.cached, false);
      const second = await renderPage(req);
      assert.equal(second.cached, true);
      assert.equal(second.via, "cache");
      assert.equal(second.file, first.file);
    });

    await check("the cache key includes the content hash", async () => {
      // Keyed on document id alone, an edited file would serve its OLD render
      // forever.
      const cache = path.join(tmp, "cache3");
      const a = await renderPage({
        rawPath: pdf1, ext: ".pdf", page: 1, width: 800,
        cacheDir: cache, sha256: "hash-one",
      });
      const b = await renderPage({
        rawPath: pdf1, ext: ".pdf", page: 1, width: 800,
        cacheDir: cache, sha256: "hash-two",
      });
      assert.notEqual(a.file, b.file);
    });

    await check("the cache key includes the width", async () => {
      const cache = path.join(tmp, "cache4");
      const a = await renderPage({
        rawPath: pdf1, ext: ".pdf", page: 1, width: 800,
        cacheDir: cache, sha256: "hash-w",
      });
      const b = await renderPage({
        rawPath: pdf1, ext: ".pdf", page: 1, width: 1600,
        cacheDir: cache, sha256: "hash-w",
      });
      assert.notEqual(a.file, b.file);
    });

    await check("different pages render to DIFFERENT images", async () => {
      if (!tools.pdftoppm) return; // sips cannot select a page
      const cache = path.join(tmp, "cache5");
      const p1 = await renderPage({
        rawPath: pdf3, ext: ".pdf", page: 1, width: 600,
        cacheDir: cache, sha256: "hash-multi",
      });
      const p3 = await renderPage({
        rawPath: pdf3, ext: ".pdf", page: 3, width: 600,
        cacheDir: cache, sha256: "hash-multi",
      });
      const b1 = await fsp.readFile(p1.file);
      const b3 = await fsp.readFile(p3.file);
      // The real failure this catches: a pager that silently returns page 1 for
      // every request. Identical bytes would mean exactly that.
      assert.ok(!b1.equals(b3), "page 1 and page 3 rendered identical bytes");
    });

    await check("a non-rasterisable extension is refused, not rendered", async () => {
      await assert.rejects(
        renderPage({
          rawPath: pdf1, ext: ".eml", page: 1, width: 800,
          cacheDir: path.join(tmp, "cache6"), sha256: "h",
        }),
        /cannot rasterise/,
      );
    });

    await check("page 0 and negative pages are refused", async () => {
      const base = {
        rawPath: pdf1, ext: ".pdf", width: 800,
        cacheDir: path.join(tmp, "cache7"), sha256: "h",
      };
      await assert.rejects(renderPage({ ...base, page: 0 }), /positive integer/);
      await assert.rejects(renderPage({ ...base, page: -2 }), /positive integer/);
      await assert.rejects(renderPage({ ...base, page: 1.5 }), /positive integer/);
    });
  }

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
