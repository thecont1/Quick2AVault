// ════════════════════════════════════════════════════════════════════════
// PEOPLE TAB
// ════════════════════════════════════════════════════════════════════════
// Collapsible section headers — toggle open/closed on click.
document.querySelectorAll(".collapse .collapse-hdr").forEach((hdr) => {
  hdr.onclick = () => hdr.parentElement.classList.toggle("open");
});
// People tab state. peopleCache feeds the merge dropdown; selectedPersonId
// highlights the open row across reloads.
let peopleCache = [];
let selectedPersonId = null;

// Relationship presets. The schema's subtype is free TEXT, so a preset is a
// convenience, not a constraint — "Custom…" reveals a free-text input.
const RELATIONSHIPS = ["spouse", "family", "merchant", "landlord", "tenant", "employer", "contractor", "friend"];

function personRow(x, selectedId) {
  const isHouse = x.is_owner || x.is_member;
  const role = x.is_owner
    ? "<span class='role owner'>★ owner</span>"
    : x.is_member
      ? "<span class='role member'>member</span>"
      : "<span class='role other'>person</span>";
  const rel = x.subtype
    ? "<span class='rel'>" + esc(x.subtype) + "</span>"
    : (isHouse ? "" : "<span class='rel'><span class='none'>unclassified</span></span>");
  return "<div class='ent" + (x.id === selectedId ? " sel" : "") + "' data-id='" + esc(x.id) + "' data-kind='person'>"
    + "<div><span class='nm'>" + esc(x.display_name) + "</span> " + role + " " + rel + "</div>"
    + "<span class='kind person'>person</span>"
    + "<span class='stat " + esc(x.status) + "'>" + esc(x.status) + "</span>"
    + "<span class='ct'>" + esc(x.document_count) + " docs · " + esc(x.transaction_count) + " txns</span></div>";
}

async function loadPeople() {
  const [p, e] = await Promise.all([api("/v1/people"), api("/v1/entities")]);
  const people = p.people || [];
  peopleCache = people;
  const house = people.filter((x) => x.is_owner || x.is_member);
  const others = people.filter((x) => !x.is_owner && !x.is_member);

  document.getElementById("houseCount").textContent = "· " + house.length + (house.length === 1 ? " person" : " people");
  document.getElementById("otherCount").textContent = "· " + others.length + (others.length === 1 ? " person" : " people");
  document.getElementById("houseList").innerHTML = !house.length
    ? "<div class='empty'>No household yet. Mark someone as “owner” or “member” to add them.</div>"
    : house.map((x) => personRow(x, selectedPersonId)).join("");
  document.getElementById("otherList").innerHTML = !others.length
    ? "<div class='empty'>No other people detected yet.</div>"
    : others.map((x) => personRow(x, selectedPersonId)).join("");

  const ents = (e.entities || []).filter((x) => x.kind !== "person");
  const orgs = ents.filter((x) => x.kind === "organisation");
  const accts = ents.filter((x) => x.kind === "account" || x.kind === "instrument");

  const entRow = (x) =>
      "<div class='ent' data-id='" + esc(x.id) + "' data-kind='" + esc(x.kind) + "'>"
      + "<div><span class='nm'>" + esc(x.display_name) + "</span>"
      + (x.subtype ? " <span class='rel'>" + esc(x.subtype) + "</span>" : "") + "</div>"
      + "<span class='kind " + esc(x.kind) + "'>" + esc(x.kind) + "</span>"
      + "<span class='stat " + esc(x.status) + "'>" + esc(x.status) + "</span>"
      + "<span class='ct'>" + esc((x.conflicts || []).length) + " conflicts</span></div>";

  document.getElementById("orgCount").textContent = "· " + orgs.length + (orgs.length === 1 ? " entity" : " entities");
  document.getElementById("orgList").innerHTML = !orgs.length
    ? "<div class='empty'>No organisations detected yet.</div>"
    : orgs.map(entRow).join("");

  document.getElementById("acctCount").textContent = "· " + accts.length + (accts.length === 1 ? " entity" : " entities");
  document.getElementById("acctList").innerHTML = !accts.length
    ? "<div class='empty'>No accounts or instruments detected yet.</div>"
    : accts.map(entRow).join("");

  document.querySelectorAll("#houseList .ent, #otherList .ent").forEach((el) =>
    el.onclick = () => showPerson(el.dataset.id, el));
  document.querySelectorAll("#orgList .ent, #acctList .ent").forEach((el) =>
    el.onclick = () => showEntity(el.dataset.id, el));
}

// Render the detail panel inline, right after the clicked row. A previously
// opened panel is removed first so only one is visible at a time.
function renderDetail(html, afterEl) {
  const old = document.querySelector(".detail-inline");
  if (old) old.remove();
  const wrap = document.createElement("div");
  wrap.className = "detail-inline";
  wrap.innerHTML = html;
  afterEl.insertAdjacentElement("afterend", wrap);
}

async function showPerson(id, rowEl) {
  selectedPersonId = id;
  // Re-render lists to reflect the selection highlight without a refetch.
  document.querySelectorAll("#houseList .ent, #otherList .ent").forEach((el) =>
    el.classList.toggle("sel", el.dataset.id === id));
  const d = await api("/v1/people/" + encodeURIComponent(id));
  const person = d.person || {};
  const aliases = d.aliases || [];
  const docs = d.documents || [];
  const txns = d.transactions || [];

  const role = person.is_owner ? "owner" : person.is_member ? "member" : "other";
  const relCur = person.subtype || "";
  const relIsPreset = RELATIONSHIPS.includes(relCur);
  const relOptions = ["<option value=''>— none —</option>"]
    .concat(RELATIONSHIPS.map((r) => "<option value='" + esc(r) + "'" + (r === relCur ? " selected" : "") + ">" + esc(r) + "</option>"))
    .concat(relCur && !relIsPreset
      ? ["<option value='" + esc(relCur) + "' selected>" + esc(relCur) + " (custom)</option>"]
      : [])
    .concat(["<option value='__custom'>Custom…</option>"])
    .join("");

  const aliasHtml = aliases.map((a) =>
    "<div class='aliasrow'>"
    + "<span class='at'>" + esc(a.alias_type) + "</span>"
    + "<span class='ax" + (a.status === "rejected" ? " rej" : "") + "'>" + esc(a.alias)
    + " <span class='src'>· " + esc(a.status) + " · " + esc(a.source) + "</span></span>"
    + (a.status === "rejected"
        ? ""
        : "<button class='x' data-alias='" + esc(a.id) + "'>reject</button>")
    + "</div>").join("");

  const docsHtml = docs.map((x) =>
    "<div class='rule'><span class='k'>" + esc(x.role) + "</span>"
    + "<span class='v'>" + esc(x.original_filename) + "</span>"
    + "<span class='n'>" + esc(String(x.received_at || "").slice(0, 10)) + "</span></div>").join("");
  const txnsHtml = txns.map((x) =>
    "<div class='rule'><span class='k'>" + esc(x.direction) + "</span>"
    + "<span class='v'>" + money(x.amount_minor) + " · " + esc(x.counterparty_name || "transfer") + "</span>"
    + "<span class='n'>" + esc(String(x.occurred_at || "").slice(0, 10)) + "</span></div>").join("");

  // Merge targets: every OTHER person. Merging folds this person into the
  // chosen survivor (every alias is kept), so the current row disappears.
  const mergeOpts = peopleCache
    .filter((x) => x.id !== id)
    .map((x) => "<option value='" + esc(x.id) + "'>" + esc(x.display_name) + "</option>").join("");

  renderDetail(
    "<div class='panel'>"
    + "<h3>" + esc(person.display_name) + " <span style='color:var(--ink);font-weight:400;text-transform:none'>· person · " + esc(person.status) + " · confidence " + esc(person.confidence) + "</span></h3>"
    + "<div class='pedit'>"
    // ── left: edit ──
    + "<div class='blk'>"
    + "<h4>Identity</h4>"
    + "<div class='field' style='margin-bottom:12px'><label>Display name</label>"
    + "<input type='text' id='pName' value='" + esc(person.display_name) + "'></div>"
    + "<h4>Role in this vault</h4>"
    + "<div class='rolepick' id='rolePick'>"
    + "<label data-role='owner'><input type='radio' name='role'" + (role === "owner" ? " checked" : "") + ">This is me (owner)</label>"
    + "<label data-role='member'><input type='radio' name='role'" + (role === "member" ? " checked" : "") + ">Household member</label>"
    + "<label data-role='other'><input type='radio' name='role'" + (role === "other" ? " checked" : "") + ">Other person</label>"
    + "</div>"
    + "<div class='field' style='margin-bottom:12px'><label>Relationship</label>"
    + "<select id='pRel'>" + relOptions + "</select>"
    + "<input type='text' id='pRelCustom' placeholder='custom relationship' style='margin-top:8px" + (relIsPreset || !relCur ? ";display:none" : "") + "' value='" + esc(relIsPreset || !relCur ? "" : relCur) + "'>"
    + "<div class='hint'>How this person relates to you — merchant, landlord, tenant, spouse…</div></div>"
    + "<div class='savebar'><button class='act' id='pSave'>Save changes</button><span class='msg' id='pMsg'></span></div>"
    // ── merge + delete ──
    + (mergeOpts
      ? "<div class='mergebar'><div class='field' style='margin:0;flex:1'><label>Merge into…</label>"
        + "<select id='pMerge'>" + mergeOpts + "</select></div>"
        + "<button class='ghost' id='pMergeGo'>merge</button></div>"
        + "<div class='hint' style='margin-top:6px'>Folds this person into the chosen survivor; every alias and document link is kept.</div>"
      : "")
    + "<div style='margin-top:14px'><button class='dangerbtn' id='pDel'>Delete person</button>"
    + "<span class='msg' id='pDelMsg' style='margin-left:10px'></span></div>"
    + "</div>"
    // ── right: evidence ──
    + "<div class='blk'>"
    + "<h4>Aliases <span style='color:var(--faint);font-weight:400;text-transform:none'>· other names, emails, phones, handles this person goes by</span></h4>"
    + (aliasHtml || "<div class='empty'>No aliases yet.</div>")
    + "<div class='aliasadd'><input type='text' id='pAliasAdd' placeholder='e.g. a name variant, email, phone, handle — type is detected automatically'>"
    + "<button class='ghost' id='pAliasGo'>add</button></div>"
    + "<div class='msg' id='pAliasMsg' style='margin-top:6px'></div>"
    + "<h4 style='margin-top:18px'>Documents</h4>" + (docsHtml || "<div class='empty'>No linked documents.</div>")
    + "<h4 style='margin-top:18px'>Transactions</h4>" + (txnsHtml || "<div class='empty'>No linked transactions.</div>")
    + "</div>"
    + "</div></div>",
    rowEl);

  // wire up the editor
  wireRolePick();
  const relSel = document.getElementById("pRel");
  const relCustom = document.getElementById("pRelCustom");
  relSel.onchange = () => {
    if (relSel.value === "__custom") {
      relCustom.style.display = "";
      relCustom.focus();
    } else {
      relCustom.style.display = "none";
      relCustom.value = "";
    }
  };
  document.getElementById("pSave").onclick = () => savePerson(id);
  document.getElementById("pAliasGo").onclick = () => addAlias(id);
  document.getElementById("pAliasAdd").onkeydown = (e) => { if (e.key === "Enter") addAlias(id); };
  document.querySelectorAll(".detail-inline .aliasrow .x").forEach((b) =>
    b.onclick = () => rejectAlias(id, b.dataset.alias));
  if (mergeOpts) document.getElementById("pMergeGo").onclick = () => mergePerson(id);
  document.getElementById("pDel").onclick = () => deletePerson(id);
}

// Keep the role radio labels in sync with their checked input.
function wireRolePick() {
  const pick = document.getElementById("rolePick");
  if (!pick) return;
  const sync = () => pick.querySelectorAll("label").forEach((l) =>
    l.classList.toggle("on", l.querySelector("input").checked));
  sync();
  pick.querySelectorAll("input").forEach((r) => r.onchange = sync);
}

function chosenRole() {
  const on = document.querySelector("#rolePick input:checked");
  return on ? on.closest("label").dataset.role : "other";
}

function chosenRelationship() {
  const sel = document.getElementById("pRel");
  const custom = document.getElementById("pRelCustom");
  if (sel.value === "__custom") return (custom.value || "").trim();
  return (sel.value || "").trim();
}

async function savePerson(id) {
  const msg = document.getElementById("pMsg");
  msg.className = "msg";
  msg.textContent = "saving…";
  const name = (document.getElementById("pName").value || "").trim();
  const rel = chosenRelationship();
  const role = chosenRole();
  if (!name) { msg.className = "msg bad"; msg.textContent = "name cannot be empty"; return; }
  const patch = { display_name: name, relationship: rel || null };
  if (role === "owner") { patch.is_owner = true; patch.is_member = true; }
  else if (role === "member") { patch.is_owner = false; patch.is_member = true; }
  else { patch.is_owner = false; patch.is_member = false; }
  const r = await apiPatch("/v1/people/" + encodeURIComponent(id), patch);
  if (r.error) {
    msg.className = "msg bad";
    msg.textContent = r.error === "name_taken" ? "That name is taken — use merge instead." : (r.message || r.error);
    return;
  }
  msg.className = "msg ok";
  msg.textContent = "saved";
  await loadPeople();
  const row = personRowEl(id);
  if (row) showPerson(id, row);
}

// Locate the list row for a person, in either the household or other list.
// Returns null when the row isn't currently rendered — callers must guard, as
// showEntity does, or renderDetail would throw on an undefined afterEl.
function personRowEl(id) {
  return document.querySelector(
    "#houseList .ent[data-id='" + CSS.escape(id) + "'], #otherList .ent[data-id='" + CSS.escape(id) + "']");
}

async function addAlias(id) {
  const inp = document.getElementById("pAliasAdd");
  const msg = document.getElementById("pAliasMsg");
  const alias = (inp.value || "").trim();
  if (!alias) return;
  msg.className = "msg"; msg.textContent = "adding…";
  const r = await apiPost("/v1/people/" + encodeURIComponent(id) + "/aliases", { alias });
  if (r.error) {
    msg.className = "msg bad";
    msg.textContent = r.error === "alias_in_use" ? "Already on file for another person — merge them if they are the same human." : (r.message || r.error);
    return;
  }
  msg.className = "msg ok"; msg.textContent = "added as " + r.alias_type;
  const row = personRowEl(id);
  if (row) showPerson(id, row);
}

async function rejectAlias(id, aliasId) {
  await apiDelete("/v1/people/" + encodeURIComponent(id) + "/aliases/" + encodeURIComponent(aliasId));
  const row = personRowEl(id);
  if (row) showPerson(id, row);
}

async function mergePerson(id) {
  const into = document.getElementById("pMerge").value;
  if (!into) return;
  if (!confirm("Merge this person into the selected survivor? This cannot be undone.")) return;
  const r = await apiPost("/v1/people/merge", { from_id: id, into_id: into });
  if (r.error) { alert(r.message || r.error); return; }
  selectedPersonId = into;
  await loadPeople();
  const row = document.querySelector("#houseList .ent[data-id='" + CSS.escape(into) + "'], #otherList .ent[data-id='" + CSS.escape(into) + "']");
  showPerson(into, row);
}

async function deletePerson(id) {
  const btn = document.getElementById("pDel");
  const msg = document.getElementById("pDelMsg");
  if (!confirm("Delete this person?")) return;
  btn.disabled = true;
  let r = await apiDelete("/v1/people/" + encodeURIComponent(id));
  if (r.error === "person_in_use") {
    msg.className = "msg";
    msg.textContent = "Named on " + r.documents + " document(s). ";
    if (confirm(r.message + "\n\nForce-delete will reassign those links to “Unidentified” and remove this person. Continue?")) {
      r = await apiDelete("/v1/people/" + encodeURIComponent(id) + "?force=1");
    } else { btn.disabled = false; return; }
  }
  if (r.error) { msg.className = "msg bad"; msg.textContent = r.message || r.error; btn.disabled = false; return; }
  selectedPersonId = null;
  const old = document.querySelector(".detail-inline");
  if (old) old.remove();
  await loadPeople();
}

// Non-person entities (organisations, accounts, instruments) are editable:
// display name, subtype, status, and same-kind merge.
async function showEntity(id, rowEl) {
  const e = await api("/v1/entities");
  const ent = (e.entities || []).find((x) => x.id === id);
  if (!ent) return;
  const conflicts = ent.conflicts || [];
  const confHtml = conflicts.map((c) =>
    "<div class='rule'><span class='k'>" + esc(c.identifier) + "</span>"
    + "<span class='v'>" + esc(c.other_name) + " <span style='color:var(--faint)'>· " + esc(c.other_kind) + " · " + esc(c.identifier_type) + "</span></span></div>").join("");

  // Merge targets: other entities of the SAME kind only (anti-pollution invariant).
  const sameKind = (e.entities || []).filter((x) => x.id !== id && x.kind === ent.kind);
  const mergeOpts = sameKind
    .map((x) => "<option value='" + esc(x.id) + "'>" + esc(x.display_name) + "</option>").join("");

  // Subtype presets by kind.
  const SUBTYPES = {
    organisation: ["merchant", "vendor", "employer", "service provider", "government"],
    account: ["bank", "credit card", "wallet", "brokerage", "savings"],
    instrument: ["equity", "bond", "fund", "crypto"],
  };
  const subPresets = SUBTYPES[ent.kind] || [];
  const subCur = ent.subtype || "";
  const subIsPreset = subPresets.includes(subCur);
  const subOptions = ["<option value=''>— none —</option>"]
    .concat(subPresets.map((s) => "<option value='" + esc(s) + "'" + (s === subCur ? " selected" : "") + ">" + esc(s) + "</option>"))
    .concat(subCur && !subIsPreset
      ? ["<option value='" + esc(subCur) + "' selected>" + esc(subCur) + " (custom)</option>"]
      : [])
    .concat(["<option value='__custom'>Custom…</option>"])
    .join("");

  renderDetail(
    "<div class='panel'>"
    + "<h3>" + esc(ent.display_name) + " <span style='color:var(--faint);font-weight:400;text-transform:none'>· " + esc(ent.kind) + " · " + esc(ent.status) + "</span></h3>"
    + "<div class='pedit'>"
    // ── left: edit ──
    + "<div class='blk'>"
    + "<h4>Identity</h4>"
    + "<div class='field' style='margin-bottom:12px'><label>Display name</label>"
    + "<input type='text' id='eName' value='" + esc(ent.display_name) + "'></div>"
    + "<div class='field' style='margin-bottom:12px'><label>Subtype</label>"
    + "<select id='eSub'>" + subOptions + "</select>"
    + "<input type='text' id='eSubCustom' style='display:none;margin-top:6px' placeholder='custom subtype'></div>"
    + "<div class='field' style='margin-bottom:12px'><label>Status</label>"
    + "<select id='eStatus'><option value='candidate'" + (ent.status === "candidate" ? " selected" : "") + ">candidate</option>"
    + "<option value='confirmed'" + (ent.status === "confirmed" ? " selected" : "") + ">confirmed</option></select></div>"
    + "<div class='row' style='gap:8px'>"
    + "<button class='act' id='eSave'>Save changes</button>"
    + (ent.status === "candidate" ? "<button class='act' id='eConfirm'>Confirm entity</button>" : "")
    + "<span class='msg' id='eMsg'></span>"
    + "</div>"
    + "</div>"
    // ── right: merge + conflicts ──
    + "<div class='blk'>"
    + (sameKind.length ? "<h4>Merge into another " + esc(ent.kind) + "</h4>"
      + "<div class='row' style='gap:8px;margin-bottom:14px'>"
      + "<select id='eMerge'><option value=''>— select target —</option>" + mergeOpts + "</select>"
      + "<button class='ghost' id='eMergeBtn'>Merge</button></div>" : "")
    + "<h4>Confidence</h4>"
    + "<div style='font:12px var(--mono);color:var(--dim);margin-bottom:14px'>" + esc(ent.confidence) + "</div>"
    + "<h4>Cross-kind identifier conflicts</h4>"
    + (confHtml || "<div class='empty'>No conflicts.</div>")
    + "<h4 style='margin-top:18px;color:var(--bad)'>Delete this " + esc(ent.kind) + "</h4>"
    + "<div class='row' style='gap:8px;align-items:center'>"
    + "<button class='dangerbtn' id='eDelete' style='border-color:var(--bad);color:var(--bad)'>Delete</button>"
    + "<span class='msg' id='eDelMsg'></span></div>"
    + "</div>"
    + "</div>"
    + "</div>",
    rowEl);

  // Subtype custom toggle
  const eSub = document.getElementById("eSub");
  const eSubCustom = document.getElementById("eSubCustom");
  if (eSub) eSub.onchange = () => {
    if (eSub.value === "__custom") { eSubCustom.style.display = ""; eSubCustom.focus(); }
    else eSubCustom.style.display = "none";
  };

  // Save
  const eSave = document.getElementById("eSave");
  if (eSave) eSave.onclick = async () => {
    const msg = document.getElementById("eMsg");
    const body = {
      display_name: document.getElementById("eName").value.trim(),
      subtype: eSub.value === "__custom" ? eSubCustom.value.trim() : eSub.value,
      status: document.getElementById("eStatus").value,
    };
    msg.className = "msg"; msg.textContent = "saving…";
    const r = await apiPatch("/v1/entities/" + encodeURIComponent(id), body);
    if (r.error) { msg.className = "msg bad"; msg.textContent = "error: " + r.error; return; }
    msg.className = "msg ok"; msg.textContent = "saved";
    await loadPeople();
    const row = document.querySelector("#orgList .ent[data-id='" + CSS.escape(id) + "'], #acctList .ent[data-id='" + CSS.escape(id) + "']");
    if (row) showEntity(id, row);
  };

  // Confirm
  const eConfirm = document.getElementById("eConfirm");
  if (eConfirm) eConfirm.onclick = async () => {
    const r = await apiPost("/v1/entities/confirm", { entity_id: id });
    if (r.error) return;
    await loadPeople();
    const row = document.querySelector("#orgList .ent[data-id='" + CSS.escape(id) + "'], #acctList .ent[data-id='" + CSS.escape(id) + "']");
    if (row) showEntity(id, row);
  };

  // Merge
  const eMergeBtn = document.getElementById("eMergeBtn");
  if (eMergeBtn) eMergeBtn.onclick = async () => {
    const into = document.getElementById("eMerge").value;
    if (!into) return;
    if (!confirm("Merge this " + ent.kind + " into the selected target? This cannot be undone.")) return;
    const r = await apiPost("/v1/entities/merge", { from_id: id, into_id: into });
    if (r.error) { alert(r.error); return; }
    selectedPersonId = null;
    const old = document.querySelector(".detail-inline");
    if (old) old.remove();
    await loadPeople();
  };

  // Delete
  const eDelete = document.getElementById("eDelete");
  if (eDelete) eDelete.onclick = async () => {
    const msg = document.getElementById("eDelMsg");
    if (!confirm("Delete " + ent.display_name + "? Documents referencing it will be reassigned to Unidentified.")) return;
    msg.className = "msg"; msg.textContent = "deleting…";
    let r = await apiDelete("/v1/entities/" + encodeURIComponent(id));
    if (r.error === "entity_in_use") {
      if (!confirm(r.message + "\n\nForce delete and reassign documents?")) {
        msg.className = "msg bad"; msg.textContent = r.message; return;
      }
      r = await apiDelete("/v1/entities/" + encodeURIComponent(id) + "?force=1");
    }
    if (r.error) { msg.className = "msg bad"; msg.textContent = "error: " + r.error; return; }
    msg.className = "msg ok"; msg.textContent = "deleted";
    const old = document.querySelector(".detail-inline");
    if (old) old.remove();
    await loadPeople();
  };
}

