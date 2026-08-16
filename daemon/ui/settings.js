// ════════════════════════════════════════════════════════════════════════
// SETTINGS TAB — curated provider catalog + eligibility-based model picker
// ════════════════════════════════════════════════════════════════════════

// Catalog state — loaded from /v1/settings/catalog
let CATALOG = [];
let CREDENTIALS = {};
let SUGGESTIONS = {};
let ACTIVE_JURISDICTION = "IN";

// Track current provider IDs for each slot
let currentPrimaryProviderId = "";
let currentSecondaryProviderId = "";

// ── Trust badge rendering ────────────────────────────────────────────────
function trustBadge(trust) {
  if (trust === "verified") return " <span style='color:var(--ok)'>●</span>";
  if (trust === "community") return " <span style='color:var(--faint)'>●</span>";
  return " <span style='color:var(--warn)'>●</span>";
}

// ── Provider grouping ────────────────────────────────────────────────────
const TIER_LABELS = {
  core: "CORE",
  regional: "REGIONAL",
  aggregator: "AGGREGATORS",
  local: "LOCAL",
};
const TIER_ORDER = ["core", "regional", "aggregator", "local"];

/**
 * Build the provider dropdown with tier grouping.
 * Aggregators are collapsed behind an <optgroup> (browsers show them
 * when the user scrolls, but they're visually separated).
 */
function buildProviderDropdown(selectId, currentProviderId) {
  const sel = document.getElementById(selectId);
  const grouped = {};
  for (const p of CATALOG) {
    if (!grouped[p.tier]) grouped[p.tier] = [];
    grouped[p.tier].push(p);
  }

  let html = "";
  for (const tier of TIER_ORDER) {
    const providers = grouped[tier] || [];
    if (providers.length === 0) continue;
    html += `<optgroup label="${TIER_LABELS[tier]}">`;
    for (const p of providers) {
      html += `<option value="${esc(p.id)}"${p.id === currentProviderId ? " selected" : ""}>${esc(p.name)}</option>`;
    }
    html += "</optgroup>";
  }
  // Custom is always last, outside all groups
  html += `<optgroup label="CUSTOM"><option value="custom"${currentProviderId === "custom" ? " selected" : ""}>Custom provider…</option></optgroup>`;
  sel.innerHTML = html;
}

// ── Load settings ────────────────────────────────────────────────────────
async function loadSettings() {
  // Load the catalog first (needed for provider dropdowns)
  try {
    const cat = await api("/v1/settings/catalog");
    CATALOG = cat.providers || [];
    CREDENTIALS = cat.credentials || {};
    SUGGESTIONS = cat.suggestions || {};
    ACTIVE_JURISDICTION = cat.jurisdiction || "IN";
  } catch {
    // Catalog endpoint not available — fall back to old settings load
    CATALOG = [];
  }

  // Load the inference slot config
  let inference = null;
  try {
    inference = await api("/v1/settings/inference");
  } catch {
    // Fall back to old settings
  }

  // Also load old settings for jurisdiction, vault, gmail
  const s = await api("/v1/settings");
  const ai = s.ai || {};

  // ── Primary inference ──────────────────────────────────────────────────
  const primProviderId = inference?.primary?.providerId
    || (ai.base_url ? providerIdFromCatalog(ai.base_url) : "");
  let primModelId = inference?.primary?.modelId || ai.model || "";
  // Validate: if the saved model doesn't belong to the provider in the
  // catalog, clear it (referential integrity — prevents gpt-4.1 under Poolside)
  if (primProviderId && primProviderId !== "custom" && primModelId) {
    const provider = CATALOG.find((p) => p.id === primProviderId);
    if (provider && !provider.models.find((m) => m.id === primModelId)) {
      primModelId = "";
    }
  }

  buildProviderDropdown("aiProvider", primProviderId);
  currentPrimaryProviderId = document.getElementById("aiProvider").value;
  document.getElementById("aiBaseUrl").value = ai.base_url || "";
  onProviderChange("primary", primModelId);
  updateKeyUI("primary", currentPrimaryProviderId);

  // ── Jurisdiction (loaded before secondary for auto-select) ─────────────
  const jur = s.jurisdiction || {};
  const sel = document.getElementById("jurSelect");
  sel.innerHTML = (jur.available || []).map((p) =>
    "<option value='" + esc(p.id) + "'" + (p.id === jur.id ? " selected" : "") + ">"
    + esc(p.name) + " (" + esc(p.id) + " v" + esc(p.version) + ")</option>").join("");
  document.getElementById("jurInfo").innerHTML =
    "Currency <b>" + esc(jur.currency) + "</b> · FY " + esc(jur.fy_label)
    + " · dates " + esc(jur.date_format) + " · grouping " + esc(jur.grouping);
  ACTIVE_JURISDICTION = jur.id || "IN";

  // ── Secondary inference ────────────────────────────────────────────────
  const sec = ai.secondary || {};
  const secProviderId = inference?.secondary?.providerId || (sec.base_url ? providerIdFromCatalog(sec.base_url) : "");
  let secModelId = inference?.secondary?.modelId || sec.model || "";
  // Validate referential integrity (same as primary)
  if (secProviderId && secProviderId !== "custom" && secModelId) {
    const provider = CATALOG.find((p) => p.id === secProviderId);
    if (provider && !provider.models.find((m) => m.id === secModelId)) {
      secModelId = "";
    }
  }

  buildProviderDropdown("ai2Provider", secProviderId);
  currentSecondaryProviderId = document.getElementById("ai2Provider").value;
  document.getElementById("ai2BaseUrl").value = sec.base_url || "";
  onProviderChange("secondary", secModelId);
  updateKeyUI("secondary", currentSecondaryProviderId);

  // ── Suggestion banners ─────────────────────────────────────────────────
  renderSuggestions(inference);

  // ── Vault summary ──────────────────────────────────────────────────────
  const v = s.vault || {};
  document.getElementById("vRoot").textContent = v.root || "—";
  document.getElementById("vDrop").textContent = v.drop || "—";
  document.getElementById("vDb").textContent = v.db || "—";
  updateVaultSummary(inference);

  // ── Gmail ──────────────────────────────────────────────────────────────
  const g = s.gmail || {};
  document.getElementById("gAddr").textContent = g.address || "not configured";
  document.getElementById("gStatus").textContent = g.status || "—";
  const gDate = document.getElementById("gAfterDate");
  if (!gDate.value) gDate.value = new Date().toISOString().slice(0, 10);

  // Auto-test both inference providers
  testAi("primary");
  testAi("secondary");
}

/**
 * Map a base URL to a provider ID from the catalog.
 */
function providerIdFromCatalog(baseUrl) {
  if (!baseUrl) return "";
  const normalized = baseUrl.replace(/\/$/, "");
  const provider = CATALOG.find((p) => p.baseUrl.replace(/\/$/, "") === normalized);
  return provider ? provider.id : "custom";
}

/**
 * Get the base URL for the currently selected provider in a slot.
 */
function providerBaseUrl(which) {
  const sel = document.getElementById(which === "primary" ? "aiProvider" : "ai2Provider");
  const pid = sel.value;
  if (pid === "custom") {
    const input = document.getElementById(which === "primary" ? "aiBaseUrl" : "ai2BaseUrl");
    return input.value.trim();
  }
  const provider = CATALOG.find((p) => p.id === pid);
  return provider ? provider.baseUrl : "";
}

/**
 * Show the provider's logo beside the provider dropdown.
 * Logos come from models.dev via logoUrl in the catalog.
 */
function updateProviderLogo(which, provider) {
  const isPrimary = which === "primary";
  const sel = document.getElementById(isPrimary ? "aiProvider" : "ai2Provider");
  const logoId = isPrimary ? "aiProviderLogo" : "ai2ProviderLogo";
  let logo = document.getElementById(logoId);
  if (!logo) {
    // Wrap the select in an inline-flex container with the logo beside it
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex;align-items:center;gap:8px";
    sel.parentNode.insertBefore(wrapper, sel);
    wrapper.appendChild(sel);
    logo = document.createElement("img");
    logo.id = logoId;
    logo.style.cssText = "width:18px;height:18px;border-radius:3px;flex-shrink:0";
    logo.onerror = () => { logo.style.display = "none"; };
    wrapper.appendChild(logo);
  }
  if (provider && provider.logoUrl) {
    logo.src = provider.logoUrl;
    logo.alt = provider.name;
    logo.style.display = "";
  } else {
    logo.style.display = "none";
  }
}

/**
 * Called when the provider dropdown changes.
 * Shows the base URL (read-only for catalog providers, editable for Custom),
 * and populates the model dropdown using eligibleModels() for that slot.
 */
function onProviderChange(which, savedModel) {
  const isPrimary = which === "primary";
  const sel = document.getElementById(isPrimary ? "aiProvider" : "ai2Provider");
  const pid = sel.value;
  const provider = CATALOG.find((p) => p.id === pid);
  const baseUrl = provider ? provider.baseUrl : "";

  // Show provider logo beside the dropdown
  updateProviderLogo(which, provider);

  // Base URL: read-only for catalog providers, editable for Custom
  const customUrlRow = document.getElementById(isPrimary ? "aiCustomUrlRow" : "ai2CustomUrlRow");
  const urlRow = document.getElementById(isPrimary ? "aiUrlRow" : "ai2UrlRow");
  const baseUrlRoInput = document.getElementById(isPrimary ? "aiBaseUrlRo" : "ai2BaseUrlRo");

  if (pid === "custom") {
    if (customUrlRow) customUrlRow.style.display = "";
    if (urlRow) urlRow.style.display = "none";
  } else {
    if (customUrlRow) customUrlRow.style.display = "none";
    if (urlRow) urlRow.style.display = "";
    if (baseUrlRoInput) baseUrlRoInput.value = baseUrl;
  }

  // Model dropdown
  const modelSelect = document.getElementById(isPrimary ? "aiModel" : "ai2Model");
  const modelNote = document.getElementById(isPrimary ? "aiModelNote" : "ai2ModelNote");

  // Custom provider: free-text model ID (use a text input)
  if (pid === "custom") {
    modelSelect.style.display = "none";
    // Create or show a text input for custom model ID
    let modelInput = document.getElementById(isPrimary ? "aiModelText" : "ai2ModelText");
    if (!modelInput) {
      modelInput = document.createElement("input");
      modelInput.type = "text";
      modelInput.id = isPrimary ? "aiModelText" : "ai2ModelText";
      modelInput.placeholder = "model-id";
      modelInput.style.width = "100%";
      modelSelect.parentNode.appendChild(modelInput);
      modelInput.oninput = () => autoSave(which);
    }
    modelInput.style.display = "";
    modelInput.value = savedModel || "";
    if (modelNote) modelNote.textContent = "";
    return;
  }

  // Catalog provider: use the select dropdown
  modelSelect.style.display = "";
  const modelInput = document.getElementById(isPrimary ? "aiModelText" : "ai2ModelText");
  if (modelInput) modelInput.style.display = "none";

  if (!provider) {
    modelSelect.innerHTML = "<option value=''>select a provider first</option>";
    modelSelect.disabled = true;
    return;
  }

  // Get eligible models for this provider + slot + jurisdiction
  const slot = isPrimary ? "primary" : "secondary";
  const result = eligibleModelsForProvider(provider, slot, ACTIVE_JURISDICTION);

  if (result.models.length === 0) {
    modelSelect.innerHTML = "<option value=''>No eligible models for this provider in this role</option>";
    modelSelect.disabled = true;
    modelSelect.style.opacity = "0.6";
    if (modelNote) modelNote.textContent = "";
    return;
  }

  modelSelect.disabled = false;
  modelSelect.style.opacity = "";

  // Build options with trust badges
  let html = "";
  if (savedModel && !result.models.find((m) => m.id === savedModel)) {
    // Saved model not in eligible list — add it at top as "(saved)"
    html += `<option value="${esc(savedModel)}">${esc(savedModel)} (saved)</option>`;
  }
  for (const m of result.models) {
    const selected = m.id === savedModel ? " selected" : "";
    const badge = trustBadge(m.trust);
    const notes = m.notes ? ` — ${esc(m.notes.slice(0, 60))}` : "";
    html += `<option value="${esc(m.id)}"${selected}>${esc(m.displayName)}${badge}${notes}</option>`;
  }
  // "Other model ID (advanced)" — always at the bottom
  html += `<option value="__other__">Other model ID (advanced)…</option>`;
  modelSelect.innerHTML = html;
  if (savedModel) modelSelect.value = savedModel;

  // Show jurisdiction fallback note
  if (modelNote) {
    modelNote.textContent = result.jurisdictionFallback ? result.note : "";
  }
}

/**
 * Filter a provider's models by eligibility for a slot.
 */
function eligibleModelsForProvider(provider, slot, jurisdiction) {
  // Client-side eligibility filter (mirrors daemon/lib/eligibility.ts)
  // Primary: chat && json. Secondary: vision && json (chat optional —
  // doc-intelligence models like Sarvam Parse have vision+json but not chat).
  const baseFiltered = provider.models
    .filter((m) => !m.deprecated)
    .filter((m) => m.capabilities.json)
    .filter((m) => {
      if (slot === "primary") return m.capabilities.chat;
      return m.capabilities.vision;
    });

  const jurisdictionMatched = baseFiltered.filter(
    (m) => !m.jurisdictionTags || m.jurisdictionTags.includes(jurisdiction),
  );

  const trustSort = (a, b) => {
    if (a.trust !== b.trust) return a.trust === "verified" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  };

  if (jurisdictionMatched.length > 0) {
    return {
      models: [...jurisdictionMatched].sort(trustSort),
      jurisdictionFallback: false,
      note: null,
    };
  }

  return {
    models: [...baseFiltered].sort(trustSort),
    jurisdictionFallback: true,
    note: `No jurisdiction-tagged model found for ${jurisdiction}; showing all eligible models.`,
  };
}

/**
 * Update the API key UI for a slot based on whether the provider has a saved key.
 * If a key exists: show "Using saved key for {provider} · Rotate key"
 * If not: show the inline input, required before Test enables.
 */
function updateKeyUI(which, providerId) {
  const isPrimary = which === "primary";
  const container = document.getElementById(isPrimary ? "aiKeyContainer" : "ai2KeyContainer");
  const keyInput = document.getElementById(isPrimary ? "aiApiKey" : "ai2ApiKey");
  const keySrc = document.getElementById(isPrimary ? "aiKeySrc" : "ai2KeySrc");

  const cred = CREDENTIALS[providerId];
  const hasKey = cred?.hasKey;

  if (hasKey) {
    // Show collapsed "using saved key" with rotate option
    const provider = CATALOG.find((p) => p.id === providerId);
    const providerName = provider ? provider.name : providerId;
    keyInput.style.display = "none";
    keySrc.innerHTML = `<span class='ok'>Using saved key for ${esc(providerName)}</span> · <a href="#" onclick="rotateKey('${which}');return false" style="color:var(--dim)">Rotate key</a>`;
    keyInput.value = "";
  } else {
    // Show inline input
    keyInput.style.display = "";
    keyInput.value = "";
    keyInput.placeholder = "paste your API key";
    keySrc.innerHTML = "<span class='warn'>no key configured</span>";
  }
}

/**
 * Expand the key input for rotation.
 */
function rotateKey(which) {
  const isPrimary = which === "primary";
  const keyInput = document.getElementById(isPrimary ? "aiApiKey" : "ai2ApiKey");
  const keySrc = document.getElementById(isPrimary ? "aiKeySrc" : "ai2KeySrc");
  keyInput.style.display = "";
  keyInput.value = "";
  keyInput.placeholder = "type a new key to replace";
  keyInput.focus();
  keySrc.innerHTML = "<span class='warn'>entering new key…</span>";
}

/**
 * Render jurisdiction-aware suggestion banners.
 * Only shown when suggestions exist AND the slot is unconfigured.
 */
function renderSuggestions(inference) {
  const container = document.getElementById("suggestionBanners");
  if (!container) return;
  let html = "";

  if (SUGGESTIONS.primary && (!inference?.primary)) {
    const s = SUGGESTIONS.primary;
    html += `<div class="panel" style="margin-bottom:7px;padding:10px 14px;border-left:3px solid var(--accent)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="flex:1">
          <b>Suggested for ${esc(ACTIVE_JURISDICTION)}:</b> ${esc(s.providerId)}/${esc(s.modelId)} (primary)
          <div class="hint">${esc(s.reason)}</div>
        </div>
        <button class="act" onclick="applySuggestion('primary','${esc(s.providerId)}','${esc(s.modelId)}')">Use this</button>
        <button class="ghost" onclick="dismissSuggestion('primary')">Dismiss</button>
      </div>
    </div>`;
  }
  if (SUGGESTIONS.secondary && (!inference?.secondary)) {
    const s = SUGGESTIONS.secondary;
    html += `<div class="panel" style="margin-bottom:7px;padding:10px 14px;border-left:3px solid var(--accent)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="flex:1">
          <b>Suggested for ${esc(ACTIVE_JURISDICTION)}:</b> ${esc(s.providerId)}/${esc(s.modelId)} (secondary)
          <div class="hint">${esc(s.reason)}</div>
        </div>
        <button class="act" onclick="applySuggestion('secondary','${esc(s.providerId)}','${esc(s.modelId)}')">Use this</button>
        <button class="ghost" onclick="dismissSuggestion('secondary')">Dismiss</button>
      </div>
    </div>`;
  }
  container.innerHTML = html;
}

/**
 * Apply a suggestion — fills the provider/model as if the user picked it.
 * Does NOT bypass the key-entry step.
 */
async function applySuggestion(slot, providerId, modelId) {
  const sel = document.getElementById(slot === "primary" ? "aiProvider" : "ai2Provider");
  sel.value = providerId;
  sel.dispatchEvent(new Event("change"));
  // Wait for model dropdown to populate, then select the suggested model
  setTimeout(() => {
    const modelSel = document.getElementById(slot === "primary" ? "aiModel" : "ai2Model");
    modelSel.value = modelId;
    modelSel.dispatchEvent(new Event("change"));
  }, 200);
  // Dismiss the banner
  dismissSuggestion(slot);
}

function dismissSuggestion(slot) {
  const banners = document.getElementById("suggestionBanners");
  if (!banners) return;
  // Remove the banner for this slot
  const banner = banners.querySelector(`div:has(button[onclick*="'${slot}'"])`);
  if (banner) banner.remove();
}

/**
 * Update the Vault Summary AI MODELS section.
 */
function updateVaultSummary(inference) {
  const vAi = document.getElementById("vAi");
  const vAi2 = document.getElementById("vAi2");

  if (inference?.primary) {
    const cred = CREDENTIALS[inference.primary.providerId];
    const keyStatus = cred?.hasKey ? "key configured" : "<span style='color:var(--bad)'>no key</span>";
    vAi.innerHTML = `${esc(inference.primary.providerId)}/${esc(inference.primary.modelId)} · ${keyStatus}`;
  } else {
    vAi.innerHTML = "<span style='color:var(--bad)'>no primary model</span>";
  }

  if (inference?.secondary) {
    const cred = CREDENTIALS[inference.secondary.providerId];
    const keyStatus = cred?.hasKey ? "key configured" : "<span style='color:var(--bad)'>no key</span>";
    vAi2.innerHTML = `${esc(inference.secondary.providerId)}/${esc(inference.secondary.modelId)} · ${keyStatus}`;
  } else {
    vAi2.innerHTML = "<span style='color:var(--faint)'>no secondary model</span>";
  }
}

// ── Save inference config ────────────────────────────────────────────────
async function saveAi(which) {
  const msg = document.getElementById(which === "primary" ? "aiMsg" : "ai2Msg");
  const isPrimary = which === "primary";
  const sel = document.getElementById(isPrimary ? "aiProvider" : "ai2Provider");
  const pid = sel.value;

  // Don't auto-save an incomplete Custom provider
  if (pid === "custom") {
    const baseUrl = document.getElementById(isPrimary ? "aiBaseUrl" : "ai2BaseUrl").value.trim();
    if (!baseUrl) return;
  }

  const modelSelect = document.getElementById(isPrimary ? "aiModel" : "ai2Model");
  const modelTextInput = document.getElementById(isPrimary ? "aiModelText" : "ai2ModelText");
  let modelId = "";
  if (pid === "custom" && modelTextInput) {
    modelId = modelTextInput.value.trim();
  } else if (modelSelect.value === "__other__") {
    // Prompt for custom model ID
    modelId = prompt("Enter the model ID:") || "";
    if (!modelId) return;
    // Add it back as a regular option
    modelSelect.innerHTML = modelSelect.innerHTML.replace(
      "<option value='__other__'>Other model ID (advanced)…</option>",
      `<option value="${esc(modelId)}">${esc(modelId)} (user-entered)</option><option value='__other__'>Other model ID (advanced)…</option>`,
    );
    modelSelect.value = modelId;
  } else {
    modelId = modelSelect.value;
  }

  if (!modelId) return;

  const baseUrl = providerBaseUrl(which);
  const keyInput = document.getElementById(isPrimary ? "aiApiKey" : "ai2ApiKey");
  const key = keyInput.value;

  const body = {
    [isPrimary ? "primary" : "secondary"]: {
      providerId: pid,
      modelId,
      ...(pid === "custom" && { baseUrlOverride: baseUrl }),
    },
  };

  // Send API key if the user entered one
  if (key) {
    body.api_key = { providerId: pid, key };
  }

  const r = await apiPost("/v1/settings/inference", body);
  if (r.error) {
    msg.className = "msg bad";
    msg.textContent = "error: " + r.error;
    return;
  }
  msg.className = "msg";
  msg.textContent = "";

  // Update credential state
  if (key) {
    CREDENTIALS[pid] = { providerId: pid, hasKey: true };
    updateKeyUI(which, pid);
  }

  // Update vault summary
  const inference = await api("/v1/settings/inference").catch(() => null);
  updateVaultSummary(inference);
}

// ── Test inference ───────────────────────────────────────────────────────
async function testAi(which) {
  const msg = document.getElementById(which === "primary" ? "aiMsg" : "ai2Msg");
  const vEl = document.getElementById(which === "primary" ? "vAi" : "vAi2");
  msg.className = "msg";
  msg.textContent = "testing…";
  const r = await apiPost("/v1/settings/inference/test", { slot: which });
  if (r.error) {
    msg.className = "msg bad";
    msg.textContent = "error: " + r.error;
    vEl.innerHTML = `<span style='color:var(--bad)'>${esc(r.error)}</span>`;
    return;
  }
  const ok = r.success;
  msg.className = "msg " + (ok ? "ok" : "bad");
  if (ok) {
    const parts = ["Connection successful"];
    if (r.latencyMs) parts.push(r.latencyMs + "ms");
    msg.textContent = parts.join(" · ");
  } else {
    msg.textContent = r.errorExplanation || r.error || "failed";
  }

  // Update vault summary
  const inference = await api("/v1/settings/inference").catch(() => null);
  if (inference) updateVaultSummary(inference);
}

// ── Jurisdiction ─────────────────────────────────────────────────────────
async function saveJur() {
  const msg = document.getElementById("jurMsg");
  msg.className = "msg";
  msg.textContent = "saving…";
  const id = document.getElementById("jurSelect").value;
  const r = await apiPost("/v1/settings", { jurisdiction: id });
  if (r.error) {
    msg.className = "msg bad";
    msg.textContent = "error: " + r.error;
    return;
  }
  msg.className = "msg ok";
  msg.textContent = "saved · reload Settings to see updated suggestions";
  loadSettings();
}

// ── Auto-save ────────────────────────────────────────────────────────────
let saveTimers = {};
function autoSave(which) {
  clearTimeout(saveTimers[which]);
  saveTimers[which] = setTimeout(() => saveAi(which), 600);
}

// ── Event handlers ───────────────────────────────────────────────────────
document.getElementById("aiTest").onclick = () => testAi("primary");
document.getElementById("aiProvider").onchange = () => {
  // Clear the model before saving — the old provider's model must not
  // be saved under the new provider (referential integrity).
  const modelSelect = document.getElementById("aiModel");
  modelSelect.value = "";
  onProviderChange("primary", "");
  const pid = document.getElementById("aiProvider").value;
  currentPrimaryProviderId = pid;
  updateKeyUI("primary", pid);
  // Don't auto-save on provider change alone — wait for the user to
  // pick a model. Saving with an empty modelId would clear the slot.
};
document.getElementById("aiApiKey").onchange = () => autoSave("primary");
document.getElementById("aiModel").onchange = () => {
  if (document.getElementById("aiModel").value === "__other__") return;
  autoSave("primary");
};
document.getElementById("aiBaseUrl").oninput = () => autoSave("primary");

document.getElementById("ai2Test").onclick = () => testAi("secondary");
document.getElementById("ai2Provider").onchange = () => {
  // Clear the model before saving — referential integrity.
  const modelSelect = document.getElementById("ai2Model");
  modelSelect.value = "";
  onProviderChange("secondary", "");
  const pid = document.getElementById("ai2Provider").value;
  currentSecondaryProviderId = pid;
  updateKeyUI("secondary", pid);
};
document.getElementById("ai2ApiKey").onchange = () => autoSave("secondary");
document.getElementById("ai2Model").onchange = () => {
  if (document.getElementById("ai2Model").value === "__other__") return;
  autoSave("secondary");
};
document.getElementById("ai2BaseUrl").oninput = () => autoSave("secondary");

document.getElementById("jurSave").onclick = saveJur;

// ── Custom provider buttons ──────────────────────────────────────────────
document.getElementById("customSavePrimary").onclick = async () => {
  const name = document.getElementById("customName").value.trim();
  const baseUrl = document.getElementById("customBaseUrl").value.trim();
  const modelId = document.getElementById("customModelId").value.trim();
  const msg = document.getElementById("customMsg");
  if (!baseUrl || !modelId) {
    msg.className = "msg bad";
    msg.textContent = "Base URL and Model ID are required";
    return;
  }
  // Select "custom" in the primary dropdown and fill the fields
  document.getElementById("aiProvider").value = "custom";
  document.getElementById("aiBaseUrl").value = baseUrl;
  onProviderChange("primary", modelId);
  const r = await saveAi("primary");
  msg.className = "msg ok";
  msg.textContent = "saved as primary";
};
document.getElementById("customSaveSecondary").onclick = async () => {
  const baseUrl = document.getElementById("customBaseUrl").value.trim();
  const modelId = document.getElementById("customModelId").value.trim();
  const msg = document.getElementById("customMsg");
  if (!baseUrl || !modelId) {
    msg.className = "msg bad";
    msg.textContent = "Base URL and Model ID are required";
    return;
  }
  document.getElementById("ai2Provider").value = "custom";
  document.getElementById("ai2BaseUrl").value = baseUrl;
  onProviderChange("secondary", modelId);
  await saveAi("secondary");
  msg.className = "msg ok";
  msg.textContent = "saved as secondary";
};

// ── Gmail ────────────────────────────────────────────────────────────────
async function gmailAction(action) {
  const msg = document.getElementById("gMsg");
  msg.className = "msg"; msg.textContent = action + "…";
  const endpoint = "/v1/gmail/" + action;
  const body = {};
  if (action === "sync") {
    body.after_date = document.getElementById("gAfterDate").value;
    body.force = document.getElementById("gForce").checked;
  }
  const r = await apiPost(endpoint, body);
  if (r.error) {
    msg.className = "msg bad"; msg.textContent = r.error;
    if (r.detail) msg.textContent += " — " + r.detail;
    return;
  }
  msg.className = "msg ok";
  if (action === "connect") {
    if (r.auth_url) {
      msg.textContent = "Opening authorisation…";
      window.open(r.auth_url, "_blank");
    } else {
      msg.textContent = "connected";
    }
  } else if (action === "sync") {
    msg.textContent = "synced · " + (r.synced ?? r.fetched ?? "done");
  } else if (action === "disconnect") {
    msg.textContent = "disconnected";
  }
  loadSettings();
}
document.getElementById("gConnect").onclick = () => gmailAction("connect");
document.getElementById("gSync").onclick = () => gmailAction("sync");
document.getElementById("gDisconnect").onclick = () => gmailAction("disconnect");

// ── Danger zone: data flush / factory reset ──────────────────────────────
let dangerMode = "";
const dangerBtn = document.getElementById("flushBtn");
const dangerConfirmRow = document.getElementById("dangerConfirmRow");
const dangerConfirmInput = document.getElementById("dangerConfirmInput");
const dangerGoBtn = document.getElementById("dangerGoBtn");
const dangerCancelBtn = document.getElementById("dangerCancelBtn");
const dangerMsg = document.getElementById("flushMsg");

document.querySelectorAll("input[name='dangerMode']").forEach((r) => {
  r.onchange = (e) => {
    dangerMode = e.target.value;
    if (dangerMode === "none") {
      dangerBtn.disabled = true;
      dangerBtn.textContent = "Flush Data";
    } else {
      dangerBtn.disabled = false;
      dangerBtn.textContent = dangerMode === "flush" ? "Flush Data" : "Factory Reset";
    }
    dangerMsg.className = "msg"; dangerMsg.textContent = "";
  };
});

dangerBtn.onclick = () => {
  dangerConfirmRow.style.display = "";
  dangerConfirmInput.value = "";
  dangerGoBtn.disabled = true;
  dangerBtn.style.display = "none";
};

dangerConfirmInput.oninput = () => {
  dangerGoBtn.disabled = dangerConfirmInput.value.trim().toUpperCase() !== "CONFIRM";
};

dangerCancelBtn.onclick = () => {
  dangerConfirmRow.style.display = "none";
  dangerConfirmInput.value = "";
  dangerGoBtn.disabled = true;
  dangerBtn.style.display = "";
};

dangerGoBtn.onclick = async () => {
  dangerMsg.className = "msg"; dangerMsg.textContent = "erasing…";
  dangerGoBtn.disabled = true;
  const endpoint = dangerMode === "flush" ? "/v1/vault/flush" : "/v1/vault/factory-reset";
  const confirmVal = dangerMode === "flush" ? "FLUSH" : "FACTORY_RESET";
  const r = await apiPost(endpoint, { confirm: confirmVal });
  if (r.error) {
    dangerMsg.className = "msg bad"; dangerMsg.textContent = "error: " + r.error;
    dangerGoBtn.disabled = false;
    return;
  }
  dangerMsg.className = "msg ok";
  dangerMsg.textContent = "done · " + (r.rows_deleted ?? 0) + " rows deleted";
  dangerConfirmRow.style.display = "none";
  dangerBtn.style.display = "";
  dangerBtn.disabled = true;
  dangerBtn.textContent = "Flush Data";
};
