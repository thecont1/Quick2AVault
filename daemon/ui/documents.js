// ════════════════════════════════════════════════════════════════════════
// DOCUMENTS REVIEW TAB
// ════════════════════════════════════════════════════════════════════════
async function loadReview() {
  // Refresh the pipeline board so it's populated when the user switches to
  // this tab — SSE events keep it live thereafter.
  refreshPipeline();
  renderPeriodsReview();
  // Collapse any inline expansion before re-rendering the list — the row
  // elements are about to be replaced, so a dangling detail slot would
  // reference a removed card.
  collapseOpenDoc();
  let url = "/v1/documents?period=" + encodeURIComponent(period) + "&limit=500";
  if (pipelineFilter) url += "&state=" + encodeURIComponent(pipelineFilter);
  const d = await api(url);
  const docs = d.documents || [];
  const label = (d.period && d.period.label) ? d.period.label : "all time";
  const dp = document.getElementById("docPeriod");
  if (dp) dp.textContent = "— " + label;
  const stateLabel = pipelineFilter
    ? (STATES.find((s) => s.k === pipelineFilter) || {}).label || pipelineFilter
    : null;
  document.getElementById("docCount").textContent = "· " + docs.length + " documents"
    + (stateLabel ? " · filtered: " + stateLabel : "");

  if (!docs.length) {
    document.getElementById("docList").innerHTML = "<div class='empty'>No documents in this period.</div>";
    return;
  }

  // The API already sorts by merchant ASC, invoice_date DESC. Group by
  // merchant so each group has a header with a count, and the documents
  // within are newest invoice date first.
  let lastMerchant = null;
  let html = "";
  for (const x of docs) {
    const merchant = x.merchant || "Unidentified";
    if (merchant !== lastMerchant) {
      if (lastMerchant !== null) html += "</div>";
      const groupDocs = docs.filter((y) => (y.merchant || "Unidentified") === merchant);
      html += "<div class='dgroup'><h4>" + esc(merchant)
        + " <span class='n'>· " + groupDocs.length + " document" + (groupDocs.length === 1 ? "" : "s") + "</span></h4>";
      lastMerchant = merchant;
    }
    const invDate = String(x.invoice_date || x.received_at || "").slice(0, 10);
    html +=
      "<div class='drow' data-id='" + esc(x.id) + "'>"
      + "<div><div class='fn'>" + esc(x.original_filename) + "</div>"
      + "<div class='meta'>" + esc(x.doc_type || "unknown") + " · " + esc(x.ext || "")
      + " · " + esc(x.markdown_chars || 0) + " chars · " + esc(x.lifecycle) + "</div></div>"
      + "<span class='kind'>" + esc(x.source) + "</span>"
      + "<span class='dt'>" + esc(invDate) + "</span></div>";
  }
  if (lastMerchant !== null) html += "</div>";
  document.getElementById("docList").innerHTML = html;
  document.querySelectorAll("#docList .drow").forEach((el) =>
    el.onclick = () => toggleDoc(el, el.dataset.id));
}

// Collapse any open document card, then expand the clicked one — or collapse
// it if it's already open. The detail renders inline below the card so the
// user doesn't have to scroll to the bottom of the page.
let openDocRow = null;
function collapseOpenDoc() {
  if (!openDocRow) return;
  openDocRow.classList.remove("open");
  const next = openDocRow.nextElementSibling;
  if (next && next.classList.contains("drow-detail")) next.remove();
  openDocRow = null;
}
function toggleDoc(row, id) {
  if (openDocRow === row) { collapseOpenDoc(); return; }
  collapseOpenDoc();
  row.classList.add("open");
  const slot = document.createElement("div");
  slot.className = "drow-detail";
  slot.innerHTML = "<div class='empty'>loading…</div>";
  row.after(slot);
  openDocRow = row;
  showDoc(id, slot);
}

async function showDoc(id, container) {
  const d = await api("/v1/documents/" + encodeURIComponent(id) + "/detail");
  const doc = d.document || {};
  const x = d.extraction || {};
  const parties = d.parties || [];
  const txns = d.transactions || [];
  const eff = d.effective || {};
  const editableFields = d.editable_fields || [];
  const pipelineState = d.pipeline_state;

  // Load vocabularies for dropdown editing.
  let vocab = {};
  try { vocab = await api("/v1/vocabularies"); } catch {}

  const partiesHtml = parties.map((p) =>
    "<div class='rule'><span class='k'>" + esc(p.role) + "</span>"
    + "<span class='v'>" + esc(p.display_name) + " <span style='color:var(--faint)'>· " + esc(p.kind) + " · " + esc(p.status) + "</span></span>"
    + "</div>").join("");
  const txnsHtml = txns.map((t) =>
    "<div class='rule'><span class='k'>" + esc(t.direction) + "</span>"
    + "<span class='v'>" + money(t.amount_minor) + " " + esc(t.currency || "")
    + " · " + esc(t.counterparty_name || "transfer")
    + " <span style='color:var(--faint)'>· " + esc(t.evidence_role) + " · " + esc(t.linked_by) + "</span></span>"
    + "<span class='n'>" + esc(String(t.occurred_at || "").slice(0, 10)) + "</span></div>").join("");

  // Render effective fields as editable rows. Fields in editableFields get
  // a click-to-edit handler; fields with a vocabulary (doc_type, financial_impact)
  // get a dropdown; others get a text input.
  const FIELD_LABELS = {
    doc_type: "Doc Type", amount_minor: "Amount", currency: "Currency",
    document_date: "Invoice Date", posted_at: "Posted At",
    counterparty: "Counterparty", person: "Person",
    financial_impact: "Impact Bucket", issuer: "Issuer", vendor: "Vendor",
    document_number: "Doc Number", financial_year: "FY",
    category: "Category", purpose_text: "Purpose",
  };
  const DROPDOWN_FIELDS = {
    doc_type: vocab.document_types || [],
    financial_impact: vocab.impact_buckets || [],
    currency: ["INR", "USD", "EUR", "GBP", "SGD", "AED"],
  };

  const effEntries = Object.entries(eff).filter(([, v]) => v && v.value !== null && v.value !== undefined);
  const effRows = effEntries.map(([k, v]) => {
    const label = FIELD_LABELS[k] || k;
    const isEditable = editableFields.includes(k);
    const displayVal = (k === "amount_minor" && v.value) ? money(Number(v.value)) : String(v.value);
    const cls = isEditable ? "rule editable" : "rule";
    return "<div class='" + cls + "' data-field='" + esc(k) + "' data-value='" + esc(String(v.value)) + "'>"
      + "<span class='k'>" + esc(label) + "</span>"
      + "<span class='v'>" + esc(displayVal) + " <span style='color:var(--faint)'>· " + esc(v.source) + "</span></span>"
      + "</div>";
  }).join("");

  const refIds = x.reference_ids ? Object.entries(x.reference_ids).map(([k, v]) =>
    esc(k) + "=" + esc(v)).join("  ") : "";

  const detailHtml =
    "<div class='panel'><h3>" + esc(doc.original_filename) + "</h3>"
    + "<div class='grid3' style='margin-bottom:14px'>"
    + "<div><div style='font:10.5px var(--mono);color:var(--faint);text-transform:uppercase'>Type</div>"
    + "<div style='font:12px var(--mono);margin-top:3px'>" + esc(doc.doc_type || "—") + "</div></div>"
    + "<div><div style='font:10.5px var(--mono);color:var(--faint);text-transform:uppercase'>Received</div>"
    + "<div style='font:12px var(--mono);margin-top:3px'>" + esc(String(doc.received_at || "").slice(0, 19)) + "</div></div>"
    + "<div><div style='font:10.5px var(--mono);color:var(--faint);text-transform:uppercase'>Lifecycle</div>"
    + "<div style='font:12px var(--mono);margin-top:3px'>" + esc(doc.lifecycle) + "</div></div>"
    + "</div>"
    + (refIds ? "<h3>Reference IDs</h3><div style='font:11.5px var(--mono);color:var(--dim);margin-bottom:14px'>" + refIds + "</div>" : "")
    + "<h3>Effective fields</h3>" + (effRows || "<div class='empty'>No extracted fields.</div>")
    + "<h3 style='margin-top:18px'>Parties</h3>" + (partiesHtml || "<div class='empty'>No resolved parties.</div>")
    + "<h3 style='margin-top:18px'>Transactions evidenced</h3>" + (txnsHtml || "<div class='empty'>Not linked to any transaction.</div>")
    // Action bar: reprocess, exclude, download, delete + status message.
    + "<div class='doc-actions'>"
    + "<button class='primary' id='reprocessBtn-" + esc(id) + "'>Reprocess</button>"
    + "<button id='excludeBtn-" + esc(id) + "'>Exclude</button>"
    + "<button id='downloadBtn-" + esc(id) + "'>Download</button>"
    + "<button class='danger' id='deleteBtn-" + esc(id) + "'>Delete</button>"
    + "<span class='msg' id='docActionMsg-" + esc(id) + "'></span>"
    + "</div>"
    + "</div>";

  // Two-column layout: details on the left, document viewer on the right.
  // The viewer has an Image/Text toggle. The toggle and default mode are
  // determined by initDocViewer() after checking /pageinfo — documents with
  // a page image default to Image; emails and text-only docs default to Text.
  const html =
    "<div class='doc-split'>"
    + "<div class='doc-details'>" + detailHtml + "</div>"
    + "<div class='doc-viewer'>"
    + "<div class='viewer-toggle' id='vToggle-" + esc(id) + "'>"
    + "<button id='vImg-" + esc(id) + "' class='on'>Image</button>"
    + "<button id='vTxt-" + esc(id) + "'>Text</button>"
    + "</div>"
    + "<div class='viewer-box' id='viewerBox-" + esc(id) + "'><div class='viewer-fallback'>loading document…</div></div>"
    + "<div class='pager' id='pager-" + esc(id) + "' style='display:none'>"
    + "<button id='pgPrev-" + esc(id) + "'>‹ Prev</button>"
    + "<span id='pgInfo-" + esc(id) + "'></span>"
    + "<button id='pgNext-" + esc(id) + "'>Next ›</button>"
    + "</div>"
    + "</div></div>";

  if (container) container.innerHTML = html;
  initDocViewer(id, { pipelineState: d.pipeline_state, intakeId: d.intake_id });
  initDocActions(id, editableFields, DROPDOWN_FIELDS);
}

// ── document action bar + inline field editing ───────────────────
function initDocActions(id, editableFields, dropdownFields) {
  const msg = document.getElementById("docActionMsg-" + id);
  function setMsg(text, cls) {
    if (msg) { msg.textContent = text; msg.className = "msg" + (cls ? " " + cls : ""); }
  }

  // Reprocess button — re-enqueues analysis (or conversion if no markdown).
  const reprocBtn = document.getElementById("reprocessBtn-" + id);
  if (reprocBtn) {
    reprocBtn.onclick = async () => {
      reprocBtn.disabled = true;
      setMsg("Reprocessing…");
      try {
        const r = await apiPost("/v1/documents/" + encodeURIComponent(id) + "/reprocess", {});
        setMsg("Reprocessing (" + (r.phase || "analyse") + ")…", "ok");
      } catch (e) {
        setMsg("Failed: " + esc(String(e.message || e)), "err");
      }
      reprocBtn.disabled = false;
    };
  }

  // Exclude button — soft remove from active view. File and claims stay
  // on disk; reprocess brings it back. Reversible.
  const excludeBtn = document.getElementById("excludeBtn-" + id);
  if (excludeBtn) {
    excludeBtn.onclick = async () => {
      if (!confirm("Exclude this document from the active view?\n\nThe file and all claims stay on disk. You can bring it back with Reprocess.")) return;
      excludeBtn.disabled = true;
      setMsg("Excluding…");
      try {
        await apiPost("/v1/documents/" + encodeURIComponent(id) + "/remove-from-active", {});
        setMsg("Excluded from active.", "ok");
        // Collapse the detail panel — the doc is no longer active.
        collapseOpenDoc();
        // Refresh the document list to remove it.
        loadReview();
      } catch (e) {
        setMsg("Failed: " + esc(String(e.message || e)), "err");
        excludeBtn.disabled = false;
      }
    };
  }

  // Download button — fetches the original file bytes and triggers a
  // browser download with the original filename.
  const downloadBtn = document.getElementById("downloadBtn-" + id);
  if (downloadBtn) {
    downloadBtn.onclick = async () => {
      downloadBtn.disabled = true;
      setMsg("Downloading…");
      try {
        const resp = await fetch("/v1/documents/" + encodeURIComponent(id) + "/file", { headers: H });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const blob = await resp.blob();
        const cd = resp.headers.get("content-disposition") || "";
        const fnameMatch = cd.match(/filename="?([^"]+)"?/);
        const fname = fnameMatch ? fnameMatch[1] : id;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setMsg("Downloaded.", "ok");
      } catch (e) {
        setMsg("Failed: " + esc(String(e.message || e)), "err");
      }
      downloadBtn.disabled = false;
    };
  }

  // Delete button — permanent. Unlinks files, tombstones the row.
  // Requires explicit confirmation typing the document ID.
  const deleteBtn = document.getElementById("deleteBtn-" + id);
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const confirmed = confirm(
        "DELETE PERMANENTLY?\n\n"
        + "This will unlink the original file and markdown from disk, "
        + "and tombstone the document row. The sha256 dedupe guard "
        + "will still reject a re-drop of the same bytes.\n\n"
        + "This action is IRREVERSIBLE."
      );
      if (!confirmed) return;
      deleteBtn.disabled = true;
      setMsg("Deleting…");
      try {
        await apiDelete("/v1/documents/" + encodeURIComponent(id));
        setMsg("Deleted permanently.", "ok");
        collapseOpenDoc();
        loadReview();
      } catch (e) {
        setMsg("Failed: " + esc(String(e.message || e)), "err");
        deleteBtn.disabled = false;
      }
    };
  }

  // Click-to-edit on editable effective fields.
  const detailPanel = document.querySelector(".doc-details .panel");
  if (!detailPanel) return;
  detailPanel.querySelectorAll(".rule.editable").forEach((row) => {
    row.onclick = (e) => {
      if (row.classList.contains("editing")) return;
      startEditField(id, row, dropdownFields);
    };
  });
}

function startEditField(id, row, dropdownFields) {
  const field = row.dataset.field;
  const currentValue = row.dataset.value;
  row.classList.add("editing");

  const valSpan = row.querySelector(".v");
  if (!valSpan) return;

  const options = dropdownFields[field] || [];
  // amount_minor is stored in paise; the user edits in rupees.
  const isMoney = field === "amount_minor";
  const editValue = isMoney && currentValue
    ? (Number(currentValue) / 100).toFixed(2)
    : currentValue;
  let inputHtml;
  if (options.length > 0) {
    const opts = options.map((o) =>
      "<option value='" + esc(String(o)) + "'" + (String(o) === currentValue ? " selected" : "") + ">"
      + esc(String(o)) + "</option>"
    ).join("");
    inputHtml = "<select class='edit-input' id='editSel-" + esc(field) + "'>" + opts + "</select>";
  } else {
    inputHtml = "<input class='edit-input' id='editInp-" + esc(field) + "' value='" + esc(editValue) + "'>";
  }

  valSpan.style.display = "none";
  valSpan.insertAdjacentHTML("afterend", inputHtml);

  const inp = row.querySelector(".edit-input");
  if (inp) inp.focus();

  // Select all text on focus for text inputs so the user can just type.
  if (inp && inp.tagName === "INPUT") inp.select();

  let saved = false;

  async function save() {
    if (saved) return;
    saved = true;
    let newVal = inp ? inp.value : "";
    // Convert rupees to paise for amount_minor.
    if (isMoney && newVal !== "") {
      const rupees = parseFloat(newVal);
      if (isNaN(rupees)) { saved = false; inp.focus(); return; }
      newVal = String(Math.round(rupees * 100));
    }
    if (newVal === currentValue) { restore(); return; }
    try {
      await apiPatch("/v1/documents/" + encodeURIComponent(id) + "/claims",
        { field, value: newVal });
      row.dataset.value = newVal;
      const displayVal = isMoney && newVal ? money(Number(newVal)) : newVal;
      valSpan.innerHTML = esc(displayVal) + " <span style='color:var(--faint)'>· user</span>";
      restore();
    } catch (e) {
      saved = false;
      inp.focus();
      alert("Failed to save: " + (e.message || e));
    }
  }

  function restore() {
    row.classList.remove("editing");
    valSpan.style.display = "";
    if (inp) inp.remove();
  }

  // Blur saves — clicking away commits the value.
  if (inp) inp.onblur = () => save();

  // Enter saves; Escape reverts without saving.
  if (inp) inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { saved = true; restore(); }
  };
}

// ── document viewer with magnifier ───────────────────────────────
// Fetches /pageinfo to discover page count and render capability, then
// loads the first page as a blob (the /page endpoint requires a Bearer
// header, which <img> can't set). A circular magnifier follows the cursor
// on hover, mirroring the Flutter app's MagnifiedDocument widget.
//
// The viewer has two modes:
//   Image — the rasterised page (PDF/photo) with magnifier + pager
//   Text  — the extracted markdown (works for emails and any document)
// Documents with a page image default to Image; documents without (emails,
// .txt) default to Text with the Image button disabled.
const LENS_RADIUS = 110;
const LENS_ZOOM = 2.5;

async function initDocViewer(id, ctx) {
  const box = document.getElementById("viewerBox-" + id);
  const imgBtn = document.getElementById("vImg-" + id);
  const txtBtn = document.getElementById("vTxt-" + id);
  if (!box || !imgBtn || !txtBtn) return;

  // If the document is in the password_needed pipeline state, show a
  // password prompt instead of the image/text viewer. The user enters a
  // password, we POST it to /v1/documents/<id>/password, and the daemon
  // re-enqueues conversion. The SSE stream will refresh the pipeline board.
  const pipelineState = ctx && ctx.pipelineState;
  if (pipelineState === "password_needed") {
    imgBtn.disabled = true;
    txtBtn.disabled = true;
    imgBtn.classList.remove("on");
    txtBtn.classList.remove("on");
    renderPasswordPrompt(id, box);
    return;
  }

  let info;
  try {
    info = await api("/v1/documents/" + encodeURIComponent(id) + "/pageinfo");
  } catch {
    info = null;
  }
  const hasImage = !!(info && info.kind !== "none" && info.pages);

  let mode = hasImage ? "image" : "text";

  // If no page image, disable the Image toggle and default to Text.
  if (!hasImage) {
    imgBtn.disabled = true;
    imgBtn.classList.remove("on");
    txtBtn.classList.add("on");
  }

  // Toggle handlers.
  imgBtn.onclick = () => { if (!imgBtn.disabled) switchMode("image"); };
  txtBtn.onclick = () => { switchMode("text"); };

  function switchMode(m) {
    mode = m;
    imgBtn.classList.toggle("on", m === "image");
    txtBtn.classList.toggle("on", m === "text");
    const pager = document.getElementById("pager-" + id);
    if (pager) pager.style.display = "none";
    if (m === "image") renderPage(1);
    else renderText();
  }

  // ── Image mode ──
  let currentPage = 1;
  const totalPages = info ? info.pages : 0;
  const pagerAvailable = info ? info.pager_available : false;

  async function renderPage(n) {
    if (!hasImage) return;
    // Lock the box height so it doesn't collapse while the loading placeholder
    // replaces the image — this prevents the card from shrinking and jumping
    // back to full size when the next page arrives.
    const lockedH = box.offsetHeight;
    if (lockedH > 0) box.style.minHeight = lockedH + "px";
    box.innerHTML = "<div class='viewer-fallback'>rendering page " + esc(n) + "…</div>";
    const url = "/v1/documents/" + encodeURIComponent(id) + "/page?n=" + n + "&w=2400";
    let blobUrl;
    try {
      const r = await fetch(url, { headers: H });
      if (!r.ok) throw new Error("http_" + r.status);
      const blob = await r.blob();
      blobUrl = URL.createObjectURL(blob);
    } catch {
      box.innerHTML = "<div class='viewer-fallback'>Failed to render page.</div>";
      return;
    }
    box.innerHTML = "<img class='page' id='pageImg-" + esc(id) + "' src='" + esc(blobUrl) + "'>"
      + "<div class='lens' id='lens-" + esc(id) + "'><img id='lensImg-" + esc(id) + "'></div>";
    attachMagnifier(id);
    // Release the height lock once the new image is in place.
    box.style.minHeight = "";

    // Pager controls.
    const pager = document.getElementById("pager-" + id);
    if (pager) {
      pager.style.display = totalPages > 1 && pagerAvailable ? "flex" : "none";
      const prev = document.getElementById("pgPrev-" + id);
      const next = document.getElementById("pgNext-" + id);
      const lbl = document.getElementById("pgInfo-" + id);
      if (lbl) lbl.textContent = "Page " + n + " of " + totalPages;
      if (prev) prev.disabled = n <= 1;
      if (next) next.disabled = n >= totalPages;
      if (prev) prev.onclick = () => { if (currentPage > 1) { currentPage--; renderPage(currentPage); } };
      if (next) next.onclick = () => { if (currentPage < totalPages) { currentPage++; renderPage(currentPage); } };
    }
  }

  // ── Text mode ──
  async function renderText() {
    box.innerHTML = "<div class='viewer-fallback'>loading text…</div>";
    try {
      const r = await api("/v1/documents/" + encodeURIComponent(id) + "/markdown");
      const md = r.markdown || "";
      if (!md) {
        box.innerHTML = "<div class='viewer-fallback'>No text extracted for this document.</div>";
        return;
      }
      box.innerHTML = "<div class='md-view' id='mdView-" + esc(id) + "'></div>";
      document.getElementById("mdView-" + id).textContent = md;
    } catch {
      box.innerHTML = "<div class='viewer-fallback'>Text not available (document may not be converted yet).</div>";
    }
  }

  // Initial render based on the default mode.
  if (mode === "image") renderPage(currentPage);
  else renderText();
}

// Render a password prompt in the viewer box for encrypted documents.
// The user enters a password and submits it; we POST to the document-level
// password endpoint, which stores it and re-enqueues conversion.
function renderPasswordPrompt(id, box) {
  box.innerHTML =
    "<div class='pw-prompt'>"
    + "<div class='pw-icon'>🔒</div>"
    + "<div class='pw-title'>Password required</div>"
    + "<div class='pw-hint'>This document is encrypted. Enter the password to unlock and convert it.</div>"
    + "<div class='pw-row'>"
    + "<input type='password' id='pwInput-" + esc(id) + "' placeholder='Password' autocomplete='off'>"
    + "<button id='pwSubmit-" + esc(id) + "'>Unlock</button>"
    + "</div>"
    + "<div class='pw-msg' id='pwMsg-" + esc(id) + "'></div>"
    + "</div>";

  const input = document.getElementById("pwInput-" + id);
  const btn = document.getElementById("pwSubmit-" + id);
  const msg = document.getElementById("pwMsg-" + id);
  if (input) input.focus();

  async function submit() {
    const pw = input ? input.value : "";
    if (!pw) return;
    if (btn) btn.disabled = true;
    if (msg) { msg.textContent = "Submitting…"; msg.className = "pw-msg"; }
    try {
      const r = await apiPost("/v1/documents/" + encodeURIComponent(id) + "/password",
        { password: pw });
      if (r.ok) {
        if (msg) { msg.textContent = "Password accepted — converting…"; msg.className = "pw-msg ok"; }
        if (input) input.disabled = true;
        if (btn) btn.disabled = true;
      } else {
        throw new Error(r.error || "submission failed");
      }
    } catch (e) {
      if (msg) {
        msg.textContent = "Failed: " + esc(String(e.message || e));
        msg.className = "pw-msg err";
      }
      if (btn) btn.disabled = false;
    }
  }

  if (btn) btn.onclick = submit;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

// Attach the circular magnifier to the page image. On mousemove the lens
// follows the cursor and shows a zoomed region of the source image.
function attachMagnifier(id) {
  const img = document.getElementById("pageImg-" + id);
  const lens = document.getElementById("lens-" + id);
  const lensImg = document.getElementById("lensImg-" + id);
  if (!img || !lens || !lensImg) return;

  lensImg.src = img.src;

  function showLens() { lens.style.display = "block"; }
  function hideLens() { lens.style.display = "none"; }

  function onMove(e) {
    const rect = img.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) { hideLens(); return; }
    showLens();

    // Position the lens centered on the cursor — no clamping so the user
    // can magnify details right up to the corners and edges of the image.
    lens.style.left = (x - LENS_RADIUS) + "px";
    lens.style.top = (y - LENS_RADIUS) + "px";
    lens.style.width = (LENS_RADIUS * 2) + "px";
    lens.style.height = (LENS_RADIUS * 2) + "px";

    // The lens image must be sized so that the zoomed region fills the lens.
    const zoomedW = rect.width * LENS_ZOOM;
    const zoomedH = rect.height * LENS_ZOOM;
    lensImg.style.width = zoomedW + "px";
    lensImg.style.height = zoomedH + "px";
    // Offset so the cursor point in the source maps to the lens center.
    lensImg.style.left = -(x * LENS_ZOOM - LENS_RADIUS) + "px";
    lensImg.style.top = -(y * LENS_ZOOM - LENS_RADIUS) + "px";
  }

  img.addEventListener("mousemove", onMove);
  img.addEventListener("mouseenter", showLens);
  img.addEventListener("mouseleave", hideLens);
}

