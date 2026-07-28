import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsvBuffer, parseXlsx } from "./spreadsheet.js";

function rowsToMarkdownTable(rows: unknown[][]): string {
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const cells = (row: unknown[]) =>
    Array.from({ length: colCount }, (_, index) => String(row[index] ?? ""));
  return [
    `| ${cells(rows[0]).join(" | ")} |`,
    `| ${Array.from({ length: colCount }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${cells(row).join(" | ")} |`),
  ].join("\n");
}

function sectionsToMarkdown(sections: Array<{ name: string; rows: unknown[][] }>): string {
  const markdown: string[] = [];
  for (const { name, rows } of sections) {
    const heading = sections.length > 1 ? `## ${name}\n` : "";
    markdown.push(`${heading}${rowsToMarkdownTable(rows)}`);
  }
  return markdown.join("\n\n");
}

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "transactions.xlsx");
const xlsxMarkdown = sectionsToMarkdown(await parseXlsx(await readFile(fixturePath)));
assert.equal(
  xlsxMarkdown,
  [
    "## Transactions",
    "| Date | Amount | Currency |",
    "| --- | --- | --- |",
    "| 2026-07-28 | 1250.5 | INR |",
    "",
    "## Vendors",
    "| Vendor | Amount |",
    "| --- | --- |",
    "| ACME | 499.99 |",
  ].join("\n"),
);

const csvPath = join(here, "fixtures", "transactions.csv");
const csvMarkdown = sectionsToMarkdown(parseCsvBuffer(await readFile(csvPath)));
assert.equal(csvMarkdown, "| Vendor | Amount |\n| --- | --- |\n| ACME | 499.99 |");

console.log("Spreadsheet XLSX/CSV conversion smoke test passed");
