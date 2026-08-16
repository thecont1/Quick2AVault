/**
 * Per-provider credential management.
 *
 * API keys are stored per provider (not per slot) so that selecting the same
 * provider in both primary and secondary slots reuses the same key
 * automatically. Keys go through the existing SecretStore (macOS Keychain
 * or 0600 file fallback) — never in plaintext SQLite.
 *
 * Secret key format: `ai.provider_key.<providerId>`
 * This is separate from the legacy `ai.api_key` / `ai.secondary.api_key`
 * keys, which are migrated by migrateInferenceSettings.ts.
 */
import type { CredentialRecord } from "../data/schema.js";
import type { SecretStore } from "../secret-store.js";

const keyPrefix = "ai.provider_key.";

/**
 * Credential manager — wraps the SecretStore with per-provider semantics.
 */
export class CredentialManager {
  constructor(private secrets: SecretStore) {}

  /** Store an API key for a provider. */
  async setKey(providerId: string, key: string): Promise<void> {
    await this.secrets.set(keyPrefix + providerId, key);
  }

  /** Remove the stored API key for a provider. */
  async removeKey(providerId: string): Promise<void> {
    await this.secrets.remove(keyPrefix + providerId);
  }

  /** Get the raw API key for a provider (or null if not set). */
  async getKey(providerId: string): Promise<string | null> {
    return this.secrets.get(keyPrefix + providerId);
  }

  /** Check if a valid key exists for a provider. */
  async hasValidKey(providerId: string): Promise<boolean> {
    const key = await this.secrets.get(keyPrefix + providerId);
    return !!key;
  }

  /** Get a CredentialRecord (metadata only, never the raw key) for UI display. */
  async getRecord(providerId: string): Promise<CredentialRecord> {
    const key = await this.secrets.get(keyPrefix + providerId);
    return {
      providerId,
      hasKey: !!key,
    };
  }

  /** Get CredentialRecords for multiple providers at once. */
  async getRecords(providerIds: string[]): Promise<Record<string, CredentialRecord>> {
    const entries = await Promise.all(
      providerIds.map(async (pid) => [pid, await this.getRecord(pid)] as const),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Get a masked version of the key for UI display (first4…last4).
   * Returns null if no key is set.
   */
  async getMaskedKey(providerId: string): Promise<string | null> {
    const key = await this.secrets.get(keyPrefix + providerId);
    if (!key) return null;
    if (key.length <= 8) return "****";
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
  }
}
