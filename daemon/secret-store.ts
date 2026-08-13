/**
 * Secret store for non-OAuth credentials — primarily AI provider API keys.
 *
 * The Gmail token store (gmail/token-store.ts) handles OAuth tokens. This
 * module handles the same keychain/file pattern for arbitrary string secrets
 * like `ai.api_key` and `ai.secondary.api_key`, which previously sat as
 * plaintext in the `app_settings` SQLite table.
 *
 * Same backends as the token store:
 *   - macOS Keychain via the `security` CLI (no native dependency)
 *   - 0600-permission file fallback for Linux / CI
 *
 * The same argv trade-off applies: `security add-generic-password -w` is used
 * because the stdin path truncates at 128 chars. See the comment in
 * token-store.ts for the full rationale.
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SERVICE = "app.quick2avault.secrets";

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  readonly backend: string;
}

/** macOS Keychain, via the `security` CLI. No native dependency. */
class KeychainSecretStore implements SecretStore {
  readonly backend = "macos-keychain";

  async get(key: string): Promise<string | null> {
    try {
      const { stdout } = await run("security", [
        "find-generic-password",
        "-s", SERVICE,
        "-a", key,
        "-w",
      ]);
      return stdout.trim() || null;
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (!/could not be found|SecKeychainSearchCopyNext/i.test(msg)) {
        throw new Error(`keychain read failed for ${key}: ${msg}`);
      }
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    // Same trade-off as token-store.ts: argv, not stdin, because
    // `security -w` with stdin truncates at 128 chars.
    await run("security", [
      "add-generic-password",
      "-s", SERVICE,
      "-a", key,
      "-w", value,
      "-U",
    ]);
  }

  async remove(key: string): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", key]);
    } catch {
      /* already gone */
    }
  }
}

/** Last resort. 0600, and the caller is told this is weaker. */
class FileSecretStore implements SecretStore {
  readonly backend = "file-0600";
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    // Hash the key so the filename doesn't leak the secret name.
    const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    return path.join(this.dir, `.secret-${hash}`);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.file(key), "utf-8");
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.file(key), value, { mode: 0o600 });
    await fs.promises.chmod(this.file(key), 0o600);
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.file(key), { force: true });
  }
}

export async function createSecretStore(fallbackDir: string): Promise<SecretStore> {
  if (process.platform === "darwin") {
    try {
      await run("security", ["-h"]);
      return new KeychainSecretStore();
    } catch {
      /* fall through */
    }
  }
  return new FileSecretStore(fallbackDir);
}
