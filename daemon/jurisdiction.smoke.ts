/**
 * Jurisdiction packs — proof that locale behaviour is DATA, not code.
 *   npx tsx daemon/jurisdiction.smoke.ts
 *
 * If these pass for both IN and JP without a single country-specific branch
 * in the daemon, the pack mechanism is real. If they only pass for India, we
 * have hardcoding wearing a JSON costume.
 */
import * as assert from "node:assert";

import { loadPack, listPacks, fyKeyFor, fyRange, formatMoney, settlementWindow } from "./jurisdiction.js";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    failed++;
  }
}

console.log("\nJurisdiction packs\n");

check("both packs load and are discoverable", () => {
  const ids = listPacks().map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ["IN", "JP"]);
});

check("India: FY runs 1 Apr – 31 Mar", () => {
  const IN = loadPack("IN");
  assert.strictEqual(fyKeyFor(IN, "2026-08-06"), "FY 2026-27");
  assert.strictEqual(fyKeyFor(IN, "2026-04-01"), "FY 2026-27", "1 Apr starts the new FY");
  assert.strictEqual(fyKeyFor(IN, "2026-03-31"), "FY 2025-26", "31 Mar is still the old FY");
  const r = fyRange(IN, "FY 2026-27");
  assert.strictEqual(r.from, "2026-04-01");
  assert.strictEqual(r.to, "2027-03-31");
});

check("Japan: same FY boundary, DIFFERENT label format", () => {
  const JP = loadPack("JP");
  // Same 1 Apr rule, but the pack's label_format has no "-27" suffix.
  assert.strictEqual(fyKeyFor(JP, "2026-08-06"), "FY2026");
  assert.strictEqual(fyKeyFor(JP, "2026-03-31"), "FY2025");
});

check("India: lakh/crore grouping, 2 minor units", () => {
  const IN = loadPack("IN");
  assert.strictEqual(formatMoney(IN, 64372), "₹643.72");
  assert.strictEqual(formatMoney(IN, 100000), "₹1,000.00");
  // The trap: 1,42,356.28 — NOT 142,356.28
  assert.strictEqual(formatMoney(IN, 14235628), "₹1,42,356.28");
  assert.strictEqual(formatMoney(IN, 1000000000), "₹1,00,00,000.00");
  assert.strictEqual(formatMoney(IN, -64372), "-₹643.72");
});

check("Japan: thousands grouping, ZERO minor units", () => {
  const JP = loadPack("JP");
  // Yen has no minor unit — 142356 minor == ¥142,356, not ¥1,423.56
  assert.strictEqual(formatMoney(JP, 142356), "¥142,356");
  assert.strictEqual(formatMoney(JP, 1000), "¥1,000");
  assert.ok(!formatMoney(JP, 142356).includes("."), "yen must not show decimals");
});

check("settlement windows come from the pack", () => {
  const IN = loadPack("IN");
  const JP = loadPack("JP");
  assert.strictEqual(settlementWindow(IN, "card"), 3);
  assert.strictEqual(settlementWindow(IN, "upi"), 1);
  assert.strictEqual(settlementWindow(IN, "unknown-rail"), 2, "falls back to default");
  // Japan has no UPI; it has furikomi.
  assert.strictEqual(settlementWindow(JP, "furikomi"), 1);
});

check("tax-ID patterns are per-jurisdiction", () => {
  const IN = loadPack("IN");
  const JP = loadPack("JP");
  assert.ok(new RegExp(IN.tax_ids.GSTIN).test("29AAAAA0000A1Z5"), "synthetic GSTIN of valid shape should match");
  assert.ok(new RegExp(IN.tax_ids.PAN).test("AAAAA0000A"), "synthetic PAN of valid shape should match");
  assert.ok(!("GSTIN" in JP.tax_ids), "Japan has no GSTIN");
  assert.ok("CorporateNumber" in JP.tax_ids);
});

check("a pack change alters behaviour with no code change", () => {
  // The whole point: same function, same input, different output — driven
  // only by which JSON file is loaded.
  const amount = 142356;
  const inr = formatMoney(loadPack("IN"), amount);
  const jpy = formatMoney(loadPack("JP"), amount);
  assert.notStrictEqual(inr, jpy);
  assert.strictEqual(inr, "₹1,423.56");
  assert.strictEqual(jpy, "¥142,356");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
