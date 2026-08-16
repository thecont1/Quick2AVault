/**
 * Eligibility filter — determines which models are eligible for a given
 * inference slot and jurisdiction.
 *
 * Rules (plan §4):
 * - Primary slot requires chat && json. Vision is not required.
 * - Secondary slot requires vision && json. Chat is NOT required for
 *   secondary, because document-intelligence models (like Sarvam Parse)
 *   are vision+json capable but not chat-capable — they use a different
 *   API protocol for raw-file extraction.
 * - Deprecated models are excluded.
 * - Jurisdiction-tagged models are filtered by the active jurisdiction.
 *   If no jurisdiction-tagged model matches, fall back to showing all
 *   eligible models with the jurisdiction filter dropped.
 * - Verified models sort above community models, but community models
 *   are still selectable — the user's own experience is a valid signal.
 */
import type {
  InferenceSlot,
  ModelRecord,
} from "../data/schema.js";

export interface EligibilityResult {
  /** Models that match the slot + jurisdiction. */
  models: ModelRecord[];
  /** If true, the jurisdiction filter was dropped (no matches found). */
  jurisdictionFallback: boolean;
  /** Human-readable note for the UI. */
  note: string | null;
}

/**
 * Filter models eligible for a given slot and jurisdiction.
 *
 * @param models  all models from the catalog (or a single provider's models)
 * @param slot    "primary" or "secondary"
 * @param jurisdiction  active jurisdiction pack id, e.g. "IN"
 */
export function eligibleModels(
  models: ModelRecord[],
  slot: InferenceSlot,
  jurisdiction: string,
): EligibilityResult {
  const baseFiltered = models
    .filter((m) => !m.deprecated)
    .filter((m) => m.capabilities.json)
    .filter((m) => {
      if (slot === "primary") return m.capabilities.chat;
      // Secondary: vision required, chat optional (doc-intelligence models
      // like Sarvam Parse have vision+json but not chat)
      return m.capabilities.vision;
    });

  // Try with jurisdiction filter first
  const jurisdictionMatched = baseFiltered.filter(
    (m) => !m.jurisdictionTags || m.jurisdictionTags.includes(jurisdiction),
  );

  const trustRank: Record<ModelRecord["trust"], number> = {
    verified: 0,
    community: 1,
    unverified: 2,
  };
  const trustSort = (a: ModelRecord, b: ModelRecord) => {
    const t = trustRank[a.trust] - trustRank[b.trust];
    if (t !== 0) return t;
    return a.displayName.localeCompare(b.displayName);
  };

  if (jurisdictionMatched.length > 0) {
    return {
      models: [...jurisdictionMatched].sort(trustSort),
      jurisdictionFallback: false,
      note: null,
    };
  }

  // No jurisdiction-tagged model found — fall back to all eligible models
  return {
    models: [...baseFiltered].sort(trustSort),
    jurisdictionFallback: true,
    note: `No jurisdiction-tagged model found for ${jurisdiction}; showing all eligible models.`,
  };
}

/**
 * Check if a specific model is eligible for a slot.
 * Used for validating saved configurations.
 */
export function isEligible(
  model: ModelRecord,
  slot: InferenceSlot,
): boolean {
  if (model.deprecated) return false;
  if (!model.capabilities.json) return false;
  if (slot === "primary") return model.capabilities.chat;
  return model.capabilities.vision;
}
