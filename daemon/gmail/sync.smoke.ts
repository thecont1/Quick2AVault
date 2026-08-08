/**
 * Gmail attachment filenames are attacker-controlled.
 *   npx tsx daemon/gmail/sync.smoke.ts
 *
 * The failure this guards against: someone emails an attachment named
 * "../../../../tmp/pwned.pdf" and the daemon writes outside its temp dir.
 * Verified exploitable before the fix — path.join put it at /tmp/pwned.pdf.
 *
 * The extension allowlist in gmail-model does NOT prevent this: a traversal
 * payload can end in .pdf and passes the gate untouched.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { __testing } from "./sync.js";

const { safeBasename, assertInside } = __testing;

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log("\nGmail attachment path safety\n");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-synctest-"));

check("THE EXPLOIT: traversal cannot escape the temp dir", () => {
  const hostile = "../../../../../../tmp/pwned.pdf";
  const safe = safeBasename(hostile, "fallback.bin");
  assert.ok(!safe.includes("/"), `separator survived: ${safe}`);
  assert.ok(!safe.startsWith("."), `leading dots survived: ${safe}`);
  const resolved = assertInside(tmp, path.join(tmp, safe));
  assert.ok(
    resolved.startsWith(path.resolve(tmp) + path.sep),
    `escaped to ${resolved}`,
  );
});

check("absolute paths are reduced to a basename", () => {
  const safe = safeBasename("/etc/cron.d/pwned.pdf", "fallback.bin");
  assert.strictEqual(safe, "pwned.pdf");
  assertInside(tmp, path.join(tmp, safe));
});

check("nested relative paths are flattened", () => {
  const safe = safeBasename("subdir/nested.pdf", "fallback.bin");
  assert.strictEqual(safe, "nested.pdf");
});

check("windows separators are handled too", () => {
  const safe = safeBasename("..\\..\\windows\\system32\\pwned.pdf", "fallback.bin");
  assert.ok(!safe.includes("\\"), `backslash survived: ${safe}`);
  assert.ok(!safe.includes("/"), `slash survived: ${safe}`);
  assertInside(tmp, path.join(tmp, safe));
});

check("a bare '..' falls back rather than becoming empty", () => {
  const safe = safeBasename("..", "fallback.bin");
  assert.strictEqual(safe, "fallback.bin");
});

check("empty and whitespace names fall back", () => {
  assert.strictEqual(safeBasename("", "fb.bin"), "fb.bin");
  assert.strictEqual(safeBasename("   ", "fb.bin"), "fb.bin");
});

check("ordinary filenames are left alone", () => {
  assert.strictEqual(safeBasename("Invoice-2026-08.pdf", "fb.bin"), "Invoice-2026-08.pdf");
  assert.strictEqual(safeBasename("CN_BZ859919_03082026.pdf", "fb.bin"), "CN_BZ859919_03082026.pdf");
});

check("absurdly long names are truncated, not rejected", () => {
  const safe = safeBasename("A".repeat(500) + ".pdf", "fb.bin");
  assert.ok(safe.length <= 120, `length ${safe.length}`);
});

check("assertInside rejects a path outside the dir", () => {
  assert.throws(
    () => assertInside(tmp, "/tmp/elsewhere/pwned.pdf"),
    /refusing to write outside/,
    "a path outside tmp must be refused",
  );
});

check("assertInside accepts the dir's own children", () => {
  const ok = assertInside(tmp, path.join(tmp, "invoice.pdf"));
  assert.ok(ok.endsWith("invoice.pdf"));
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
