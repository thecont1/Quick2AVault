// ── observability: health strip ──────────────────────────────────
async function refreshHealth() {
  const h = await api("/v1/health");
  // Version lives in the footer only, not the header.
  document.getElementById("footer").innerHTML =
    "&copy; " + new Date().getFullYear() + " <a href='https://thecontrarian.in' target='_blank' rel='noopener'>Mahesh Shantaram</a>"
    + " <span style='color:var(--line)'>·</span> " + esc(h.version);
}

// ── observability: money section ─────────────────────────────────
async function refreshMoney() {
  const s = await api("/v1/snapshot?period=" + encodeURIComponent(period));
  document.getElementById("moneyPeriod").textContent = "— " + s.period.label;
  document.getElementById("income").textContent = money(s.income_minor);
  document.getElementById("spend").textContent = money(s.spending_minor);
  document.getElementById("invest").textContent = money(s.investments_net_minor);
  document.getElementById("xfer").textContent = money(s.transfers_minor);
  document.getElementById("incomeN").innerHTML = "<b>" + esc(s.income_documents) + "</b> documents · net of refunds";
  document.getElementById("spendN").innerHTML = "<b>" + esc(s.spending_documents) + "</b> documents · net of refunds";
  document.getElementById("investN").innerHTML = "<b>" + esc(s.investment_documents) + "</b> documents · purchases";

  const ucNote = (arr) => !arr || !arr.length ? "" : arr.map((u) =>
    "<span class='warn'>" + esc(u.currency || "?") + " " + money(u.amount_minor).replace("₹","")
    + " (" + esc(u.transactions) + " txns)</span>").join("  ");
  document.getElementById("incomeSub").innerHTML = ucNote(s.unconverted.income);
  document.getElementById("spendSub").innerHTML = ucNote(s.unconverted.spending);
  document.getElementById("investSub").innerHTML = "";
  document.getElementById("xferSub").innerHTML = ucNote(s.unconverted.transfers);
}

async function showCard(id) {
  selected = id;
  const c = await api("/v1/transactions/" + id + "/evidence");
  const t = c.transaction;
  const docs = (c.evidence || []).map((e) => {
    const refs = e.extraction && e.extraction.reference_ids || {};
    const shared = Object.entries(refs).map(([k, v]) =>
      (c.evidence || []).filter((o) => o.extraction && o.extraction.reference_ids
        && Object.values(o.extraction.reference_ids).includes(v)).length > 1
        ? "<em>" + esc(k) + "=" + esc(v) + "</em>" : esc(k) + "=" + esc(v)).join("  ");
    return "<div class='doc'><div class='fn'>" + esc(e.original_filename) + "</div>"
      + "<div class='rf'>" + esc(e.evidence_role) + " · linked by " + esc(e.linked_by)
      + (e.match_score ? " at " + Number(e.match_score).toFixed(2) : "")
      + (shared ? "<br>" + shared : "") + "</div></div>";
  }).join("");
  const prov = (c.provenance || []).map((p) =>
    esc(p.field) + "=" + esc(p.value) + " [" + esc(p.source) + "]").join("   ");
  document.getElementById("card").innerHTML =
    "<div class='card'><h3>Evidence · " + money(t.amount_minor) + " · "
    + esc(t.counterparty_name || "transfer") + "</h3>" + docs
    + (prov ? "<div class='prov'>" + prov + "</div>" : "")
    + "<div class='sum'>" + esc(c.summary) + "</div></div>";
}

// ── observability: document pipeline ─────────────────────────────
const STATES = [
  { k: "received", label: "Received", cls: "active" },
  { k: "stable", label: "Stable", cls: "active" },
  { k: "hashed", label: "Hashed", cls: "active" },
  { k: "triaged", label: "Triaged", cls: "active" },
  { k: "queued", label: "Queued", cls: "active" },
  { k: "processing", label: "Processing", cls: "active" },
  { k: "complete", label: "Complete", cls: "complete" },
  { k: "failed", label: "Failed", cls: "failed" },
  { k: "duplicate", label: "Duplicate", cls: "duplicate term" },
  { k: "irrelevant", label: "Irrelevant", cls: "irrelevant term" },
  { k: "password_needed", label: "Password", cls: "password_needed" },
];

// Live pipeline counts — updated incrementally from SSE events so the user
// can watch documents move from received → stable → hashed → … → complete
// in real time without waiting for a full refresh.
let pipelineCounts = {};
let pipelineStalled = 0;
// When set, the Documents Browser filters its document list to this pipeline
// state. Clicking the selected cell again clears it.
let pipelineFilter = null;

function renderPipelineBoard() {
  // Dashboard board — not clickable, just a status display.
  const dashHtml = STATES.map((st) => {
    const n = pipelineCounts[st.k] || 0;
    return "<div class='state " + esc(st.cls) + "'><div class='k'>" + esc(st.label) + "</div>"
      + "<div class='v " + (n ? "" : "zero") + "'>" + esc(n) + "</div></div>";
  }).join("") + (pipelineStalled
    ? "<div class='state stalled'><div class='k'>Stalled</div><div class='v'>" + esc(pipelineStalled) + "</div></div>"
    : "");
  const board = document.getElementById("board");
  if (board) board.innerHTML = dashHtml;

  // Documents Browser board — each cell is a clickable filter.
  const reviewHtml = STATES.map((st) => {
    const n = pipelineCounts[st.k] || 0;
    const sel = pipelineFilter === st.k ? " selected" : "";
    return "<div class='state clickable " + esc(st.cls) + sel + "' data-state='" + esc(st.k) + "'>"
      + "<div class='k'>" + esc(st.label) + "</div>"
      + "<div class='v " + (n ? "" : "zero") + "'>" + esc(n) + "</div></div>";
  }).join("") + (pipelineStalled
    ? "<div class='state stalled'><div class='k'>Stalled</div><div class='v'>" + esc(pipelineStalled) + "</div></div>"
    : "");
  const boardReview = document.getElementById("boardReview");
  if (boardReview) {
    boardReview.innerHTML = reviewHtml;
    boardReview.querySelectorAll(".state.clickable").forEach((cell) =>
      cell.onclick = () => {
        const s = cell.dataset.state;
        pipelineFilter = (pipelineFilter === s) ? null : s;
        renderPipelineBoard();
        loadReview();
      });
  }
}

// Apply a PipelineStateChanged event to the live counts and re-render the
// board immediately — this is what makes the numbers tick in real time.
function onPipelineStateChanged(data) {
  if (data.from_state) {
    pipelineCounts[data.from_state] = Math.max(0, (pipelineCounts[data.from_state] || 0) - 1);
  }
  if (data.to_state) {
    pipelineCounts[data.to_state] = (pipelineCounts[data.to_state] || 0) + 1;
  }
  renderPipelineBoard();
}

// A new document arriving increments the "received" counter immediately.
function onDocumentReceived() {
  pipelineCounts["received"] = (pipelineCounts["received"] || 0) + 1;
  renderPipelineBoard();
}

async function refreshPipeline() {
  const intake = await api("/v1/intake/status?limit=100");
  const events = intake.events || [];
  document.getElementById("intakeCount").textContent = events.length + " items";
  // Rebuild counts from the authoritative server state.
  pipelineCounts = {};
  for (const e of events) pipelineCounts[e.processing_state] = (pipelineCounts[e.processing_state] || 0) + 1;
  pipelineStalled = 0;
  for (const e of events) if (e.stalled) pipelineStalled++;
  renderPipelineBoard();

  const box = document.getElementById("intake");
  if (!events.length) { box.innerHTML = "<div class='empty'>No intake events yet.</div>"; return; }
  box.innerHTML = events.map((e) => {
    const state = esc(e.processing_state);
    const err = e.last_error ? "<span class='err'>" + esc(e.last_error) + "</span>" : "";
    const stall = e.stalled ? "  <span class='stall'>STALLED</span>" : "";
    const retry = e.retry_count ? "  · retry " + esc(e.retry_count) : "";
    const docLink = e.document_id ? "  · doc " + esc(String(e.document_id).slice(0, 12)) : "";
    const meta = "<div class='meta'>" + esc(e.kind) + " · " + esc(e.source) + retry
      + docLink + (err ? "  · " + err : "") + stall + "</div>";
    return "<div class='irow'>"
      + "<div><div class='fn'>" + esc(e.filename) + "</div>" + meta + "</div>"
      + "<span class='pill " + state + "'>" + state + "</span>"
      + "<span class='age'>" + ago(e.updated_at || e.created_at) + "</span></div>";
  }).join("");
}

// ── live event stream ────────────────────────────────────────────
const DESC = {
  DocumentReceived:   (e) => "received  " + e.filename,
  DocumentDuplicate:  (e) => "duplicate  " + e.filename + "  (same bytes — ignored)",
  MarkdownReady:      (e) => "converted  " + e.chars + " chars",
  AnalysisComplete:   (e) => "analysed  " + String(e.document_id || "").slice(0, 12),
  TransactionRecorded:(e) => "transaction  " + money(e.amount_minor) + "  " + e.direction,
  MatchProposed:      (e) => "MATCHED  score " + Number(e.score).toFixed(2) + "  → one rupee",
  JobStateChanged:    (e) => e.phase + "  " + e.state,
  PipelineStateChanged: (e) => (e.from_state || "—") + " → " + e.to_state,
};
function push(type, data) {
  // The Live Events feed was removed from the Dashboard. The push function
  // is kept as a no-op so the SSE handler doesn't break — pipeline state
  // changes are handled directly by onPipelineStateChanged/onDocumentReceived.
}

function connect() {
  const es = new EventSource("/v1/events?token=" + encodeURIComponent(TOKEN));
  const dot = document.getElementById("dot");
  es.onopen = () => { dot.className = "dot live"; };
  es.onerror = () => { dot.className = "dot dead"; };
  for (const type of Object.keys(DESC).concat("Ready")) {
    es.addEventListener(type, (m) => {
      let d = {}; try { d = JSON.parse(m.data); } catch {}
      if (type !== "Ready") push(type, d);
      // Pipeline state changes update the board instantly — no debounce —
      // so the user can watch documents flow through the pipeline live.
      if (type === "PipelineStateChanged") onPipelineStateChanged(d);
      else if (type === "DocumentReceived") onDocumentReceived();
      // JobStateChanged is a safety net: if any state change bypasses
      // PipelineStateChanged (e.g. a raw SQL update in the API layer),
      // the job event still fires and we refresh the pipeline counts
      // from the authoritative /v1/intake/status endpoint.
      if (type === "JobStateChanged") {
        clearTimeout(window.__pr);
        window.__pr = setTimeout(() => refreshPipeline(), 300);
      }
      if (["TransactionRecorded", "MatchProposed", "AnalysisComplete",
           "DocumentReceived", "JobStateChanged"].includes(type)) {
        clearTimeout(window.__rt);
        window.__rt = setTimeout(() => { if (activeTab === "obs") refreshObs(); }, 220);
      }
    });
  }
}

async function refreshObs() {
  await Promise.all([refreshHealth(), refreshMoney(), refreshPipeline()]);
}

