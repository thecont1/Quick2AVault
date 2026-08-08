/**
 * AiProvider port + Anthropic adapter (plan §8).
 *
 * User supplies base URL + API key + model, so any Anthropic-compatible
 * endpoint works; Claude is the default. Strict tool-use output, low
 * temperature. Validation failures degrade to the review queue rather than
 * corrupting the ledger.
 */
import Anthropic from "@anthropic-ai/sdk";

import type { Logger } from "./ports.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_TOOL_SCHEMA,
  EXTRACTION_VERSION,
  type ExtractionResult,
} from "./extraction-contract.js";

export interface AiProvider {
  readonly available: boolean;
  readonly model: string;
  extract(markdown: string, filename: string): Promise<ExtractionResult | null>;
}

export interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
}

/** No-op provider so P0/P1 keep working with no AI configured (plan §8). */
export const nullAiProvider: AiProvider = {
  available: false,
  model: "(none)",
  async extract() {
    return null;
  },
};

export function createAnthropicProvider(cfg: AiConfig, logger: Logger): AiProvider {
  const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    logger.warn("no AI key configured — P2 analysis will be skipped");
    return nullAiProvider;
  }

  const model = cfg.model ?? process.env.Q2AV_MODEL ?? "claude-sonnet-5";
  const client = new Anthropic({
    apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  });

  return {
    available: true,
    model,
    async extract(markdown: string, filename: string): Promise<ExtractionResult | null> {
      // Long documents: head+tail keeps the totals block, which usually sits at
      // the end, while staying inside a cheap token budget.
      const text =
        markdown.length > 24000
          ? `${markdown.slice(0, 16000)}\n\n[...truncated...]\n\n${markdown.slice(-8000)}`
          : markdown;

      try {
        const res = await client.messages.create({
          model,
          // A contract note settling 18 securities needs ~18 line items with
          // name, ISIN, quantity and price. At 2048 the model silently
          // dropped the holdings array rather than exceed the budget — the
          // extraction looked fine and the portfolio was simply absent.
          max_tokens: cfg.maxTokens ?? 8192,
          // NOTE: `temperature` is REJECTED by Claude 5 models
          // ("`temperature` is deprecated for this model", HTTP 400).
          // Determinism comes from the forced tool_choice + strict schema.
          system: EXTRACTION_SYSTEM_PROMPT,
          tools: [EXTRACTION_TOOL_SCHEMA as never],
          tool_choice: { type: "tool", name: "record_extraction" },
          messages: [
            {
              role: "user",
              content: `Document filename: ${filename}\n\nCanonical markdown:\n\n${text}`,
            },
          ],
        });

        const block = res.content.find((c) => c.type === "tool_use");
        if (!block || block.type !== "tool_use") {
          logger.warn("extraction: no tool_use block returned", { filename });
          return null;
        }
        return normalise(block.input as Record<string, unknown>);
      } catch (err) {
        logger.error("extraction failed", { filename, err: (err as Error)?.message });
        return null;
      }
    },
  };
}

/**
 * Defensive normalisation. The model is instructed to emit integer minor units,
 * but a float here would silently corrupt every downstream total, so we coerce
 * and log rather than trusting.
 */
function normalise(raw: Record<string, unknown>): ExtractionResult {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : null;
  };

  return {
    doc_type: (raw.doc_type as ExtractionResult["doc_type"]) ?? "unknown",
    occurred_at: (raw.occurred_at as string) ?? null,
    posted_at: (raw.posted_at as string) ?? null,
    amount_minor: num(raw.amount_minor),
    currency: (raw.currency as string) ?? "INR",
    direction: (raw.direction as ExtractionResult["direction"]) ?? null,
    payment_rail: (raw.payment_rail as ExtractionResult["payment_rail"]) ?? null,
    parties: Array.isArray(raw.parties) ? (raw.parties as ExtractionResult["parties"]) : [],
    reference_ids: (raw.reference_ids as ExtractionResult["reference_ids"]) ?? {},
    counterparty_descriptor: (raw.counterparty_descriptor as string) ?? null,
    source_of_funds_text: (raw.source_of_funds_text as string) ?? null,
    destination_of_funds_text: (raw.destination_of_funds_text as string) ?? null,
    purpose_text: (raw.purpose_text as string) ?? null,
    category_hint: (raw.category_hint as string) ?? null,
    is_wallet_topup: raw.is_wallet_topup === true,
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    notes: (raw.notes as string) ?? null,
    // Portfolio line items. NOTE: this function rebuilds the result field by
    // field, so ANY field added to the contract must be copied here too —
    // otherwise the model returns it and this silently discards it. That is
    // exactly what happened to holdings: the extraction was correct and the
    // data died in normalisation.
    holdings: Array.isArray(raw.holdings)
      ? (raw.holdings as ExtractionResult["holdings"])
      : null,
  };
}

export { EXTRACTION_VERSION };
