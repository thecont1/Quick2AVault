import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatFromBytes, toMarkdownBytes } from "@firecrawl/anydoc";

// AnyDoc's Format is a declared const enum, so name formats via a cast (the
// string values match it exactly).
const format = (name: string) => name as Parameters<typeof toMarkdownBytes>[1];

const here = dirname(fileURLToPath(import.meta.url));

// CSV carries no content marker, so detection is null and the converter passes
// the format explicitly (as extractText does via FileType).
const csvPath = join(here, "fixtures", "transactions.csv");
const csv = await readFile(csvPath);
assert.equal(formatFromBytes(csv), null);
assert.equal(
  (await toMarkdownBytes(csv, format("csv"))).trim(),
  "| Vendor | Amount |\n| --- | --- |\n| ACME | 499.99 |",
);

// Binary formats are detected from content; multi-sheet XLSX becomes headed
// Markdown tables.
const xlsxPath = join(here, "fixtures", "transactions.xlsx");
const xlsx = await readFile(xlsxPath);
assert.equal(formatFromBytes(xlsx), "xlsx");
const xlsxMarkdown = await toMarkdownBytes(xlsx, format("xlsx"));
assert.ok(xlsxMarkdown.includes("## Transactions"));
assert.ok(xlsxMarkdown.includes("| Date | Amount | Currency |"));
assert.ok(xlsxMarkdown.includes("| 2026-07-28 | 1250.5 | INR |"));
assert.ok(xlsxMarkdown.includes("## Vendors"));
assert.ok(xlsxMarkdown.includes("| ACME | 499.99 |"));

// Corrupted input rejects with a structured error code instead of garbage.
await assert.rejects(
  toMarkdownBytes(Buffer.from("not a real document"), format("docx")),
  (error: Error & { code?: string }) =>
    typeof error.code === "string" && error.code.length > 0,
);

console.log("AnyDoc CSV/XLSX conversion smoke test passed");
