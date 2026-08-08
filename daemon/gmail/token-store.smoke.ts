/**
 * Token store — round-trip against the REAL macOS Keychain.
 *   npx tsx daemon/gmail/token-store.smoke.ts
 *
 * A Gmail refresh token grants ongoing mailbox access. The failure this
 * guards against is silently degrading to plaintext, or "storing" a token
 * that cannot be read back.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTokenStore } from "./token-store.js";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    failed++;
  }
}

const TEST_PROVIDER = "smoke-test-provider";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-tok-"));

console.log("\nToken store\n");

const store = await createTokenStore(tmp);
console.log(`  backend: ${store.backend}\n`);

await check("a token round-trips", async () => {
  await store.set(TEST_PROVIDER, {
    accessToken: "synthetic-access-token",
    refreshToken: "synthetic-refresh-token",
    expiresIn: 3599,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  });
  const back = await store.get(TEST_PROVIDER);
  assert.ok(back, "nothing came back");
  assert.strictEqual(back.accessToken, "synthetic-access-token");
  assert.strictEqual(back.refreshToken, "synthetic-refresh-token");
  assert.strictEqual(back.expiresIn, 3599);
});

await check("updatedAt survives as a Date", async () => {
  const back = await store.get(TEST_PROVIDER);
  assert.ok(back?.updatedAt instanceof Date, "updatedAt is not a Date");
  assert.ok(!Number.isNaN(back.updatedAt.getTime()), "updatedAt is invalid");
});

await check("overwriting replaces rather than duplicating", async () => {
  await store.set(TEST_PROVIDER, { accessToken: "second-token" });
  const back = await store.get(TEST_PROVIDER);
  assert.strictEqual(back?.accessToken, "second-token");
});

await check("an unknown provider returns null, not an error", async () => {
  assert.strictEqual(await store.get("no-such-provider-xyz"), null);
});

await check("remove actually removes", async () => {
  await store.remove(TEST_PROVIDER);
  assert.strictEqual(await store.get(TEST_PROVIDER), null);
});

await check("removing twice is safe", async () => {
  await store.remove(TEST_PROVIDER);
});

// The stdin variant of `security -w` truncates at 128 chars, which stored a
// broken token that read back as "no tokens" — a silent logout. A realistic
// Google token JSON is ~180 bytes, so this asserts a long secret survives
// EXACTLY, which is the property truncation breaks.
await check("a long token survives byte-for-byte (128-char truncation guard)", async () => {
  const longAccess = `ya29.${"A".repeat(180)}`;
  const longRefresh = `1//0g${"B".repeat(90)}`;
  await store.set(TEST_PROVIDER, {
    accessToken: longAccess,
    refreshToken: longRefresh,
    expiresIn: 3599,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  });
  const back = await store.get(TEST_PROVIDER);
  assert.ok(back, "long token vanished — truncation regression");
  assert.strictEqual(back.accessToken, longAccess, "access token was truncated");
  assert.strictEqual(back.refreshToken, longRefresh, "refresh token was truncated");
  assert.strictEqual(back.scope, "https://www.googleapis.com/auth/gmail.readonly");
});

await check("no token is written to the vault directory", async () => {
  // On macOS the keychain is used, so the fallback dir must stay empty.
  if (store.backend !== "macos-keychain") return;
  await store.set(TEST_PROVIDER, { accessToken: "leak-check" });
  const leaked = fs.readdirSync(tmp).filter((f) => f.includes("oauth"));
  await store.remove(TEST_PROVIDER);
  assert.strictEqual(leaked.length, 0, `token leaked to disk: ${leaked.join(", ")}`);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
