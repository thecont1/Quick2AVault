// ════════════════════════════════════════════════════════════════════════
// LEARNING TAB
// ════════════════════════════════════════════════════════════════════════
let learnEnabled = true;
async function loadLearning() {
  const l = await api("/v1/learning");
  learnEnabled = l.enabled !== false;
  document.getElementById("learnStatus").textContent =
    "Learning is " + (learnEnabled ? "ON" : "OFF") + " · " + esc(l.answered || 0) + " questions answered";
  document.getElementById("learnBudget").textContent = "Question budget: " + esc(l.budget);
  const tBtn = document.getElementById("learnToggle");
  tBtn.textContent = learnEnabled ? "Turn off" : "Turn on";
  tBtn.onclick = async () => {
    const r = await apiPost("/v1/learning/toggle", { enabled: !learnEnabled });
    if (!r.error) loadLearning();
  };

  const qs = l.questions || [];
  document.getElementById("qCount").textContent = "· " + qs.length + " open";
  document.getElementById("qList").innerHTML = !qs.length
    ? "<div class='empty'>No open questions.</div>"
    : qs.map((q) => {
      const opts = (q.options || []);
      const optBtns = opts.map((o) =>
        "<button class='a' data-qid='" + esc(q.id) + "' data-ans='" + esc(o) + "'>" + esc(o) + "</button>").join("");
      const ctx = q.context ? (typeof q.context === "string" ? q.context : JSON.stringify(q.context, null, 1)) : "";
      return "<div class='qcard' data-qid='" + esc(q.id) + "'>"
        + "<div class='trig'>" + esc(q.trigger) + "</div>"
        + "<div class='q'>" + esc(q.question) + "</div>"
        + (ctx ? "<div class='ctx'>" + esc(ctx) + "</div>" : "")
        + "<div class='opts'>" + optBtns
        + "<button class='d' data-qid='" + esc(q.id) + "' data-dismiss='1'>Dismiss</button></div></div>";
    }).join("");

  document.querySelectorAll("#qList .a").forEach((b) => b.onclick = async () => {
    const r = await apiPost("/v1/learning/answer", { review_id: Number(b.dataset.qid), answer: b.dataset.ans });
    if (!r.error) loadLearning();
  });
  document.querySelectorAll("#qList .d").forEach((b) => b.onclick = async () => {
    const r = await apiPost("/v1/learning/dismiss", { review_id: Number(b.dataset.qid) });
    if (!r.error) loadLearning();
  });

  const rules = l.rules || [];
  document.getElementById("rCount").textContent = "· " + rules.length + " active";
  document.getElementById("rList").innerHTML = !rules.length
    ? "<div class='empty'>No learned rules yet.</div>"
    : rules.map((r) =>
      "<div class='rule'><span class='k'>" + esc(r.kind) + "</span>"
      + "<span class='v'>" + esc(r.match_key) + " → " + esc(r.value) + "</span>"
      + "<span class='n'>applied " + esc(r.times_applied) + "×</span></div>"
    ).join("");

  const answered = l.answered_questions || [];
  document.getElementById("aCount").textContent = "· " + answered.length + " answered";
  document.getElementById("aList").innerHTML = !answered.length
    ? "<div class='empty'>No answered questions yet.</div>"
    : answered.map((a) =>
      "<div class='rule'><span class='k'>" + esc(a.trigger) + "</span>"
      + "<span class='v'>" + esc(a.question) + " → <b style='color:var(--ok)'>" + esc(a.answer) + "</b></span>"
      + "<span class='n'>" + esc(String(a.answered_at || "").slice(0, 19)) + "</span></div>"
    ).join("");
}
