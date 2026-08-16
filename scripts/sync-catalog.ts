/**
 * Catalog sync script — fetches models.dev/api.json and normalizes it into
 * the ProviderPreset[] shape defined in daemon/data/schema.ts.
 *
 * This is a BUILD-TIME script, run manually or via CI. The running app never
 * fetches models.dev — it only reads the committed catalog.generated.json.
 *
 * Usage:
 *   npx tsx scripts/sync-catalog.ts
 *
 * Output:
 *   daemon/data/catalog.generated.json
 *
 * Trust policy: every model from models.dev is set to trust: "community".
 * Verified models are added via catalog.overrides.json (merged at runtime).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ApiStyle,
  ModelCapabilities,
  ModelRecord,
  ProviderPreset,
  ProviderTier,
} from "../daemon/data/schema.js";

// ─── Provider tier mapping ───────────────────────────────────────────────
// Manually curated. Providers not in this map default to "aggregator".
const TIER_MAP: Record<string, ProviderTier> = {
  // Core — major frontier model providers
  openai: "core",
  anthropic: "core",
  google: "core",
  "google-vertex": "core",
  "google-vertex-anthropic": "core",
  openrouter: "core",
  mistral: "core",
  deepseek: "core",
  xai: "core",
  meta: "core",
  // Regional — regional or specialized providers
  alibaba: "regional",
  "alibaba-token-plan": "regional",
  moonshotai: "regional",
  "moonshotai-cn": "regional",
  "kimi-for-coding": "regional",
  minimax: "regional",
  zhipuai: "regional",
  "zhipuai-coding-plan": "regional",
  nvidia: "regional",
  sarvam: "regional",
  cohere: "regional",
  poolside: "regional",
  inception: "regional",
  upstage: "regional",
  xiaomi: "regional",
  "xiaomi-token-plan-sgp": "regional",
  // Local — self-hosted runtimes
  "ollama-cloud": "local",
  "lm-studio": "local",
  // Aggregators — everything else defaults here
};

// ─── API style mapping ───────────────────────────────────────────────────
// Inferred from the npm package field. Most are openai-compatible.
const NPM_TO_STYLE: Record<string, ApiStyle> = {
  "@ai-sdk/openai-compatible": "openai",
  "@ai-sdk/openai": "openai",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "gemini",
  "@ai-sdk/ollama": "ollama",
  "@ai-sdk/mistral": "openai",
  "@ai-sdk/xai": "openai",
};

// ─── Fallback base URLs ──────────────────────────────────────────────────
// Some major providers (OpenAI, Anthropic, Google, Mistral, xAI) don't
// include an `api` field in models.dev because the base URL is implicit in
// their SDK package. We fill them in here.
const FALLBACK_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "google-vertex": "https://us-central1-aiplatform.googleapis.com/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  cohere: "https://api.cohere.com/v2",
  ollama: "http://localhost:11434/v1",
};

// ─── models.dev API shapes ───────────────────────────────────────────────
interface ModelsDevModel {
  id: string;
  name: string;
  description?: string;
  attachment?: boolean;
  structured_output?: boolean;
  tool_call?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  deprecated?: boolean;
}

interface ModelsDevProvider {
  id: string;
  name: string;
  api: string;
  doc?: string;
  npm?: string;
  models: Record<string, ModelsDevModel>;
}

// ─── Normalization ───────────────────────────────────────────────────────

function inferCapabilities(m: ModelsDevModel): ModelCapabilities {
  const inputs = m.modalities?.input ?? [];
  const hasImage =
    m.attachment === true ||
    inputs.includes("image") ||
    inputs.includes("pdf");
  return {
    chat: true, // All models.dev entries are chat/completion models by definition
    json: m.structured_output === true,
    vision: hasImage,
  };
}

function normalizeModel(
  m: ModelsDevModel,
  providerId: string,
): ModelRecord {
  return {
    id: m.id,
    displayName: m.name || m.id,
    providerId,
    capabilities: inferCapabilities(m),
    trust: "community", // Default; overrides can upgrade to "verified"
    deprecated: m.deprecated === true,
    notes: m.description,
  };
}

function normalizeProvider(
  p: ModelsDevProvider,
): ProviderPreset | null {
  // Use fallback base URL for providers that don't include one
  const baseUrl = p.api || FALLBACK_BASE_URL[p.id] || "";
  if (!baseUrl || !p.models) return null;

  const tier = TIER_MAP[p.id] ?? "aggregator";
  const apiStyle = NPM_TO_STYLE[p.npm ?? ""] ?? "openai";

  const models = Object.values(p.models)
    .map((m) => normalizeModel(m, p.id))
    .filter((m) => !m.deprecated);

  if (models.length === 0) return null;

  return {
    id: p.id,
    name: p.name || p.id,
    logoUrl: `https://models.dev/logos/${p.id}.png`,
    baseUrl,
    apiStyle,
    tier,
    docsUrl: p.doc,
    models,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching models.dev/api.json…");
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) {
    console.error(`Failed to fetch: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const raw = (await res.json()) as Record<string, ModelsDevProvider>;

  const providers: ProviderPreset[] = [];
  for (const [id, p] of Object.entries(raw)) {
    // Ensure id matches the key
    const provider = { ...p, id };
    const normalized = normalizeProvider(provider);
    if (normalized) providers.push(normalized);
  }

  // Sort by tier then name for stable output
  const tierOrder: Record<ProviderTier, number> = {
    core: 0,
    regional: 1,
    aggregator: 2,
    local: 3,
  };
  providers.sort((a, b) => {
    const t = tierOrder[a.tier] - tierOrder[b.tier];
    if (t !== 0) return t;
    return a.name.localeCompare(b.name);
  });

  const outPath = path.join(
    import.meta.dirname ?? __dirname,
    "..",
    "daemon",
    "data",
    "catalog.generated.json",
  );

  const output = {
    _generated_from: "https://models.dev/api.json",
    _generated_at: new Date().toISOString(),
    _trust_policy:
      "All models default to trust:community. Verified models are in catalog.overrides.json.",
    providers,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `Wrote ${providers.length} providers (${providers.reduce((a, p) => a + p.models.length, 0)} models) to ${outPath}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
