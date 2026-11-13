// TX Case Desk — Case Desk Assistant (read-only) and the daily brief on Today.
// The button lives in the top bar (its own space: it never covers tabs, buttons or cards). Tapping it opens the assistant
// already knowing the page: a side panel on desktop, a full-screen sheet on phones. Open/closed is remembered per person.
// Uses helpers from app.js: $, $$, esc, api, toast, me, tab, ic, nav, closeSheet.
(() => {
  const NAME = "Case Desk Assistant";
  const wide = () => window.matchMedia("(min-width:1000px)").matches;
  const S = { open: false, thread: null, threadCase: null, msgs: [], busy: false, view: "chat", restored: false };
  let panel = null;

  // what the person is looking at (set by the case hub and the calendar sheet; cleared when the screen changes)
  window.assistCtx = { case_id: null, case_label: null, event_id: null };
  const ctxNow = () => ({ screen: (typeof titleOf === "function" ? titleOf(tab) : tab), case_id: assistCtx.case_id, event_id: assistCtx.event_id });

  // ---------- rendering answers: plain text, **bold**, "- " lists, [[case:ID]] links (only to cases the server checked) ----------
  function render(text, links) {
    const L = new Map((links || []).map(l => [+l.id, l.label]));
    const inline = s => esc(s).replace(/\*\*([^*]{1,200})\*\*/g, "<b>$1</b>")
      .replace(/\[\[case:(\d{1,9})\]\]/g, (m, id) => L.has(+id) ? `<button type="button" class="caselink" data-ascase="${+id}">${esc(L.get(+id))}</button>` : "");
    const out = []; let list = null;
    for (const line of String(text || "").split("\n")) {
      const li = line.match(/^\s*[-•*]\s+(.*)$/);
      if (li) { if (!list) { list = []; out.push(list); } list.push(inline(li[1])); continue; }
      list = null; if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    return out.map(x => Array.isArray(x) ? `<ul>${x.map(i => `<li>${i}</li>`).join("")}</ul>` : x).join("");
  }
  function wireLinks(root) {
    root.querySelectorAll("[data-ascase]").forEach(b => b.onclick = () => { if (!wide()) setOpen(false); window.caseHub && caseHub(+b.dataset.ascase); });
    root.querySelectorAll("[data-assignup]").forEach(b => b.onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/?signup=1"; });
    root.querySelectorAll("[data-asfirm]").forEach(b => b.onclick = () => { if (!wide()) setOpen(false); window.fsSecGo = "ai"; nav("firm"); });
  }
  // a plain error, with a Sign up button when the demo's AI allowance is used up
  const errHtml = e => `<div>${esc(e.message || "The AI service didn't answer.")}</div>${e.code === "DEMO_CAP" ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-assignup>Sign up</button></div>`
    : e.code === "NO_KEY" && me && me.role === "admin" && !me.demo ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm ghost" data-asfirm>Open Firm Settings → AI (Claude)</button></div>` : ""}`;
  window.assistErrHtml = errHtml; window.assistWire = wireLinks; window.assistRender = render;

  // ---------- talking to the assistant: speak, it sends when you stop, the answer is read out loud, then it listens again ----------
  // Uses the phone's or browser's own speech (nothing extra is recorded or kept). Hands-free until End, a typed question,
  // closing the panel, or a turn where nothing is said.
  const MIC = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"/></svg>`;
  const SPK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>`;
  const STOP = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
  const VOICE = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, syn = window.speechSynthesis;
    const V = { ok: !!SR, canSay: !!(syn && window.SpeechSynthesisUtterance), on: false, state: "idle" };
    let rec = null, gen = 0, voice = null;
    const el = id => panel && panel.querySelector(id);
    function ui(state, note) {
      V.state = state; const m = el("#asMic"), vs = el("#asVs"); if (!m || !vs) return;
      m.classList.toggle("rec", state === "listen"); m.classList.toggle("talk", state === "speak");
      m.innerHTML = state === "speak" ? STOP : MIC;
      m.setAttribute("aria-label", state === "listen" ? "Stop listening and send" : state === "speak" ? "Stop talking and listen" : state === "think" ? "Stop the voice conversation" : "Talk to the assistant");
      const t = { listen: "Listening… just talk. It sends when you stop.", think: "Looking that up…", speak: "Answering out loud. Tap ■ to cut in." }[state];
      vs.hidden = !(V.on && t) && !note; vs.dataset.state = state;
      el("#asVsT").textContent = note || t || ""; el("#asVsEnd").hidden = !V.on;
    }
    // the voices this device has: English first (US first), then the rest; names differ per device
    V.list = () => { if (!syn) return []; const all = syn.getVoices() || [], en = all.filter(v => /^en/i.test(v.lang));
      return (en.length ? en : all).slice().sort((a, b) => (/^en[-_]US/i.test(b.lang) - /^en[-_]US/i.test(a.lang)) || a.name.localeCompare(b.name)); };
    const pref = k => (me && me.prefs || {})[k];
    V.length = () => { const l = pref("assistant_length"); return l === "short" || l === "full" ? l : "normal"; };
    V.rate = () => { const r = +pref("assistant_voice_rate"); return r >= 0.7 && r <= 1.5 ? r : 1.03; };
    V.chosen = () => { const n = pref("assistant_voice_name"); return n ? V.list().find(v => v.name === n) || null : null; };
    function pick() {
      const c = V.chosen(); if (c) return c;
      if (voice || !syn) return voice; const all = syn.getVoices().filter(v => /^en[-_]US/i.test(v.lang));
      return voice = all.find(v => /natural|neural|premium|enhanced/i.test(v.name)) || all.find(v => /Google US English|Samantha|Aria|Jenny/i.test(v.name)) || all.find(v => v.localService) || all[0] || null;
    }
    let vkey = "";   // redraw the menu only when the voice list really changed, and never while someone is using it (an open phone picker would close)
    if (syn && syn.addEventListener) syn.addEventListener("voiceschanged", () => { voice = null;
      const k = V.list().map(v => v.name).join("|"); if (k === vkey) return; vkey = k;
      const m = el("#asVm"); if (panel && m && !m.hidden && !m.contains(document.activeElement)) V.menu(true); });
    // what is read aloud: no markdown, case links read as the case name, list items as sentences
    V.plain = (text, links) => { const L = new Map((links || []).map(l => [+l.id, l.label]));
      return String(text || "").replace(/\[\[case:(\d{1,9})\]\]/g, (m, id) => L.get(+id) || "").replace(/\*\*/g, "").replace(/^\s*[-•*]\s+(.*?)[.;:]?\s*$/gm, "$1.")
        .replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").replace(/\s+([.,;:?!])/g, "$1").trim(); };
    // long answers are read in short pieces (Chrome stops one piece after ~15 seconds). Split only at a period followed by a space,
    // so "§ 16.003" and "$1,250.50" stay whole; very long sentences break at a comma or space. (No lookbehind: older iOS can't parse it.)
    const chunks = t => t.replace(/([.!?]+["')\]]*)\s+/g, "$1\n").split("\n")
      .flatMap(s => { s = s.trim(); const o = []; while (s.length > 200) { let k = s.lastIndexOf(", ", 200); if (k < 80) k = s.lastIndexOf(" ", 200); if (k < 1) k = 200; o.push(s.slice(0, k + 1).trim()); s = s.slice(k + 1).trim(); } if (s) o.push(s); return o; })
      .reduce((o, s) => { const l = o[o.length - 1]; if (l && (l + " " + s).length < 220) o[o.length - 1] = l + " " + s; else o.push(s); return o; }, []);
    window.assistChunks = chunks;   // pure; used by the tests
    let backup = 0;
    const hush = () => { clearTimeout(backup); if (syn && (syn.speaking || syn.pending)) try { syn.cancel(); } catch (e) {} };
    V.replaying = false;
    V.say = (text, links, thenListen, note) => {
      if (!V.canSay) return thenListen && V.on ? V.end("This browser can't read answers out loud; the answer is on screen.") : undefined;
      if (!thenListen && V.on) V.end();   // a replay ends the hands-free conversation (and gives back a half-typed question)
      const my = ++gen; stopRec(); hush();
      const parts = chunks(V.plain(text, links)); if (!parts.length) return thenListen && V.on ? listen() : ui("idle");
      V.replaying = !thenListen; ui(thenListen ? "speak" : "idle", thenListen ? undefined : note); if (!thenListen) draw();
      const done = () => { if (my !== gen) return; gen++; clearTimeout(backup); V.q = [];
        if (V.replaying) { V.replaying = false; draw(); }
        if (thenListen && V.on && S.open) { const g = gen; setTimeout(() => g === gen && V.on && listen(), 250); } else if (!V.on) ui("idle", thenListen ? undefined : note); };
      V.q = [];   // kept referenced: Chrome can drop an unreferenced piece and never say it finished
      parts.forEach((p, i) => { const u = new SpeechSynthesisUtterance(p); const v = pick(); if (v) u.voice = v; u.lang = v ? v.lang : "en-US"; u.rate = V.rate();
        if (i === parts.length - 1) u.onend = u.onerror = done;
        V.q.push(u); syn.speak(u); });
      // backup in case the browser never reports the end (about 90 ms a character, plus slack)
      const check = () => { if (my !== gen) return; if (syn.speaking || syn.pending) backup = setTimeout(check, 5000); else done(); };   // still reading: check again in 5 s
      backup = setTimeout(check, parts.join(" ").length * 90 + 3000);
    };
    V.hushReplay = () => { gen++; hush(); V.replaying = false; draw(); };
    function stopRec() { clearTimeout(V.quiet); if (rec) { const r = rec; rec = null; r.onresult = r.onend = r.onerror = null; try { r.abort(); } catch (e) {} } }
    let draft = "";
    function listen(keepUnlock) {
      if (!V.on || !panel) return;
      if (S.busy) return V.end("Wait for the answer to finish, then tap the mic.");
      stopRec(); if (keepUnlock) clearTimeout(backup); else hush(); if (V.replaying) { V.replaying = false; draw(); }   // don't cancel the silent unlock word on the first tap
      const inp = el("#asIn"), my = ++gen; if (inp.value.trim()) draft = inp.value; inp.value = "";
      const r = rec = new SR(); r.lang = "en-US"; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      let fin = "", err = null;
      r.onresult = e => { let f = "", t = ""; for (let i = 0; i < e.results.length; i++) { const x = e.results[i][0].transcript; if (e.results[i].isFinal) f += x; else t += x; }
        fin = f; inp.value = (f + t).replace(/\s+/g, " ").trim();
        // some phones (iOS) keep listening after you go quiet: 1.5 seconds with no new words sends it
        clearTimeout(V.quiet); if (inp.value) V.quiet = setTimeout(() => { if (rec === r) try { r.stop(); } catch (x) {} }, 1500); };
      r.onerror = e => { err = e.error; };
      r.onend = () => { if (rec !== r || my !== gen) return; rec = null; clearTimeout(V.quiet);
        const text = (fin || inp.value).replace(/\s+/g, " ").trim();
        if (err === "not-allowed" || err === "service-not-allowed") return V.end("Allow the microphone for this site in your browser settings, then tap the mic.");
        if (err === "audio-capture") return V.end("No microphone found. Plug one in or check your settings, then tap the mic.");
        if (err === "network") return V.end("Speech recognition needs an internet connection. Tap the mic to try again.");
        if (!text) return V.end("Didn't hear anything. Tap the mic to talk.");
        draft = ""; inp.value = text; ui("think"); send(true); };
      try { r.start(); ui("listen"); } catch (e) { rec = null; V.end("The microphone didn't start. Tap the mic to try again."); }
    }
    V.tap = () => {
      if (!V.ok) return toast("Talking to the assistant needs Chrome, Edge or Safari.");
      if (!V.enabled()) return;
      if (V.state === "listen" && rec) { try { rec.stop(); } catch (e) {} return; }      // done talking: send now
      if (V.state === "think") return V.end();                                          // waiting on an answer: stop the conversation
      // phones only allow reading aloud after a tap: a silent word now lets the answer be read later
      let first = false;
      if (V.canSay && !V.unlocked) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; syn.speak(u); } catch (e) {} V.unlocked = first = true; }
      V.on = true; listen(first && V.state !== "speak" && !V.replaying);                                                             // start, or cut in while it's talking
    };
    V.end = note => { const was = V.on; V.on = false; gen++; stopRec(); hush(); V.replaying = false; ui("idle", note);
      const inp = el("#asIn"); if (was && draft && inp && !inp.value.trim()) inp.value = draft; draft = ""; };
    // phone locked or app switched: stop (reading can pause there and never finish)
    document.addEventListener("visibilitychange", () => { if (document.hidden && (V.on || V.replaying)) { V.end(); if (panel) draw(); } });
    // the on/off switch: per person, remembered on every device (off = no mic, no speaker buttons, nothing read aloud)
    V.enabled = () => !(me && me.prefs && me.prefs.assistant_voice === false);
    V.paint = () => { const t = el("#asVoice"), m = el("#asMic"), on = V.enabled();
      if (t) { t.innerHTML = `${SPK}<span><span class="vw">Voice </span>${on ? "on" : "off"}</span>`; t.classList.toggle("on", on);
        t.setAttribute("aria-label", `Assistant options (voice is ${on ? "on" : "off"})`); t.setAttribute("aria-expanded", String(!el("#asVm").hidden)); }
      if (m) m.hidden = !on; };
    const save = (body, local) => { if (me) me.prefs = { ...(me.prefs || {}), ...local }; api("/api/assistant/prefs", { method: "PUT", body }).catch(() => {}); };
    V.set = on => { if (!on) V.end(); save({ voice: !!on }, { assistant_voice: !!on }); draw(); V.menu(true); };
    // the Voice menu: on/off, which voice, how fast, hear a sample. Remembered per person on every device;
    // a voice another device doesn't have falls back to the best one it does have.
    const RATES = [[0.85, "Slower"], [1.03, "Normal"], [1.15, "Faster"], [1.3, "Fastest"]];
    V.menu = keep => {
      const m = el("#asVm"); if (!m) return;
      if (!keep) { m.hidden = !m.hidden; if (m.hidden) { V.paint(); return; } } else if (m.hidden) return;
      const on = V.enabled(), list = V.list(), want = pref("assistant_voice_name"), have = V.chosen(), r = V.rate();
      vkey = list.map(v => v.name).join("|"); const fid = m.contains(document.activeElement) && document.activeElement.id;
      const rateNow = RATES.reduce((a, b) => Math.abs(b[0] - r) < Math.abs(a[0] - r) ? b : a)[0];
      m.innerHTML = `<label class="asvrow"><input type="checkbox" id="asVOn" ${on ? "checked" : ""}> <span><b>Talk and hear answers</b><br><span class="ashint">${V.ok ? "Mic to ask out loud; answers are read to you." : "Answers can be read to you."}</span></span></label>
        ${V.canSay ? `<label class="asvf"><span>Voice</span><select id="asVSel" ${on ? "" : "disabled"}><option value="">Automatic (best on this device)</option>
          ${list.map(v => `<option value="${esc(v.name)}" ${have && have.name === v.name ? "selected" : ""}>${esc(v.name.replace(/^(Microsoft|Google)\s+/, ""))} · ${esc(v.lang)}</option>`).join("")}</select></label>
        ${want && !have ? `<div class="ashint asvmiss">Your chosen voice (${esc(want)}) isn't on this device, so the best one here is used.</div>` : ""}
        ${!list.length ? `<div class="ashint">This device hasn't listed its voices yet. The best one is used automatically.</div>` : ""}
        <label class="asvf"><span>Speed</span><select id="asVRate" ${on ? "" : "disabled"}>${RATES.map(([v, n]) => `<option value="${v}" ${v === rateNow ? "selected" : ""}>${n}</option>`).join("")}</select></label>` : ""}
        <label class="asvf"><span>Answers</span><select id="asVLen">${[["short", "Short summary"], ["normal", "Normal"], ["full", "Full detail"]].map(([v, n]) => `<option value="${v}" ${V.length() === v ? "selected" : ""}>${n}</option>`).join("")}</select>
          <small class="ashint">How long the assistant's answers are, typed or spoken. Spoken answers stay short unless you pick Full detail.</small></label>
        <div class="row" style="gap:8px;margin-top:4px">${V.canSay ? `<button type="button" class="btn sm ghost" id="asVTry" ${on ? "" : "disabled"}>Hear a sample</button>` : ""}<button type="button" class="btn sm" id="asVDone">Done</button></div>`;
      m.querySelector("#asVOn").onchange = e => V.set(e.target.checked);
      const sel = m.querySelector("#asVSel"); if (sel) sel.onchange = () => { voice = null; save({ voice_name: sel.value }, { assistant_voice_name: sel.value }); V.sample(); m.querySelectorAll(".asvmiss").forEach(x => x.remove()); };
      const rt = m.querySelector("#asVRate"); if (rt) rt.onchange = () => { save({ voice_rate: +rt.value }, { assistant_voice_rate: +rt.value }); V.sample(); };
      m.querySelector("#asVLen").onchange = e => save({ answer_length: e.target.value }, { assistant_length: e.target.value });
      const tr = m.querySelector("#asVTry"); if (tr) tr.onclick = () => V.sample();
      m.querySelector("#asVDone").onclick = () => { m.hidden = true; V.paint(); el("#asVoice")?.focus(); };
      if (fid) { const f = m.querySelector("#" + fid); if (f) f.focus(); }   // keep the keyboard / screen reader where it was
      V.paint();
    };
    V.sample = () => { if (!V.canSay || !V.enabled()) return; V.replayIdx = -1; V.end(); V.say("This is how the Case Desk Assistant will sound when it reads your answers.", [], false); };
    V.ui = ui;
    return V;
  })();

  // ---------- proposed date changes: a card under the answer; nothing changes until Confirm ----------
  const fdate = d => { if (!d) return "no date"; const x = new Date(d + "T12:00:00"); return x.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(x.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }); };
  const when = (d, t) => fdate(d) + (t ? " · " + t : "");
  const TYPE = { hearing: "Court date", deadline: "Deadline", meeting: "Meeting", event: "Calendar item", todo: "To-do" };
  function propHtml(ps) {
    if (!ps || !ps.length) return "";
    const pend = ps.filter(p => p.status === "pending");
    return `<div class="asprops">${ps.map(p => `<div class="asprop" data-st="${esc(p.status)}">
        <div class="aspk">${esc(TYPE[p.type] || "Item")}${p.kind === "task" ? " due date" : ""}</div>
        <div class="aspt">${esc(p.title || "")}</div>
        <div class="aspd"><span class="aspold">${esc(when(p.old_date, p.old_time))}</span> <span aria-hidden="true">→</span><span class="sr-only" style="position:absolute;left:-9999px"> to </span> <b>${esc(when(p.new_date, p.new_time))}</b></div>
        ${p.status === "pending" && p.type === "hearing" ? `<div class="aspw">This moves it in TX Case Desk only. It doesn't change the court's setting: file a motion or notice to reset it.</div>` : ""}
        ${p.status === "pending" && p.type === "deadline" ? `<div class="aspw">Check the new date against the rules and any court order. It will show as not confirmed until you confirm it on the calendar.</div>` : ""}
        ${p.status === "pending" && [0, 6].includes(new Date(p.new_date + "T12:00:00").getDay()) ? `<div class="aspw">The new date is a ${new Date(p.new_date + "T12:00:00").getDay() ? "Saturday" : "Sunday"}.</div>` : ""}
        ${p.status === "pending" ? `<div class="row asprow"><button type="button" class="btn sm" data-pconf="${+p.id}">Confirm</button><button type="button" class="btn sm ghost" data-pcan="${+p.id}">Cancel</button></div>`
          : `<div class="asps">${p.status === "applied" ? "✓ Moved." : p.status === "cancelled" ? "Cancelled. Nothing changed." : "Expired. Nothing changed; ask again if you still want it."}</div>`}
      </div>`).join("")}${pend.length > 1 ? `<div class="row asprow"><button type="button" class="btn sm" data-pall="${pend.map(p => +p.id).join(",")}">Confirm all ${pend.length}</button></div>` : ""}</div>`;
  }
  const allProps = () => S.msgs.flatMap(m => m.proposals || []);
  const setProp = np => { for (const m of S.msgs) (m.proposals || []).forEach((p, i, a) => { if (+p.id === +np.id) a[i] = np; }); };
  // after a move, redraw the page underneath only when nothing is being typed there (a redraw would lose it)
  function refreshScreen() {
    try {
      const app = document.querySelector("#app"), a = document.activeElement;
      const busy = app && ((a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || (a && app.contains(a) && a.isContentEditable)
        || [...app.querySelectorAll("textarea, input[type=text], input:not([type])")].some(x => x.value !== x.defaultValue));
      if (busy) return toast("Moved. Your screen shows it next time you open it.");
      if (assistCtx.case_id && window.caseHub && document.querySelector("#app .cdet")) caseHub(assistCtx.case_id);   // only when the case page is what's showing
      else if (["today", "calendar", "tasks", "dashboard"].includes(tab) && !(typeof subView !== "undefined" && subView) && typeof show === "function") show();
    } catch (e) {}
  }
  async function decide(ids, how) {
    let moved = 0, msg = "";
    for (const id of ids) {
      try { const r = await api(`/api/assistant/proposals/${id}/${how}`, { method: "POST" }); setProp(r.proposal); if (how === "confirm" && r.proposal.status === "applied") moved++; }
      catch (e) { if (e.data && e.data.proposal) setProp(e.data.proposal); msg = e.message || "That didn't work."; }
    }
    draw();
    if (moved) { toast(moved > 1 ? `Moved ${moved} dates.` : "Moved."); refreshScreen(); }
    if (msg) toast(msg);
  }
  function wireProps(root) {
    root.querySelectorAll("[data-pconf]").forEach(b => b.onclick = () => { b.disabled = true; decide([+b.dataset.pconf], "confirm"); });
    root.querySelectorAll("[data-pcan]").forEach(b => b.onclick = () => { b.disabled = true; decide([+b.dataset.pcan], "cancel"); });
    root.querySelectorAll("[data-pall]").forEach(b => b.onclick = () => { b.closest(".asprops").querySelectorAll("button").forEach(x => x.disabled = true); decide(b.dataset.pall.split(",").map(Number), "confirm"); });
  }

  // ---------- the panel ----------
  function build() {
    panel = document.createElement("aside"); panel.id = "asPanel"; panel.className = "asp"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", NAME);
    panel.innerHTML = `<div class="ash"><h2><span class="asfull">Case Desk </span>Assistant</h2>
        ${VOICE.ok || VOICE.canSay ? `<button type="button" class="btn sm ghost asvt" id="asVoice" aria-expanded="false" aria-controls="asVm" title="Assistant options: voice on/off, which voice, speed, answer length"></button>` : ""}
        <button type="button" class="btn sm ghost" id="asNew" title="Start a new conversation">New</button>
        <button type="button" class="btn sm ghost" id="asHist" title="Saved conversations">History</button>
        <button type="button" class="iconb" id="asX" aria-label="Close the assistant">${ic("close", 20, 2)}</button></div>
      <div class="asvm" id="asVm" hidden role="group" aria-label="Assistant options"></div>
      <div class="asctx" id="asCtx"></div>
      <div class="asbody" id="asBody" aria-live="polite"></div>
      <div class="asvs" id="asVs" hidden aria-live="polite"><span class="ddot" aria-hidden="true"></span><span id="asVsT"></span><button type="button" class="btn sm ghost" id="asVsEnd">End</button></div>
      <form class="asf" id="asF" data-nomic><label for="asIn" class="sr-only" style="position:absolute;left:-9999px">Ask the assistant</label>
        <textarea id="asIn" rows="2" placeholder="Ask about your cases, deadlines, to-dos…" maxlength="4000"></textarea>
        ${VOICE.ok ? `<button type="button" class="asmic" id="asMic" aria-label="Talk to the assistant" title="Talk: it answers out loud">${MIC}</button>` : ""}
        <button class="btn" id="asGo">Send</button></form>`;
    document.body.appendChild(panel);
    panel.querySelector("#asX").onclick = () => setOpen(false);
    const mic = panel.querySelector("#asMic"); if (mic) mic.onclick = () => VOICE.tap();
    const vt = panel.querySelector("#asVoice"); if (vt) vt.onclick = () => VOICE.menu();
    panel.querySelector("#asVsEnd").onclick = () => VOICE.end();
    panel.querySelector("#asNew").onclick = () => { VOICE.end(); S.thread = null; S.threadCase = assistCtx.case_id; S.msgs = []; S.view = "chat"; draw(); panel.querySelector("#asIn").focus(); };
    panel.querySelector("#asHist").onclick = () => { VOICE.end(); S.view = S.view === "hist" ? "chat" : "hist"; draw(); };
    panel.querySelector("#asF").onsubmit = e => { e.preventDefault(); VOICE.end(); send(); };
    panel.querySelector("#asIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && wide()) { e.preventDefault(); VOICE.end(); send(); } });
    document.addEventListener("keydown", e => { if (e.key !== "Escape" || !S.open) return;
      const vm = panel.querySelector("#asVm"); if (vm && !vm.hidden && panel.contains(document.activeElement)) { vm.hidden = true; VOICE.paint(); panel.querySelector("#asVoice")?.focus(); return; }
      if (!wide()) setOpen(false); });
  }
  function drawCtx() {
    const c = panel.querySelector("#asCtx"), x = ctxNow();
    c.innerHTML = x.case_id ? `Looking at: <b>${esc(assistCtx.case_label || "this case")}</b>` : `Screen: <b>${esc(x.screen || "")}</b>`;
  }
  function draw() {
    if (!panel) return; drawCtx(); VOICE.paint();
    const body = panel.querySelector("#asBody");
    panel.querySelector("#asF").hidden = S.view !== "chat";
    panel.querySelector("#asHist").textContent = S.view === "hist" ? "Back" : "History";
    if (S.view === "hist") return drawHist(body);
    body.innerHTML = (S.msgs.length ? "" : `<div class="ashint">${assistCtx.case_id ? `Ask about this case: what's due, the last conversation, who opposing counsel is, new court emails.`
      : `Ask about your cases: "what's due this week?", "which cases have no next court date?", "any new court emails?". I can only read your data; I can't change or send anything.`}${VOICE.ok && VOICE.enabled() ? ` Or tap the mic and just talk: it answers out loud.` : ""}</div>`)
      + S.msgs.map((m, i) => m.role === "user" ? `<div class="asm asu">${esc(m.text)}</div>` : m.role === "error" ? `<div class="asm ase">${m.html}</div>` : `<div class="asm asa">${VOICE.canSay && VOICE.enabled() ? (VOICE.replaying && VOICE.replayIdx === i ? `<button type="button" class="assay on" data-asay="${i}" aria-label="Stop reading" title="Stop reading">${STOP}</button>` : `<button type="button" class="assay" data-asay="${i}" aria-label="Read this answer out loud" title="Read out loud">${SPK}</button>`) : ""}${render(m.text, m.links)}${propHtml(m.proposals)}</div>`).join("")
      + (S.busy ? `<div class="asm asa busy ashint">Looking that up…</div>` : "");
    wireLinks(body); wireProps(body);
    body.querySelectorAll("[data-asay]").forEach(b => b.onclick = () => { if (VOICE.replaying && +b.dataset.asay === VOICE.replayIdx) return VOICE.hushReplay();
      const m = S.msgs[+b.dataset.asay]; if (m) { VOICE.replayIdx = +b.dataset.asay; VOICE.say(m.text, m.links, false); } });
    body.scrollTop = body.scrollHeight;
  }
  async function drawHist(body) {
    body.innerHTML = `<div class="ashint">Loading…</div>`;
    let r; try { r = await api("/api/assistant/threads"); } catch (e) { body.innerHTML = `<div class="asm ase">${errHtml(e)}</div>`; return; }
    body.innerHTML = `<div class="ashint">Your saved conversations. Only you see them; your firm admin can delete them.</div>`
      + (r.threads.map(t => `<div class="asth"><button type="button" class="lk" data-th="${t.id}"><b>${esc(t.title || "Conversation")}</b><br><span class="ashint">${esc(t.style ? String(t.style).slice(0, 60) + " · " : "")}${esc(new Date(t.updated_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></button>
        <button type="button" class="btn sm ghost" data-thdel="${t.id}" aria-label="Delete this conversation">Delete</button></div>`).join("") || `<div class="ashint">No saved conversations yet.</div>`)
      + (r.threads.length ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm danger" id="asDelAll">Delete all my conversations</button></div>` : "");
    body.querySelectorAll("[data-th]").forEach(b => b.onclick = () => loadThread(+b.dataset.th));
    body.querySelectorAll("[data-thdel]").forEach(b => b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again"; return; }
      await api(`/api/assistant/threads/${b.dataset.thdel}`, { method: "DELETE" }).catch(() => {}); if (S.thread === +b.dataset.thdel) { S.thread = null; S.msgs = []; } drawHist(body); });
    const all = body.querySelector("#asDelAll"); if (all) all.onclick = async () => { if (!all.dataset.sure) { all.dataset.sure = 1; all.textContent = "Tap again to delete all"; return; }
      await api("/api/assistant/threads", { method: "DELETE" }).catch(() => {}); S.thread = null; S.msgs = []; drawHist(body); };
  }
  async function loadThread(id) {
    try { const r = await api(`/api/assistant/threads/${id}`); S.thread = r.thread.id; S.threadCase = r.thread.case_id; S.msgs = r.messages.map(m => ({ role: m.role, text: m.text, links: m.links, proposals: m.proposals || [] })); }
    catch (e) { S.thread = null; S.msgs = [{ role: "error", html: errHtml(e) }]; }
    S.view = "chat"; draw();
  }
  // the page changed: a different case starts (or reopens) that case's conversation
  async function follow() {
    if (!S.open || !panel) return;
    const cid = assistCtx.case_id || null;
    if (cid && cid !== S.threadCase) {
      S.thread = null; S.threadCase = cid; S.msgs = [];
      try { const r = await api(`/api/assistant/threads?case_id=${cid}`); if (r.threads[0] && assistCtx.case_id === cid) return loadThread(r.threads[0].id); } catch (e) {}
    }
    draw();
  }
  window.assistFollow = () => { if (S.open) follow(); };
  window.assistOpen = () => { if (!me || me.dev_view) return; if (S.open) follow(); else setOpen(true); };
  async function send(voice) {
    const inp = panel.querySelector("#asIn"), text = inp.value.trim();
    if (!text || S.busy) return;
    let said = null; const conv = S.msgs;
    S.busy = true; S.msgs.push({ role: "user", text }); inp.value = ""; draw();
    try {
      const r = await api("/api/assistant/chat", { method: "POST", body: { message: text, thread_id: S.thread, context: { ...ctxNow(), voice: !!voice, length: VOICE.length() } } });
      if (S.msgs !== conv) { S.busy = false; draw(); return; }   // they started another conversation while waiting; this answer stays saved in its own
      S.thread = r.thread_id; if (S.threadCase == null) S.threadCase = assistCtx.case_id || null;
      S.msgs.push({ role: "assistant", text: r.reply, links: r.links, proposals: r.proposals || [] }); if (voice) said = r;
    } catch (e) { if (S.msgs !== conv) { S.busy = false; draw(); return; } S.msgs.push({ role: "error", html: errHtml(e) }); if (!inp.value) inp.value = text; if (voice) VOICE.end("The assistant didn't answer. Tap the mic to try again."); }
    S.busy = false; draw();
    // a change waiting for Confirm: read the answer, then stop listening so the tap decides (never a spoken "yes")
    if (said && VOICE.on && (said.proposals || []).some(p => p.status === "pending")) { VOICE.end(); VOICE.replayIdx = S.msgs.length - 1; VOICE.say(said.reply, said.links, false, "Tap Confirm to make the change."); }
    else if (said && VOICE.on) VOICE.say(said.reply, said.links, true);
  }
  function setOpen(on, quiet) {
    if (!panel) build();
    if (!on) { VOICE.end(); const vm = panel.querySelector("#asVm"); if (vm) vm.hidden = true; VOICE.paint(); }
    S.open = !!on; panel.hidden = !on; document.body.classList.toggle("ason", !!on);
    const b = $("#asBtn"); if (b) b.setAttribute("aria-expanded", String(!!on));
    if (on) { S.view = "chat"; follow(); if (wide()) setTimeout(() => panel.querySelector("#asIn").focus({ preventScroll: true }), 50); }
    if (!quiet && me && !me.dev_view) { me.prefs = { ...(me.prefs || {}), assistant_open: !!on }; api("/api/assistant/prefs", { method: "PUT", body: { open: !!on } }).catch(() => {}); }
  }
  // called by app.js when the signed-in shell shows (off = signed out)
  window.assistShell = off => {
    const b = $("#asBtn"); if (!b) return;
    if (off || !me || me.dev_view) { VOICE.end(); b.hidden = true; if (panel) { panel.hidden = true; document.body.classList.remove("ason"); } S.open = false; S.thread = null; S.msgs = []; return; }
    b.hidden = false;
    b.onclick = () => setOpen(!S.open);
    // remembered per person: the side panel reopens on desktop (a phone always starts on the page, not a full-screen sheet)
    if (!S.restored) { S.restored = true; if (me.prefs && me.prefs.assistant_open && wide()) setOpen(true, true); }
  };
  addEventListener("tcd:screen", () => { if (S.open && panel) follow(); });

  // ---------- the daily brief (Today) ----------
  window.assistBrief = async el => {
    if (!el || !me || me.dev_view) { if (el) el.remove(); return; }
    const head = `<div class="bh"><h2 id="tdBriefH">Daily brief</h2><button type="button" class="btn sm ghost" id="brGo">Generate brief</button></div>`;
    el.innerHTML = head + `<div class="brief mute">Loading…</div>`;
    let r; try { r = await api("/api/assistant/brief"); } catch (e) { el.innerHTML = head + `<div class="brief">${errHtml(e)}</div>`; wireLinks(el); return; }
    const show = b => {
      el.innerHTML = head + (b ? `<div class="brief">${render(b.text, b.links)}<div class="mute" style="font-size:12px;margin-top:6px">Written ${esc(new Date(b.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))} from your calendar, to-dos and court email.</div></div>`
        : `<div class="brief mute">${r.available ? "Court dates, deadlines, overdue to-dos and new court emails since yesterday, in a few lines. Tap Generate brief." : (me.demo ? "The demo's AI isn't switched on yet." : "Add your firm's Claude key in Firm Settings.")}</div>`);
      const g = el.querySelector("#brGo"); g.textContent = b ? "Refresh" : "Generate brief"; g.disabled = !r.available;
      g.onclick = async () => { g.disabled = true; g.textContent = "Writing…";
        try { const x = await api("/api/assistant/brief", { method: "POST", body: { refresh: !!b } }); r.available = true; show(x.brief); }
        catch (e) { show(b); const d = document.createElement("div"); d.className = "brief"; d.innerHTML = errHtml(e); el.appendChild(d); wireLinks(el); } };
      wireLinks(el);
    };
    show(r.brief);
  };
})();
