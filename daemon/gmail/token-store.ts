/**
 * OAuth token storage for the daemon.
 *
 * Replaces Glaze's OAuthTokenStore. Tokens are secrets: a Gmail refresh token
 * grants ongoing mailbox access, so it goes in the macOS Keychain via the
 * `security` CLI — not a plaintext file next to the ledger.
 *
 * Falls back to a 0600 file only where no keychain exists (Linux CI), and says
 * so out loud rather than silently downgrading the user's security.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

import type { StoredOAuthTokens, StoredOAuthTokensInput } from "./gmail-oauth-model.js";

const run = promisify(execFile);

const SERVICE = "app.quick2avault.oauth";

export interface TokenStore {
  get(providerId: string): Promise<StoredOAuthTokens | null>;
  set(providerId: string, tokens: StoredOAuthTokensInput): Promise<void>;
  remove(providerId: string): Promise<void>;
  readonly backend: string;
}

function serialise(t: StoredOAuthTokensInput): string {
  return JSON.stringify({ ...t, updatedAt: (t.updatedAt ?? new Date()).toISOString() });
}

function deserialise(raw: string): StoredOAuthTokens | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (typeof j.accessToken !== "string") return null;
    return {
      accessToken: j.accessToken,
      refreshToken: typeof j.refreshToken === "string" ? j.refreshToken : undefined,
      idToken: typeof j.idToken === "string" ? j.idToken : undefined,
      expiresIn: typeof j.expiresIn === "number" ? j.expiresIn : undefined,
      scope: typeof j.scope === "string" ? j.scope : undefined,
      tokenType: typeof j.tokenType === "string" ? j.tokenType : undefined,
      updatedAt: new Date(String(j.updatedAt ?? Date.now())),
    };
  } catch {
    return null;
  }
}

/** macOS Keychain, via the `security` CLI. No native dependency. */
class KeychainStore implements TokenStore {
  readonly backend = "macos-keychain";

  async get(providerId: string): Promise<StoredOAuthTokens | null> {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s", SERVICE,
        "-a", providerId,
        "-w",
      ]);
      return deserialise(stdout.trim());
    } catch {
      return null; // not found is the normal path, not an error
    }
  }

  async set(providerId: string, tokens: StoredOAuthTokensInput): Promise<void> {
    // -U updates in place if the item already exists.
    await run("security", [
      "add-generic-password",
      "-s", SERVICE,
      "-a", providerId,
      "-w", serialise(tokens),
      "-U",
    ]);
  }

  async remove(providerId: string): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", providerId]);
    } catch {
      /* already gone */
    }
  }
}

/** Last resort. 0600, and the caller is told this is weaker. */
class FileStore implements TokenStore {
  readonly backend = "file-0600";
  constructor(private readonly dir: string) {}

  private file(providerId: string) {
    return path.join(this.dir, `.oauth-${providerId}.json`);
  }

  async get(providerId: string): Promise<StoredOAuthTokens | null> {
    try {
      return deserialise(await fs.promises.readFile(this.file(providerId), "utf-8"));
    } catch {
      return null;
    }
  }

  async set(providerId: string, tokens: StoredOAuthTokensInput): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.file(providerId), serialise(tokens), { mode: 0o600 });
    await fs.promises.chmod(this.file(providerId), 0o600);
  }

  async remove(providerId: string): Promise<void> {
    await fs.promises.rm(this.file(providerId), { force: true });
  }
}

export async function createTokenStore(fallbackDir: string): Promise<TokenStore> {
  if (process.platform === "darwin") {
    try {
      await run("security", ["-h"]);
      return new KeychainStore();
    } catch {
      /* fall through */
    }
  }
  return new FileStore(fallbackDir);
}
