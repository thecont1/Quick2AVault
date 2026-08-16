/**
 * Schema types for the curated provider/model catalog.
 *
 * The catalog is sourced from models.dev at build time (scripts/sync-catalog.ts)
 * and merged with manually maintained overrides (daemon/data/catalog.overrides.json).
 * The running app never fetches models.dev — it only reads the committed JSON.
 *
 * See plan §1 (Data model) for the full specification.
 */

/** API protocol style the provider speaks. */
export type ApiStyle = "openai" | "anthropic" | "gemini" | "ollama" | "sarvam-docai";

/** Provider grouping for the picker UI. */
export type ProviderTier = "core" | "regional" | "aggregator" | "local";

/**
 * Trust level — how much we've verified a model.
 *
 * - "verified": we've tested it end-to-end in Q2AV.
 * - "community": capability comes from public catalog metadata, unverified by us.
 * - "unverified": reserved for future use; currently treated same as community.
 */
export type TrustLevel = "verified" | "community" | "unverified";

/** What a model can do. Used by eligibility filtering. */
export interface ModelCapabilities {
  /** Can do text chat / completions. */
  chat: boolean;
  /** Can produce structured JSON output. */
  json: boolean;
  /** Can accept and understand images. */
  vision: boolean;
}

/** A single model entry in the catalog. */
export interface ModelRecord {
  /** Provider-facing model id, e.g. "gpt-4.1" or "sarvam-105b". */
  id: string;
  /** Human-readable name for the dropdown. */
  displayName: string;
  /** Provider this model belongs to. */
  providerId: string;
  capabilities: ModelCapabilities;
  trust: TrustLevel;
  /** Jurisdiction tags for region-specific models, e.g. ["IN"]. */
  jurisdictionTags?: string[];
  /** If true, the model is deprecated and should not be selectable. */
  deprecated?: boolean;
  /** Shown in UI as a one-line note, e.g. "Community-reported vision support". */
  notes?: string;
}

/** A provider preset in the catalog. */
export interface ProviderPreset {
  /** Canonical id, e.g. "openai", "anthropic", "sarvam". */
  id: string;
  /** Display name for the picker. */
  name: string;
  /** Logo URL from models.dev catalog (if available). */
  logoUrl?: string;
  /** API base URL. */
  baseUrl: string;
  /** API protocol style. */
  apiStyle: ApiStyle;
  /** Tier grouping for the picker UI. */
  tier: ProviderTier;
  /** Documentation URL. */
  docsUrl?: string;
  /** Models offered by this provider. */
  models: ModelRecord[];
}

/** Credential state for a provider (stored, not the key itself). */
export interface CredentialRecord {
  providerId: string;
  hasKey: boolean;
  lastRotatedAt?: string;
}

/** Which slot a provider/model is configured for. */
export type InferenceSlot = "primary" | "secondary";

/** Configuration for a single inference slot. */
export interface SlotConfig {
  providerId: string;
  modelId: string;
  /** Only used for "custom" providers. */
  baseUrlOverride?: string;
}

/** The full inference configuration persisted by the app. */
export interface InferenceConfig {
  primary: SlotConfig | null;
  secondary: SlotConfig | null;
}
