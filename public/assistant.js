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

  // ---------- the panel ----------
  function build() {
    panel = document.createElement("aside"); panel.id = "asPanel"; panel.className = "asp"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", NAME);
    panel.innerHTML = `<div class="ash"><h2>${NAME}</h2>
        <button type="button" class="btn sm ghost" id="asNew" title="Start a new conversation">New</button>
        <button type="button" class="btn sm ghost" id="asHist" title="Saved conversations">History</button>
        <button type="button" class="iconb" id="asX" aria-label="Close the assistant">${ic("close", 20, 2)}</button></div>
      <div class="asctx" id="asCtx"></div>
      <div class="asbody" id="asBody" aria-live="polite"></div>
      <form class="asf" id="asF"><label for="asIn" class="sr-only" style="position:absolute;left:-9999px">Ask the assistant</label>
        <textarea id="asIn" rows="2" placeholder="Ask about your cases, deadlines, to-dos…" maxlength="4000"></textarea>
        <button class="btn" id="asGo">Send</button></form>`;
    document.body.appendChild(panel);
    panel.querySelector("#asX").onclick = () => setOpen(false);
    panel.querySelector("#asNew").onclick = () => { S.thread = null; S.threadCase = assistCtx.case_id; S.msgs = []; S.view = "chat"; draw(); panel.querySelector("#asIn").focus(); };
    panel.querySelector("#asHist").onclick = () => { S.view = S.view === "hist" ? "chat" : "hist"; draw(); };
    panel.querySelector("#asF").onsubmit = e => { e.preventDefault(); send(); };
    panel.querySelector("#asIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && wide()) { e.preventDefault(); send(); } });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && S.open && !wide()) setOpen(false); });
  }
  function drawCtx() {
    const c = panel.querySelector("#asCtx"), x = ctxNow();
    c.innerHTML = x.case_id ? `Looking at: <b>${esc(assistCtx.case_label || "this case")}</b>` : `Screen: <b>${esc(x.screen || "")}</b>`;
  }
  function draw() {
    if (!panel) return; drawCtx();
    const body = panel.querySelector("#asBody");
    panel.querySelector("#asF").hidden = S.view !== "chat";
    panel.querySelector("#asHist").textContent = S.view === "hist" ? "Back" : "History";
    if (S.view === "hist") return drawHist(body);
    body.innerHTML = (S.msgs.length ? "" : `<div class="ashint">${assistCtx.case_id ? `Ask about this case: what's due, the last conversation, who opposing counsel is, new court emails.`
      : `Ask about your cases: "what's due this week?", "which cases have no next court date?", "any new court emails?". I can only read your data; I can't change or send anything.`}</div>`)
      + S.msgs.map(m => m.role === "user" ? `<div class="asm asu">${esc(m.text)}</div>` : m.role === "error" ? `<div class="asm ase">${m.html}</div>` : `<div class="asm asa">${render(m.text, m.links)}</div>`).join("")
      + (S.busy ? `<div class="asm asa busy ashint">Looking that up…</div>` : "");
    wireLinks(body); body.scrollTop = body.scrollHeight;
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
    try { const r = await api(`/api/assistant/threads/${id}`); S.thread = r.thread.id; S.threadCase = r.thread.case_id; S.msgs = r.messages.map(m => ({ role: m.role, text: m.text, links: m.links })); }
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
  async function send() {
    const inp = panel.querySelector("#asIn"), text = inp.value.trim();
    if (!text || S.busy) return;
    S.busy = true; S.msgs.push({ role: "user", text }); inp.value = ""; draw();
    try {
      const r = await api("/api/assistant/chat", { method: "POST", body: { message: text, thread_id: S.thread, context: ctxNow() } });
      S.thread = r.thread_id; if (S.threadCase == null) S.threadCase = assistCtx.case_id || null;
      S.msgs.push({ role: "assistant", text: r.reply, links: r.links });
    } catch (e) { S.msgs.push({ role: "error", html: errHtml(e) }); if (!inp.value) inp.value = text; }
    S.busy = false; draw();
  }
  function setOpen(on, quiet) {
    if (!panel) build();
    S.open = !!on; panel.hidden = !on; document.body.classList.toggle("ason", !!on);
    const b = $("#asBtn"); if (b) b.setAttribute("aria-expanded", String(!!on));
    if (on) { S.view = "chat"; follow(); if (wide()) setTimeout(() => panel.querySelector("#asIn").focus({ preventScroll: true }), 50); }
    if (!quiet && me && !me.dev_view) { me.prefs = { ...(me.prefs || {}), assistant_open: !!on }; api("/api/assistant/prefs", { method: "PUT", body: { open: !!on } }).catch(() => {}); }
  }
  // called by app.js when the signed-in shell shows (off = signed out)
  window.assistShell = off => {
    const b = $("#asBtn"); if (!b) return;
    if (off || !me || me.dev_view) { b.hidden = true; if (panel) { panel.hidden = true; document.body.classList.remove("ason"); } S.open = false; S.thread = null; S.msgs = []; return; }
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
