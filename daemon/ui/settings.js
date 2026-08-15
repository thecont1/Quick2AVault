// ════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ════════════════════════════════════════════════════════════════════════

// Known LLM providers. The user picks one from a dropdown; the base URL is
// set automatically. "Custom" lets them type their own.
// Alphabetical by name (Custom forced to last).
const PROVIDERS = [
  { id: "alibaba",    name: "Alibaba Cloud",       baseUrl: "https://dashscope-intl.aliyuncs.com/api/v1" },
  { id: "anthropic",  name: "Anthropic",           baseUrl: "https://api.anthropic.com/v1" },
  { id: "groq",       name: "Groq",                baseUrl: "https://api.groq.com/openai/v1" },
  { id: "kimi",       name: "Kimi (Moonshot AI)",  baseUrl: "https://api.moonshot.ai/v1" },
  { id: "minimax",    name: "MiniMax",             baseUrl: "https://api.minimax.io/v1" },
  { id: "mimo",       name: "MiMo (Xiaomi)",       baseUrl: "https://api.xiaomimimo.com/v1" },
  { id: "openai",     name: "OpenAI",              baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter",          baseUrl: "https://openrouter.ai/api/v1" },
  { id: "perplexity", name: "Perplexity",          baseUrl: "https://api.perplexity.ai/v1" },
  { id: "poolside",   name: "Poolside",            baseUrl: "https://inference.poolside.ai/v1" },
  { id: "together",   name: "Together AI",         baseUrl: "https://api.together.ai/v1" },
  { id: "custom",     name: "Custom",              baseUrl: "" },
];

function providerIdForBaseUrl(baseUrl) {
  const p = PROVIDERS.find((p) => p.baseUrl && p.baseUrl === baseUrl);
  return p ? p.id : (baseUrl ? "custom" : "");
}

function fillProviderDropdown(selectId, currentBaseUrl) {
  const sel = document.getElementById(selectId);
  const currentId = providerIdForBaseUrl(currentBaseUrl);
  sel.innerHTML = PROVIDERS.map((p) =>
    "<option value='" + esc(p.id) + "'" + (p.id === currentId ? " selected" : "") + ">"
    + esc(p.name) + "</option>").join("");
}

// The masked key shown in the text box (first4*******last4). Stored at load
// time so saveAi can detect when the user hasn't touched the field.
let primaryKeyMask = "";
let secondaryKeyMask = "";
// Per-provider key inventory from the backend: { openai: { set: true, mask: "..." }, ... }
let providerKeys = {};
let secondaryProviderKeys = {};
// Track the current provider IDs so we can save keys per-provider on switch.
let currentPrimaryProviderId = "";
let currentSecondaryProviderId = "";

async function loadSettings() {
  const s = await api("/v1/settings");
  const ai = s.ai || {};

  // Store per-provider key inventory for swapping keys on provider change.
  providerKeys = ai.provider_keys || {};
  secondaryProviderKeys = ai.provider_keys || {};

  // Primary provider
  fillProviderDropdown("aiProvider", ai.base_url || "");
  currentPrimaryProviderId = document.getElementById("aiProvider").value;
  document.getElementById("aiBaseUrl").value = ai.base_url || "";
  toggleCustomUrl("primary");
  document.getElementById("aiKeySrc").innerHTML = ai.api_key_set
    ? "<span class='ok'>key set via " + esc(ai.api_key_source) + "</span>"
    : "<span class='warn'>no key configured</span>";
  primaryKeyMask = ai.api_key_mask || "";
  const aiKeyInput = document.getElementById("aiApiKey");
  aiKeyInput.value = primaryKeyMask;
  aiKeyInput.placeholder = ai.api_key_set ? "type a new key to replace" : "paste your API key";
  // Model is a text input with a datalist of fetched models. Show the saved
  // model as the value; the datalist is populated by autoFetchModels.
  document.getElementById("aiModel").value = ai.model || "";

  // Secondary provider
  const sec = ai.secondary || {};
  fillProviderDropdown("ai2Provider", sec.base_url || "");
  currentSecondaryProviderId = document.getElementById("ai2Provider").value;
  document.getElementById("ai2BaseUrl").value = sec.base_url || "";
  toggleCustomUrl("secondary");
  secondaryKeyMask = sec.api_key_mask || "";
  document.getElementById("ai2KeySrc").innerHTML = sec.api_key_set
    ? "<span class='ok'>key set via " + esc(sec.api_key_source || "keychain") + "</span>"
    : "<span class='warn'>no key configured</span>";
  const ai2KeyInput = document.getElementById("ai2ApiKey");
  ai2KeyInput.value = secondaryKeyMask;
  ai2KeyInput.placeholder = sec.api_key_set ? "type a new key to replace" : "paste your API key";
  document.getElementById("ai2Model").value = sec.model || "";

  // Auto-fetch model lists for the selected providers (silent — the user can
  // still type a model manually if the fetch fails).
  autoFetchModels("primary");
  autoFetchModels("secondary");

  // Jurisdiction
  const jur = s.jurisdiction || {};
  const sel = document.getElementById("jurSelect");
  sel.innerHTML = (jur.available || []).map((p) =>
    "<option value='" + esc(p.id) + "'" + (p.id === jur.id ? " selected" : "") + ">"
    + esc(p.name) + " (" + esc(p.id) + " v" + esc(p.version) + ")</option>").join("");
  document.getElementById("jurInfo").innerHTML =
    "Currency <b>" + esc(jur.currency) + "</b> · FY " + esc(jur.fy_label)
    + " · dates " + esc(jur.date_format) + " · grouping " + esc(jur.grouping);

  // Vault
  const v = s.vault || {};
  document.getElementById("vRoot").textContent = v.root || "—";
  document.getElementById("vDrop").textContent = v.drop || "—";
  document.getElementById("vDb").textContent = v.db || "—";
  // Initial state — testAi will update these with the real result.
  document.getElementById("vAi").innerHTML = ai.active_model
    ? "<span style='color:var(--faint)'>testing " + esc(ai.active_model) + "…</span>"
    : "<span style='color:var(--bad)'>no primary model</span>";
  document.getElementById("vAi2").innerHTML = sec.model
    ? "<span style='color:var(--faint)'>testing " + esc(sec.model) + "…</span>"
    : "<span style='color:var(--faint)'>no secondary model</span>";

  // Gmail
  const g = s.gmail || {};
  document.getElementById("gAddr").textContent = g.address || "not configured";
  document.getElementById("gStatus").textContent = g.status || "—";
  // Default the date picker to today if the user hasn't set it yet.
  const gDate = document.getElementById("gAfterDate");
  if (!gDate.value) gDate.value = new Date().toISOString().slice(0, 10);

  // Auto-test both inference providers so the user sees a green/red status
  // the moment they open Settings — no need to click Test manually.
  testAi("primary");
  testAi("secondary");
}

function providerBaseUrl(which) {
  const sel = document.getElementById(which === "primary" ? "aiProvider" : "ai2Provider");
  const p = PROVIDERS.find((p) => p.id === sel.value);
  if (!p) return "";
  if (p.id === "custom") {
    const input = document.getElementById(which === "primary" ? "aiBaseUrl" : "ai2BaseUrl");
    return input.value.trim();
  }
  return p.baseUrl;
}

function toggleCustomUrl(which) {
  const sel = document.getElementById(which === "primary" ? "aiProvider" : "ai2Provider");
  const row = document.getElementById(which === "primary" ? "aiCustomUrlRow" : "ai2CustomUrlRow");
  row.style.display = sel.value === "custom" ? "" : "none";
}

async function autoFetchModels(which) {
  const baseUrl = providerBaseUrl(which);
  if (!baseUrl) return;
  const list = document.getElementById(which === "primary" ? "aiModelList" : "ai2ModelList");
  const keyInput = document.getElementById(which === "primary" ? "aiApiKey" : "ai2ApiKey");
  const key = keyInput.value;
  const mask = which === "primary" ? primaryKeyMask : secondaryKeyMask;
  // If the user hasn't changed the mask, send empty string — the backend will
  // use the stored key from the secret store.
  const apiKey = key && key !== mask ? key : "";
  try {
    const r = await apiPost("/v1/settings/models", { base_url: baseUrl, api_key: apiKey });
    if (r.error) return;
    const models = r.models || [];
    list.innerHTML = models.map((m) => "<option value='" + esc(m) + "'>").join("");
  } catch { /* silent — the user can still type a model manually */ }
}

async function saveAi(which) {
  const msg = document.getElementById(which === "primary" ? "aiMsg" : "ai2Msg");
  const baseUrl = providerBaseUrl(which);
  const model = document.getElementById(which === "primary" ? "aiModel" : "ai2Model").value.trim();
  // Don't auto-save an incomplete Custom provider — the user is still typing
  // the URL. Saving an empty base_url would clobber the previous config and
  // cause spurious test errors.
  const sel = document.getElementById(which === "primary" ? "aiProvider" : "ai2Provider");
  if (sel.value === "custom" && !baseUrl) return;
  const keyInput = document.getElementById(which === "primary" ? "aiApiKey" : "ai2ApiKey");
  const key = keyInput.value;
  const mask = which === "primary" ? primaryKeyMask : secondaryKeyMask;
  const body = {};
  // Use the tracked provider ID (not sel.value) so that when the user
  // switches providers, the old provider's key is saved under the old ID
  // before the new provider's key is loaded.
  const pid = which === "primary" ? (currentPrimaryProviderId || sel.value) : (currentSecondaryProviderId || sel.value);
  if (which === "primary") {
    body.base_url = baseUrl;
    body.model = model;
    body.api_key_provider = pid;
    if (key && key !== mask) body.api_key = key;
    else if (!key) body.api_key = "";
  } else {
    body.secondary_base_url = baseUrl;
    body.secondary_model = model;
    body.secondary_api_key_provider = pid;
    if (key && key !== mask) body.secondary_api_key = key;
    else if (!key) body.secondary_api_key = "";
  }
  const r = await apiPost("/v1/settings", body);
  if (r.error) { msg.className = "msg bad"; msg.textContent = "error: " + r.error; return; }
  // Silent on success — auto-save doesn't need a "saved" flash. The Test
  // button is the user's confirmation that the setting works.
  // Do NOT call loadSettings() here — it would rebuild the dropdowns and
  // clobber the user's in-progress edits (e.g. selecting Custom).
  msg.className = "msg"; msg.textContent = "";
}

async function testAi(which) {
  const msg = document.getElementById(which === "primary" ? "aiMsg" : "ai2Msg");
  const vEl = document.getElementById(which === "primary" ? "vAi" : "vAi2");
  msg.className = "msg"; msg.textContent = "testing…";
  const r = await apiPost("/v1/settings/provider-test", { which });
  if (r.error) {
    msg.className = "msg bad"; msg.textContent = "error: " + r.error;
    vEl.innerHTML = "<span style='color:var(--bad)'>" + esc(r.model || "?") + " · " + esc(r.error) + "</span>";
    return;
  }
  const ok = r.reachable && r.authenticated && r.model_available;
  msg.className = "msg " + (ok ? "ok" : "bad");
  const parts = [];
  parts.push(r.reachable ? "reachable" : "unreachable");
  parts.push(r.authenticated ? "auth ok" : "auth failed");
  parts.push(r.model_available ? "model ok" : "model unavailable");
  if (r.latency_ms) parts.push(r.latency_ms + "ms");
  if (r.vision) parts.push("vision");
  if (r.structured_output) parts.push("structured");
  msg.textContent = parts.join(" · ");
  // Update the Vault summary with the real test result.
  vEl.innerHTML = ok
    ? "<span style='color:var(--ok)'>" + esc(r.model || "?") + " · available</span>"
    : "<span style='color:var(--bad)'>" + esc(r.model || "?") + " · " + parts.slice(1).join(", ") + "</span>";
}

async function saveJur() {
  const msg = document.getElementById("jurMsg");
  msg.className = "msg"; msg.textContent = "saving…";
  const id = document.getElementById("jurSelect").value;
  const r = await apiPost("/v1/settings", { jurisdiction: id });
  if (r.error) { msg.className = "msg bad"; msg.textContent = "error: " + r.error; return; }
  msg.className = "msg ok";
  msg.textContent = "saved · restart the daemon for the jurisdiction change to take full effect";
  loadSettings();
}

// Auto-save: any change to provider, API key, model, or custom URL saves
// immediately. A debounce on the model text input prevents saving on every
// keystroke — only after the user stops typing for 600ms.
let saveTimers = {};
function autoSave(which) {
  clearTimeout(saveTimers[which]);
  saveTimers[which] = setTimeout(() => saveAi(which), 600);
}

// When the user switches providers, swap the API key field to show the new
// provider's saved key (or empty if none). The old provider's key was already
// saved by autoSave on the previous change.
function swapProviderKey(which) {
  const sel = document.getElementById(which === "primary" ? "aiProvider" : "ai2Provider");
  const newPid = sel.value;
  const keys = which === "primary" ? providerKeys : secondaryProviderKeys;
  const keyField = document.getElementById(which === "primary" ? "aiApiKey" : "ai2ApiKey");
  const keySrc = document.getElementById(which === "primary" ? "aiKeySrc" : "ai2KeySrc");
  const lookupKey = which === "primary" ? newPid : `secondary:${newPid}`;
  const entry = keys[lookupKey];
  if (entry && entry.set) {
    const mask = entry.mask || "********";
    keyField.value = mask;
    if (which === "primary") primaryKeyMask = mask;
    else secondaryKeyMask = mask;
    keySrc.innerHTML = "<span class='ok'>key set via keychain</span>";
    keyField.placeholder = "type a new key to replace";
  } else {
    keyField.value = "";
    if (which === "primary") primaryKeyMask = "";
    else secondaryKeyMask = "";
    keySrc.innerHTML = "<span class='warn'>no key configured</span>";
    keyField.placeholder = "paste your API key";
  }
  if (which === "primary") currentPrimaryProviderId = newPid;
  else currentSecondaryProviderId = newPid;
}

document.getElementById("aiTest").onclick = () => testAi("primary");
document.getElementById("aiProvider").onchange = () => {
  // Save the old provider's key first, then swap to the new provider's key.
  saveAi("primary");
  toggleCustomUrl("primary");
  swapProviderKey("primary");
  autoFetchModels("primary");
  autoSave("primary");
};
document.getElementById("aiApiKey").onchange = () => autoSave("primary");
document.getElementById("aiModel").oninput = () => autoSave("primary");
document.getElementById("aiBaseUrl").oninput = () => autoSave("primary");
document.getElementById("ai2Test").onclick = () => testAi("secondary");
document.getElementById("ai2Provider").onchange = () => {
  saveAi("secondary");
  toggleCustomUrl("secondary");
  swapProviderKey("secondary");
  autoFetchModels("secondary");
  autoSave("secondary");
};
document.getElementById("ai2ApiKey").onchange = () => autoSave("secondary");
document.getElementById("ai2Model").oninput = () => autoSave("secondary");
document.getElementById("ai2BaseUrl").oninput = () => autoSave("secondary");
document.getElementById("jurSave").onclick = saveJur;

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

// ── danger zone: data flush / factory reset ────────────────────────
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
  document.querySelectorAll("input[name='dangerMode']").forEach((r) => r.checked = false);
  dangerMode = "";
  loadSettings();
  if (activeTab === "obs") refreshObs();
};

