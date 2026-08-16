/**
 * Jurisdiction-aware default suggestions.
 *
 * When a user selects a jurisdiction pack, we can suggest appropriate
 * providers/models for each slot. Suggestions are only applied when the
 * slot is currently unconfigured — never silently overwrite an existing
 * configuration.
 *
 * The UI renders the suggestion as a dismissible inline banner:
 * "Suggested for India: Poolside (primary). [Use this] [Dismiss]"
 */
import type { InferenceSlot } from "../data/schema.js";

export interface Suggestion {
  providerId: string;
  modelId: string;
  reason: string;
}

const JURISDICTION_DEFAULTS: Record<string, Record<InferenceSlot, Suggestion>> = {
  IN: {
    primary: {
      providerId: "poolside",
      modelId: "poolside/laguna-s-2.1",
      reason: "Fast, free-tier primary — no vision needed for transaction parsing.",
    },
    secondary: {
      providerId: "sarvam",
      modelId: "parse",
      reason: "Tuned for Indian financial documents (GST invoices, bank statement screenshots).",
    },
  },
};

/**
 * Get the suggested default for a jurisdiction and slot.
 * Returns undefined if no suggestion exists for this jurisdiction.
 */
export function suggestDefaults(
  jurisdiction: string,
  slot: InferenceSlot,
): Suggestion | undefined {
  return JURISDICTION_DEFAULTS[jurisdiction]?.[slot];
}

/**
 * Check if any suggestions exist for a jurisdiction.
 * Used by the UI to decide whether to show the "Recommended defaults" section.
 */
export function hasSuggestions(jurisdiction: string): boolean {
  return !!JURISDICTION_DEFAULTS[jurisdiction];
}
