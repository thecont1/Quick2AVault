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

// ── Provider grouping ────────────────────────────────────────────────────
const TIER_LABELS = {
  core: "Core",
  regional: "Regional",
  aggregator: "Aggregators",
  local: "Local",
};
const TIER_ORDER = ["core", "regional", "aggregator", "local"];

/**
 * Build the custom provider picker with logos inside the dropdown.
 * Replaces the native <select> with a button + dropdown panel.
 */
function buildProviderDropdown(selectId, currentProviderId) {
  const sel = document.getElementById(selectId);
  const pickerId = selectId === "aiProvider" ? "aiProviderPicker" : "ai2ProviderPicker";
  const picker = document.getElementById(pickerId);
  if (!picker) return;

  const grouped = {};
  for (const p of CATALOG) {
    if (!grouped[p.tier]) grouped[p.tier] = [];
    grouped[p.tier].push(p);
  }

  // Build hidden select options (for compatibility)
  let optHtml = "";
  if (!currentProviderId) optHtml += `<option value="" selected>Select provider…</option>`;
  for (const tier of TIER_ORDER) {
    const providers = (grouped[tier] || []).sort((a, b) => a.name.localeCompare(b.name));
    if (providers.length === 0) continue;
    optHtml += `<optgroup label="${TIER_LABELS[tier]} (${providers.length})">`;
    for (const p of providers) {
      optHtml += `<option value="${esc(p.id)}"${p.id === currentProviderId ? " selected" : ""}>${esc(p.name)}</option>`;
    }
    optHtml += "</optgroup>";
  }
  optHtml += `<optgroup label="Custom"><option value="custom"${currentProviderId === "custom" ? " selected" : ""}>Custom provider…</option></optgroup>`;
  sel.innerHTML = optHtml;

  // Build custom dropdown button
  const current = CATALOG.find((p) => p.id === currentProviderId);
  const currentName = currentProviderId === "custom" ? "Custom provider…" : (current?.name || "Select provider…");
  const currentLogo = current?.logoUrl || "";

  let btnHtml = `<button type="button" class="pp-btn">`;
  if (currentLogo) {
    btnHtml += `<img class="pp-logo" src="${esc(currentLogo)}" width="20" height="20" onerror="this.style.display='none'">`;
  }
  btnHtml += `<span class="pp-name">${esc(currentName)}</span><span class="pp-arrow">▼</span></button>`;

  // Build dropdown panel
  let panelHtml = `<div class="pp-panel">`;
  for (const tier of TIER_ORDER) {
    const providers = (grouped[tier] || []).sort((a, b) => a.name.localeCompare(b.name));
    if (providers.length === 0) continue;
    panelHtml += `<div class="pp-group">${TIER_LABELS[tier]} (${providers.length})</div>`;
    for (const p of providers) {
      const logo = p.logoUrl ? `<img class="pp-opt-logo" src="${esc(p.logoUrl)}" width="18" height="18" onerror="this.style.display='none'">` : "";
      panelHtml += `<div class="pp-opt${p.id === currentProviderId ? " selected" : ""}" data-pid="${esc(p.id)}">${logo}<span class="pp-opt-name">${esc(p.name)}</span></div>`;
    }
  }
  panelHtml += `<div class="pp-group">Custom</div>`;
  panelHtml += `<div class="pp-opt${currentProviderId === "custom" ? " selected" : ""}" data-pid="custom"><span class="pp-opt-name">Custom provider…</span></div>`;
  panelHtml += `</div>`;

  picker.innerHTML = btnHtml + panelHtml;

  // Wire up interactions
  const btn = picker.querySelector(".pp-btn");
  const panel = picker.querySelector(".pp-panel");

  btn.onclick = (e) => {
    e.stopPropagation();
    // Close any other open pickers
    document.querySelectorAll(".pp-panel.open").forEach((p) => { if (p !== panel) p.classList.remove("open"); });
    panel.classList.toggle("open");
  };

  panel.querySelectorAll(".pp-opt").forEach((opt) => {
    opt.onclick = () => {
      const pid = opt.dataset.pid;
      sel.value = pid;
      panel.classList.remove("open");
      sel.dispatchEvent(new Event("change"));
      // Rebuild to update the button
      buildProviderDropdown(selectId, pid);
    };
  });
}

// ── model dropdown with provider logos ──────────────────────────
// models.dev serves provider logos (https://models.dev/logos/{provider}.svg).
// Prefer the .svg form, fall back to the catalog's logoUrl (also models.dev,
// .png), then hide on error. Native <select> cannot render images, so this is
// a custom picker (same pattern as the provider picker); the hidden select
// keeps saveAi/autoSave working unchanged.

function providerLogoUrls(provider) {
  const urls = [];
  if (provider) {
    urls.push("https://models.dev/logos/" + encodeURIComponent(provider.id) + ".svg");
    if (provider.logoUrl && provider.logoUrl !== urls[0]) urls.push(provider.logoUrl);
  }
  return urls;
}

function logoImgHtml(urls, cls, w) {
  if (!urls.length) return "";
  let onerr;
  if (urls.length === 1) {
    onerr = "this.style.display='none'";
  } else {
    const rest = urls.slice(1).map((u) => "'" + u.replace(/'/g, "\\'") + "'");
    onerr = "if(this.dataset.i){this.style.display='none'}else{this.dataset.i='1';this.src=" + rest[0] + "}";
  }
  return `<img class="${cls}" src="${esc(urls[0])}" width="${w}" height="${w}" alt="" onerror="${onerr}">`;
}

// Per-slot state so a programmatic select.value change (e.g. a suggestion
// applied) can rebuild the picker from the same data.
const modelPickerState = { primary: null, secondary: null };

function buildModelDropdown(which, provider, savedModel, models) {
  const isPrimary = which === "primary";
  const sel = document.getElementById(isPrimary ? "aiModel" : "ai2Model");
  const picker = document.getElementById(isPrimary ? "aiModelPicker" : "ai2ModelPicker");
  if (!sel || !picker) return;
  modelPickerState[which] = { provider, savedModel, models };

  const logos = providerLogoUrls(provider);

  // Hidden native select — saveAi / autoSave keep reading .value.
  let optHtml = "";
  if (savedModel && !models.find((m) => m.id === savedModel)) {
    optHtml += `<option value="${esc(savedModel)}" selected>${esc(savedModel)} (saved)</option>`;
  }
  for (const m of models) {
    optHtml += `<option value="${esc(m.id)}"${m.id === savedModel ? " selected" : ""}>${esc(m.displayName)}</option>`;
  }
  optHtml += `<option value="__other__">Other model ID (advanced)…</option>`;
  sel.innerHTML = optHtml;
  if (savedModel) sel.value = savedModel;

  const currentName = savedModel
    ? (models.find((m) => m.id === savedModel)?.displayName || savedModel)
    : (provider ? "select a model…" : "select a provider first");

  let btnHtml = `<button type="button" class="pp-btn">`;
  if (savedModel) btnHtml += logoImgHtml(logos, "pp-logo", 20);
  btnHtml += `<span class="pp-name">${esc(currentName)}</span><span class="pp-arrow">▼</span></button>`;

  let panelHtml = `<div class="pp-panel">`;
  if (!models.length) {
    panelHtml += `<div class="pp-opt" style="cursor:default"><span class="pp-opt-name">No eligible models for this provider in this role</span></div>`;
  } else {
    if (provider) panelHtml += `<div class="pp-group">${esc(provider.name)} models</div>`;
    if (savedModel && !models.find((m) => m.id === savedModel)) {
      panelHtml += `<div class="pp-opt selected" data-mid="${esc(savedModel)}">${logoImgHtml(logos, "pp-opt-logo", 18)}`
        + `<span class="pp-opt-name">${esc(savedModel)}<span class="pp-opt-sub">saved</span></span></div>`;
    }
    for (const m of models) {
      panelHtml += `<div class="pp-opt${m.id === savedModel ? " selected" : ""}" data-mid="${esc(m.id)}">`
        + logoImgHtml(logos, "pp-opt-logo", 18)
        + `<span class="pp-opt-name">${esc(m.displayName)}<span class="pp-opt-sub">${esc(m.id)}</span></span></div>`;
    }
  }
  panelHtml += `<div class="pp-opt" data-other="1"><span class="pp-opt-name">Other model ID (advanced)…</span></div>`;
  panelHtml += `</div>`;

  picker.innerHTML = btnHtml + panelHtml;

  const btn = picker.querySelector(".pp-btn");
  const panel = picker.querySelector(".pp-panel");
  btn.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll(".pp-panel.open").forEach((p) => { if (p !== panel) p.classList.remove("open"); });
    panel.classList.toggle("open");
  };
  picker.querySelectorAll(".pp-opt[data-mid]").forEach((opt) => {
    opt.onclick = () => {
      sel.value = opt.dataset.mid;
      sel.dispatchEvent(new Event("change"));
    };
  });
  const otherOpt = picker.querySelector(".pp-opt[data-other]");
  if (otherOpt) {
    otherOpt.onclick = () => {
      const mid = prompt("Enter the model ID:") || "";
      if (!mid) return;
      sel.value = mid;
      sel.dispatchEvent(new Event("change"));
    };
  }
  // The select's change event rebuilds the picker (panel closes, button
  // resyncs) and autoSave fires exactly as with the native select.
  if (!sel.dataset.pickerBound) {
    sel.dataset.pickerBound = "1";
    sel.addEventListener("change", () => {
      const st = modelPickerState[which];
      if (!st) return;
      buildModelDropdown(which, st.provider, sel.value === "__other__" ? st.savedModel : sel.value, st.models);
    });
  }
}

// Close dropdowns when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".provider-picker")) {
    document.querySelectorAll(".pp-panel.open").forEach((p) => p.classList.remove("open"));
  }
});

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
  // Clear only a genuine cross-provider leak (the saved model id belongs to a
  // DIFFERENT catalog provider). A model id absent from the catalog is a
  // user-entered / legacy id and is preserved.
  if (primProviderId && primProviderId !== "custom" && primModelId) {
    const provider = CATALOG.find((p) => p.id === primProviderId);
    const belongsHere = provider && provider.models.some((m) => m.id === primModelId);
    const belongsElsewhere = CATALOG.some((p) => p.id !== primProviderId && p.models.some((m) => m.id === primModelId));
    if (!belongsHere && belongsElsewhere) primModelId = "";
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
  // Validate referential integrity (same as primary): clear only a genuine
  // cross-provider leak; preserve user-entered / legacy model ids.
  if (secProviderId && secProviderId !== "custom" && secModelId) {
    const provider = CATALOG.find((p) => p.id === secProviderId);
    const belongsHere = provider && provider.models.some((m) => m.id === secModelId);
    const belongsElsewhere = CATALOG.some((p) => p.id !== secProviderId && p.models.some((m) => m.id === secModelId));
    if (!belongsHere && belongsElsewhere) secModelId = "";
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

  // ── Duplicate documents (post-resync maintenance) ──────────────
  loadDuplicates();
}

// ── Duplicate flush ──────────────────────────────────────────────
async function loadDuplicates() {
  const summary = document.getElementById("dupSummary");
  const list = document.getElementById("dupList");
  const btn = document.getElementById("dupFlushBtn");
  if (!summary || !list) return;
  try {
    const d = await api("/v1/maintenance/duplicates");
    const groups = d.groups || [];
    const copies = d.total_copies || 0;
    if (!groups.length) {
      summary.textContent = "No duplicates — clean.";
      list.innerHTML = "";
      if (btn) btn.disabled = true;
      return;
    }
    summary.textContent = copies + " duplicate copies across " + groups.length + " groups. Re-delivered attachments (e.g. after a hard Gmail resync) land here; originals stay untouched.";
    list.innerHTML = groups.map((g) =>
      "<div class='irow'>"
      + "<div><div class='fn'>" + esc(g.original_filename || (g.files[0] || {}).filename || "unknown") + "</div>"
      + "<div class='meta'>" + esc(String(g.sha256).slice(0, 12)) + "… · " + g.copies + " cop" + (g.copies > 1 ? "ies" : "y")
      + (g.document_id ? "" : " · <span class='err'>no live document</span>") + "</div></div>"
      + "<span class='pill archived'>duplicate</span>"
      + "<span class='age'>" + ago((g.files[0] || {}).created_at) + "</span></div>"
    ).join("");
    if (btn) btn.disabled = false;
  } catch (e) {
    summary.textContent = "could not load duplicates: " + String(e.message || e);
  }
}

document.getElementById("dupFlushBtn").onclick = async () => {
  const msg = document.getElementById("dupMsg");
  const btn = document.getElementById("dupFlushBtn");
  const policy = (document.querySelector('input[name="dupPolicy"]:checked') || {}).value || "keep_originals";
  const what = policy === "promote_newest"
    ? "Archived duplicates will be deleted AND every affected document will be re-processed with the current models."
    : "Archived duplicate files will be deleted. Original documents are untouched.";
  if (!confirm("Flush duplicate documents?\n\n" + what)) return;
  btn.disabled = true;
  msg.className = "msg";
  msg.textContent = "Flushing…";
  try {
    const r = await apiPost("/v1/maintenance/flush-duplicates", { policy, confirm: "FLUSH" });
    if (r && r.error) throw new Error(r.message || r.error);
    msg.className = "msg ok";
    msg.textContent = "Flushed " + (r.copies || 0) + " copies across " + (r.groups || 0) + " groups · "
      + (r.deleted_files || 0) + " files deleted"
      + (r.reprocessed ? " · re-processing " + r.reprocessed + " documents" : "");
    loadDuplicates();
    if (typeof refreshPipeline === "function") refreshPipeline();
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = "Failed: " + String(e.message || e);
  }
  btn.disabled = false;
};

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
    const pickerEl = document.getElementById(isPrimary ? "aiModelPicker" : "ai2ModelPicker");
    if (pickerEl) pickerEl.style.display = "none";
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

  // Catalog provider: the native select stays hidden; the custom picker
  // (with provider logos) is the visible control.
  modelSelect.style.display = "none";
  const modelInput = document.getElementById(isPrimary ? "aiModelText" : "ai2ModelText");
  if (modelInput) modelInput.style.display = "none";

  if (!provider) {
    modelSelect.innerHTML = "<option value=''>select a provider first</option>";
    modelSelect.disabled = true;
    const pickerEl = document.getElementById(isPrimary ? "aiModelPicker" : "ai2ModelPicker");
    if (pickerEl) { pickerEl.style.display = ""; buildModelDropdown(which, null, "", []); }
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
    const pickerEl = document.getElementById(isPrimary ? "aiModelPicker" : "ai2ModelPicker");
    if (pickerEl) { pickerEl.style.display = ""; buildModelDropdown(which, provider, "", []); }
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
    html += `<option value="${esc(m.id)}"${selected}>${esc(m.displayName)}</option>`;
  }
  // "Other model ID (advanced)" — always at the bottom
  html += `<option value="__other__">Other model ID (advanced)…</option>`;
  modelSelect.innerHTML = html;
  if (savedModel) modelSelect.value = savedModel;
  const pickerEl = document.getElementById(isPrimary ? "aiModelPicker" : "ai2ModelPicker");
  if (pickerEl) { pickerEl.style.display = ""; buildModelDropdown(which, provider, savedModel, result.models); }

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

  const trustRank = { verified: 0, community: 1, unverified: 2 };
  const trustSort = (a, b) => {
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
    // Insert it before the "__other__" entry, which stays at the bottom.
    // (Rewriting innerHTML doesn't work — the browser normalises the single
    // quotes to double quotes, so the string replace never matches.)
    const otherOpt = modelSelect.querySelector("option[value='__other__']");
    const newOpt = new Option(modelId + " (user-entered)", modelId);
    modelSelect.insertBefore(newOpt, otherOpt);
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
