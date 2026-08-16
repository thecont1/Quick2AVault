/**
 * Migration from the old inference settings shape to the new one.
 *
 * Old shape (app_settings + SecretStore):
 *   ai.base_url, ai.model, ai.api_key (or ai.api_key.<providerId>)
 *   ai.secondary.base_url, ai.secondary.model, ai.secondary.api_key
 *   (or ai.secondary_api_key.<providerId>)
 *
 * New shape:
 *   inference.primary = SlotConfig { providerId, modelId }
 *   inference.secondary = SlotConfig { providerId, modelId }
 *   ai.provider_key.<providerId> = <key>  (per-provider, not per-slot)
 *
 * Migration rules (plan §13):
 * - If both slots use the same provider and two different keys exist,
 *   keep the most recently updated one (or prefer primary if no timestamps).
 *   Log a warning in development.
 * - Preserve the user's configured model IDs even if not in the catalog;
 *   treat them as user-entered model IDs.
 * - Do not discard old values silently.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SecretStore } from "../secret-store.js";
import type { SlotConfig } from "../data/schema.js";
import type { ProviderPreset } from "../data/schema.js";
import { modelBelongsToOtherProvider } from "./catalog.js";
import { CredentialManager } from "./credentials.js";

interface OldSettings {
  primaryBaseUrl?: string;
  primaryModel?: string;
  primaryApiKey?: string;
  secondaryBaseUrl?: string;
  secondaryModel?: string;
  secondaryApiKey?: string;
}

/**
 * Provider ID lookup from base URL. Maps known base URLs to canonical
 * provider IDs from the catalog. Falls back to "custom" for unknown URLs.
 */
const BASE_URL_TO_PROVIDER: Record<string, string> = {
  "https://api.openai.com/v1": "openai",
  "https://api.anthropic.com/v1": "anthropic",
  "https://generativelanguage.googleapis.com/v1beta": "google",
  "https://api.mistral.ai/v1": "mistral",
  "https://api.x.ai/v1": "xai",
  "https://api.deepseek.com": "deepseek",
  "https://openrouter.ai/api/v1": "openrouter",
  "https://api.together.ai/v1": "togetherai",
  "https://api.groq.com/openai/v1": "groq",
  "https://api.moonshot.ai/v1": "moonshotai",
  "https://api.minimax.io/v1": "minimax",
  "https://dashscope-intl.aliyuncs.com/api/v1": "alibaba",
  "https://api.sarvam.ai/v1": "sarvam",
  "https://api.sarvam.ai/doc-ai/v1": "sarvam-docai",
  "https://inference.poolside.ai/v1": "poolside",
  "https://api.perplexity.ai/v1": "perplexity",
};

function providerIdFromBaseUrl(baseUrl: string): string {
  if (!baseUrl) return "custom";
  const normalized = baseUrl.replace(/\/$/, "");
  return BASE_URL_TO_PROVIDER[normalized] ?? "custom";
}

/**
 * Map old model IDs to new catalog model IDs.
 * The Sarvam provider previously used "sarvam-doc-ai" as a sentinel;
 * the catalog uses "parse" for the document intelligence model.
 */
const MODEL_ID_MIGRATION: Record<string, string> = {
  "sarvam-doc-ai": "parse",
  "Sarvam Parse": "parse",
};

function migrateModelId(providerId: string, modelId: string): string {
  return MODEL_ID_MIGRATION[modelId] ?? modelId;
}

/**
 * Read the old settings from app_settings + SecretStore.
 */
async function readOldSettings(
  db: DatabaseSync,
  secrets: SecretStore,
): Promise<OldSettings> {
  const get = (key: string): string | undefined => {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key=?")
      .get(key) as { value?: string } | undefined;
    return row?.value;
  };

  const primaryBaseUrl = get("ai.base_url");
  const secondaryBaseUrl = get("ai.secondary.base_url");
  const primaryProviderId = providerIdFromBaseUrl(primaryBaseUrl ?? "");
  const secondaryProviderId = providerIdFromBaseUrl(secondaryBaseUrl ?? "");

  // Flat key first, then the per-provider key the old UI wrote for the
  // provider this slot pointed at (ai.api_key.<pid> / ai.secondary_api_key.<pid>).
  // Without the fallback, per-provider credentials are silently dropped.
  const primaryApiKey =
    (await secrets.get("ai.api_key"))
    ?? (await secrets.get(`ai.api_key.${primaryProviderId}`))
    ?? undefined;
  const secondaryApiKey =
    (await secrets.get("ai.secondary.api_key"))
    ?? (await secrets.get(`ai.secondary_api_key.${secondaryProviderId}`))
    ?? undefined;

  return {
    primaryBaseUrl,
    primaryModel: get("ai.model"),
    primaryApiKey,
    secondaryBaseUrl,
    secondaryModel: get("ai.secondary.model"),
    secondaryApiKey,
  };
}

/**
 * Check if migration has already been done.
 */
function isMigrated(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key='inference.migrated'")
    .get() as { value?: string } | undefined;
  return row?.value === "1";
}

/**
 * Mark migration as complete.
 */
function markMigrated(db: DatabaseSync): void {
  db.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('inference.migrated', '1')",
  ).run();
}

/**
 * Read the new SlotConfig from app_settings.
 */
export function readSlotConfig(
  db: DatabaseSync,
  slot: "primary" | "secondary",
): SlotConfig | null {
  const get = (key: string): string | undefined => {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key=?")
      .get(key) as { value?: string } | undefined;
    return row?.value;
  };

  const providerId = get(`inference.${slot}.provider_id`);
  const modelId = get(`inference.${slot}.model_id`);
  const baseUrlOverride = get(`inference.${slot}.base_url_override`);

  if (!providerId || !modelId) return null;
  return { providerId, modelId, baseUrlOverride };
}

/**
 * Write a SlotConfig to app_settings.
 */
export function writeSlotConfig(
  db: DatabaseSync,
  slot: "primary" | "secondary",
  config: SlotConfig,
): void {
  const set = (key: string, value: string) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
      )
      .run(key, value);

  set(`inference.${slot}.provider_id`, config.providerId);
  set(`inference.${slot}.model_id`, config.modelId);
  if (config.baseUrlOverride) {
    set(`inference.${slot}.base_url_override`, config.baseUrlOverride);
  } else {
    db.prepare(
      "DELETE FROM app_settings WHERE key=?",
    ).run(`inference.${slot}.base_url_override`);
  }
}

/**
 * Validate that a SlotConfig's modelId actually belongs to its providerId
 * in the catalog. If not, clear the modelId to prevent contradictory state
 * (e.g. gpt-4.1 appearing under Poolside).
 *
 * Run at settings-load time (catches already-corrupted state) and on
 * every provider-change event (prevents recurrence).
 */
export function validateSlotConfig(
  config: SlotConfig | null,
  catalog: ProviderPreset[],
): SlotConfig | null {
  if (!config) return null;
  const provider = catalog.find((p) => p.id === config.providerId);
  if (!provider) return config; // Unknown provider (e.g. custom) — leave as-is
  if (provider.models.some((m) => m.id === config.modelId)) return config;
  // The model isn't in this provider's list. Clear it ONLY when it belongs to
  // a DIFFERENT catalog provider (a genuine cross-provider leak). A model id
  // absent from the catalog entirely is a user-entered / legacy id and must be
  // preserved per the migration contract.
  if (modelBelongsToOtherProvider(catalog, config.providerId, config.modelId)) {
    return { ...config, modelId: "" };
  }
  return config;
}

/**
 * Migrate from the old settings shape to the new one.
 *
 * This is idempotent — if already migrated, it does nothing.
 * Old values are NOT deleted (they remain in app_settings for rollback).
 */
export async function migrateInferenceSettings(
  db: DatabaseSync,
  secrets: SecretStore,
  logger?: { warn: (msg: string, ctx?: unknown) => void },
): Promise<{ migrated: boolean; primary: SlotConfig | null; secondary: SlotConfig | null }> {
  if (isMigrated(db)) {
    return {
      migrated: false,
      primary: readSlotConfig(db, "primary"),
      secondary: readSlotConfig(db, "secondary"),
    };
  }

  const old = await readOldSettings(db, secrets);
  const creds = new CredentialManager(secrets);

  // Migrate primary
  let primary: SlotConfig | null = null;
  if (old.primaryBaseUrl && old.primaryModel) {
    const providerId = providerIdFromBaseUrl(old.primaryBaseUrl);
    primary = {
      providerId,
      modelId: migrateModelId(providerId, old.primaryModel),
      ...(providerId === "custom" && { baseUrlOverride: old.primaryBaseUrl }),
    };
    writeSlotConfig(db, "primary", primary);

    // Migrate the key to per-provider storage
    if (old.primaryApiKey) {
      // Check if secondary already has a key for the same provider
      if (
        old.secondaryApiKey &&
        providerId === providerIdFromBaseUrl(old.secondaryBaseUrl ?? "")
      ) {
        // Same provider in both slots — prefer primary key, warn about conflict
        logger?.warn("migration: both slots had keys for the same provider; keeping primary", {
          providerId,
        });
      }
      await creds.setKey(providerId, old.primaryApiKey);
    }
  }

  // Migrate secondary
  let secondary: SlotConfig | null = null;
  if (old.secondaryBaseUrl && old.secondaryModel) {
    const providerId = providerIdFromBaseUrl(old.secondaryBaseUrl);
    secondary = {
      providerId,
      modelId: migrateModelId(providerId, old.secondaryModel),
      ...(providerId === "custom" && { baseUrlOverride: old.secondaryBaseUrl }),
    };
    writeSlotConfig(db, "secondary", secondary);

    // Migrate the key — only if not already set (primary might have set it)
    if (old.secondaryApiKey) {
      const hasKey = await creds.hasValidKey(providerId);
      if (!hasKey) {
        await creds.setKey(providerId, old.secondaryApiKey);
      }
    }
  }

  markMigrated(db);
  return { migrated: true, primary, secondary };
}
