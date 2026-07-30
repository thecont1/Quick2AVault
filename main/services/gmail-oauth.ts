import * as crypto from "node:crypto";
import * as http from "node:http";

import { shell } from "@glaze/core/backend";
import { OAuthTokenStore, type OAuthTokens } from "@glaze/core/oauth";
import {
  buildGoogleAuthorizationUrl,
  GOOGLE_TOKEN_URL,
  googleTokenInput,
  isStoredTokenFresh,
  parseOAuthCallback,
} from "./gmail-oauth-model.js";
const CALLBACK_PATH = "/oauth2/callback";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

async function tokenRequest(params: URLSearchParams): Promise<Record<string, unknown>> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: params,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof body.error_description === "string" ? body.error_description : body.error;
    throw new Error(
      `Google token request failed (${response.status}): ${String(detail ?? "unknown error")}`,
    );
  }
  return body;
}

export class GmailDesktopOAuth {
  private readonly store = new OAuthTokenStore();

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly providerId: string,
  ) {}

  async authorize(mailbox: string): Promise<OAuthTokens> {
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64Url(crypto.randomBytes(32));
    const callback = await this.waitForCallback(state);
    await shell.openExternal(
      buildGoogleAuthorizationUrl({
        clientId: this.clientId,
        redirectUri: callback.redirectUri,
        state,
        codeChallenge: challenge,
        mailbox,
      }),
    );
    const code = await callback.code;
    const payload = await tokenRequest(
      new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: callback.redirectUri,
      }),
    );
    await this.store.set(this.providerId, googleTokenInput(payload));
    return this.requireTokens();
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.requireTokens();
    if (isStoredTokenFresh(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken)
      throw new Error("Gmail authorization expired. Reconnect the mailbox.");
    const payload = await tokenRequest(
      new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: "refresh_token",
      }),
    );
    await this.store.set(this.providerId, googleTokenInput(payload, tokens.refreshToken));
    return (await this.requireTokens()).accessToken;
  }

  getTokens(): Promise<OAuthTokens | null> {
    return this.store.get(this.providerId);
  }

  removeTokens(): Promise<void> {
    return this.store.remove(this.providerId);
  }

  private async requireTokens(): Promise<OAuthTokens> {
    const tokens = await this.store.get(this.providerId);
    if (!tokens) throw new Error("Gmail is not connected.");
    return tokens;
  }

  private async waitForCallback(expectedState: string): Promise<{
    redirectUri: string;
    code: Promise<string>;
  }> {
    let resolveCode: (code: string) => void = () => {};
    let rejectCode: (error: Error) => void = () => {};
    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    const server = http.createServer((request, response) => {
      if (!request.url || !request.headers.host) return;
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end("Not found");
        return;
      }
      try {
        const result = parseOAuthCallback(url.toString(), expectedState);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          "<h1>Gmail connected</h1><p>You can close this window and return to Quick2A Vault.</p>",
        );
        resolveCode(result.code);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Gmail authorization failed. Return to Quick2A Vault for details.");
        rejectCode(error instanceof Error ? error : new Error(String(error)));
      } finally {
        server.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Could not start the local Gmail OAuth callback.");
    }
    const timer = setTimeout(() => {
      server.close();
      rejectCode(new Error("Gmail authorization timed out."));
    }, AUTH_TIMEOUT_MS);
    code.finally(() => clearTimeout(timer)).catch(() => {});
    return { redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`, code };
  }
}
