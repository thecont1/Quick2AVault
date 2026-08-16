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
let pipelineDocCounts = {};
let pipelineStalled = 0;
// When set, the Documents Browser filters its document list to this pipeline
// state. Clicking the selected cell again clears it.
let pipelineFilter = null;

// Document Pipeline — rendered as a flowchart: documents travel along the
// main chain (received → … → complete) and branch to terminal states.
const FLOW_MAIN = ["received", "stable", "hashed", "triaged", "converting", "analysing", "complete"];
const FLOW_BRANCH = ["failed", "duplicate", "irrelevant", "password_needed"];
const FLOW_STATE = {
  received: { label: "Received", cls: "" },
  stable: { label: "Stable", cls: "" },
  hashed: { label: "Hashed", cls: "" },
  triaged: { label: "Triaged", cls: "active" },
  converting: { label: "Converting", cls: "active" },
  analysing: { label: "Analysing", cls: "active" },
  complete: { label: "Complete", cls: "complete" },
  failed: { label: "Failed", cls: "failed" },
  duplicate: { label: "Duplicate", cls: "duplicate term" },
  irrelevant: { label: "Irrelevant", cls: "irrelevant term" },
  password_needed: { label: "Password", cls: "password_needed" },
};

function renderPipelineBoard() {
  // Dashboard board — the flowchart. Each step is a clickable Document
  // Scope selector and the counters tick live as documents flow through.
  const flowStep = (k) => {
    const st = FLOW_STATE[k] || { label: k, cls: "" };
    const n = pipelineDocCounts[k] || 0;
    const sel = docScope.state === k ? " selected" : "";
    return "<div class='fstep " + esc(st.cls) + sel + "' data-state='" + esc(k) + "'>"
      + "<div class='k'>" + esc(st.label) + "</div>"
      + "<div class='v " + (n ? "" : "zero") + "'>" + esc(n) + "</div></div>";
  };
  const arrow = () => "<div class='farrow'>→</div>";
  const mainHtml = FLOW_MAIN.map(flowStep).join(arrow());
  const branchHtml = FLOW_BRANCH.map(flowStep).join(arrow());
  const stalledHtml = pipelineStalled
    ? "<div class='stalled-chip'>⚠ " + esc(pipelineStalled) + " stalled</div>"
    : "";
  const board = document.getElementById("board");
  if (board) {
    board.innerHTML = stalledHtml
      + "<div class='flow-main'>" + mainHtml + "</div>"
      + "<div class='flow-branch'>" + branchHtml + "</div>";
    board.querySelectorAll(".fstep").forEach((cell) =>
      cell.onclick = () => setStateScope(cell.dataset.state));
  }

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
    pipelineDocCounts[data.from_state] = Math.max(0, (pipelineDocCounts[data.from_state] || 0) - 1);
  }
  if (data.to_state) {
    pipelineCounts[data.to_state] = (pipelineCounts[data.to_state] || 0) + 1;
    pipelineDocCounts[data.to_state] = (pipelineDocCounts[data.to_state] || 0) + 1;
  }
  renderPipelineBoard();
}

// A new document arriving increments the "received" counter immediately.
function onDocumentReceived() {
  pipelineCounts["received"] = (pipelineCounts["received"] || 0) + 1;
  pipelineDocCounts["received"] = (pipelineDocCounts["received"] || 0) + 1;
  renderPipelineBoard();
}

// ── Document Scope ──────────────────────────────────────────────
// The left column is the live document list. Every cell in the dashboard —
// period buttons, money heroes, pipeline state cells — narrows its scope,
// and clicking a document opens the viewing/editing screen in the Documents
// Browser. Live movement: a document entering the system visibly ticks the
// pipeline counters down to Complete / Failed / Duplicate via SSE.
let docScope = { state: null, bucket: null };

// Money heroes — click to scope documents by their linked bucket.
document.querySelectorAll("#tab-obs .hero.click").forEach((h) =>
  h.onclick = () => setBucketScope(h.dataset.bucket));

function setStateScope(k) {
  docScope.state = docScope.state === k ? null : k;
  renderPipelineBoard();
  renderScopeList();
}

function setBucketScope(b) {
  docScope.bucket = docScope.bucket === b ? null : b;
  document.querySelectorAll("#tab-obs .hero.click").forEach((h) =>
    h.classList.toggle("sel", h.dataset.bucket === docScope.bucket));
  renderScopeList();
}

function scopeLabel() {
  const parts = [];
  if (docScope.state) parts.push((STATES.find((s) => s.k === docScope.state) || {}).label || docScope.state);
  if (docScope.bucket) parts.push(docScope.bucket);
  return parts.length ? parts.join(" · ") : "All documents";
}

async function renderScopeList() {
  const box = document.getElementById("scopeList");
  if (!box) return;
  const url = "/v1/documents?limit=500&sort=received"
    + "&period=" + encodeURIComponent(period)
    + (docScope.state ? "&state=" + encodeURIComponent(docScope.state) : "")
    + (docScope.bucket ? "&bucket=" + encodeURIComponent(docScope.bucket) : "");
  let d;
  try {
    d = await api(url);
  } catch {
    box.innerHTML = "<div class='empty'>could not load documents.</div>";
    return;
  }
  const docs = d.documents || [];
  const label = document.getElementById("scopeLabel");
  if (label) {
    const stateLabel = d.period && d.period.label ? d.period.label + " · " : "";
    label.textContent = stateLabel + scopeLabel() + " · " + docs.length
      + " document" + (docs.length === 1 ? "" : "s");
  }
  if (!docs.length) {
    box.innerHTML = "<div class='empty'>No documents in this scope."
      + (docScope.state === "duplicate" || docScope.state === "irrelevant"
        ? " Duplicate and irrelevant copies are intake items, not documents — flush duplicates from Settings."
        : "")
      + "</div>";
    return;
  }
  box.innerHTML = docs.map((x) => {
    const dt = String(x.invoice_date || x.received_at || "").slice(0, 10);
    return "<div class='drow' data-id='" + esc(x.id) + "'>"
      + "<div><div class='fn'>" + esc(x.original_filename) + "</div>"
      + "<div class='meta'>" + esc(x.merchant || "Unidentified") + " · " + esc(x.doc_type || "unknown")
      + (x.pipeline_state ? " · " + esc(x.pipeline_state) : "") + "</div></div>"
      + "<span class='kind'>" + esc(x.source || "") + "</span>"
      + "<span class='dt'>" + esc(dt) + "</span></div>";
  }).join("");
  box.querySelectorAll(".drow").forEach((el) =>
    el.onclick = () => openDocumentDirect(el.dataset.id));
}

async function refreshPipeline() {
  // Pipeline counters come from the authoritative whole-table intake
  // state; the Document Scope list refetches per the active scope.
  const intake = await api("/v1/intake/status?limit=20&offset=0");
  pipelineCounts = {};
  const counts = intake.counts || {};
  for (const k of Object.keys(counts)) pipelineCounts[k] = counts[k];
  pipelineDocCounts = intake.pipeline_counts || {};
  pipelineStalled = intake.stalled || 0;
  renderPipelineBoard();
  renderScopeList();
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
  es.onopen = () => { dot.className = "dot live"; dot.title = "Live — connected to daemon"; };
  es.onerror = () => { dot.className = "dot dead"; dot.title = "Disconnected — trying to reconnect…"; };
  for (const type of Object.keys(DESC).concat("Ready")) {
    es.addEventListener(type, (m) => {
      let d = {}; try { d = JSON.parse(m.data); } catch {}
      if (type !== "Ready") push(type, d);
      // Pipeline state changes update the board instantly — no debounce —
      // so the user can watch documents flow through the pipeline live.
      if (type === "PipelineStateChanged") {
        onPipelineStateChanged(d);
        // Refresh the open document detail so the user sees reprocessing
        // progress (state transitions, new analysis results).
        if (typeof refreshOpenDocIfMatch === "function") refreshOpenDocIfMatch(d.document_id);
      }
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

