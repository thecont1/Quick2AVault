/**
 * Catalog loader — reads the generated catalog JSON and merges it with
 * manually maintained overrides at runtime.
 *
 * The generated catalog (catalog.generated.json) is committed to git and
 * updated by scripts/sync-catalog.ts. The overrides file
 * (catalog.overrides.json) is manually maintained for models we've verified
 * or want to force specific capabilities for.
 *
 * Merge logic: overrides win. For each model keyed by "providerId/modelId",
 * the override's fields replace the generated fields. If an override marks
 * a model as deprecated, it is filtered out.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ModelCapabilities,
  ModelRecord,
  ProviderPreset,
} from "../data/schema.js";

interface GeneratedCatalog {
  providers: ProviderPreset[];
}

interface OverrideEntry {
  trust?: ModelRecord["trust"];
  capabilities?: ModelCapabilities;
  jurisdictionTags?: string[];
  deprecated?: boolean;
  notes?: string;
  displayName?: string;
}

interface ProviderOverrideEntry {
  baseUrl?: string;
  apiStyle?: ProviderPreset["apiStyle"];
  tier?: ProviderPreset["tier"];
  name?: string;
  docsUrl?: string;
}

type OverridesMap = Record<string, OverrideEntry | ProviderOverrideEntry>;

const dataDir = () =>
  path.join(import.meta.dirname ?? __dirname, "..", "data");

let cachedCatalog: ProviderPreset[] | null = null;

/**
 * Load and merge the generated catalog with overrides.
 * Result is cached for the lifetime of the process.
 *
 * Override keys:
 * - "provider:<providerId>" — provider-level override (baseUrl, apiStyle, etc.)
 * - "<providerId>/<modelId>" — model-level override (trust, capabilities, etc.)
 *   If the model doesn't exist in the generated catalog, it's added as a new model.
 */
export function loadCatalog(): ProviderPreset[] {
  if (cachedCatalog) return cachedCatalog;

  const generatedPath = path.join(dataDir(), "catalog.generated.json");
  const overridesPath = path.join(dataDir(), "catalog.overrides.json");

  const generated = JSON.parse(
    fs.readFileSync(generatedPath, "utf-8"),
  ) as GeneratedCatalog;

  let overrides: OverridesMap = {};
  try {
    overrides = JSON.parse(
      fs.readFileSync(overridesPath, "utf-8"),
    ) as OverridesMap;
  } catch {
    // Overrides file is optional
  }

  // Separate provider overrides from model overrides
  const providerOverrides: Record<string, ProviderOverrideEntry> = {};
  const modelOverrides: Record<string, OverrideEntry> = {};
  for (const [key, val] of Object.entries(overrides)) {
    if (key.startsWith("provider:")) {
      providerOverrides[key.slice("provider:".length)] = val as ProviderOverrideEntry;
    } else if (!key.startsWith("_")) {
      modelOverrides[key] = val as OverrideEntry;
    }
  }

  cachedCatalog = generated.providers.map((provider) => {
    // Apply provider-level overrides
    const pov = providerOverrides[provider.id];
    const mergedProvider: ProviderPreset = {
      ...provider,
      ...(pov?.baseUrl !== undefined && { baseUrl: pov.baseUrl }),
      ...(pov?.apiStyle !== undefined && { apiStyle: pov.apiStyle }),
      ...(pov?.tier !== undefined && { tier: pov.tier }),
      ...(pov?.name !== undefined && { name: pov.name }),
      ...(pov?.docsUrl !== undefined && { docsUrl: pov.docsUrl }),
    };

    // Merge existing models with overrides
    const existingModelIds = new Set(provider.models.map((m) => m.id));
    const mergedModels = provider.models
      .map((model) => {
        const key = `${provider.id}/${model.id}`;
        const ov = modelOverrides[key];
        if (!ov) return model;
        return {
          ...model,
          ...(ov.trust !== undefined && { trust: ov.trust }),
          ...(ov.capabilities !== undefined && { capabilities: ov.capabilities }),
          ...(ov.jurisdictionTags !== undefined && { jurisdictionTags: ov.jurisdictionTags }),
          ...(ov.deprecated !== undefined && { deprecated: ov.deprecated }),
          ...(ov.notes !== undefined && { notes: ov.notes }),
          ...(ov.displayName !== undefined && { displayName: ov.displayName }),
        };
      })
      .filter((m) => !m.deprecated);

    // Add new models from overrides that don't exist in the generated catalog
    for (const [key, ov] of Object.entries(modelOverrides)) {
      if (!key.startsWith(`${provider.id}/`)) continue;
      const modelId = key.slice(`${provider.id}/`.length);
      if (existingModelIds.has(modelId)) continue;
      if (ov.deprecated) continue; // Don't add deprecated new models
      mergedModels.push({
        id: modelId,
        displayName: ov.displayName ?? modelId,
        providerId: provider.id,
        capabilities: ov.capabilities ?? { chat: false, json: false, vision: false },
        trust: ov.trust ?? "community",
        ...(ov.jurisdictionTags !== undefined && { jurisdictionTags: ov.jurisdictionTags }),
        ...(ov.notes !== undefined && { notes: ov.notes }),
      });
    }

    return { ...mergedProvider, models: mergedModels };
  });

  return cachedCatalog;
}

/**
 * Find a provider by id in the catalog.
 */
export function findProvider(
  catalog: ProviderPreset[],
  providerId: string,
): ProviderPreset | undefined {
  return catalog.find((p) => p.id === providerId);
}

/**
 * Find a specific model in a provider's model list.
 */
export function findModel(
  catalog: ProviderPreset[],
  providerId: string,
  modelId: string,
): ModelRecord | undefined {
  return findProvider(catalog, providerId)?.models.find(
    (m) => m.id === modelId,
  );
}

/**
 * Get all models across all providers, flattened.
 */
export function allModels(catalog: ProviderPreset[]): ModelRecord[] {
  return catalog.flatMap((p) => p.models);
}
