/**
 * AiProvider port + Anthropic adapter (plan §8).
 *
 * User supplies base URL + API key + model, so any Anthropic-compatible
 * endpoint works; Claude is the default. Strict tool-use output, low
 * temperature. Validation failures degrade to the review queue rather than
 * corrupting the ledger.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { Logger } from "./ports.js";
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_TOOL_SCHEMA,
  OPENAI_TOOL,
  EXTRACTION_VERSION,
  type ExtractionResult,
} from "./extraction-contract.js";
import { createSarvamProvider } from "./sarvam.js";

export interface AiProvider {
  readonly available: boolean;
  readonly model: string;
  extract(markdown: string, filename: string): Promise<ExtractionResult | null>;
  /**
   * Document intelligence extraction: takes the RAW file path (PDF/image)
   * instead of markdown. Implemented by providers like Sarvam AI that do
   * OCR + field extraction server-side. Returns null if not supported.
   */
  extractDocument?(rawPath: string, filename: string): Promise<ExtractionResult | null>;
}

export interface AiConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  // Work order 07 §D2: secondary (vision/fallback) model config.
  secondaryApiKey?: string;
  secondaryBaseUrl?: string;
  secondaryModel?: string;
  routingMode?: "auto" | "primary_only" | "vision_fallback";
  /** Force "anthropic" or "openai". When omitted the provider is auto-detected
   *  from baseUrl: anthropic.com → Anthropic, everything else → OpenAI-compatible.
   */
  providerType?: "anthropic" | "openai";
}

/** No-op provider so P0/P1 keep working with no AI configured (plan §8). */
export const nullAiProvider: AiProvider = {
  available: false,
  model: "(none)",
  async extract() {
    return null;
  },
};

/**
 * A provider whose configuration can change while the daemon runs.
 *
 * The AI provider used to be built once at startup, so pasting a key into
 * Settings saved it to the database and then did nothing until the daemon was
 * restarted — the worst kind of failure, because the UI said "saved" and the
 * behaviour never changed. This wrapper holds a swappable inner provider so
 * `reconfigure()` takes effect on the very next job.
 *
 * `available` and `model` are getters, not captured values: callers that hold
 * a reference (the job worker, the settings endpoint) see the current state
 * rather than a snapshot from boot.
 */
export interface MutableAiProvider extends AiProvider {
  /** Rebuild the inner provider. Returns whether AI is available afterwards. */
  reconfigure(cfg: AiConfig): boolean;
}

export function createMutableProvider(cfg: AiConfig, logger: Logger): MutableAiProvider {
  let inner = createProvider(cfg, logger);
  // Work order 07 §D1: secondary (vision/fallback) provider. Blank secondary
  // is valid — the user may configure only a primary model. When the secondary
  // base URL is Sarvam AI, the secondary is a SarvamProvider that exposes
  // extractDocument() for raw-file document intelligence.
  let secondary = createSecondaryProvider(cfg, logger);
  let routingMode = cfg.routingMode ?? "auto";
  return {
    get available() {
      return inner.available;
    },
    get model() {
      return inner.model;
    },
    extract(markdown, filename) {
      // Work order 07 §D3: routing. In primary_only mode, always use primary.
      // In auto/vision_fallback mode, use primary for ordinary text; the
      // routing decision for vision/scanned input is made by the caller
      // (runAnalyseJob), not here — this method is called for text extraction.
      return inner.extract(markdown, filename);
    },
    /** Document intelligence: delegate to the secondary provider if it
     *  supports extractDocument (Sarvam AI does; generic LLMs don't). */
    async extractDocument(rawPath: string, filename: string): Promise<ExtractionResult | null> {
      if (secondary.extractDocument && secondary.available) {
        return secondary.extractDocument(rawPath, filename);
      }
      return null;
    },
    reconfigure(next: AiConfig) {
      inner = createProvider(next, logger);
      secondary = createSecondaryProvider(next, logger);
      routingMode = next.routingMode ?? "auto";
      logger.info("ai provider reconfigured", {
        available: inner.available,
        model: inner.model,
        secondary_available: secondary.available,
        secondary_model: secondary.model,
        routing_mode: routingMode,
      });
      return inner.available;
    },
  };
}

/**
 * Work order 07 §D1: create the secondary (vision/fallback) provider. Returns
 * a null provider when no secondary is configured — a blank secondary is valid.
 *
 * When the secondary base URL is Sarvam AI's document intelligence endpoint,
 * a SarvamProvider is created instead of a generic LLM provider. Sarvam uses
 * a different API protocol (async job + multipart, not chat completions) and
 * exposes extractDocument() instead of extract().
 */
function createSecondaryProvider(cfg: AiConfig, logger: Logger): AiProvider {
  const apiKey = cfg.secondaryApiKey ?? "";
  if (!apiKey || !cfg.secondaryModel) {
    return nullAiProvider;
  }
  // Sarvam Document Intelligence: detect by base URL containing doc-ai.
  // The Sarvam provider does OCR + field extraction on the raw file
  // via an async job protocol, not text chat completions.
  const baseUrl = cfg.secondaryBaseUrl || cfg.baseUrl || "";
  if (baseUrl.includes("sarvam.ai") && baseUrl.includes("doc-ai")) {
    const sarvam = createSarvamProvider({ apiKey, baseUrl }, logger);
    // Wrap as an AiProvider: extract() returns null (Sarvam can't do text
    // extraction), extractDocument() does the real work.
    return {
      get available() { return sarvam.available; },
      model: sarvam.model,
      async extract() { return null; },
      extractDocument: (rawPath: string, filename: string) => sarvam.extractDocument(rawPath, filename),
    };
  }
  return createProvider(
    {
      apiKey,
      baseUrl: cfg.secondaryBaseUrl || cfg.baseUrl,
      model: cfg.secondaryModel,
      providerType: cfg.providerType,
    },
    logger,
  );
}

/** Provider-agnostic key resolution. Prefers Q2AV_AI_API_KEY; falls back to
 * ANTHROPIC_API_KEY for existing setups. An explicitly empty string ("") means
 * "cleared" and must NOT fall through to the env var.
 */
function resolveApiKey(cfg: AiConfig): string {
  if (cfg.apiKey !== undefined) return cfg.apiKey;
  return process.env.Q2AV_AI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
}

/**
 * Dispatch to the right provider based on explicit override or URL detection.
 * anthropic.com → Anthropic Messages API; anything else → OpenAI-compatible
 * /v1/chat/completions.
 */
export function createProvider(cfg: AiConfig, logger: Logger): AiProvider {
  // Explicit override wins. When omitted, auto-detect: a base URL
  // containing "anthropic.com" → Anthropic; any other URL → OpenAI-compatible;
  // no URL → Anthropic (legacy default for users who just paste a key).
  let isAnthropic: boolean;
  if (cfg.providerType === "anthropic") isAnthropic = true;
  else if (cfg.providerType === "openai") isAnthropic = false;
  else if (cfg.baseUrl) isAnthropic = cfg.baseUrl.includes("anthropic.com");
  else isAnthropic = true;

  return isAnthropic
    ? createAnthropicProvider(cfg, logger)
    : createOpenAiProvider(cfg, logger);
}

export function createAnthropicProvider(cfg: AiConfig, logger: Logger): AiProvider {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    logger.warn("no AI key configured — P2 analysis will be skipped");
    return nullAiProvider;
  }

  const model = cfg.model ?? process.env.Q2AV_MODEL ?? "";
  if (!model) {
    logger.warn("no AI model configured — P2 analysis will be skipped");
    return nullAiProvider;
  }
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
 * OpenAI-compatible provider for any endpoint that speaks the
 * /v1/chat/completions protocol with function-calling tools (Poolside,
 * OpenRouter, etc.). Same extraction schema, same truncation, same
 * normalisation — just a different wire format.
 */
export function createOpenAiProvider(cfg: AiConfig, logger: Logger): AiProvider {
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    logger.warn("no AI key configured — P2 analysis will be skipped");
    return nullAiProvider;
  }

  const model = cfg.model ?? process.env.Q2AV_MODEL ?? "";
  if (!model) {
    logger.warn("no AI model configured — P2 analysis will be skipped");
    return nullAiProvider;
  }
  const client = new OpenAI({
    apiKey,
    ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
  });

  return {
    available: true,
    model,
    async extract(markdown: string, filename: string): Promise<ExtractionResult | null> {
      const text =
        markdown.length > 24000
          ? `${markdown.slice(0, 16000)}\n\n[...truncated...]\n\n${markdown.slice(-8000)}`
          : markdown;

      try {
        const res = await client.chat.completions.create({
          model,
          max_tokens: cfg.maxTokens ?? 8192,
          messages: [
            {
              role: "user",
              content: `Document filename: ${filename}\n\nCanonical markdown:\n\n${text}`,
            },
          ],
          tools: [OPENAI_TOOL],
          tool_choice: { type: "function", function: { name: "record_extraction" } },
        });

        const toolCall = res.choices[0]?.message?.tool_calls?.[0];
        if (!toolCall || toolCall.type !== "function" || !toolCall.function?.arguments) {
          logger.warn("extraction: no function tool_call returned", { filename });
          return null;
        }
        const parsed = JSON.parse(toolCall.function.arguments);
        return normalise(parsed as Record<string, unknown>);
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
