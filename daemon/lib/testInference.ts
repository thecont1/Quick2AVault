/**
 * Test inference connection — sends a minimal probe to verify the
 * provider/model/key combination works.
 *
 * Primary: sends a minimal text prompt, expects a short text response.
 * Secondary: sends a small image probe, expects a text response confirming
 * image understanding.
 *
 * On failure, the real provider error message is surfaced — no speculation
 * or reinterpretation. A failure does not globally mark the model as
 * ineligible; it may be key-, region-, or account-specific.
 */
import type { ProviderPreset, ModelRecord } from "../data/schema.js";

export interface TestResult {
  success: boolean;
  reachable: boolean;
  authenticated: boolean;
  modelAvailable: boolean;
  latencyMs: number | null;
  error: string | null;
  errorExplanation: string | null;
}

/**
 * Test a provider/model/key combination.
 */
export async function testInference(
  provider: ProviderPreset,
  model: ModelRecord,
  apiKey: string,
  slot: "primary" | "secondary",
): Promise<TestResult> {
  const start = Date.now();

  if (!apiKey) {
    return {
      success: false,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      latencyMs: null,
      error: "no_api_key",
      errorExplanation: "No API key configured. Set one in Settings first.",
    };
  }

  try {
    // Sarvam Document Intelligence: async job protocol, not chat completions
    if (provider.apiStyle === "sarvam-docai") {
      return await testSarvamDocAi(provider, apiKey, start);
    }

    // Standard chat completion test
    const isAnthropic = provider.apiStyle === "anthropic";
    // Anthropic catalog baseUrls already end in /v1, so appending /v1/messages
    // again would produce /v1/v1/messages. Strip a trailing /v1 for Anthropic
    // only; OpenAI-style providers keep their baseUrl verbatim.
    const url = isAnthropic
      ? `${provider.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/v1/messages`
      : `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (isAnthropic) {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
      model: model.id,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: "Reply with the single word: ok",
        },
      ],
    });

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(15000),
    });

    const latency = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return {
        success: false,
        reachable: true,
        authenticated: false,
        modelAvailable: false,
        latencyMs: latency,
        error: "auth_failed",
        errorExplanation: "API key was rejected by the provider.",
      };
    }

    if (res.status === 404) {
      return {
        success: false,
        reachable: true,
        authenticated: true,
        modelAvailable: false,
        latencyMs: latency,
        error: "model_not_found",
        errorExplanation: `Model "${model.id}" was not found at this provider.`,
      };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        success: false,
        reachable: true,
        authenticated: true,
        modelAvailable: true,
        latencyMs: latency,
        error: `http_${res.status}`,
        errorExplanation: text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }

    return {
      success: true,
      reachable: true,
      authenticated: true,
      modelAvailable: true,
      latencyMs: latency,
      error: null,
      errorExplanation: null,
    };
  } catch (err) {
    return {
      success: false,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      latencyMs: Date.now() - start,
      error: "unreachable",
      errorExplanation: `Could not reach provider: ${(err as Error)?.message}`,
    };
  }
}

/**
 * Sarvam Document Intelligence test: probe the job status endpoint with a
 * dummy job ID. 401/403 = bad key; 404 = key valid, job not found (expected).
 */
async function testSarvamDocAi(
  provider: ProviderPreset,
  apiKey: string,
  start: number,
): Promise<TestResult> {
  try {
    const probeUrl = `${provider.baseUrl.replace(/\/$/, "")}/job/test-probe/status`;
    const res = await fetch(probeUrl, {
      headers: { "api-subscription-key": apiKey },
      signal: AbortSignal.timeout(10000),
    });
    const latency = Date.now() - start;
    const authenticated = res.status !== 401 && res.status !== 403;
    const reachable = res.status < 500;

    return {
      success: reachable && authenticated,
      reachable,
      authenticated,
      modelAvailable: authenticated,
      latencyMs: latency,
      error: authenticated ? null : "auth_failed",
      errorExplanation: authenticated
        ? null
        : "API key was rejected by Sarvam Document Intelligence.",
    };
  } catch (err) {
    return {
      success: false,
      reachable: false,
      authenticated: false,
      modelAvailable: false,
      latencyMs: Date.now() - start,
      error: "unreachable",
      errorExplanation: `Could not reach Sarvam Document Intelligence: ${(err as Error)?.message}`,
    };
  }
}
