import assert from "node:assert/strict";

import {
  buildGoogleAuthorizationUrl,
  isStoredTokenFresh,
  parseOAuthCallback,
} from "./gmail-oauth-model.js";

const authorize = buildGoogleAuthorizationUrl({
  clientId: "desktop-client-id",
  redirectUri: "http://127.0.0.1:49152/oauth2/callback",
  state: "expected-state",
  codeChallenge: "challenge",
  mailbox: `financial.dropbox@${"gmail.com"}`,
});
const parsed = new URL(authorize);
assert.equal(parsed.origin + parsed.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
assert.equal(parsed.searchParams.get("response_type"), "code");
assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
assert.equal(parsed.searchParams.get("access_type"), "offline");
assert.equal(parsed.searchParams.get("login_hint"), `financial.dropbox@${"gmail.com"}`);
assert.ok(parsed.searchParams.get("scope")?.includes("gmail.readonly"));
assert.equal(parsed.searchParams.has("client_secret"), false);

assert.deepEqual(
  parseOAuthCallback(
    "http://127.0.0.1:49152/oauth2/callback?code=auth-code&state=expected-state",
    "expected-state",
  ),
  { code: "auth-code" },
);
assert.throws(
  () =>
    parseOAuthCallback(
      "http://127.0.0.1:49152/oauth2/callback?code=auth-code&state=wrong-state",
      "expected-state",
    ),
  /state mismatch/i,
);
assert.throws(
  () =>
    parseOAuthCallback(
      "http://127.0.0.1:49152/oauth2/callback?error=access_denied&state=expected-state",
      "expected-state",
    ),
  /access_denied/,
);
assert.equal(
  isStoredTokenFresh(
    { accessToken: "token", expiresIn: 3600, updatedAt: new Date("2026-07-29T00:00:00Z") },
    new Date("2026-07-29T00:30:00Z"),
  ),
  true,
);
assert.equal(
  isStoredTokenFresh(
    { accessToken: "token", expiresIn: 3600, updatedAt: new Date("2026-07-29T00:00:00Z") },
    new Date("2026-07-29T00:59:30Z"),
  ),
  false,
);

console.log("gmail oauth smoke: ok");
