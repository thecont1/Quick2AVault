/**
 * Gmail desktop OAuth — ported from the Glaze app to the headless daemon.
 *
 * Same PKCE + loopback design (Google's recommended flow for installed apps),
 * with two Glaze dependencies replaced:
 *   shell.openExternal  →  the platform's `open` command
 *   OAuthTokenStore     →  daemon/gmail/token-store.ts (macOS Keychain)
 *
 * A headless daemon cannot show a browser, so `authorize()` returns the URL to
 * the caller as well as opening it: the Flutter app shows a clickable link,
 * and a user on a remote/SSH box can still complete the flow by hand.
 *
 * Scope is gmail.readonly, and nothing here ever sends, deletes, or labels.
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as http from "node:http";

import {
  buildGoogleAuthorizationUrl,
  GOOGLE_TOKEN_URL,
  googleTokenInput,
  isStoredTokenFresh,
  parseOAuthCallback,
  type StoredOAuthTokens,
} from "./gmail-oauth-model.js";
import type { TokenStore } from "./token-store.js";
import type { Logger } from "../ports.js";

const CALLBACK_PATH = "/oauth2/callback";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

const base64Url = (b: Buffer) => b.toString("base64url");

function openInBrowser(url: string, logger: Logger): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], (err) => {
    // Not fatal: the URL is also returned to the caller, so the user can click
    // it in the app or paste it into any browser.
    if (err) logger.warn("could not open a browser automatically", { error: String(err) });
  });
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
    throw new Error(`Google token request failed (${response.status}): ${String(detail ?? "unknown")}`);
  }
  return body;
}

export interface AuthorizeHandle {
  /** Show this to the user; it is also opened automatically. */
  authUrl: string;
  /** Resolves when the user finishes consent, rejects on timeout/mismatch. */
  completed: Promise<StoredOAuthTokens>;
}

export class GmailOAuth {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly providerId: string,
    private readonly store: TokenStore,
    private readonly logger: Logger,
  ) {}

  /**
   * Begin authorisation. Returns immediately with the URL so an HTTP caller is
   * not held open for the full five minutes; `completed` settles later.
   */
  async authorize(mailbox: string): Promise<AuthorizeHandle> {
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
    const state = base64Url(crypto.randomBytes(32));

    const callback = await this.waitForCallback(state);
    const authUrl = buildGoogleAuthorizationUrl({
      clientId: this.clientId,
      redirectUri: callback.redirectUri,
      state,
      codeChallenge: challenge,
      mailbox,
    });
    openInBrowser(authUrl, this.logger);
    this.logger.info("gmail: awaiting consent", { mailbox, redirect: callback.redirectUri });

    const completed = callback.code.then(async (code) => {
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
      this.logger.info("gmail: connected", { mailbox });
      return this.requireTokens();
    });

    return { authUrl, completed };
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.requireTokens();
    if (isStoredTokenFresh(tokens)) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error("Gmail authorization expired. Reconnect the mailbox.");
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

  getTokens(): Promise<StoredOAuthTokens | null> {
    return this.store.get(this.providerId);
  }

  disconnect(): Promise<void> {
    return this.store.remove(this.providerId);
  }

  private async requireTokens(): Promise<StoredOAuthTokens> {
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
          `<!doctype html><meta charset="utf-8">
           <title>Gmail connected</title>
           <style>body{font:15px -apple-system,system-ui;margin:20vh auto;max-width:30rem;
             text-align:center;color:#1c1c1e}h1{font-size:20px}p{color:#6b6b70}</style>
           <h1>Gmail connected</h1>
           <p>You can close this window and return to Quick2A Vault.</p>`,
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
      // Loopback only: never expose the callback beyond this machine.
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
