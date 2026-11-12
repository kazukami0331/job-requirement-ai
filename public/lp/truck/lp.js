/* ドライバーJob（トラック）LP 共通スクリプト
 * - 来訪者の振り分けモーダル（index.html のみ）: 広告運用前のため、訪問のたびに毎回表示する（保存による非表示はしない）
 * - リード獲得モーダル: 1 連絡先 → 2〜4 任意アンケート → 完了
 * - デモ版のため送信先APIは未接続（DEMO = true の間は入力内容をどこにも送らない）。
 *   本番化するときは driver-career-lp の /api/lead と同じ受け口を用意し、DEMO を false にする
 */
(function(){
  "use strict";
  var CFG = window.LP_CONFIG || {};
  var LP_ID = CFG.lpId || "truck";
  var DEMO = true;
  var API_URL = "/api/lead";
  var SUBMIT_LABEL = "送信して申し込む（無料）";

  function pushDL(obj){ window.dataLayer = window.dataLayer || []; window.dataLayer.push(obj); }

  var qs = new URLSearchParams(location.search);
  ["gclid","utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach(function(k){
    var v = qs.get(k);
    try { if (v) sessionStorage.setItem("lp_" + k, v); } catch (_) {}
  });
  function param(k){ try { return sessionStorage.getItem("lp_" + k) || ""; } catch (_) { return ""; } }

  var modal = document.getElementById("leadModal");
  var dialog = modal.querySelector(".lm-dialog");
  var form = document.getElementById("leadForm");
  var submitBtn = document.getElementById("leadSubmit");
  var spinner = document.getElementById("leadSpinner");
  var submitLabel = document.getElementById("leadSubmitLabel");
  var globalErr = document.getElementById("leadGlobalErr");
  var steps = modal.querySelectorAll(".sv-step");
  var TOTAL = steps.length - 1; // 最後の1つは完了画面
  var current = 1, submitted = false, submitting = false, surveySent = false, openedAt = 0, lastFocused = null;
  var pref = {};
  var lead = { name: "", email: "" };

  function showStep(n){
    current = n;
    Array.prototype.forEach.call(steps, function(el){ el.hidden = (parseInt(el.getAttribute("data-step"), 10) !== n); });
    var prog = document.getElementById("svProgress");
    prog.hidden = (n === 1 || n > TOTAL);
    if (n > 1 && n <= TOTAL) {
      document.getElementById("svCount").textContent = "質問 " + (n - 1) + "/" + (TOTAL - 1);
      document.getElementById("svBarFill").style.width = ((n - 1) / (TOTAL - 1) * 100) + "%";
    }
    dialog.scrollTop = 0;
    if (n === 1) setTimeout(function(){ document.getElementById("leadName").focus(); }, 60);
    pushDL({ event: "lead_step_view", lead_step: n });
  }

  modal.addEventListener("click", function(e){
    var chip = e.target.closest(".sv-chip");
    if (chip) {
      var single = chip.closest("[data-sv-single]");
      if (single) {
        Array.prototype.forEach.call(single.querySelectorAll(".sv-chip"), function(c){ c.setAttribute("aria-pressed", c === chip ? "true" : "false"); });
        pref[single.getAttribute("data-sv-single")] = [chip.getAttribute("data-v")];
        return;
      }
      var multi = chip.closest("[data-sv-multi]");
      if (!multi) return;
      var key = multi.getAttribute("data-sv-multi");
      var list = pref[key] = pref[key] || [];
      var v = chip.getAttribute("data-v");
      var on = chip.getAttribute("aria-pressed") === "true";
      if (!on) {
        // data-exclusive のチップ（「まだ決めていない」など）は他と同時に選べない
        var ex = chip.hasAttribute("data-exclusive");
        Array.prototype.forEach.call(multi.querySelectorAll(".sv-chip[aria-pressed='true']"), function(c){
          if (ex !== c.hasAttribute("data-exclusive")) {
            c.setAttribute("aria-pressed", "false");
            list.splice(list.indexOf(c.getAttribute("data-v")), 1);
          }
        });
      }
      chip.setAttribute("aria-pressed", on ? "false" : "true");
      var i = list.indexOf(v);
      if (on && i > -1) list.splice(i, 1);
      if (!on && i === -1) list.push(v);
      return;
    }
    if (e.target.closest("[data-sv-next]")) { if (current < TOTAL) showStep(current + 1); else finishSurvey(); return; }
    if (e.target.closest("[data-sv-back]")) { if (current > 2) showStep(current - 1); return; }
  });

  function openModal(cta){
    var wasHidden = modal.hidden;
    if (wasHidden) pushDL({ event: "lead_open", lead_cta: cta || "" });
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    openedAt = Date.now();
    lastFocused = document.activeElement;
    if (wasHidden) showStep(submitted ? Math.max(current, 2) : 1);
  }
  function closeModal(){
    if (submitting) return;
    if (submitted && current <= TOTAL) { finishSurvey(); return; }
    if (!modal.hidden && !submitted) pushDL({ event: "lead_modal_close", lead_step: current });
    modal.hidden = true;
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }
  document.addEventListener("click", function(e){
    var opener = e.target.closest("[data-open-lead]");
    if (opener) { e.preventDefault(); openModal(opener.getAttribute("data-cta")); return; }
    if (e.target.closest("[data-close-lead]") && !modal.hidden) closeModal();
  });
  modal.addEventListener("mousedown", function(e){ if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", function(e){
    if (modal.hidden) return;
    if (e.key === "Escape") { closeModal(); return; }
    if (e.key === "Tab") {
      var list = Array.prototype.filter.call(dialog.querySelectorAll("a[href], button:not([disabled]), input, [tabindex]:not([tabindex='-1'])"), function(el){ return el.offsetParent !== null; });
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ===== 来訪者の振り分け（未経験/経験者）。訪問のたびに毎回表示する =====
  (function audienceGate(){
    var gate = document.getElementById("audienceGate");
    if (!gate) return;
    if (qs.get("apply") === "1") return;
    gate.hidden = false;
    document.body.style.overflow = "hidden";
    pushDL({ event: "audience_gate_view" });
    function closeGate(){ gate.hidden = true; document.body.style.overflow = ""; }
    gate.addEventListener("click", function(e){
      var btn = e.target.closest("[data-ag]");
      if (btn) {
        var a = btn.getAttribute("data-ag");
        pushDL({ event: "audience_gate_select", audience: a });
        if (a === "experienced") { location.href = "experienced.html" + location.search; return; }
        closeGate();
        return;
      }
      if (e.target === gate) { pushDL({ event: "audience_gate_dismiss" }); closeGate(); }
    });
    document.addEventListener("keydown", function(e){ if (!gate.hidden && e.key === "Escape") { pushDL({ event: "audience_gate_dismiss" }); closeGate(); } });
  })();

  if (qs.get("apply") === "1") openModal("apply_param");

  // ===== 連絡先フォーム =====
  function fieldErr(input, msg){
    var p = input.closest(".lm-field").querySelector(".lm-err");
    if (msg) { p.textContent = msg; p.hidden = false; input.classList.add("lm-invalid"); }
    else { p.hidden = true; input.classList.remove("lm-invalid"); }
    return !msg;
  }
  function validate(){
    var name = document.getElementById("leadName");
    var email = document.getElementById("leadEmail");
    var phone = document.getElementById("leadPhone");
    var ok = fieldErr(name, name.value.trim() ? "" : "お名前を入力してください");
    ok = fieldErr(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()) ? "" : "メールアドレスの形式が正しくありません") && ok;
    var pv = phone.value.replace(/[‐－ー\-\s]/g, "");
    ok = fieldErr(phone, /^0\d{9,10}$/.test(pv) ? "" : (pv === "" ? "電話番号を入力してください" : "電話番号の形式が正しくありません（例：090-1234-5678）")) && ok;
    return ok;
  }
  function setSubmitting(v){
    submitting = v;
    submitBtn.disabled = v;
    spinner.hidden = !v;
    submitLabel.textContent = v ? "送信中…" : SUBMIT_LABEL;
  }
  function post(body){
    if (DEMO) return Promise.resolve({ ok: true });
    return fetch(API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true })
      .then(function(r){ if (!r.ok) throw new Error("http " + r.status); return r.json(); });
  }
  function tracking(){
    return { gclid: param("gclid"), utm_source: param("utm_source"), utm_medium: param("utm_medium"), utm_campaign: param("utm_campaign"), utm_term: param("utm_term"), utm_content: param("utm_content") };
  }
  function finishSurvey(){
    if (!surveySent) {
      surveySent = true;
      var answered = Object.keys(pref).some(function(k){ return pref[k].length; });
      pushDL({ event: "lead_survey_finish", survey_answered: answered ? 1 : 0 });
      if (answered) post(Object.assign({ type: "survey", silent: true, lp: LP_ID, name: lead.name, email: lead.email }, pref, tracking())).catch(function(){});
    }
    document.getElementById("leadModalTitle").textContent = "ご登録ありがとうございます";
    showStep(TOTAL + 1);
  }
  form.addEventListener("submit", function(e){
    e.preventDefault();
    globalErr.hidden = true;
    if (!validate()) return;
    setSubmitting(true);
    var payload = Object.assign({
      name: document.getElementById("leadName").value.trim(),
      email: document.getElementById("leadEmail").value.trim(),
      phone: document.getElementById("leadPhone").value.trim(),
      lp: LP_ID,
      company: form.querySelector("input[name=company]").value,
      elapsedMs: Date.now() - openedAt
    }, tracking());
    post(payload).then(function(d){
      if (!d.ok) throw new Error("api error");
      lead.name = payload.name; lead.email = payload.email;
      pushDL({ event: "form_submit_success" });
      submitted = true;
      setSubmitting(false);
      document.getElementById("leadModalTitle").textContent = "送信ありがとうございます！";
      showStep(2);
    }).catch(function(){
      setSubmitting(false);
      globalErr.textContent = "送信に失敗しました。時間をおいて再度お試しください。";
      globalErr.hidden = false;
    });
  });

  // よくある質問の開閉（どの質問か）
  Array.prototype.forEach.call(document.querySelectorAll("#faq details"), function(d){
    d.addEventListener("toggle", function(){ if (d.open) pushDL({ event: "faq_open", faq_q: d.querySelector("summary").textContent.trim() }); });
  });
})();
