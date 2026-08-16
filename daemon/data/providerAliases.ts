/**
 * Provider search aliases — lets users find providers by the names they
 * actually know, not just the canonical models.dev id.
 *
 * Used by the provider picker's search box. When the user types "gemini",
 * it matches the "google" provider. When they type "glm", it matches
 * "zhipuai". Etc.
 *
 * This applies only to provider search UX, not to canonical IDs.
 */
export const PROVIDER_ALIASES: Record<string, string[]> = {
  google: ["gemini", "google gemini", "bard", "palm"],
  "google-vertex": ["vertex", "vertex ai", "gcp"],
  anthropic: ["claude", "anthropic claude"],
  openai: ["gpt", "chatgpt", "o1", "o3"],
  xai: ["grok", "eliza"],
  deepseek: ["deep seek", "coder"],
  mistral: ["mixtral", "codestral"],
  meta: ["llama", "facebook ai"],
  openrouter: ["open router"],
  alibaba: ["qwen", "tongyi", "bailian"],
  "alibaba-token-plan": ["qwen token", "alibaba token"],
  moonshotai: ["kimi", "moonshot ai", "moonshot"],
  "moonshotai-cn": ["kimi cn", "moonshot china"],
  "kimi-for-coding": ["kimi coding", "kimi code"],
  minimax: ["mini max", "abab"],
  zhipuai: ["glm", "bigmodel", "chatglm", "zhipu"],
  "zhipuai-coding-plan": ["glm coding", "zhipu coding"],
  nvidia: ["nim", "nemotron", "cuda"],
  sarvam: ["sarvam ai", "indian ai", "saaras", "bulbul", "mayura"],
  cohere: ["command r", "command-r"],
  poolside: ["laguna"],
  inception: ["inception labs"],
  upstage: ["solar"],
  xiaomi: ["mimo", "xiaomi ai"],
  "xiaomi-token-plan-sgp": ["mimo sgp", "xiaomi sgp"],
  "ollama-cloud": ["ollama", "local llm", "self-hosted"],
  togetherai: ["together", "together ai"],
  "fireworks-ai": ["fireworks", "fireworks ai"],
  huggingface: ["hugging face", "hf", "inference endpoints"],
};

/**
 * Search providers by name or alias.
 * Returns provider IDs that match the query (case-insensitive substring).
 */
export function searchProviderIds(
  query: string,
  allProviderIds: string[],
  providerNames: Record<string, string>,
): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return allProviderIds;

  return allProviderIds.filter((pid) => {
    // Match on provider name
    const name = (providerNames[pid] ?? pid).toLowerCase();
    if (name.includes(q)) return true;
    // Match on canonical id
    if (pid.toLowerCase().includes(q)) return true;
    // Match on aliases
    const aliases = PROVIDER_ALIASES[pid] ?? [];
    return aliases.some((a) => a.toLowerCase().includes(q));
  });
}
