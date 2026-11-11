// TX Case Desk — practice screens: Today, Calendar (+ Texas deadlines), Clients, Tasks, Billing, Trust, Case hub, Firm settings.
// Uses helpers from app.js: $, $$, esc, api, toast, fail, me, META, tab, renderNav, show, VIEWS, emailView, TYPES.
(() => {
  const pf = { who: "mine", attorney: "", county: "" };       // one set of filters shared by Today, Calendar and Tasks
  const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d10 = v => v ? String(v).slice(0, 10) : "";
  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });   // the Texas date (YYYY-MM-DD), whatever the device's time zone
  const addD = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const niceDate = s => { const d = new Date(d10(s) + "T12:00:00"); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }); };
  const KIND_TAG = { hearing: ["n", "Hearing"], deadline: ["a", "Deadline"], meeting: ["k", "Meeting"], event: ["k", "Event"] };
  const go = t => { tab = t; renderNav(); show(); };
  const isLawyer = () => me.role !== "paralegal";
  const firmToggle = () => me.sees_firm && me.firm_kind !== "solo";
  let people = null, caseCache = null, caseAt = 0;
  async function loadPeople() { if (!people) people = (await api("/api/firm/people")).people; return people; }
  let counties = null, countiesAt = 0;      // every county with a case this person can see (not just "my counties")
  async function loadCounties() { if (!counties || Date.now() - countiesAt > 5 * 60e3) { counties = (await api("/api/case-counties").catch(() => ({ counties: me.counties || [] }))).counties; countiesAt = Date.now(); } return counties; }
  const countySelect = (list, sel) => `<select name="county" aria-label="County"><option value="">All counties</option>${list.map(c => `<option ${sel === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>`;
  addEventListener("tcd:cases", () => { caseCache = null; });
  async function loadCases() { if (!caseCache || Date.now() - caseAt > 60e3) { caseCache = (await api("/api/cases?view=firm")).cases; caseAt = Date.now(); } return caseCache; }
  const caseOptions = (cs, sel) => `<option value="">— No case —</option>` + cs.map(c => `<option value="${c.id}" ${+sel === c.id ? "selected" : ""}>${esc(c.cause_no)} · ${esc((c.style || "").slice(0, 50))}</option>`).join("");
  const peopleOptions = (ps, sel) => ps.map(p => `<option value="${p.id}" ${+sel === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const sure = (btn, fn) => { if (!btn.dataset.sure) { btn.dataset.sure = 1; btn.dataset.t = btn.textContent; btn.textContent = "Tap again"; setTimeout(() => { delete btn.dataset.sure; btn.textContent = btn.dataset.t; }, 3000); return; } fn(); };

  // ---------- shared filter bar ----------
  // Calendar and Tasks filters. One listener for the page: the bar is drawn after the data loads, so wiring it at
  // build time missed it (the filters did nothing). Values are drawn as "selected" in the HTML.
  const filterCb = {};
  document.addEventListener("change", e => {
    const s = e.target, bar = s && s.tagName === "SELECT" ? s.closest(".ph[data-fb]") : null;
    if (!bar || !filterCb[bar.id] || !(s.name in pf)) return;
    pf[s.name] = s.value;
    if (s.name === "attorney" && s.value) pf.who = "firm";
    if (s.name === "who" && s.value === "mine") pf.attorney = "";
    filterCb[bar.id]();
  });
  async function filterBar(id, onChange, title) {
    const ps = firmToggle() ? await loadPeople().catch(() => []) : [];
    const cos = await loadCounties();
    filterCb[id] = onChange;
    const inner = `${firmToggle() ? `<select name="who" aria-label="Show"><option value="mine"${pf.who === "mine" ? " selected" : ""}>Mine</option><option value="firm"${pf.who === "firm" ? " selected" : ""}>Whole firm</option></select>` : ""}
      ${firmToggle() ? `<select name="attorney" aria-label="Attorney"><option value="">All attorneys</option>${peopleOptions(ps.filter(p => p.role !== "paralegal"), pf.attorney)}</select>` : ""}
      ${cos.length > 1 || pf.county ? countySelect(cos, pf.county) : ""}`;
    return inner.trim() ? `<div class="ph" id="${id}" data-fb aria-label="${esc(title || "Filters")}"><div class="row">${inner}</div></div>` : "";   // nothing to filter: no empty band
  }
  const qs = extra => new URLSearchParams({ who: pf.who, attorney: pf.attorney, county: pf.county, ...(extra || {}) });

  // ---------- running timer (kept on this device; the shell shows it on every screen) ----------
  const T = TM;
  function timerCard(cs) {
    const t = T.get();
    if (!t) return `<section class="timer" aria-labelledby="tmH"><h2 id="tmH">Timer</h2><div class="sub">Keeps running while you use the rest of the app.</div>
      <div><label for="tmCase" style="color:var(--navy-ink)">Case</label><select id="tmCase">${caseOptions(cs)}</select></div>
      <button class="btn lite" id="tmStart">Start timer</button></section>`;
    return `<section class="timer" aria-labelledby="tmH"><h2 id="tmH">Timer running</h2>
      <div><div class="clock tel">${hms(Date.now() - t.start)}</div><div class="sub">${esc(t.label || "No case")}</div></div>
      <div><label for="tmDesc" style="color:var(--navy-ink)">What did you work on?</label><input id="tmDesc" placeholder="Prep for hearing"></div>
      <div class="row"><button class="btn lite" id="tmStop" style="flex:1">Stop and save</button><button class="btn ghost" id="tmCancel">Discard</button></div></section>`;
  }
  function wireTimer(cs, after) {
    if ($("#tmStart")) $("#tmStart").onclick = () => { const id = +$("#tmCase").value || null; const c = cs.find(x => x.id === id); T.set({ case_id: id, label: c ? `${c.cause_no} · ${c.style || ""}` : "", start: Date.now() }); after(); };
    if ($("#tmStop")) $("#tmStop").onclick = async () => { const t = T.get(); const mins = Math.max(1, Math.round((Date.now() - t.start) / 60000));
      try { await api("/api/time", { method: "POST", body: { case_id: t.case_id, minutes: mins, description: $("#tmDesc").value } }); T.set(null); toast(`Saved ${mins} minutes`); after(); } catch (e) { fail(e); } };
    if ($("#tmCancel")) $("#tmCancel").onclick = () => sure($("#tmCancel"), () => { T.set(null); after(); });
  }

  // ---------- shared bits for list rows ----------
  const tParts = s => { const m = String(s || "").match(/^\s*(\d{1,2}(?::\d{2})?)\s*([AP]M)?/i); return m ? [m[1], (m[2] || "").toUpperCase()] : ["All day", ""]; };
  const caseLink = c => `<button type="button" class="caselink" data-case="${c.id}">${esc(String(c.style || c.cause_no || "").slice(0, 70))}</button>`;
  function confirmBit(i) {
    if (i.kind !== "deadline" || i.src !== "event" || i.done) return "";
    return i.confirmed ? `<span class="ok">${ic("check", 16, 2)}Confirmed</span>` : `<button type="button" class="btn sm ghost" data-confirm="${i.id}">Confirm date</button>`;
  }
  // every calculated deadline waits for an attorney to confirm it
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-confirm]"); if (!b) return; b.disabled = true;
    try { await api(`/api/events/${b.dataset.confirm}`, { method: "PATCH", body: { confirm: true } }); b.outerHTML = `<span class="ok">${ic("check", 16, 2)}Confirmed</span>`; toast("Date confirmed"); }
    catch (x) { b.disabled = false; fail(x); }
  });
  const daysFrom = (a, b) => Math.round((new Date(d10(a) + "T12:00:00") - new Date(d10(b) + "T12:00:00")) / 864e5);
  const ago = s => { const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

  // ===================== TODAY =====================
  const TODAY_CARDS = [["court", "In court today"], ["deadlines", "Deadlines"], ["mail", "New from court email"], ["next", "Next 14 days"], ["timer", "Timer"], ["tasks", "My tasks"], ["glance", "At a glance (numbers)"], ["caseload", "Open cases by county"]];
  VIEWS.today = async function todayView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    $("#app").innerHTML = `<div class="card mute">Loading today…</div>`;
    const [ps, cos] = await Promise.all([firmToggle() ? loadPeople().catch(() => []) : [], loadCounties()]);
    const hid = new Set((me.prefs && me.prefs.today_hidden) || []);
    let d, cs, ib; try { [d, cs, ib] = await Promise.all([api("/api/dashboard?" + qs()), isLawyer() ? loadCases() : Promise.resolve([]), api("/api/inbox").catch(() => ({ emails: [], unread: 0 }))]); } catch (e) { return fail(e); }
    const t = d.today, hr = new Date().getHours(), first = String(me.name || "").split(/\s+/)[0];
    const longDate = new Date(t + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const courtToday = d.upcoming.filter(i => i.date === t && i.kind === "hearing");
    const nextCourt = d.upcoming.find(i => i.date > t && i.kind === "hearing");
    const dls = [...(d.overdueDl || []), ...d.upcoming.filter(i => i.kind === "deadline")];
    const other = d.upcoming.filter(i => !(i.date === t && i.kind === "hearing") && i.kind !== "deadline");
    const byDay = {}; other.forEach(i => (byDay[i.date] = byDay[i.date] || []).push(i));
    const mail = (ib.emails || []).filter(m => !m.read).slice(0, 4);
    const mine = pf.who === "mine";
    const courtRow = i => { const [tm, ap] = tParts(i.time); return `<li class="li"><div class="when tm"><span class="big">${esc(tm)}</span><span class="mute">${esc(ap)}</span></div>
      <div class="body"><span class="tt" style="font-size:15px">${esc(i.title)}</span>${i.case ? `<div>${caseLink(i.case)}</div>` : ""}
      <div class="meta">${[i.location, i.case && i.case.cause_no ? "Cause No. " + i.case.cause_no : "", !mine && i.who ? i.who : ""].filter(Boolean).map(esc).join(" · ")}</div></div>
      ${i.src === "court" ? `<span class="tag k">From court record</span>` : ""}</li>`; };
    const dlRow = i => { const n = daysFrom(i.date, t);
      const [cls, lbl] = n < 0 ? ["bad", "Overdue"] : n === 0 ? ["warn", "Due today"] : n === 1 ? ["warn", "Tomorrow"] : ["", `In ${n} days`];
      const when = n === 0 ? (i.time || "End of day") : niceDate(i.date) + (i.time ? " · " + i.time : "");
      return `<li class="li"><div class="when"><span class="lbl ${cls}">${lbl}</span><span style="font-size:13px;font-weight:500">${esc(when)}</span></div>
        <div class="body"><span class="tt">${esc(i.title)}</span><div class="meta">${i.cite ? `<span class="tag k">${esc(i.cite)}</span>` : ""}${i.case ? caseLink(i.case) : ""}${!mine && i.who ? `<span>${esc(i.who)}</span>` : ""}</div></div>
        ${confirmBit(i)}</li>`; };
    const mailRow = m => { const c = (m.cases || []).find(x => x.case) || (m.cases || [])[0];
      return `<li class="li"><span aria-hidden="true" style="width:36px;height:36px;border-radius:8px;background:var(--navy-t);color:var(--navy);display:flex;align-items:center;justify-content:center;flex:none">${ic("mail")}</span>
        <div class="body"><span class="tt">${esc(m.type && m.type !== "Email" ? m.type : (m.subject || "Court email"))}</span>
        <div class="meta">${esc([c ? (c.case && c.case.style) || c.cause_no : "", m.type && m.type !== "Email" ? String(m.subject || "").slice(0, 70) : "", ago(m.received_at)].filter(Boolean).join(" · "))}</div></div>
        <button type="button" class="btn sm ghost" data-mail="${m.id}">Open</button></li>`; };
    const gl = [["Open cases", d.open + (d.alerts ? ` · ${d.alerts} with alerts` : ""), "cases"], ["Overdue tasks", d.overdue, "tasks"]];
    if (isLawyer()) gl.push(["Hours this month", d.hours, "billing"], ["Unbilled", usd(d.unbilled), "billing"], ["Outstanding", usd(d.outstanding) + (d.outstandingCount ? ` · ${d.outstandingCount}` : ""), "billing"], ["Collected this month", usd(d.collected), "billing"]); if (isLawyer() && d.trust != null) gl.push(["Trust held", usd(d.trust), "trust"]);
    const bars = rows => { const mx = Math.max(1, ...rows.map(r => r.n)); return rows.map(r => `<div style="margin:8px 0"><div class="row" style="justify-content:space-between;font-size:14px"><span>${esc(r.k)}</span><b>${r.n}</b></div><div style="height:6px;background:var(--chip);border-radius:4px;margin-top:4px"><div style="height:6px;width:${Math.round(r.n / mx * 100)}%;background:var(--navy);border-radius:4px"></div></div></div>`).join("") || `<div class="mute">No open cases.</div>`; };
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `
      <div class="ph"><div><div class="eyebrow">${esc(longDate)}</div><h1 class="pt">${hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening"}${first ? ", " + esc(first) : ""}</h1></div>
        <div class="row" id="pfToday">${firmToggle() ? `<div class="seg" role="group" aria-label="Show"><button type="button" data-who="mine" aria-pressed="${mine}">Mine</button><button type="button" data-who="firm" aria-pressed="${!mine}">Whole firm</button></div>` : ""}
        ${firmToggle() ? `<select name="attorney" aria-label="Attorney"><option value="">All attorneys</option>${peopleOptions(ps.filter(p => p.role !== "paralegal"), pf.attorney)}</select>` : ""}
        ${cos.length > 1 || pf.county ? countySelect(cos, pf.county) : ""}
        <button type="button" class="btn ghost" id="tdCust">Customize</button></div></div>
      ${d.court_queue ? `<div class="banner"><span>${ic("inbox", 18)}<b>${d.court_queue} court notice${d.court_queue === 1 ? "" : "s"} need${d.court_queue === 1 ? "s" : ""} assigning</b><span class="mute">from the shared court inbox</span></span><button type="button" class="btn sm" data-court>Assign</button></div>` : ""}
      <div class="cols"><div class="cmain">
        <section class="box" data-card="court" aria-labelledby="tdCourt"><div class="bh"><h2 id="tdCourt">In court today</h2><a data-go="calendar">Open calendar</a></div>
          <ul style="list-style:none;margin:0;padding:0">${courtToday.map(courtRow).join("") || `<li class="empty">Nothing in court today.${nextCourt ? ` Next: <b>${esc(nextCourt.title)}</b> on ${esc(niceDate(nextCourt.date))}${nextCourt.time ? " at " + esc(nextCourt.time) : ""}${nextCourt.case ? " · " + caseLink(nextCourt.case) : ""}` : ""}</li>`}</ul>
          <div class="mute" style="padding:10px 18px;border-top:1px solid var(--line2)">Court dates on watched cases are checked every hour.</div></section>
        <section class="box" data-card="deadlines" aria-labelledby="tdDl"><div class="bh"><h2 id="tdDl">Deadlines</h2><a data-qa="deadline">Calculate a deadline</a></div>
          <ul style="list-style:none;margin:0;padding:0">${dls.map(dlRow).join("") || `<li class="empty">No deadlines in the next two weeks.</li>`}</ul></section>
        <section class="box" data-card="mail" aria-labelledby="tdMail"><div class="bh"><h2 id="tdMail">New from court email</h2><a data-court>Open court notices</a></div>
          <ul style="list-style:none;margin:0;padding:0">${mail.map(mailRow).join("") || `<li class="empty">No new court email.</li>`}</ul></section>
        <section class="box" data-card="next" aria-labelledby="tdNext"><div class="bh"><h2 id="tdNext">Next 14 days</h2><a data-go="calendar">Open calendar</a></div>
          ${Object.entries(byDay).map(([day, items]) => `<div class="dayh">${day === t ? "Today" : esc(niceDate(day))}</div><div class="dayb">${items.map(i => itemRow(i)).join("")}</div>`).join("") || `<div class="empty">Nothing else on the calendar for the next two weeks.</div>`}</section>
      </div><div class="cside">
        ${isLawyer() && !hid.has("timer") ? timerCard(cs) : ""}
        <section class="box" data-card="tasks" aria-labelledby="tdTasks"><div class="bh"><h2 id="tdTasks">${mine ? "My tasks" : "Tasks due this week"}</h2><a data-go="tasks">All tasks</a></div>
          ${d.tasksDue.slice(0, 8).map(x => { const late = x.due_date && d10(x.due_date) < t; return `<label class="tk"><input type="checkbox" data-task="${x.id}"><span>${esc(x.title)}<small${late ? ' style="color:var(--bad);font-weight:600"' : ""}>${x.cause_no ? esc(String(x.style || x.cause_no).slice(0, 44)) + " · " : ""}${late ? "Overdue · " : ""}${x.due_date ? esc(niceDate(x.due_date)) : ""}</small></span></label>`; }).join("") || `<div class="empty">No tasks due this week.</div>`}
          ${d.tasksDue.length > 8 ? `<div class="empty"><a data-go="tasks">${d.tasksDue.length - 8} more due this week</a></div>` : ""}
          <div style="padding:12px 18px;border-top:1px solid var(--line2)"><button type="button" class="btn sm ghost" data-qa="task">${ic("plus", 16, 2)}Add task</button></div></section>
        <section class="box" data-card="glance" aria-labelledby="tdGl"><div class="bh"><h2 id="tdGl">At a glance</h2>${isLawyer() && d.hoursToday ? `<span class="mute">${d.hoursToday} h logged today</span>` : ""}</div>
          <div class="glance">${gl.map(([k, v, g]) => `<button type="button" data-go="${g}"><span>${k}</span><b>${esc(String(v))}</b></button>`).join("")}</div></section>
        <section class="box" data-card="caseload" aria-labelledby="tdLoad"><div class="bh"><h2 id="tdLoad">Open cases by county</h2></div><div style="padding:0 18px 12px">${bars(d.byCounty)}
          <details style="margin-top:6px"><summary class="mute">By court</summary>${bars(d.byCourt)}</details></div></section>
      </div></div>`;
    $$("#app [data-card]").forEach(el => { if (hid.has(el.dataset.card)) el.remove(); });
    if (!$("#app .cmain").children.length && !$("#app .cside").children.length) $("#app .cmain").innerHTML = `<div class="card mute">Everything is hidden. Tap Customize to choose what you see here.</div>`;
    $("#tdCust").onclick = () => openSheet("Choose what you see on Today", `<p class="mute" style="margin:0">Saved to your sign-in, so it's the same on your phone and computer.</p>
      <div style="display:flex;flex-direction:column">${TODAY_CARDS.filter(([k]) => k !== "timer" || isLawyer()).map(([k, v]) => `<label class="ck" style="margin:0;padding:6px 0;border-top:1px solid var(--line2)"><input type="checkbox" data-tc="${k}"${hid.has(k) ? "" : " checked"}>${v}</label>`).join("")}</div>
      <div class="row"><button type="button" class="btn" id="tcSave" style="flex:1">Save</button><button type="button" class="btn ghost" id="tcAll">Show all</button></div>`, sh => {
      sh.querySelector("#tcAll").onclick = () => sh.querySelectorAll("[data-tc]").forEach(c => c.checked = true);
      sh.querySelector("#tcSave").onclick = async () => { const today_hidden = [...sh.querySelectorAll("[data-tc]")].filter(c => !c.checked).map(c => c.dataset.tc);
        try { const x = await api("/api/me/prefs", { method: "PUT", body: { today_hidden } }); me.prefs = x.prefs; closeSheet(); toast("Today updated"); todayView(); } catch (e) { fail(e); } };
    });
    $$("#app [data-go]").forEach(b => b.onclick = e => { e.preventDefault(); go(b.dataset.go); });
    $$("#app [data-court]").forEach(b => b.onclick = e => { e.preventDefault(); window.mailOpenCourt ? mailOpenCourt() : go("inbox"); });
    $$("#app [data-qa]").forEach(b => b.onclick = e => { e.preventDefault(); quickAdd(b.dataset.qa); });
    $$("#app [data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("#app [data-mail]").forEach(a => a.onclick = () => { tab = "inbox"; renderNav(); emailView(+a.dataset.mail); });
    $$("#app [data-task]").forEach(c => c.onchange = async () => { await api(`/api/tasks/${c.dataset.task}`, { method: "PATCH", body: { done: c.checked } }); toast(c.checked ? "Done" : "Reopened"); });
    $$("#pfToday [data-who]").forEach(b => b.onclick = () => { pf.who = b.dataset.who; if (pf.who === "mine") pf.attorney = ""; todayView(); });
    $$("#pfToday select").forEach(s => s.onchange = () => { pf[s.name] = s.value; if (s.name === "attorney" && s.value) pf.who = "firm"; todayView(); });
    if (isLawyer()) wireTimer(cs, todayView);
  };
  function itemRow(i, o = {}) {
    const [cls, word] = KIND_TAG[i.kind] || KIND_TAG.event;
    const [tm, ap] = tParts(i.time);
    return `<div class="it"><div class="t${o.date ? " wide" : ""}">${o.date ? `${esc(niceDate(i.date))}<small>${esc(i.time || "All day")}</small>` : `${esc(tm)}<small>${esc(ap)}</small>`}</div>
      <div class="b"><span class="h">${esc(i.title)}</span><div class="m"><span class="tag ${cls}">${word}</span>${i.src === "court" ? `<span>from court record</span>` : ""}${i.done ? `<span class="tag g">Done</span>` : ""}${i.cite ? `<span class="tag k">${esc(i.cite)}</span>` : ""}
        ${i.case && !o.noCase ? caseLink(i.case) : ""}${i.who && pf.who === "firm" ? `<span>${esc(i.who)}</span>` : ""}</div></div>${confirmBit(i)}</div>`;
  }

  // ===================== DASHBOARD (firm view for admins, partners, managers and solo; "My cases" for everyone) =====================
  const dash = { scope: null, attorney: "" };
  const short$ = n => { n = Number(n || 0); return n >= 1e6 ? "$" + (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? "$" + (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : usd(n).replace(/\.00$/, ""); };
  const niceMax = v => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  function delta(cur, prev, money) {
    if (!prev) return cur ? `<span class="mute">none last month</span>` : "";
    const d = cur - prev, pct = Math.round(d / prev * 100);
    if (!pct) return `<span class="mute">same as last month</span>`;
    return `<span class="dl ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span> <span class="mute">vs last month</span>`;
  }
  function columns(rows, o) {
    const vals = rows.map(o.value), top = niceMax(Math.max(...vals)), last = rows.length - 1;
    return `<figure class="cchart"><figcaption class="sr">${esc(o.title)}</figcaption>
      <div class="cwrap"><div class="cy" aria-hidden="true"><span>${o.tick(top)}</span><span>${o.tick(top / 2)}</span><span>0</span></div>
      <div class="cplot">${rows.map((r, i) => `<div class="ccol" tabindex="0" aria-label="${esc(o.label(r))}: ${esc(o.fmt(vals[i]))}">
        ${i === last && vals[i] ? `<span class="ccap" style="bottom:calc(${vals[i] / top * 100}% + 4px)">${esc(o.fmt(vals[i]))}</span>` : ""}
        <span class="cbar" style="height:${vals[i] / top * 100}%"></span><span class="ctip" role="tooltip">${esc(o.label(r))}<b>${esc(o.fmt(vals[i]))}</b></span></div>`).join("")}</div></div>
      <div class="cx" aria-hidden="true">${rows.map(r => `<span>${esc(o.axis(r))}</span>`).join("")}</div>
      <details class="ctable"><summary>Show as table</summary><table><thead><tr><th scope="col">${esc(o.col1)}</th><th scope="col">${esc(o.col2)}</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${esc(o.label(r))}</td><td>${esc(o.fmt(vals[i]))}</td></tr>`).join("")}</tbody></table></details></figure>`;
  }
  const hbars = rows => { const mx = Math.max(1, ...rows.map(r => r.n)); return rows.map(r => `<div class="hb"><div class="row" style="justify-content:space-between;font-size:14px"><span>${esc(r.k)}</span><b>${r.n}</b></div><div class="hbt"><span style="width:${Math.max(2, Math.round(r.n / mx * 100))}%"></span></div></div>`).join("") || `<div class="mute">No open cases.</div>`; };
  VIEWS.dashboard = async function dashboardView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    if (!dash.scope) dash.scope = me.firm_dash ? "firm" : "mine";
    $("#app").innerHTML = `<div class="card mute">Loading dashboard…</div>`;
    const solo = me.firm_kind === "solo";
    const ps = me.firm_dash && !solo ? await loadPeople().catch(() => []) : [];
    let r; try { r = await api("/api/reports?" + new URLSearchParams({ scope: dash.scope, attorney: dash.attorney })); } catch (e) { return fail(e); }
    const T = r.tiles, firm = r.scope === "firm", money = isLawyer();
    const attName = r.attorney ? (ps.find(x => x.id === r.attorney) || {}).name || "Attorney" : "";
    const title = solo ? "My practice" : firm ? (attName ? attName : "Firm dashboard") : "My dashboard";
    const month = new Date(r.today + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });
    const tile = (label, value, sub, go, warn) => `<button type="button" class="tile${warn ? " warn" : ""}" ${go ? `data-go="${go}"` : "disabled"}><span class="tl">${label}</span><span class="tv">${value}</span>${sub ? `<span class="ts">${sub}</span>` : ""}</button>`;
    const tiles = [
      tile("Open cases", T.open, `${T.newThisMonth} new this month`, "cases"),
      tile("Court dates, next 7 days", T.court7, "", "calendar"),
      tile("Overdue deadlines", T.overdueDeadlines, T.overdueDeadlines ? "need attention" : "all clear", "calendar", T.overdueDeadlines > 0),
      tile("Overdue tasks", T.overdueTasks, T.overdueTasks ? "need attention" : "all clear", "tasks", T.overdueTasks > 0),
      tile("Hours this month", T.hours, delta(T.hours, T.hoursPrev), money ? "billing" : "")];
    if (money) tiles.push(tile("Unbilled", short$(T.unbilled), "time not yet invoiced", "billing"), tile("Outstanding", short$(T.outstanding), `${T.outstandingCount} open invoice${T.outstandingCount === 1 ? "" : "s"}`, "billing"),
      tile("Collected this month", short$(T.collected), delta(T.collected, T.collectedPrev, true), "billing"));
    if (money && T.trust != null) tiles.push(tile("Trust held", short$(T.trust), "all clients", "trust"));
    const wkLbl = w => new Date(w + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const moLbl = m => new Date(m + "T12:00:00").toLocaleDateString("en-US", { month: "short" });
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `
      <div class="ph"><div><div class="eyebrow">${esc(month)}${firm && !attName && !solo ? " · every attorney" : ""}</div><h1 class="pt">${esc(title)}</h1></div>
        ${me.firm_dash && !solo ? `<div class="row" id="dashF"><div class="seg" role="group" aria-label="Show"><button type="button" data-scope="firm" aria-pressed="${firm}">Firm</button><button type="button" data-scope="mine" aria-pressed="${!firm}">My cases</button></div>
          ${firm ? `<select id="dashAtt" aria-label="Attorney"><option value="">Every attorney</option>${peopleOptions(ps.filter(x => x.role !== "paralegal"), r.attorney)}</select>` : ""}</div>` : ""}</div>
      <div class="tiles">${tiles.join("")}</div>
      <div class="cols"><div class="cmain">
        <section class="box"><div class="bh"><h2>Hours logged by week</h2><span class="mute">${firm && !attName ? "everyone" : attName ? esc(attName) : "mine"}</span></div><div style="padding:4px 18px 16px">
          ${columns(r.hoursByWeek, { title: "Hours logged by week", value: x => x.h, label: x => "Week of " + wkLbl(x.wk), axis: x => wkLbl(x.wk), fmt: v => `${v} h`, tick: v => String(Math.round(v * 10) / 10), col1: "Week", col2: "Hours" })}</div></section>
        ${money ? `<section class="box"><div class="bh"><h2>Collected by month</h2></div><div style="padding:4px 18px 16px">
          ${columns(r.collectedByMonth, { title: "Collected by month", value: x => x.v, label: x => new Date(x.mo + "T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" }), axis: x => moLbl(x.mo), fmt: v => usd(v), tick: v => short$(v), col1: "Month", col2: "Collected" })}</div></section>` : ""}
        ${r.byAttorney ? `<section class="box"><div class="bh"><h2>By attorney</h2><span class="mute">this month</span></div><div class="atts">${r.byAttorney.map(a => `<div class="att">
          <div class="row" style="justify-content:space-between"><b>${esc(a.name)}</b><span class="tag k">${esc(a.role)}</span></div>
          <dl><div><dt>Open cases</dt><dd>${a.open}</dd></div><div><dt>Hours</dt><dd>${a.hours}</dd></div>${money ? `<div><dt>Unbilled</dt><dd>${short$(a.unbilled)}</dd></div><div><dt>Outstanding</dt><dd>${short$(a.outstanding)}</dd></div><div><dt>Collected</dt><dd>${short$(a.collected)}</dd></div>` : ""}
          <div><dt>Overdue</dt><dd${a.overdueDl + a.overdueTasks ? ' class="bad"' : ""}>${a.overdueDl} date${a.overdueDl === 1 ? "" : "s"} · ${a.overdueTasks} task${a.overdueTasks === 1 ? "" : "s"}</dd></div></dl>
          <button type="button" class="btn sm ghost" data-att="${a.id}">Open ${esc(a.name.split(" ")[0])}'s dashboard</button></div>`).join("")}</div></section>` : ""}
      </div><div class="cside">
        <section class="box"><div class="bh"><h2>Needs attention</h2></div>
          ${r.attention.deadlines.map(i => `<div class="li"><div class="body"><span class="lbl bad">Overdue · ${esc(niceDate(i.date))}</span><span class="tt">${esc(i.title)}</span><div class="meta">${i.cite ? `<span class="tag k">${esc(i.cite)}</span>` : ""}${i.case ? caseLink(i.case) : ""}</div></div></div>`).join("")}
          ${r.attention.tasks.map(x => `<div class="li"><div class="body"><span class="lbl bad">Task overdue · ${esc(niceDate(x.due_date))}</span><span class="tt">${esc(x.title)}</span><div class="meta">${x.style || x.cause_no ? `<span>${esc(String(x.style || x.cause_no).slice(0, 50))}</span>` : ""}${firm && x.who ? `<span>${esc(x.who)}</span>` : ""}</div></div></div>`).join("")}
          ${!r.attention.deadlines.length && !r.attention.tasks.length ? `<div class="empty">Nothing overdue.</div>` : ""}</section>
        <section class="box"><div class="bh"><h2>Court, next 7 days</h2><a data-go="calendar">Calendar</a></div>
          ${r.next7.map(i => `<div class="li"><div class="body"><span class="lbl">${esc(niceDate(i.date))}${i.time ? " · " + esc(i.time) : ""}</span><span class="tt">${esc(i.title)}</span>${i.case ? `<div class="meta">${caseLink(i.case)}</div>` : ""}</div></div>`).join("") || `<div class="empty">No court dates this week.</div>`}</section>
        <section class="box"><div class="bh"><h2>Open cases by type</h2></div><div style="padding:0 18px 12px">${hbars(r.byType)}</div></section>
        <section class="box"><div class="bh"><h2>Open cases by county</h2></div><div style="padding:0 18px 12px">${hbars(r.byCounty)}</div></section>
      </div></div>`;
    $$("#app [data-go]").forEach(b => b.onclick = e => { e.preventDefault(); go(b.dataset.go); });
    $$("#app [data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("#dashF [data-scope]").forEach(b => b.onclick = () => { dash.scope = b.dataset.scope; dash.attorney = ""; dashboardView(); });
    if ($("#dashAtt")) $("#dashAtt").onchange = e => { dash.attorney = e.target.value; dashboardView(); };
    $$("#app [data-att]").forEach(b => b.onclick = () => { dash.attorney = b.dataset.att; dashboardView(); window.scrollTo(0, 0); });
  };

  // ===================== CALENDAR (+ Texas deadline calculator + feed) =====================
  // ===================== CALENDAR: Month, Week, Day and List views =====================
  const cal = { view: "month", anchor: null, sel: null, hide: {}, openDl: false };
  let rules = null;   // Texas deadline rules, loaded once
  const KCLS = { hearing: "k-h", deadline: "k-d", meeting: "k-m", event: "k-o" };
  const KWORD = { hearing: "Hearing", deadline: "Deadline", meeting: "Meeting", event: "Other" };
  const mins = s => { const m = String(s || "").match(/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M/i); return m ? (+m[1] % 12 + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + (+m[2] || 0) : null; };
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const D = s => new Date(s + "T12:00:00");
  const sunday = s => { const d = D(s); d.setDate(d.getDate() - d.getDay()); return ymd(d); };
  const shortT = s => { const m = mins(s); if (m == null) return ""; const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`; };
  const initialsOf = n => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join("").toUpperCase();
  function calRange() {
    const a = cal.anchor;
    if (cal.view === "month") { const f = D(a); f.setDate(1); const l = new Date(f); l.setMonth(l.getMonth() + 1); l.setDate(0); const from = sunday(ymd(f)); const end = D(ymd(l)); end.setDate(end.getDate() + (6 - end.getDay())); return { from, to: ymd(end) }; }
    if (cal.view === "week") { const from = sunday(a); return { from, to: addD(from, 6) }; }
    if (cal.view === "day") return { from: a, to: a };
    return { from: a, to: addD(a, 44) };
  }
  function calTitle(r) {
    const a = D(cal.anchor);
    if (cal.view === "month") return a.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    if (cal.view === "day") return a.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const f = D(r.from), t = D(r.to), sameM = f.getMonth() === t.getMonth();
    if (cal.view === "list") return `${f.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    return `${f.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${sameM ? t.getDate() : t.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${t.getFullYear()}`;
  }
  function calMove(n) {
    const d = D(cal.anchor);
    if (cal.view === "month") { d.setDate(1); d.setMonth(d.getMonth() + n); }
    else d.setDate(d.getDate() + n * (cal.view === "week" ? 7 : cal.view === "day" ? 1 : 45));
    cal.anchor = ymd(d); cal.sel = null; calendarView();
  }
  const chip = (i, k, firm) => `<button type="button" class="ev ${KCLS[i.kind] || "k-o"}${i.done ? " done" : ""}" data-ev="${k}" aria-label="${esc(KWORD[i.kind] || "Event")}: ${esc(i.title)}${i.time ? ", " + esc(i.time) : ""}${i.done ? ", done" : ""}">${i.time ? `<span class="et">${esc(shortT(i.time))}</span>` : ""}${i.kind === "deadline" ? "Due: " : ""}${esc(i.title)}${firm && i.who ? ` <span class="ew">${esc(initialsOf(i.who))}</span>` : ""}</button>`;

  VIEWS.calendar = async function calendarView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    if (!cal.anchor) cal.anchor = todayStr();
    $("#app").innerHTML = `<div class="card mute">Loading calendar…</div>`;
    const bar = await filterBar("pfCal", calendarView, "Calendar");
    const t = todayStr(), rg = calRange(), firm = pf.who === "firm";
    let r, cs; try { [r, cs] = await Promise.all([api("/api/calendar?" + qs(rg)), loadCases()]); if (!rules) rules = (await api("/api/deadlines/rules")).rules; } catch (e) { return fail(e); }
    const items = r.items.filter(i => !cal.hide[i.kind || "event"]);
    const byDay = {}; items.forEach((i, k) => { i._k = k; (byDay[i.date] = byDay[i.date] || []).push(i); });
    const groups = [...new Set(rules.map(x => x.group))];
    const phone = window.matchMedia("(max-width:999px)").matches;
    let body = "";
    if (cal.view === "month") {
      const days = []; for (let d = rg.from; d <= rg.to; d = addD(d, 1)) days.push(d);
      const mon = D(cal.anchor).getMonth();
      body = `<div class="mgrid" role="grid" aria-label="${esc(calTitle(rg))}"><div class="mhead" role="row">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(x => `<span role="columnheader">${x}</span>`).join("")}</div>
        ${Array.from({ length: days.length / 7 }, (_, w) => `<div class="mrow" role="row">${days.slice(w * 7, w * 7 + 7).map(d => { const its = byDay[d] || [], out = D(d).getMonth() !== mon;
          return `<div class="mcell${out ? " out" : ""}${d === t ? " today" : ""}${cal.sel === d ? " sel" : ""}" role="gridcell"><button type="button" class="mday" data-day="${d}" aria-label="${esc(D(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}, ${its.length} item${its.length === 1 ? "" : "s"}">${D(d).getDate()}</button>
            <div class="mevs">${its.slice(0, 3).map(i => chip(i, i._k, firm)).join("")}${its.length > 3 ? `<button type="button" class="more" data-day="${d}">+${its.length - 3} more</button>` : ""}</div>
            <div class="mdots" aria-hidden="true">${its.slice(0, 4).map(i => `<span class="dot ${KCLS[i.kind] || "k-o"}"></span>`).join("")}</div></div>`; }).join("")}</div>`).join("")}</div>
        ${phone ? `<div id="dayPanel">${dayList(cal.sel || (rg.from <= t && t <= rg.to ? t : cal.anchor), byDay, firm)}</div>` : ""}`;
    } else if (cal.view === "week" || cal.view === "day") {
      const days = cal.view === "day" ? [cal.anchor] : Array.from({ length: 7 }, (_, i) => addD(rg.from, i));
      if (phone) body = days.map(d => dayList(d, byDay, firm, true)).join("");
      else {
        const timed = items.filter(i => mins(i.time) != null).map(i => mins(i.time));
        const h0 = Math.min(7, ...timed.map(m => Math.floor(m / 60))), h1 = Math.max(19, ...timed.map(m => Math.ceil(m / 60) + 1));
        const H = 48, hours = Array.from({ length: h1 - h0 }, (_, i) => h0 + i);
        const col = d => { const evs = (byDay[d] || []).filter(i => mins(i.time) != null).sort((a, b) => mins(a.time) - mins(b.time));
          const lanes = []; evs.forEach(i => { const st = mins(i.time); let l = lanes.findIndex(end => end <= st); if (l < 0) { l = lanes.length; lanes.push(0); } lanes[l] = st + 60; i._lane = l; });
          const n = Math.max(1, lanes.length);
          return evs.map(i => `<div class="wev" style="top:${(mins(i.time) - h0 * 60) / 60 * H}px;height:${H - 4}px;left:calc(${i._lane / n * 100}% + 2px);width:calc(${100 / n}% - 4px)">${chip(i, i._k, firm)}</div>`).join(""); };
        body = `<div class="wk" style="--cols:${days.length}">
          <div class="wkh"><span></span>${days.map(d => `<button type="button" class="wkd${d === t ? " today" : ""}" data-gday="${d}"><small>${D(d).toLocaleDateString("en-US", { weekday: "short" })}</small><b>${D(d).getDate()}</b></button>`).join("")}</div>
          <div class="wka"><span class="wkl">All day</span>${days.map(d => `<div class="wkac">${(byDay[d] || []).filter(i => mins(i.time) == null).map(i => chip(i, i._k, firm)).join("")}</div>`).join("")}</div>
          <div class="wkb" style="height:${hours.length * H}px"><div class="wkt">${hours.map(h => `<span style="height:${H}px">${h % 12 || 12} ${h < 12 ? "AM" : "PM"}</span>`).join("")}</div>
            ${days.map(d => `<div class="wkc${d === t ? " today" : ""}" style="background-size:100% ${H}px">${col(d)}</div>`).join("")}</div></div>`;
      }
    } else {
      body = Object.keys(byDay).length ? Object.entries(byDay).map(([day, its]) => `<div class="card"><div style="font-weight:700;margin-bottom:4px">${day === t ? "Today · " : ""}${niceDate(day)}</div>${its.map(i => itemRow(i) + (i.src === "event" ? `<div class="row" style="margin:2px 0 6px 82px"><label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);margin:0"><input type="checkbox" data-done="${i.id}" ${i.done ? "checked" : ""}> Done</label><button class="btn sm ghost" data-del="${i.id}">Delete</button></div>` : "")).join("")}</div>`).join("") : `<div class="card mute">Nothing on the calendar from ${esc(niceDate(rg.from))} to ${esc(niceDate(rg.to))}.</div>`;
    }
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `${bar}
      <div class="calbar"><div class="row calnav"><button type="button" class="btn ghost sm" id="calToday">Today</button>
          <button type="button" class="iconb" id="calPrev" aria-label="Previous">${ic("back", 20, 2)}</button><button type="button" class="iconb" id="calNext" aria-label="Next">${ic("chev", 20, 2)}</button>
          <h1 class="pt calt" aria-live="polite">${esc(calTitle(rg))}</h1></div>
        <div class="row"><div class="seg" role="group" aria-label="View">${[["month", "Month"], ["week", "Week"], ["day", "Day"], ["list", "List"]].map(([k, v]) => `<button type="button" data-view="${k}" aria-pressed="${cal.view === k}">${v}</button>`).join("")}</div>
          <button type="button" class="btn" id="calAdd">${ic("plus", 18, 2)}Add</button></div></div>
      <div class="typef" role="group" aria-label="Show types">${Object.entries(KWORD).map(([k, v]) => `<button type="button" class="tf" data-kind="${k}" aria-pressed="${!cal.hide[k]}"><span class="sw ${KCLS[k]}" aria-hidden="true"></span>${v === "Other" ? "Other" : v + "s"}</button>`).join("")}</div>
      ${body}
      <details class="card" id="dlBox" ${cal.openDl ? "open" : ""} style="margin-top:16px"><summary>Texas deadline calculator</summary>
        <p class="mute" style="margin:6px 0">Counts under TRCP 4: weekends and legal holidays push the last day forward. Texas state holidays are flagged so you can check the clerk's office. Always confirm against the rules and any court order.</p>
        <div class="grid"><div class="full"><label>Deadline</label><select id="dlRule">${groups.map(g => `<optgroup label="${esc(g)}">${rules.filter(x => x.group === g).map(x => `<option value="${x.key}">${esc(x.label)} — ${esc(x.cite)}</option>`).join("")}</optgroup>`).join("")}</select></div>
        <div><label id="dlTrigLabel">Date</label><input type="date" id="dlTrig"></div>
        <div id="dlOpts" class="full"></div></div>
        <div class="row" style="margin-top:8px"><button class="btn" id="dlCalc">Calculate</button></div><div class="err" id="dlErr"></div><div id="dlOut"></div></details>
      <details class="card"><summary>See this calendar in Outlook, Google or your iPhone</summary><div id="feedBox" class="mute" style="margin-top:8px">Loading…</div></details>`;
    const open = k => evSheet(items[k], cs);
    $$("#app [data-ev]").forEach(b => b.onclick = () => open(+b.dataset.ev));
    $$("#app [data-view]").forEach(b => b.onclick = () => { cal.view = b.dataset.view; cal.sel = null; calendarView(); });
    $$("#app [data-kind]").forEach(b => b.onclick = () => { cal.hide[b.dataset.kind] = !cal.hide[b.dataset.kind]; calendarView(); });
    $("#calPrev").onclick = () => calMove(-1); $("#calNext").onclick = () => calMove(1);
    $("#calToday").onclick = () => { cal.anchor = todayStr(); cal.sel = null; calendarView(); };
    $("#calAdd").onclick = () => addSheet(cal.sel || (cal.view === "day" ? cal.anchor : t), cs);
    $$("#app [data-gday]").forEach(b => b.onclick = () => { cal.anchor = b.dataset.gday; cal.view = "day"; calendarView(); });
    $$("#app [data-day]").forEach(b => b.onclick = () => { const d = b.dataset.day;
      if (phone && cal.view === "month") { cal.sel = d; $$(".mcell.sel").forEach(x => x.classList.remove("sel")); b.closest(".mcell").classList.add("sel"); $("#dayPanel").innerHTML = dayList(d, byDay, firm); $$("#dayPanel [data-ev]").forEach(x => x.onclick = () => open(+x.dataset.ev)); $$("#dayPanel [data-addday]").forEach(x => x.onclick = () => addSheet(x.dataset.addday, cs)); }
      else { cal.anchor = d; cal.view = "day"; calendarView(); } });
    $$("#app [data-addday]").forEach(b => b.onclick = () => addSheet(b.dataset.addday, cs));
    $$("#app [data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("[data-done]").forEach(c => c.onchange = async () => { await api(`/api/events/${c.dataset.done}`, { method: "PATCH", body: { done: c.checked } }); toast(c.checked ? "Marked done" : "Reopened"); });
    $$("[data-del]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/events/${b.dataset.del}`, { method: "DELETE" }); calendarView(); }));
    $("#dlBox").ontoggle = () => cal.openDl = $("#dlBox").open;
    wireDeadline(cs, null, calendarView);
    window.calAdd = () => addSheet(t, cs);
    $("#feedBox").parentElement.ontoggle = async function () { if (!this.open || $("#feedBox").dataset.done) return; try { const f = await api("/api/calendar/feed"); $("#feedBox").dataset.done = 1; $("#feedBox").innerHTML = feedHelp(f); wireFeed(); } catch (e) { $("#feedBox").textContent = e.message; } };
  };
  function calendarView() { return VIEWS.calendar(); }   // for the helpers below
  // one day's items as a list (phone month panel, phone week/day)
  function dayList(d, byDay, firm, head) {
    const its = (byDay[d] || []).slice().sort((a, b) => (mins(a.time) ?? -1) - (mins(b.time) ?? -1));
    return `<section class="box daylist"><div class="bh"><h2>${d === todayStr() ? "Today · " : ""}${esc(D(d).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }))}</h2><button type="button" class="btn sm ghost" data-addday="${d}">${ic("plus", 16, 2)}Add</button></div>
      ${its.map(i => `<div class="dli">${chip(i, i._k, firm)}</div>`).join("") || `<div class="empty">Nothing scheduled.</div>`}</section>`;
  }
  // details for one calendar item
  function evSheet(i, cs) {
    if (!i) return;
    const isEv = i.src === "event";
    openSheet(i.title, `<div class="row" style="gap:6px"><span class="tag ${KCLS[i.kind] || "k-o"}">${KWORD[i.kind] || "Other"}</span>${i.cite ? `<span class="tag k">${esc(i.cite)}</span>` : ""}${i.done ? `<span class="tag g">Done</span>` : ""}${!isEv ? `<span class="tag k">From the court record</span>` : ""}</div>
      <dl class="kv" style="margin:0"><div><b>When</b>${esc(niceDate(i.date))}${i.time ? " · " + esc(i.time) : " · all day"}</div>${i.location ? `<div><b>Where</b>${esc(i.location)}</div>` : ""}${i.who ? `<div><b>Attorney</b>${esc(i.who)}</div>` : ""}</dl>
      ${i.case ? `<div><button type="button" class="caselink" id="evCase">${esc(i.case.style || i.case.cause_no)}</button><div class="mute">Cause ${esc(i.case.cause_no)}${i.case.county ? " · " + esc(i.case.county) + " County" : ""}</div></div>` : ""}
      ${i.notes ? `<div class="mute" style="white-space:pre-wrap;font-size:14px;color:var(--ink2)">${esc(i.notes)}</div>` : ""}
      ${isEv ? `<div class="row">${i.kind === "deadline" && !i.done ? (i.confirmed ? `<span class="ok">${ic("check", 16, 2)}Confirmed</span>` : `<button type="button" class="btn ghost" id="evConf">Confirm date</button>`) : ""}
        <button type="button" class="btn ghost" id="evDone">${i.done ? "Reopen" : "Mark done"}</button><button type="button" class="btn danger" id="evDel">Delete</button></div>` : `<p class="mute" style="margin:0">Updates automatically when the court record changes.</p>`}`, sh => {
      const c = sh.querySelector("#evCase"); if (c) c.onclick = () => { closeSheet(); caseHub(i.case.id); };
      const cf = sh.querySelector("#evConf"); if (cf) cf.onclick = async () => { await api(`/api/events/${i.id}`, { method: "PATCH", body: { confirm: true } }); closeSheet(); toast("Date confirmed"); calendarView(); };
      const dn = sh.querySelector("#evDone"); if (dn) dn.onclick = async () => { await api(`/api/events/${i.id}`, { method: "PATCH", body: { done: !i.done } }); closeSheet(); toast(i.done ? "Reopened" : "Marked done"); calendarView(); };
      const dl = sh.querySelector("#evDel"); if (dl) dl.onclick = () => sure(dl, async () => { await api(`/api/events/${i.id}`, { method: "DELETE" }); closeSheet(); toast("Deleted"); calendarView(); });
    });
  }
  // add a hearing, meeting or other item on a day
  function addSheet(day, cs) {
    openSheet("Add to calendar", `<form id="evF"><div class="grid">
        <div class="full"><label for="evT">What</label><input id="evT" name="title" required placeholder="Mediation with opposing counsel"></div>
        <div><label for="evD">Date</label><input id="evD" type="date" name="on_date" required value="${esc(day)}"></div><div><label for="evH">Time</label><input id="evH" name="at_time" placeholder="10:00 AM"></div>
        <div><label for="evK">Type</label><select id="evK" name="kind"><option value="hearing">Hearing</option><option value="deadline">Deadline</option><option value="meeting">Meeting</option><option value="event" selected>Other</option></select></div>
        <div class="full"><label for="evC">Case</label><select id="evC" name="case_id">${caseOptions(cs)}</select></div>
        <div class="full"><label for="evW">Where</label><input id="evW" name="location"></div><div class="full"><label for="evN">Notes</label><input id="evN" name="notes"></div></div>
        <div class="err"></div><button class="btn wide">Add</button></form>
      <p class="mute" style="margin:0">For a rule-based deadline, use the Texas deadline calculator below the calendar.</p>`, sh => {
      sh.querySelector("#evF").onsubmit = async e => { e.preventDefault(); try { await api("/api/events", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); closeSheet(); toast("Added"); cal.anchor = e.target.on_date.value; calendarView(); } catch (x) { e.target.querySelector(".err").textContent = x.message; } };
    });
  }

  function wireDeadline(cs, caseId, after) {
    const sync = () => { const r = rules.find(x => x.key === $("#dlRule").value); $("#dlTrigLabel").textContent = r.trigger; $("#dlOpts").innerHTML =
      (r.mail ? `<label style="display:flex;gap:6px;align-items:center;font-size:14px;color:var(--ink)"><input type="checkbox" id="dlMail" style="width:auto"> Served by mail (+3 days, TRCP 21a(c))</label>` : "") +
      (r.extended ? `<label style="display:flex;gap:6px;align-items:center;font-size:14px;color:var(--ink)"><input type="checkbox" id="dlExt" style="width:auto"> A timely motion for new trial / to modify / to reinstate, or request for findings, was filed (90 days)</label>` : ""); };
    $("#dlRule").onchange = () => { sync(); $("#dlOut").innerHTML = ""; }; sync();
    $("#dlCalc").onclick = async () => {
      $("#dlErr").textContent = ""; const body = { rule: $("#dlRule").value, trigger: $("#dlTrig").value, mail: !!($("#dlMail") && $("#dlMail").checked), extended: !!($("#dlExt") && $("#dlExt").checked) };
      try { const { result: r } = await api("/api/deadlines/calc", { method: "POST", body });
        $("#dlOut").innerHTML = `<div class="card" style="background:#fdf6e7;border-color:#f1dfa4;margin:10px 0 0"><div class="mute">${esc(r.label)} · ${esc(r.cite)}</div>
          <div class="stat">${niceDate(r.date)}${r.time ? " · " + esc(r.time) : ""}</div><div>${esc(r.how)}</div>${r.moved ? `<div class="mute">${esc(r.moved)}</div>` : ""}
          ${r.flags.map(f => `<div style="color:var(--warn);font-size:13px">${esc(f)}</div>`).join("")}
          <div class="grid" style="margin-top:8px">${caseId ? "" : `<div class="full"><label>Add it to a case</label><select id="dlCase">${caseOptions(cs)}</select></div>`}</div>
          <button class="btn sm" id="dlAdd" style="margin-top:8px">Add to ${caseId ? "this case" : "case"}</button></div>`;
        $("#dlAdd").onclick = async () => { const cid = caseId || +$("#dlCase").value; if (!cid) return toast("Pick a case");
          try { await api("/api/deadlines/add", { method: "POST", body: { ...body, case_id: cid } }); toast("Deadline added"); cal.openDl = false; after(); } catch (e) { fail(e); } };
      } catch (e) { $("#dlErr").textContent = e.message; }
    };
  }
  function feedHelp(f) {
    return `<p style="color:var(--ink)">Your private calendar link. Anyone with it can see your court dates, so don't share it.</p>${copyBox(f.url)}
      <ol style="padding-left:20px;line-height:1.6;color:var(--ink)"><li><b>Outlook:</b> Calendar → <b>Add calendar</b> → <b>Subscribe from web</b> → paste the link.</li>
      <li><b>Google Calendar</b> (on a computer): <b>Other calendars +</b> → <b>From URL</b> → paste. Google can take several hours to pick up changes.</li>
      <li><b>iPhone:</b> Settings → Calendar → Accounts → Add Account → Other → <b>Add Subscribed Calendar</b> → paste.</li></ol>
      <p class="mute">Court settings, deadlines and events show up there automatically. Changes are made here in TX Case Desk.</p><button class="btn sm ghost" id="feedReset">Make a new link (old one stops working)</button>`;
  }
  function wireFeed() { $("#feedReset").onclick = () => sure($("#feedReset"), async () => { const f = await api("/api/calendar/feed?reset=1"); $("#feedBox").innerHTML = feedHelp(f); wireFeed(); toast("New link made"); }); }

  // ===================== CLIENTS =====================
  const cl = { q: "", kind: "" };
  let conflictTimer;
  function conflictBox(matches) {
    if (!matches || !matches.length) return `<div class="mute" style="margin-top:6px">✓ No conflicts found in your firm's contacts or cases.</div>`;
    return `<div class="card" style="background:#fde4e1;border-color:#f5c2bc;margin:8px 0 0;padding:10px"><b>Possible conflicts — review before taking the case</b>
      ${matches.map(m => m.type === "contact" ? `<div style="margin-top:4px">${esc(m.name)}${m.company ? ", " + esc(m.company) : ""} <span class="tag n">${esc(m.kind)}</span>${m.cases && m.cases.length ? `<div class="mute">${m.cases.map(esc).join("<br>")}</div>` : ""}</div>`
        : `<div style="margin-top:4px">Case: ${esc(m.name)} <span class="mute">${esc(m.cause_no)} · ${esc(m.county)}</span></div>`).join("")}</div>`;
  }
  function contactFields(c) {
    const v = k => esc(c?.[k] ?? "");
    return `<div class="grid"><div class="full"><label>Name</label><input name="name" required value="${v("name")}" autocomplete="off"></div>
      <div><label>Type</label><select name="kind">${["client", "opposing", "witness", "other"].map(k => `<option value="${k}" ${c?.kind === k ? "selected" : ""}>${k === "opposing" ? "Opposing party / counsel" : k[0].toUpperCase() + k.slice(1)}</option>`).join("")}</select></div>
      <div><label>Company</label><input name="company" value="${v("company")}"></div><div><label>Phone</label><input name="phone" type="tel" value="${v("phone")}"></div>
      <div><label>Email</label><input name="email" type="email" value="${v("email")}"></div><div class="full"><label>Address</label><input name="address" value="${v("address")}"></div>
      <div class="full"><label>Notes</label><input name="notes" value="${v("notes")}"></div></div>`;
  }
  function liveConflicts(form) {
    const inp = form.querySelector("[name=name]"), out = form.querySelector(".cfOut");
    const run = () => { clearTimeout(conflictTimer); const n = (inp.value + " " + (form.querySelector("[name=company]").value || "")).trim(); if (n.length < 3) { out.innerHTML = ""; return; }
      conflictTimer = setTimeout(async () => { try { out.innerHTML = conflictBox((await api("/api/conflicts?name=" + encodeURIComponent(n))).matches); } catch {} }, 350); };
    inp.oninput = run; form.querySelector("[name=company]").oninput = run;
  }
  VIEWS.clients = async function clientsView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    $("#app").innerHTML = `<div class="card mute">Loading clients…</div>`;
    let r; try { r = await api(`/api/contacts?${new URLSearchParams({ q: cl.q, kind: cl.kind })}`); } catch (e) { return fail(e); }
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `<div class="card"><div class="grid"><div><label>Search</label><input id="clQ" value="${esc(cl.q)}" placeholder="Name, company, email, phone"></div>
      <div><label>Type</label><select id="clK"><option value="">Everyone</option><option value="client">Clients</option><option value="opposing">Opposing</option><option value="witness">Witnesses</option><option value="other">Other</option></select></div></div></div>
      <details class="card" ${r.contacts.length ? "" : "open"}><summary>+ New contact (with conflict check)</summary><form id="ctF" style="margin-top:8px">${contactFields()}<div class="cfOut"></div><div class="err"></div><button class="btn">Save contact</button></form></details>
      <div class="mute" style="margin:0 4px 8px">${r.contacts.length} contact${r.contacts.length === 1 ? "" : "s"}</div>
      ${r.contacts.map(c => `<div class="card" data-ct="${c.id}" style="cursor:pointer"><div class="row"><b>${esc(c.name)}</b><span class="tag ${c.kind === "client" ? "g" : c.kind === "opposing" ? "r" : "n"}">${esc(c.kind)}</span>${Number(c.trust) ? `<span class="tag y">Trust ${usd(c.trust)}</span>` : ""}</div>
        <div class="mute">${[c.company, c.phone, c.email].filter(Boolean).map(esc).join(" · ")}${c.cases ? ` · ${c.cases} case${c.cases === 1 ? "" : "s"}` : ""}</div></div>`).join("")}
      <details class="card"><summary>Import contacts or cases from Clio, MyCase or PracticePanther</summary><div style="margin-top:8px">
        <p class="mute">Export a CSV from your old system and paste or upload it. Columns are matched by name (Name / First Name / Last Name, Email, Phone, Company…).</p>
        <label>What's in the file</label><select id="imWhat"><option value="contacts">Contacts</option><option value="matters">Matters / cases</option></select>
        <div id="imCounty" hidden><label>County for these cases</label><select id="imCo">${me.counties.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
        <input type="file" id="imFile" accept=".csv,text/csv" style="margin-top:8px"><textarea id="imCsv" placeholder="Paste CSV here" style="margin-top:8px"></textarea>
        <div class="err" id="imErr"></div><button class="btn" id="imGo">Import</button></div></details>`;
    $("#clK").value = cl.kind;
    let st; $("#clQ").oninput = e => { clearTimeout(st); st = setTimeout(() => { cl.q = e.target.value; clientsView().then(() => { const i = $("#clQ"); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 400); };
    $("#clK").onchange = e => { cl.kind = e.target.value; clientsView(); };
    $$("[data-ct]").forEach(c => c.onclick = () => contactView(+c.dataset.ct));
    liveConflicts($("#ctF"));
    $("#ctF").onsubmit = async e => { e.preventDefault(); try { const x = await api("/api/contacts", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast(x.conflicts.length ? "Saved — possible conflicts shown on the contact" : "Saved"); contactView(x.contact.id, x.conflicts); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    $("#imWhat").onchange = () => $("#imCounty").hidden = $("#imWhat").value !== "matters";
    $("#imFile").onchange = async e => { const f = e.target.files[0]; if (f) $("#imCsv").value = await f.text(); };
    $("#imGo").onclick = async () => { try { const w = $("#imWhat").value; const x = await api(`/api/import/${w}`, { method: "POST", body: { csv: $("#imCsv").value, county: $("#imCo").value } }); toast(`Imported ${x.added}, skipped ${x.skipped}`); caseCache = null; clientsView(); } catch (e) { $("#imErr").textContent = e.message; } };
  };
  async function contactView(id, conflicts) {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    if (window.leaveMail) leaveMail(); else document.body.classList.remove("mailmode"); window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading…</div>`;
    let r; try { r = await api(`/api/contacts/${id}`); } catch (e) { return fail(e); }
    const c = r.contact;
    const next = r.cases.map(x => x.next_setting).find(Boolean);
    const sms = c.phone && next ? `sms:${encodeURIComponent(c.phone)}?&body=${encodeURIComponent(`Reminder from ${me.firm_name}: your next court date is ${next}. Please call us with any questions.`)}` : null;
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Clients</button>
      <div class="card" style="margin-top:10px"><div class="row"><h2 style="margin:0">${esc(c.name)}</h2><span class="tag ${c.kind === "client" ? "g" : "n"}">${esc(c.kind)}</span></div>
        <div class="row" style="margin-top:8px">${c.phone ? `<a class="btn sm ghost" href="tel:${esc(c.phone)}" style="text-decoration:none">Call</a>` : ""}${c.email ? `<a class="btn sm ghost" href="mailto:${esc(c.email)}" style="text-decoration:none">Email</a>` : ""}${sms ? `<a class="btn sm ghost" href="${sms}" style="text-decoration:none">Text court-date reminder</a>` : ""}</div>
        ${conflicts ? conflictBox(conflicts) : ""}</div>
      <div class="card"><h3>Cases</h3>${r.cases.map(x => `<div style="border-top:1px solid var(--line);padding:6px 0"><a class="link" data-case="${x.id}">${esc(x.cause_no)} · ${esc(x.style || "")}</a><div class="mute">${esc(x.role)} · ${esc(x.county)} County${x.next_setting ? " · Next: " + esc(x.next_setting) : ""}</div></div>`).join("") || `<div class="mute">Not on any case yet. Add them from a case's People section.</div>`}</div>
      ${isLawyer() ? `<div class="card"><h3>Money</h3><div class="kv"><div><b>Trust balance</b>${usd(r.trust)}</div><div><b>Invoices</b>${r.invoices.length}</div><div><b>Owed</b>${usd(r.invoices.filter(i => i.status !== "void").reduce((s, i) => s + Number(i.total) - Number(i.paid), 0))}</div></div></div>` : ""}
      <div class="card"><h3>Client page (portal)</h3><p class="mute" style="margin-top:0">A private link where ${esc(c.name.split(" ")[0])} sees their next court date, status, shared documents and invoices — no password. Send it by text or email.</p>
        ${c.portal_url ? copyBox(c.portal_url) + `<button class="btn sm ghost" id="ptOff">Turn the link off</button>` : `<button class="btn sm" id="ptOn">Make a client link</button>`}</div>
      <details class="card"><summary>Edit details</summary><form id="ctE" style="margin-top:8px">${contactFields(c)}<div class="cfOut"></div><div class="err"></div><div class="row"><button class="btn">Save</button><button type="button" class="btn danger" id="ctDel">Delete</button></div></form></details>`;
    $("#bk").onclick = () => go("clients");
    $$("[data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    if ($("#ptOn")) $("#ptOn").onclick = async () => { await api(`/api/contacts/${id}/portal`, { method: "POST", body: {} }); contactView(id); };
    if ($("#ptOff")) $("#ptOff").onclick = () => sure($("#ptOff"), async () => { await api(`/api/contacts/${id}/portal`, { method: "POST", body: { revoke: true } }); contactView(id); });
    liveConflicts($("#ctE"));
    $("#ctE").onsubmit = async e => { e.preventDefault(); try { await api(`/api/contacts/${id}`, { method: "PATCH", body: Object.fromEntries(new FormData(e.target)) }); toast("Saved"); contactView(id); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    $("#ctDel").onclick = () => sure($("#ctDel"), async () => { try { await api(`/api/contacts/${id}`, { method: "DELETE" }); toast("Deleted"); go("clients"); } catch (e) { fail(e); } });
  }
  window.contactView = contactView;

  // ===================== TASKS =====================
  const tk = { status: "open" };
  VIEWS.tasks = async function tasksView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    $("#app").innerHTML = `<div class="card mute">Loading tasks…</div>`;
    const bar = await filterBar("pfTasks", tasksView, "Tasks");
    let r, cs, ps; try { [r, cs, ps] = await Promise.all([api("/api/tasks?" + qs({ status: tk.status })), loadCases(), loadPeople()]); } catch (e) { return fail(e); }
    const t = todayStr();
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `${bar}
      <details class="card"><summary>+ Add a task</summary><form id="tkF" style="margin-top:8px"><div class="grid"><div class="full"><label>Task</label><input name="title" required></div>
        <div><label>Due</label><input type="date" name="due_date"></div><div><label>For</label><select name="assignee">${peopleOptions(ps, me.id)}</select></div>
        <div class="full"><label>Case</label><select name="case_id">${caseOptions(cs)}</select></div></div><div class="err"></div><button class="btn">Add task</button></form></details>
      <div class="card"><div class="row"><button class="btn sm ${tk.status === "open" ? "" : "ghost"}" data-st="open">Open</button><button class="btn sm ${tk.status === "done" ? "" : "ghost"}" data-st="done">Done</button><button class="btn sm ${tk.status === "all" ? "" : "ghost"}" data-st="all">All</button></div></div>
      ${r.tasks.map(x => `<div class="card" style="padding:10px 14px"><label style="display:flex;gap:10px;align-items:flex-start;font-size:15px;color:var(--ink)"><input type="checkbox" data-task="${x.id}" ${x.done ? "checked" : ""} style="width:auto;margin-top:3px">
        <span style="flex:1;${x.done ? "text-decoration:line-through;color:var(--mute)" : ""}">${esc(x.title)}<br><span class="mute" style="${!x.done && x.due_date && d10(x.due_date) < t ? "color:var(--bad);font-weight:600" : ""}">${x.due_date ? (d10(x.due_date) < t && !x.done ? "Overdue · " : "Due ") + niceDate(x.due_date) : "No due date"}${x.assignee_name && pf.who === "firm" ? " · " + esc(x.assignee_name) : ""}</span></span></label>
        <div class="row" style="margin:4px 0 0 30px">${x.case_id ? `<a class="link" data-case="${x.case_id}" style="font-size:13px">${esc(x.cause_no)} · ${esc((x.style || "").slice(0, 50))}</a>` : ""}<button class="btn sm ghost" data-tdel="${x.id}" style="margin-left:auto">Delete</button></div></div>`).join("") || `<div class="card mute">No tasks here.</div>`}`;
    $$("[data-st]").forEach(b => b.onclick = () => { tk.status = b.dataset.st; tasksView(); });
    $$("[data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("[data-task]").forEach(c => c.onchange = async () => { await api(`/api/tasks/${c.dataset.task}`, { method: "PATCH", body: { done: c.checked } }); toast(c.checked ? "Done ✓" : "Reopened"); tasksView(); });
    $$("[data-tdel]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/tasks/${b.dataset.tdel}`, { method: "DELETE" }); tasksView(); }));
    $("#tkF").onsubmit = async e => { e.preventDefault(); try { await api("/api/tasks", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Task added"); tasksView(); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
  };

  // ===================== BILLING =====================
  const bl = { inv: "" };
  function timeForm(cs, caseId) {
    return `<form id="teF"><div class="grid">${caseId ? "" : `<div class="full"><label>Case</label><select name="case_id">${caseOptions(cs)}</select></div>`}
      <div><label>Date</label><input type="date" name="on_date" value="${todayStr()}"></div><div><label>Hours</label><input name="hours" inputmode="decimal" placeholder="1.5"></div>
      <div><label>or flat amount ($)</label><input name="amount" inputmode="decimal" placeholder="Filing fee 350"></div>
      <div class="full"><label>Description</label><input name="description" placeholder="Drafted motion to compel"></div>
      <div class="full"><label style="display:flex;gap:6px;align-items:center;color:var(--ink);font-size:14px"><input type="checkbox" name="billable" checked style="width:auto"> Billable</label></div></div>
      <div class="err"></div><button class="btn">Save time</button></form>`;
  }
  function wireTimeForm(caseId, after) {
    $("#teF").onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
      const body = { case_id: caseId || b.case_id, on_date: b.on_date, minutes: Math.round(parseFloat(b.hours || 0) * 60) || 0, amount: b.amount ? parseFloat(String(b.amount).replace(/[^0-9.]/g, "")) : null, description: b.description, billable: !!b.billable };
      try { const r = await api("/api/time", { method: "POST", body }); toast(r.entry.amount == null && !Number(r.entry.rate) ? "Saved — set your hourly rate in Billing so this time is priced" : "Saved"); after(); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
  }
  VIEWS.billing = async function billingView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    $("#app").innerHTML = `<div class="card mute">Loading billing…</div>`;
    let t, inv, cs; try { [t, inv, cs] = await Promise.all([api("/api/time?unbilled=1&who=" + (me.sees_firm ? "firm" : "mine")), api("/api/invoices" + (bl.inv ? "?status=" + bl.inv : "")), loadCases()]); } catch (e) { return fail(e); }
    const byCase = {}; t.entries.forEach(e => { const k = e.case_id || 0; (byCase[k] = byCase[k] || { label: e.case_id ? `${e.cause_no} · ${e.style || ""}` : "No case", total: 0, n: 0, id: e.case_id }); byCase[k].total += Number(e.value); byCase[k].n++; });
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `${timerCard(cs)}
      <details class="card"><summary>+ Log time or a charge</summary><div style="margin-top:8px">${timeForm(cs)}</div></details>
      <div class="card"><h2>Unbilled ${me.sees_firm ? "(whole firm)" : "(mine)"}</h2>
        ${Object.values(byCase).map(g => `<div style="border-top:1px solid var(--line);padding:8px 0"><div class="row"><b style="flex:1">${esc(g.label)}</b><b>${usd(g.total)}</b></div><div class="row" style="margin-top:4px"><span class="mute">${g.n} entr${g.n === 1 ? "y" : "ies"}</span>${g.id ? `<button class="btn sm" data-bill="${g.id}" style="margin-left:auto">Create invoice</button>` : ""}</div></div>`).join("") || `<div class="mute">Nothing unbilled.</div>`}
        <details style="margin-top:8px"><summary class="mute">Show entries</summary>${t.entries.map(e => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><span style="flex:1">${esc(e.description || "—")}</span><b>${usd(e.value)}</b></div><div class="row"><span class="mute">${d10(e.on_date)} · ${e.amount != null ? "flat" : (e.minutes / 60).toFixed(2) + " h × " + usd(e.rate)} · ${esc(e.who || "")}${e.cause_no ? " · " + esc(e.cause_no) : ""}</span>${e.user_id === me.id || ["admin", "partner", "manager"].includes(me.role) ? `<button class="btn sm ghost" data-tedel="${e.id}" style="margin-left:auto">Delete</button>` : ""}</div></div>`).join("") || ""}</details></div>
      <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Invoices</h2><select id="invSt" style="width:auto"><option value="">All</option><option value="draft">Draft</option><option value="sent">Sent</option><option value="paid">Paid</option><option value="void">Void</option></select></div>
        ${inv.invoices.map(i => `<div style="border-top:1px solid var(--line);padding:8px 0;cursor:pointer" data-inv="${i.id}"><div class="row"><b>#${esc(i.number)}</b><span class="tag ${i.status === "paid" ? "g" : i.status === "void" ? "n" : i.status === "sent" ? "y" : "n"}">${esc(i.status)}</span><b style="margin-left:auto">${usd(i.total)}</b></div>
          <div class="mute">${esc(i.client || "No client")} · ${esc(i.cause_no || "")} · issued ${d10(i.issued)}${Number(i.total) - Number(i.paid) > 0 && i.status !== "void" ? ` · balance ${usd(Number(i.total) - Number(i.paid))}` : ""}</div></div>`).join("") || `<div class="mute" style="margin-top:8px">No invoices yet.</div>`}</div>
      <div class="card"><h3>My hourly rate</h3><div class="row"><input id="myRate" inputmode="decimal" placeholder="250" value="${t.rate || ""}" style="max-width:160px"><button class="btn sm" id="myRateSave">Save</button></div><p class="mute">Used for new time entries unless the case has its own rate.</p></div>`;
    $("#invSt").value = bl.inv; $("#invSt").onchange = e => { bl.inv = e.target.value; billingView(); };
    wireTimer(cs, billingView); wireTimeForm(null, billingView);
    $$("[data-bill]").forEach(b => b.onclick = async () => { try { const r = await api("/api/invoices", { method: "POST", body: { case_id: +b.dataset.bill } }); toast(`Invoice #${r.invoice.number} created`); invoiceView(r.invoice.id); } catch (e) { fail(e); } });
    $$("[data-inv]").forEach(r => r.onclick = () => invoiceView(+r.dataset.inv));
    $$("[data-tedel]").forEach(b => b.onclick = () => sure(b, async () => { try { await api(`/api/time/${b.dataset.tedel}`, { method: "DELETE" }); billingView(); } catch (e) { fail(e); } }));
    $("#myRateSave").onclick = async () => { await api("/api/me/rate", { method: "PUT", body: { rate: $("#myRate").value } }); toast("Rate saved"); };
  };
  async function invoiceView(id) {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading invoice…</div>`;
    let r; try { r = await api(`/api/invoices/${id}`); } catch (e) { return fail(e); }
    const i = r.invoice;
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Billing</button>
      <div class="card" style="margin-top:10px"><div class="row"><h2 style="margin:0">Invoice #${esc(i.number)}</h2><span class="tag ${i.status === "paid" ? "g" : i.status === "sent" ? "y" : "n"}">${esc(i.status)}</span></div>
        <div class="mute">${esc(i.client || "No client linked")} · ${esc(i.style || "")} · Cause ${esc(i.cause_no || "")}</div>
        <div class="kv"><div><b>Issued</b>${d10(i.issued)}</div><div><b>Due</b>${d10(i.due)}</div><div><b>Total</b>${usd(i.total)}</div><div><b>Paid</b>${usd(i.paid)}</div><div><b>Balance</b>${usd(i.balance)}</div></div>
        ${i.card_fee != null && i.balance > 0 ? `<p class="mute">If paid by card, about ${usd(i.card_fee)} goes to the card processor (your rate in Firm Settings).</p>` : ""}</div>
      <div class="card">${i.lines.map(l => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${esc(l.description)}</span><b>${usd(l.amount)}</b></div>`).join("")}</div>
      <div class="card"><div class="row"><a class="btn sm ghost" href="/invoice/${i.id}/print" target="_blank" rel="noopener" style="text-decoration:none">Print / PDF</a>
        ${i.status === "draft" ? `<button class="btn sm" id="ivSent">Mark as sent</button>` : ""}${i.status !== "void" && i.status !== "paid" && !i.payments.length ? `<button class="btn sm danger" id="ivVoid">Void</button>` : ""}</div>
        ${i.card_on && i.balance > 0 && i.status !== "void" ? `<p style="margin:10px 0 4px"><b>Online payment link</b> — send it to the client:</p>${copyBox(i.pay_url)}` : !i.card_on ? `<p class="mute">Turn on card payments in Firm Settings to get a pay link.</p>` : ""}</div>
      ${i.balance > 0 && i.status !== "void" ? `<div class="card"><h3>Record a payment</h3><form id="pyF"><div class="grid"><div><label>Amount</label><input name="amount" inputmode="decimal" value="${i.balance}"></div>
        <div><label>How</label><select name="method"><option value="check">Check</option><option value="card">Card</option><option value="bank">Bank transfer</option><option value="cash">Cash</option><option value="trust">From client's trust balance</option><option value="other">Other</option></select></div>
        <div><label>Date</label><input type="date" name="on_date" value="${todayStr()}"></div><div><label>Reference</label><input name="ref" placeholder="Check #"></div></div><div class="err"></div><button class="btn">Record payment</button></form></div>` : ""}
      ${i.payments.length ? `<div class="card"><h3>Payments</h3>${i.payments.map(p => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${d10(p.on_date)} · ${esc(p.method)}${p.ref && !/^manual-/.test(p.ref) ? " · " + esc(p.ref) : ""}</span><b>${usd(p.amount)}</b></div>`).join("")}</div>` : ""}`;
    $("#bk").onclick = () => go("billing");
    if ($("#ivSent")) $("#ivSent").onclick = async () => { await api(`/api/invoices/${id}`, { method: "PATCH", body: { status: "sent" } }); invoiceView(id); };
    if ($("#ivVoid")) $("#ivVoid").onclick = () => sure($("#ivVoid"), async () => { try { await api(`/api/invoices/${id}`, { method: "PATCH", body: { status: "void" } }); invoiceView(id); } catch (e) { fail(e); } });
    if ($("#pyF")) $("#pyF").onsubmit = async e => { e.preventDefault(); try { await api(`/api/invoices/${id}/payments`, { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Payment recorded"); invoiceView(id); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
  }
  window.invoiceView = invoiceView;

  // ===================== TRUST (beta) =====================
  VIEWS.trust = async function trustView() {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    $("#app").innerHTML = `<div class="card mute">Loading trust…</div>`;
    let r, ct, cs; try { [r, ct, cs] = await Promise.all([api("/api/trust"), api("/api/contacts?kind=client"), loadCases()]); } catch (e) { return fail(e); }
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4"><b>Beta.</b> Have your trust account procedures reviewed against the Texas rules before relying on this ledger. Client balances can't go below zero here.</div>
      <div class="card"><div class="mute">Held in trust for all clients</div><div class="stat">${usd(r.total)}</div></div>
      <details class="card" ${r.clients.length ? "" : "open"}><summary>+ Record a deposit or payment out</summary><form id="trF" style="margin-top:8px"><div class="grid">
        <div class="full"><label>Client</label><select name="contact_id" required><option value="">Pick a client</option>${ct.contacts.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
        <div class="full"><label>Case (optional)</label><select name="case_id">${caseOptions(cs)}</select></div>
        <div><label>Type</label><select name="dir"><option value="1">Deposit (money in)</option><option value="-1">Payment out</option></select></div><div><label>Amount</label><input name="amount" inputmode="decimal" required></div>
        <div><label>Date</label><input type="date" name="on_date" value="${todayStr()}"></div><div><label>Check / ref #</label><input name="ref"></div>
        <div class="full"><label>Memo</label><input name="memo" required placeholder="Retainer deposit"></div></div><div class="err"></div><button class="btn">Save</button></form></details>
      <div class="card"><h2>Client balances</h2>${r.clients.map(c => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><a class="link" data-ct="${c.id}" style="flex:1">${esc(c.name)}</a><b>${usd(c.balance)}</b></div>`).join("") || `<div class="mute">No trust activity yet.</div>`}</div>
      <div class="card"><h2>Three-way reconciliation</h2><p class="mute" style="margin-top:0">Enter the balance from your trust bank statement. It's checked against the book balance and the total of every client's ledger.</p>
        <form id="rcF"><div class="grid"><div><label>Statement date</label><input type="date" name="as_of" value="${todayStr()}"></div><div><label>Bank balance</label><input name="bank_balance" inputmode="decimal" required></div></div><div class="err"></div><button class="btn">Reconcile</button></form><div id="rcOut"></div>
        ${r.recons.length ? `<h3 style="margin-top:12px">Past reconciliations</h3>${r.recons.map(x => `<div class="mute">${d10(x.as_of)} · bank ${usd(x.bank_balance)} · book ${usd(x.book_balance)} · ledgers ${usd(x.ledgers_total)} · ${x.ok ? "✓ balanced" : "✗ off by " + usd(x.bank_balance - x.book_balance)}</div>`).join("")}` : ""}</div>
      <div class="card"><h2>Recent activity</h2>${r.recent.map(x => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><span style="flex:1">${esc(x.name)} · ${esc(x.memo || "")}</span><b style="color:${Number(x.amount) < 0 ? "var(--bad)" : "var(--ok)"}">${Number(x.amount) < 0 ? "−" : "+"}${usd(Math.abs(x.amount))}</b></div><div class="mute">${d10(x.on_date)}${x.ref ? " · " + esc(x.ref) : ""}${x.cause_no ? " · " + esc(x.cause_no) : ""}</div></div>`).join("") || `<div class="mute">None yet.</div>`}</div>`;
    $$("[data-ct]").forEach(a => a.onclick = () => contactView(+a.dataset.ct));
    $("#trF").onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); b.amount = Math.abs(parseFloat(String(b.amount).replace(/[^0-9.]/g, ""))) * +b.dir;
      try { const x = await api("/api/trust", { method: "POST", body: b }); toast(`Saved — client balance ${usd(x.balance)}`); trustView(); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    $("#rcF").onsubmit = async e => { e.preventDefault(); try { const x = await api("/api/trust/reconcile", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
      $("#rcOut").innerHTML = `<div class="card" style="margin:10px 0 0;${x.ok ? "background:#e3f4ea;border-color:#bfe3cd" : "background:#fde4e1;border-color:#f5c2bc"}"><b>${x.ok ? "✓ Balanced" : "✗ Doesn't balance"}</b><div class="kv"><div><b>Bank</b>${usd(x.bank)}</div><div><b>Book</b>${usd(x.book)}</div><div><b>Client ledgers</b>${usd(x.ledgers)}</div>${x.ok ? "" : `<div><b>Difference</b>${usd(x.difference)}</div>`}</div></div>`; } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
  };

  // ===================== CASE HUB =====================
  const hub = { id: null, sec: "overview" }, hubList = { mine: null, q: "" };
  // desktop: case list beside the open case (hidden on smaller screens)
  function clist(cs, id) {
    if (hubList.mine === null) hubList.mine = me.role !== "paralegal";   // paralegals don't lead cases: start them on every case they can see
    const rows = cs.filter(c => !hubList.mine || c.user_id === me.id);
    return `<aside class="clist" aria-label="Case list"><div class="hd"><div class="row" style="justify-content:space-between"><h2 style="margin:0;font:600 16px var(--sans)">Cases</h2><span class="mute">${rows.length} open</span></div>
      <input type="search" id="clQ2" placeholder="Filter by name or cause no." aria-label="Filter cases" value="${esc(hubList.q)}">
      <div class="row" style="gap:0"><button type="button" class="chip${hubList.mine ? " sel" : ""}" data-cl="mine" aria-pressed="${hubList.mine}">Mine</button><button type="button" class="chip${!hubList.mine ? " sel" : ""}" data-cl="all" aria-pressed="${!hubList.mine}">All firm</button></div></div>
      <ul id="clUl">${rows.map(c => `<li data-s="${esc(`${c.cause_no} ${c.style || ""} ${c.court || ""}`.toLowerCase())}"><button type="button" class="ci${c.id === id ? " on" : ""}" data-cid="${c.id}"${c.id === id ? ' aria-current="page"' : ""}><b>${esc(c.style || c.cause_no)}</b><small>${esc(c.cause_no)}${c.court ? " · " + esc(c.court) : ""}</small>${c.next_setting ? `<small style="color:var(--warn);font-weight:600">${esc(String(c.next_setting).slice(0, 60))}</small>` : ""}</button></li>`).join("") || `<li class="mute" style="padding:10px">No cases yet.</li>`}</ul></aside>`;
  }
  function wireClist(cs, id) {
    const filt = () => { const v = hubList.q.toLowerCase(); $$("#clUl li[data-s]").forEach(li => li.hidden = !!v && !li.dataset.s.includes(v)); };
    $("#clQ2").oninput = e => { hubList.q = e.target.value; filt(); }; filt();
    $$(".clist [data-cl]").forEach(b => b.onclick = () => { hubList.mine = b.dataset.cl === "mine"; $(".clist").outerHTML = clist(cs, id); wireClist(cs, id); });
    $$(".clist [data-cid]").forEach(b => b.onclick = () => caseHub(+b.dataset.cid));
  }
  async function caseHub(id) {
    const __v = ++viewSeq;   // a slower, older screen load must not draw over this one
    subView = true; if (window.leaveMail) leaveMail(); else document.body.classList.remove("mailmode"); window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading case…</div>`;
    let r, cs, tpl, ps, dsc, cv; try { [r, cs, tpl, ps, dsc, cv] = await Promise.all([api(`/api/cases/${id}/hub`), loadCases(), api("/api/templates"), loadPeople(), api(`/api/cases/${id}/discovery`).catch(() => ({ sets: [] })), api(`/api/cases/${id}/convos`).catch(() => ({ convos: [], kinds: [] }))]); if (!rules) rules = (await api("/api/deadlines/rules")).rules; } catch (e) { return fail(e); }
    const c = r.case, t = todayStr();
    const unbilled = r.time.filter(x => x.billable && !x.invoice_id).reduce((s, x) => s + (x.amount != null ? Number(x.amount) : x.minutes / 60 * x.rate), 0);
    const groups = [...new Set(rules.map(x => x.group))];
    const back = titleOf(tab);
    if (hub.id !== id) { hub.id = id; hub.sec = "overview"; }
    const SECS = [["overview", "Overview"], ["talk", "Conversations", cv.convos.length], ["dates", "Dates", r.events.filter(e => e.date >= t && !e.done).length], ["people", "People", r.contacts.length], ["tasks", "Tasks", r.tasks.filter(x => !x.done).length], ["docs", "Documents", r.documents.length], ["discovery", "Discovery", dsc.sets.filter(x => x.status !== "sent").length || null]];
    if (isLawyer()) SECS.push(["law", "Case law"], ["billing", "Time & billing"]);
    const st = c.status || "Open", stCls = /closed|dismiss|dispos/i.test(st) ? "k" : /new/i.test(st) ? "n" : "g";
    const up = r.events.filter(e => e.date >= t && !e.done), nextH = up.find(e => e.kind === "hearing");
    const openTasks = r.tasks.filter(x => !x.done);
    const trustHeld = r.contacts.reduce((s, x) => s + Number(x.trust || 0), 0);
    const cap = s => String(s || "").replace(/^./, m => m.toUpperCase());
    const tkRow = x => `<label class="tk"><input type="checkbox" data-task="${x.id}"><span>${esc(x.title)}<small${x.due_date && d10(x.due_date) < t ? ' style="color:var(--bad);font-weight:600"' : ""}>${x.due_date ? "Due " + esc(niceDate(x.due_date)) : "No due date"}${x.assignee_name ? " · " + esc(x.assignee_name) : ""}</small></span></label>`;
    const qaBtns = [["date", "Add date", "calendar"], ["task", "Add task", "tasks"], ["draft", "Draft", "file"], isLawyer() ? ["time", "Log time", "clock"] : ["people", "People", "clients"]];
    const nh = nextH ? new Date(nextH.date + "T12:00:00") : null;
    if (__v !== viewSeq) return;   // the person already opened another screen
    $("#app").innerHTML = `<div class="ld">${clist(cs, id)}<div class="cdet">
      <nav class="crumb" aria-label="Breadcrumb"><button type="button" id="bk">${esc(back)}</button>${ic("chev", 14, 2)}<span>${esc(c.style || c.cause_no)}</span></nav>
      <button type="button" class="btn sm ghost phone-back" id="bk2">${ic("back", 16, 2)}${esc(back)}</button>
      <div class="chead"><div style="min-width:0"><h1 class="pt">${esc(c.style || c.cause_no)}</h1>
          <div class="chips"><span class="tag ${stCls}">${esc(st)}</span>${c.case_type ? `<span class="tag k">${esc(c.case_type)}</span>` : ""}${c.watch_dates ? `<span class="tag n">Watching court dates</span>` : ""}${c.stage === "Closed" ? `<span class="tag k">Closed${c.closed_at ? " " + esc(new Date(c.closed_at).toLocaleDateString()) : ""}${c.closed_why ? " · " + esc(c.closed_why) : ""}</span>` : ""}</div></div>
        <div class="row acts">${isLawyer() ? `<button type="button" class="btn ghost" data-act="time">${ic("clock")}Log time</button>` : ""}<button type="button" class="btn ghost" data-act="draft">${ic("file")}Draft document</button><button type="button" class="btn" data-act="date">${ic("plus", 18, 2)}Add date</button></div></div>
      <div class="qa">${qaBtns.map(([k, v, i]) => `<button type="button" data-act="${k}">${ic(i, 22)}${v}</button>`).join("")}</div>
      <dl class="cmeta"><div><dt><label for="hbStage" style="margin:0;font:inherit;color:inherit">Stage</label></dt><dd><select id="hbStage" class="stsel"><option value="">Not set</option>${(META.stages || []).map(x => `<option ${c.stage === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></dd></div><div><dt>Cause No.</dt><dd>${/^PRE-/.test(c.cause_no) ? "Not filed yet" : esc(c.cause_no)}</dd></div><div><dt>Court</dt><dd>${esc([c.court, c.county ? c.county + " County" : ""].filter(Boolean).join(", "))}</dd></div><div><dt>Attorney</dt><dd>${esc(c.attorney || "—")}</dd></div><div><dt>Appeals to</dt><dd>${esc(META.appeals[c.county] || "—")}</dd></div></dl>
      <nav class="secnav" aria-label="Case sections">${SECS.map(([k, v, n]) => `<button type="button" data-sec-go="${k}"${hub.sec === k ? ' aria-current="page"' : ""}>${v}${n != null ? `<span>${n}</span>` : ""}</button>`).join("")}</nav>
      <div class="secsel"><label for="secSel">Section</label><select id="secSel">${SECS.map(([k, v, n]) => `<option value="${k}"${hub.sec === k ? " selected" : ""}>${v}${n != null ? ` (${n})` : ""}</option>`).join("")}</select></div>
      <div class="cols" data-sec="overview"><div class="cmain">
        ${nextH ? `<section class="box" style="padding:16px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div class="datebox" aria-hidden="true"><small>${nh.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</small><b>${nh.getDate()}</b></div>
          <div style="flex:1;min-width:200px"><div style="font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mute)">Next court date</div><div style="font-weight:600;font-size:16px">${esc(nextH.title)} · ${esc(niceDate(nextH.date))}${nextH.time ? " " + esc(nextH.time) : ""}</div><div class="mute">${esc(nextH.location || c.court || "")}${c.watch_dates ? " · checked every hour" : ""}</div></div></section>` : ""}
        <section class="box"><div class="bh"><h2>Coming up</h2><button type="button" class="lk" data-sec-go="dates">All dates</button></div><div class="dayb">${up.slice(0, 4).map(e => itemRow(e, { date: true, noCase: true })).join("") || `<div class="mute" style="padding:0 0 14px">No upcoming dates.</div>`}</div></section>
        <section class="box"><div class="bh"><h2>Notes</h2><span class="mute" id="hbNotesSt" style="font-size:13px"></span></div><div style="padding:0 18px 16px">${richEditor("notes", c.notes || "", "Case notes")}<div class="row" style="margin-top:8px"><button type="button" class="btn sm" id="hbNotesSave">Save notes</button></div></div></section>
        <section class="box"><div class="bh"><h2>Conversations</h2><button type="button" class="lk" id="cvQuick">+ Log</button></div><div class="cvlist" id="cvRecent" style="padding:0 18px 12px"></div></section>
        <section class="box"><div class="bh"><h2>Open tasks</h2><button type="button" class="lk" data-sec-go="tasks">All tasks</button></div>${openTasks.slice(0, 4).map(tkRow).join("") || `<div class="empty">No open tasks.</div>`}</section>
      </div><div class="cside">
        <section class="box"><div class="bh"><h2>People</h2><button type="button" class="lk" data-sec-go="people">Manage</button></div><div style="padding:0 18px 8px">${r.contacts.slice(0, 5).map(x => `<div style="padding:10px 0;border-top:1px solid var(--line2)"><div class="mute" style="font-size:12px">${esc(cap(x.role))}</div><div style="font-weight:600">${esc(x.name)}</div>${x.company ? `<div class="mute">${esc(x.company)}</div>` : ""}${x.role === "client" && (x.phone || x.email) ? `<div class="row" style="gap:14px;font-size:14px;margin-top:2px">${x.phone ? `<a href="tel:${esc(x.phone)}">Call</a><a href="sms:${esc(x.phone)}">Text</a>` : ""}${x.email ? `<a href="mailto:${esc(x.email)}">Email</a>` : ""}</div>` : ""}</div>`).join("") || `<div class="mute" style="padding:0 0 10px">Add the client and the other side; every name is checked for conflicts.</div>`}</div></section>
        ${isLawyer() ? `<section class="box"><div class="bh"><h2>Time &amp; money</h2></div><div class="glance"><button type="button" data-sec-go="billing"><span>Unbilled</span><b>${usd(unbilled)}</b></button><button type="button" data-sec-go="billing"><span>Billing</span><b>${esc(cap(c.billing || "hourly"))}</b></button><button type="button" data-sec-go="billing"><span>Rate</span><b>${c.rate != null ? usd(c.rate) + " / h" : "Attorney's rate"}</b></button>${trustHeld ? `<button type="button" data-go="trust"><span>Trust balance</span><b>${usd(trustHeld)}</b></button>` : ""}</div>${unbilled > 0 ? `<div style="padding:12px 18px;border-top:1px solid var(--line2)"><button type="button" class="btn wide" id="ovInv">Create invoice</button></div>` : ""}</section>` : ""}
        <section class="box"><div class="bh"><h2>Recent documents</h2><button type="button" class="lk" data-sec-go="docs">All ${r.documents.length}</button></div><div style="padding:0 10px 10px">${r.documents.slice(0, 3).map(x => `<a href="/api/documents/${x.id}" style="display:flex;align-items:center;gap:10px;min-height:44px;padding:0 8px;border-radius:8px;text-decoration:none;color:var(--ink)">${ic("file")}<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px">${esc(x.name)}</span></a>`).join("") || `<div class="mute" style="padding:0 8px 6px">No documents yet.</div>`}</div></section>
      </div></div>
      <div class="card" data-sec="dates"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Dates & deadlines</h3><button class="btn sm" id="hbDl">+ Deadline</button></div>
        <div id="hbDlBox" hidden style="margin-top:8px"><div class="grid"><div class="full"><label>Deadline</label><select id="dlRule">${groups.map(g => `<optgroup label="${esc(g)}">${rules.filter(x => x.group === g).map(x => `<option value="${x.key}">${esc(x.label)} — ${esc(x.cite)}</option>`).join("")}</optgroup>`).join("")}</select></div>
          <div><label id="dlTrigLabel">Date</label><input type="date" id="dlTrig"></div><div id="dlOpts" class="full"></div></div><button class="btn sm" id="dlCalc" style="margin-top:8px">Calculate</button><div class="err" id="dlErr"></div><div id="dlOut"></div>
          <details style="margin-top:8px"><summary class="mute">Or add a hearing / meeting by hand</summary><form id="hbEv" style="margin-top:6px"><div class="grid"><div class="full"><label>What</label><input name="title" required></div><div><label>Date</label><input type="date" name="on_date" required></div><div><label>Time</label><input name="at_time" placeholder="9:00 AM"></div><div><label>Type</label><select name="kind"><option value="hearing">Hearing</option><option value="meeting">Meeting</option><option value="deadline">Deadline</option><option value="event">Other</option></select></div></div><button class="btn sm">Add</button></form></details></div>
        ${r.events.filter(e => e.date >= addD(t, -30)).map(e => itemRow(e, { date: true, noCase: true }) + (e.src === "event" ? `<div class="row" style="margin:2px 0 6px 74px"><label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" data-done="${e.id}" ${e.done ? "checked" : ""} style="width:auto"> Done</label><button class="btn sm ghost" data-evdel="${e.id}">Delete</button></div>` : "")).join("") || `<div class="mute" style="margin-top:6px">No dates yet.</div>`}</div>
      <div class="card" data-sec="people"><h3>Firm team</h3><p class="mute" style="margin:0 0 8px">Who at the firm works this case. People added here can see it.</p>
        <div class="row" style="gap:6px"><span class="tag n">Lead: ${esc(c.attorney || "—")}</span>${(r.team || []).map(m => `<span class="tag k">${esc(m.name)}${r.can_team ? ` <button type="button" class="lk" data-team-del="${m.id}" aria-label="Remove ${esc(m.name)}" style="border:0;background:none;cursor:pointer;color:var(--bad);font-weight:700;padding:0 0 0 4px">×</button>` : ""}</span>`).join("")}</div>
        ${r.can_team ? `<div class="row" style="margin-top:10px"><label for="tmAdd" style="margin:0">Add to team</label><select id="tmAdd" style="flex:1;min-width:180px"><option value="">Pick a person</option>${ps.filter(x => x.id !== c.user_id && !(r.team || []).some(m => m.id === x.id)).map(x => `<option value="${x.id}">${esc(x.name)} (${esc(x.role)})</option>`).join("")}</select><button type="button" class="btn sm" id="tmAddGo">Add</button></div>` : ""}</div>
      <div class="card" data-sec="people"><div class="row" style="justify-content:space-between"><h3 style="margin:0">People</h3><button class="btn sm" id="hbPp">+ Add</button></div>
        <div id="hbPpBox" hidden style="margin-top:8px"><label>Existing contact</label><input id="ppSearch" placeholder="Type a name"><div id="ppRes"></div>
          <details style="margin-top:8px"><summary class="mute">Or a new person</summary><form id="ppNew" style="margin-top:6px">${contactFields()}<label>Role on this case</label><select name="role"><option value="client">Client</option><option value="opposing party">Opposing party</option><option value="opposing counsel">Opposing counsel</option><option value="witness">Witness</option><option value="other">Other</option></select><div class="cfOut"></div><div class="err"></div><button class="btn sm">Add</button></form></details></div>
        ${r.contacts.map(p => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><a class="link" data-ct="${p.id}">${esc(p.name)}</a><span class="tag ${p.role === "client" ? "g" : /opposing/.test(p.role) ? "r" : "n"}">${esc(p.role)}</span>${Number(p.trust) && isLawyer() ? `<span class="tag y">Trust ${usd(p.trust)}</span>` : ""}<button class="btn sm ghost" data-ppdel="${p.id}" style="margin-left:auto">Remove</button></div><div class="mute">${[p.company, p.phone, p.email].filter(Boolean).map(esc).join(" · ")}</div></div>`).join("") || `<div class="mute" style="margin-top:6px">Add the client and the other side — every name is checked for conflicts.</div>`}</div>
      <div class="card" data-sec="talk"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Conversations</h3><button class="btn sm" id="cvNew">+ Log conversation</button></div>
        <p class="mute" style="margin:6px 0 0">Calls, meetings, voicemails, emails and texts on this case — who, when and what was said.</p>
        <form id="cvF" hidden style="margin-top:10px"><input type="hidden" name="id"><div class="grid">
          <div><label for="cvKind">Type</label><select id="cvKind" name="kind">${[["call", "Call"], ["meeting", "Meeting"], ["voicemail", "Voicemail"], ["email", "Email"], ["text", "Text message"], ["court", "Court / clerk"], ["note", "Note to file"]].map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div>
          <div><label for="cvAt">When</label><input id="cvAt" type="datetime-local" name="at" required></div>
          <div><label for="cvWho">With</label><select id="cvWho" name="contact_id"><option value="">Someone else / no one</option>${r.contacts.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.role)})</option>`).join("")}</select></div>
          <div id="cvOtherW"><label for="cvOther">Name (if not on the case)</label><input id="cvOther" name="with_name" maxlength="200" placeholder="e.g. adjuster, clerk"></div>
          <div><label for="cvDir">Direction</label><select id="cvDir" name="direction"><option value="">—</option><option value="in">Incoming (they reached us)</option><option value="out">Outgoing (we reached them)</option></select></div>
          <div><label for="cvMin">Minutes</label><input id="cvMin" name="minutes" type="number" min="0" max="1440" step="1" inputmode="numeric" placeholder="e.g. 12"><div class="mute" id="cvMinNote" hidden style="font-size:12.5px;margin-top:4px">Already billed: change the time entry under Time &amp; billing.</div></div>
          <div class="full">${richEditor("body", "", "What was said", "Type or dictate what was said…")}</div>
          ${isLawyer() ? `<div class="full" id="cvBillW"><label class="chk"><input type="checkbox" id="cvBill"> Add the minutes to billing (time entry on this case)</label>
            <div id="cvBdW" hidden style="margin-top:6px"><label for="cvBd">Billing description (prints on the invoice — the notes above never do)</label><input id="cvBd" maxlength="300"></div></div>` : ""}
          <div id="cvFuW"><label for="cvFu">Follow up by</label><input id="cvFu" type="date"></div>
          <div id="cvFuTW"><label for="cvFuT">Follow-up task</label><input id="cvFuT" maxlength="300" placeholder="e.g. Send the records request"></div></div>
          <div class="err"></div><div class="row" style="margin-top:8px"><button class="btn sm" id="cvSave">Save</button><button type="button" class="btn sm ghost" id="cvCancel">Cancel</button></div></form>
        <div class="grid cvfilt" style="margin-top:12px"><div><label for="cvFk">Type</label><select id="cvFk"><option value="">All types</option></select></div><div><label for="cvFw">With</label><select id="cvFw"><option value="">Everyone</option></select></div><div class="full"><label for="cvFq">Search</label><input id="cvFq" type="search" placeholder="Words in the notes or a name" data-nomic></div></div>
        <div class="cvlist" id="cvList" style="margin-top:10px"></div></div>
      <div class="card" data-sec="tasks"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Tasks</h3><button class="btn sm" id="hbTk">+ Task</button></div>
        <form id="hbTkF" hidden style="margin-top:8px"><div class="grid"><div class="full"><label>Task</label><input name="title" required></div><div><label>Due</label><input type="date" name="due_date"></div><div><label>For</label><select name="assignee">${peopleOptions(ps, c.user_id || me.id)}</select></div></div><button class="btn sm">Add</button></form>
        ${r.tasks.map(x => `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:15px;color:var(--ink)"><input type="checkbox" data-task="${x.id}" ${x.done ? "checked" : ""} style="width:auto;margin-top:3px"><span style="${x.done ? "text-decoration:line-through;color:var(--mute)" : ""}">${esc(x.title)}<br><span class="mute" style="${!x.done && x.due_date && d10(x.due_date) < t ? "color:var(--bad)" : ""}">${x.due_date ? "Due " + niceDate(x.due_date) : ""}${x.assignee_name ? " · " + esc(x.assignee_name) : ""}</span></span></label>`).join("") || `<div class="mute" style="margin-top:6px">No tasks.</div>`}</div>
      <div class="card" data-sec="docs"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Documents</h3><label class="btn sm" style="cursor:pointer">Upload<input type="file" id="docUp" multiple hidden></label></div>
        <div class="row" style="margin-top:8px"><select id="tplSel" style="flex:1;min-width:200px">${tpl.templates.map(x => `<option value="${x.key}">${esc(x.label)}</option>`).join("")}</select><button class="btn sm ghost" id="tplGo">Draft in Word</button></div><div id="tplAsk"></div>
        ${r.documents.map(d => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><a class="link" href="/api/documents/${d.id}" style="flex:1">${esc(d.name)}</a><span class="mute">${Math.max(1, Math.round(d.size / 1024))} KB</span></div>
          <div class="row"><label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" data-share="${d.id}" ${d.shared ? "checked" : ""} style="width:auto"> Show on client page</label><button class="btn sm ghost" data-docdel="${d.id}" style="margin-left:auto">Delete</button></div></div>`).join("")}
        ${r.emails.length ? `<h3 style="margin-top:12px">Court emails</h3>${r.emails.map(m => `<div style="border-top:1px solid var(--line);padding:6px 0"><a class="link" data-mail="${m.id}">${esc(m.subject || "(no subject)")}</a><div class="mute">${new Date(m.received_at).toLocaleString()}</div></div>`).join("")}` : ""}
        ${!r.documents.length && !r.emails.length ? `<div class="mute" style="margin-top:6px">Upload files, or draft a notice or letter from the case details.</div>` : ""}</div>
      <div class="card" data-sec="discovery"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Discovery responses</h3><button class="btn sm" id="dsNew">+ Respond to discovery</button></div>
        <p class="mute" style="margin:6px 0 0">Add the other side's requests (PDF or Word). The app splits them into items, AI drafts the objections and answers from the case file, you edit and approve every one, then one click serves the response.</p>
        <form id="dsForm" hidden style="margin-top:10px"><div class="grid">
          <div class="full"><label for="dsDoc">The requests</label><select id="dsDoc"><option value="">Upload a file…</option>${r.documents.filter(d => /pdf|word|text/i.test(d.mime || "") || /\.(pdf|docx|txt)$/i.test(d.name)).map(d => `<option value="${d.id}" ${/interrog|request|admission|production|discovery|RFP|RFA/i.test(d.name) ? "selected" : ""}>${esc(d.name)}</option>`).join("")}<option value="hand">None — I'll type the requests</option></select></div>
          <div class="full" id="dsUpBox"><label for="dsUp">File (PDF or Word)</label><input type="file" id="dsUp" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></div>
          <div><label for="dsServed">Served on</label><input type="date" id="dsServed" value="${t}"></div>
          <div><label for="dsBy">Served by</label><select id="dsBy"><option value="email">Email</option><option value="efile">eFileTexas</option><option value="mail">Mail (+3 days)</option><option value="hand">Hand delivery</option></select></div>
          <div class="full" id="dsTitleBox" hidden><label for="dsTitle">What the requests are called</label><input id="dsTitle" placeholder="Plaintiff's First Set of Interrogatories"></div>
        </div><div class="err" id="dsErr"></div><button class="btn" id="dsGo" style="margin-top:8px">Build the response</button></form>
        ${dsc.sets.map(x => { const left = Math.round((new Date(x.due_on + "T12:00:00") - new Date(t + "T12:00:00")) / 864e5);
          return `<div class="dsrow"><div style="min-width:0;flex:1"><a class="link" data-ds="${x.id}" style="font-weight:600">${esc(x.title)}</a>
            <div class="mute" style="font-size:13px">${x.status === "sent" ? `Served ${esc(new Date(x.sent_at).toLocaleDateString())} to ${esc(x.sent_to || "")}` : `Due ${esc(niceDate(x.due_on))} · ${left < 0 ? `<b style="color:var(--bad)">${-left} day${left === -1 ? "" : "s"} late</b>` : left <= 7 ? `<b style="color:var(--bad)">${left} day${left === 1 ? "" : "s"} left</b>` : `${left} days left`} · ${x.counts.approved} of ${x.counts.total} approved`}</div></div>
            <span class="tag ${x.status === "sent" ? "g" : x.counts.total && x.counts.approved === x.counts.total ? "y" : "n"}">${x.status === "sent" ? "Served" : x.counts.total && x.counts.approved === x.counts.total ? "Ready to serve" : "In progress"}</span></div>`; }).join("") || `<div class="mute" style="margin-top:8px">No discovery yet.</div>`}</div>
      ${isLawyer() ? `<div data-sec="law">${analysisPanel(c)}</div>` : ""}
      ${isLawyer() ? `<div class="card" data-sec="billing"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Time & billing</h3><button class="btn sm" id="hbTime">+ Time</button></div>
        <div id="hbTimeBox" hidden style="margin-top:8px">${timeForm(cs, c.id)}</div>
        <div class="kv"><div><b>Unbilled</b>${usd(unbilled)}</div><div><b>Billing</b>${esc(c.billing || "hourly")}</div><div><b>Case rate</b>${c.rate != null ? usd(c.rate) + "/h" : "attorney's rate"}</div></div>
        <div class="row" style="margin-top:8px">${unbilled > 0 ? `<button class="btn sm" id="hbInv">Create invoice</button>` : ""}<button class="btn sm ghost" id="hbRate">Billing settings</button></div>
        <form id="hbRateF" hidden style="margin-top:8px"><div class="grid"><div><label>Billing</label><select name="billing"><option value="hourly">Hourly</option><option value="flat">Flat fee</option><option value="contingency">Contingency</option></select></div><div><label>Case hourly rate</label><input name="rate" inputmode="decimal" value="${c.rate ?? ""}" placeholder="use attorney's"></div></div><button class="btn sm">Save</button></form>
        ${r.invoices.map(i => `<div style="border-top:1px solid var(--line);padding:6px 0;cursor:pointer" data-inv="${i.id}"><div class="row"><b>#${esc(i.number)}</b><span class="tag ${i.status === "paid" ? "g" : i.status === "sent" ? "y" : "n"}">${esc(i.status)}</span><b style="margin-left:auto">${usd(i.total)}</b></div></div>`).join("")}
        ${r.time.slice(0, 8).map(x => `<div class="mute" style="border-top:1px solid var(--line);padding:4px 0">${d10(x.on_date)} · ${esc(x.description || "—")} · ${x.amount != null ? usd(x.amount) : (x.minutes / 60).toFixed(2) + " h"}${x.invoice_id ? " · billed" : ""}</div>`).join("")}</div>` : ""}
      </div></div>`;
    $("#bk").onclick = $("#bk2").onclick = () => { subView = false; show(); };
    if (isLawyer()) wireAnalysis(c);
    // stage: one tap, saved right away
    $("#hbStage").onchange = async e => { try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { stage: e.target.value } }); c.stage = e.target.value || null; toast(e.target.value ? `Stage: ${e.target.value}` : "Stage cleared"); } catch (err) { fail(err); e.target.value = c.stage || ""; } };
    // notes: Word-style, saved with the button (and kept safe if you leave with unsaved changes)
    const nb = $("#hbNotesSave").closest(".box"); wireRte(nb);
    const nEd = nb.querySelector(".rta"), nSt = $("#hbNotesSt"); let nSaved = c.notes || "";
    const nNow = () => { syncRte(nb); return nb.querySelector("input[name=notes]").value; };
    nEd.addEventListener("input", () => { nSt.textContent = nNow() !== nSaved ? "Not saved yet" : ""; });
    $("#hbNotesSave").onclick = async () => { const v = nNow(); try { const r = await api(`/api/cases/${c.id}`, { method: "PATCH", body: { notes: v } }); nSaved = v; c.notes = r.case.notes || null; nSt.textContent = "Saved"; toast("Notes saved"); } catch (e) { fail(e); } };
    // conversations: log, list (newest first), edit/delete by the person who logged it or an attorney
    const CVK = { call: "Call", meeting: "Meeting", voicemail: "Voicemail", email: "Email", text: "Text", court: "Court / clerk", note: "Note to file" };
    const pad = n => String(n).padStart(2, "0"), localDT = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const when = v => { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined, hour: "numeric", minute: "2-digit" }); };
    const DIR = { in: "Incoming", out: "Outgoing" }, hrs = m => (Math.round(m / 6) / 10).toFixed(1) + " h";
    const cvRow = (x, full) => `<div class="cvrow" data-cv="${x.id}"><div class="cvh"><span class="tag ${x.kind === "court" ? "k" : x.kind === "note" ? "k" : "n"}">${esc(CVK[x.kind] || x.kind)}</span>${x.direction ? `<span class="mute">${DIR[x.direction]}</span>` : ""}${x.with_name ? `<b>${esc(x.with_name)}</b>` : ""}<span class="mute">${esc(when(x.at))}${x.minutes ? " · " + x.minutes + " min" : ""}</span></div>
      <div class="cvb">${full ? renderNotes(x.body) : esc(clip(txt(x.body), 160))}</div>
      ${full && (x.time_id || x.task_id) ? `<div class="cvx">${x.time_id && isLawyer() ? `<span class="tag g">Billed ${hrs(x.billed_minutes || 0)}${x.billed_invoice ? " · invoiced" : ""}</span>` : ""}${x.task_id ? `<span class="tag ${x.follow_done ? "k" : "n"}">Follow-up${x.follow_due ? " " + esc(niceDate(x.follow_due)) : ""}${x.follow_done ? " · done" : ""}</span>` : ""}</div>` : ""}
      ${full ? `<div class="cvf mute">Logged by ${esc(x.logged_by || "—")}${x.created_at && Math.abs(new Date(x.created_at) - new Date(x.at)) > 864e5 ? ` on ${esc(when(x.created_at))}` : ""}${x.edited_by ? ` · edited by ${esc(x.edited_by)}` : ""}${x.can_edit ? ` <button type="button" class="lk" data-cv-edit="${x.id}">Edit</button> <button type="button" class="lk" data-cv-del="${x.id}">Delete</button>` : ""}</div>` : ""}</div>`;
    const clip = (t, n) => (t = String(t).replace(/\s+/g, " ").trim()).length > n ? t.slice(0, n - 1) + "…" : t;
    const cvF = $("#cvF"); wireRte(cvF);
    const txt = h => !h ? "" : /<\w/.test(h) ? new DOMParser().parseFromString(h, "text/html").body.textContent : String(h);
    const cvDraw = () => { const L = cv.convos;
      const fk = $("#cvFk").value, fw = $("#cvFw").value, fq = $("#cvFq").value.trim().toLowerCase();
      const kinds = [...new Set(L.map(x => x.kind))], names = [...new Set(L.map(x => x.with_name).filter(Boolean))].sort();
      $("#cvFk").innerHTML = `<option value="">All types</option>` + kinds.map(k => `<option value="${esc(k)}"${k === fk ? " selected" : ""}>${esc(CVK[k] || k)}</option>`).join("");
      $("#cvFw").innerHTML = `<option value="">Everyone</option>` + names.map(n => `<option${n === fw ? " selected" : ""}>${esc(n)}</option>`).join("");
      $(".cvfilt").hidden = L.length < 4;
      const F = L.filter(x => (!fk || x.kind === fk) && (!fw || x.with_name === fw) && (!fq || (txt(x.body) + " " + (x.with_name || "") + " " + (x.logged_by || "")).toLowerCase().includes(fq)));
      $("#cvList").innerHTML = F.map(x => cvRow(x, true)).join("") || `<div class="empty">${L.length ? "Nothing matches." : "No conversations logged yet."}</div>`;
      $("#cvRecent").innerHTML = L.slice(0, 3).map(x => cvRow(x, false)).join("") + (L.length ? `<button type="button" class="lk" data-sec-go="talk" style="margin-top:6px">All ${L.length}</button>` : `<div class="mute">None logged yet.</div>`);
      $$(".secnav [data-sec-go=talk] span").forEach(e => e.textContent = L.length); const o = $("#secSel option[value=talk]"); if (o) o.textContent = `Conversations (${L.length})`;
      $$("#cvRecent [data-sec-go]").forEach(b => b.onclick = () => { setSec("talk"); $(".secnav").scrollIntoView({ block: "start" }); });
      $$("#cvList [data-cv-edit]").forEach(b => b.onclick = () => cvOpen(cv.convos.find(x => x.id === +b.dataset.cvEdit)));
      $$("#cvList [data-cv-del]").forEach(b => b.onclick = async () => { if (!confirm("Delete this conversation entry? Its time entry and follow-up task stay (delete those separately if needed).")) return; try { await api(`/api/convos/${b.dataset.cvDel}`, { method: "DELETE" }); cv.convos = cv.convos.filter(x => x.id !== +b.dataset.cvDel); cvDraw(); toast("Deleted"); } catch (e) { fail(e); } });
    };
    const cvOther = () => { $("#cvOtherW").hidden = !!$("#cvWho").value; };
    const cvOpen = x => { cvF.reset(); cvF.id.value = x ? x.id : ""; $("#cvKind").value = x ? x.kind : "call"; $("#cvAt").value = $("#cvAt").dataset.dflt = localDT(x ? new Date(x.at) : new Date());
      $("#cvWho").value = x && x.contact_id && r.contacts.some(p => p.id === x.contact_id) ? x.contact_id : ""; $("#cvOther").value = x && !$("#cvWho").value ? x.with_name || "" : ""; cvOther();
      const ed = cvF.querySelector(".rta"); ed.innerHTML = x && x.body ? (isRichText(x.body) ? safeHtml(x.body) : esc(x.body).replace(/\n/g, "<br>")) : ""; syncRte(cvF);
      $("#cvDir").value = x ? x.direction || "" : ""; $("#cvMin").value = x && x.minutes != null ? x.minutes : "";
      if ($("#cvBillW")) { $("#cvBillW").hidden = !!(x && (x.time_id || x.user_id !== me.id)); $("#cvBill").checked = false; delete $("#cvBd").dataset.edited; billSync(); }   // only your own entry can be billed (in your name and rate)
      $("#cvMinNote").hidden = !(x && x.time_id);
      $("#cvFuW").hidden = $("#cvFuTW").hidden = !!(x && x.task_id); $("#cvFu").value = ""; $("#cvFuT").value = "";
      cvF.querySelector(".err").textContent = ""; $("#cvSave").textContent = x ? "Save changes" : "Save"; cvF.hidden = false; setSec("talk"); cvF.scrollIntoView({ block: "nearest" }); ed.focus(); };
    $("#cvWho").onchange = cvOther;
    const BILLD = { call: "Telephone conference", meeting: "Conference", voicemail: "Voicemail", email: "Email correspondence", text: "Text message correspondence", court: "Communication with court/clerk", note: "Case file review" };
    const billDflt = () => { const w = $("#cvWho").value ? (r.contacts.find(p => p.id === +$("#cvWho").value) || {}).name : $("#cvOther").value.trim(); return (BILLD[$("#cvKind").value] || "Conference") + (w && $("#cvKind").value !== "note" ? " with " + w : ""); };
    const billSync = () => { if (!$("#cvBill")) return; $("#cvBdW").hidden = !$("#cvBill").checked; if (!$("#cvBd").dataset.edited) $("#cvBd").value = billDflt(); };
    if ($("#cvBill")) { $("#cvBill").onchange = billSync; $("#cvBd").oninput = () => { $("#cvBd").dataset.edited = 1; }; ["#cvKind", "#cvOther"].forEach(k => $(k).addEventListener("input", billSync)); $("#cvKind").addEventListener("change", billSync); $("#cvWho").addEventListener("change", billSync); }
    $("#cvMin").oninput = () => { if ($("#cvBill") && !$("#cvBillW").hidden) { $("#cvBill").checked = +$("#cvMin").value > 0; billSync(); } };
    ["#cvFk", "#cvFw"].forEach(k => $(k).onchange = cvDraw); $("#cvFq").oninput = cvDraw;
    $("#cvNew").onclick = () => cvOpen();
    $("#cvQuick").onclick = () => { cvOpen(); $(".secnav").scrollIntoView({ block: "start" }); cvF.querySelector(".rta").focus(); };
    $("#cvCancel").onclick = () => { cvF.hidden = true; cvF.id.value = ""; };
    cvF.onsubmit = async e => { e.preventDefault(); syncRte(cvF); const err = cvF.querySelector(".err"); err.textContent = "";
      const id = cvF.id.value, untouched = $("#cvAt").value === $("#cvAt").dataset.dflt;
      const d = untouched ? (id ? null : new Date()) : new Date($("#cvAt").value);   // time left as is: a new entry gets the exact time now, an edit keeps its own
      const mins = $("#cvMin").value === "" ? null : Math.round(+$("#cvMin").value);
      if (d && isNaN(d)) { err.textContent = "Check the date and time."; return; }
      const body = { kind: $("#cvKind").value, ...(d ? { at: d.toISOString() } : {}), contact_id: $("#cvWho").value ? +$("#cvWho").value : null, with_name: $("#cvWho").value ? null : $("#cvOther").value,
        direction: $("#cvDir").value, minutes: mins, body: cvF.querySelector("input[name=body]").value };
      if (!body.body) { err.textContent = "Write what was said."; return; }
      const bill = $("#cvBill") && !$("#cvBillW").hidden && $("#cvBill").checked, fu = !$("#cvFuW").hidden && $("#cvFu").value;
      if (bill && !(mins > 0)) { err.textContent = "Enter the minutes to bill."; return; }
      const btn = $("#cvSave"); btn.disabled = true;
      try { let x = (await api(id ? `/api/convos/${id}` : `/api/cases/${c.id}/convos`, { method: id ? "PATCH" : "POST", body })).convo;
        // billing and the follow-up are separate records; the entry links to them
        const who = x.with_name ? ` with ${x.with_name}` : "", link = {}, notes = [];
        if (bill) try { const te = (await api("/api/time", { method: "POST", body: { case_id: c.id, minutes: mins, on_date: localDT(new Date(x.at)).slice(0, 10), description: clip($("#cvBd").value.trim() || billDflt(), 300) } })).entry; link.time_id = te.id; r.time = [te, ...(r.time || [])]; } catch (e2) { notes.push("time wasn't added (" + e2.message + ")"); }
        if (fu) try { const tk = (await api("/api/tasks", { method: "POST", body: { case_id: c.id, title: $("#cvFuT").value.trim() || `Follow up: ${(CVK[x.kind] || "conversation").toLowerCase()}${who}`, due_date: $("#cvFu").value } })).task; link.task_id = tk.id; } catch (e2) { notes.push("follow-up task wasn't added (" + e2.message + ")"); }
        if (Object.keys(link).length) try { x = (await api(`/api/convos/${x.id}`, { method: "PATCH", body: link })).convo; } catch (e3) { x = { ...x, ...link }; notes.push("link to it wasn't saved (" + e3.message + ")"); }
        if (notes.length) toast("Saved, but the " + notes.join(" and the "));
        cv.convos = [x, ...cv.convos.filter(y => y.id !== x.id)].sort((a, b) => new Date(b.at) - new Date(a.at) || b.id - a.id);
        cvF.hidden = true; cvF.id.value = ""; cvDraw(); if (!notes.length) toast(id ? "Saved" : link.time_id || link.task_id ? `Logged${link.time_id ? ", billed" : ""}${link.task_id ? ", follow-up set" : ""}` : "Conversation logged"); }
      catch (er) { err.textContent = er.message; } finally { btn.disabled = false; } };
    cvDraw();
    // sections: tabs on desktop, a dropdown on phones
    const setSec = k => { hub.sec = k; $$("#app [data-sec]").forEach(s => s.hidden = s.dataset.sec !== k); $$(".secnav [data-sec-go]").forEach(b => b.dataset.secGo === k ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")); $("#secSel").value = k; };
    setSec(SECS.some(([k]) => k === hub.sec) ? hub.sec : "overview");
    $$("#app [data-sec-go]").forEach(b => b.onclick = () => { setSec(b.dataset.secGo); if (!b.closest(".secnav")) $(".secnav").scrollIntoView({ block: "start" }); });
    $("#secSel").onchange = e => setSec(e.target.value);
    $$("#app .glance [data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
    const reveal = (sec, sel, focus) => { setSec(sec); const el = $(sel); if (el) { el.hidden = false; setTimeout(() => { el.scrollIntoView({ behavior: "smooth", block: "center" }); const f = focus ? $(focus) : el.querySelector("input,select,textarea"); if (f) f.focus({ preventScroll: true }); }, 50); } };
    $$("#app [data-act]").forEach(b => b.onclick = () => ({ date: () => reveal("dates", "#hbDlBox"), task: () => reveal("tasks", "#hbTkF"), draft: () => reveal("docs", "#tplSel", "#tplSel"), time: () => reveal("billing", "#hbTimeBox"), people: () => reveal("people", "#hbPpBox", "#ppSearch") })[b.dataset.act]());
    if ($("#ovInv")) $("#ovInv").onclick = async () => { try { const x = await api("/api/invoices", { method: "POST", body: { case_id: id } }); toast(`Invoice #${x.invoice.number} created`); invoiceView(x.invoice.id); } catch (e) { fail(e); } };
    wireClist(cs, id);
    $$("[data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("[data-ct]").forEach(a => a.onclick = () => contactView(+a.dataset.ct));
    $$("[data-mail]").forEach(a => a.onclick = () => emailView(+a.dataset.mail));
    const reload = () => { caseCache = null; caseHub(id); };
    // dates
    $("#hbDl").onclick = () => { $("#hbDlBox").hidden = !$("#hbDlBox").hidden; };
    wireDeadline(cs, id, reload);
    $("#hbEv").onsubmit = async e => { e.preventDefault(); try { await api("/api/events", { method: "POST", body: { ...Object.fromEntries(new FormData(e.target)), case_id: id } }); toast("Added"); reload(); } catch (x) { fail(x); } };
    $$("[data-done]").forEach(x => x.onchange = async () => { await api(`/api/events/${x.dataset.done}`, { method: "PATCH", body: { done: x.checked } }); });
    $$("[data-evdel]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/events/${b.dataset.evdel}`, { method: "DELETE" }); reload(); }));
    // people
    $("#hbPp").onclick = () => { $("#hbPpBox").hidden = !$("#hbPpBox").hidden; };
    if ($("#tmAddGo")) $("#tmAddGo").onclick = async () => { const v = +$("#tmAdd").value; if (!v) return; try { await api(`/api/cases/${id}/team`, { method: "POST", body: { user_id: v } }); toast("Added to the team"); reload(); } catch (x) { fail(x); } };
    $$("[data-team-del]").forEach(b => b.onclick = async () => { try { await api(`/api/cases/${id}/team/${b.dataset.teamDel}`, { method: "DELETE" }); reload(); } catch (x) { fail(x); } });
    let ps2; $("#ppSearch").oninput = e => { clearTimeout(ps2); ps2 = setTimeout(async () => { const v = e.target.value.trim(); if (v.length < 2) { $("#ppRes").innerHTML = ""; return; }
      const x = await api("/api/contacts?q=" + encodeURIComponent(v)); $("#ppRes").innerHTML = x.contacts.slice(0, 8).map(p => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${esc(p.name)} <span class="mute">${esc(p.kind)}</span></span>
        <select data-role="${p.id}" style="width:auto"><option value="client">Client</option><option value="opposing party">Opposing party</option><option value="opposing counsel">Opposing counsel</option><option value="witness">Witness</option><option value="other">Other</option></select><button class="btn sm" data-addp="${p.id}">Add</button></div>`).join("") || `<div class="mute">No match — add a new person below.</div>`;
      $$("[data-addp]").forEach(b => b.onclick = async () => { const x2 = await api(`/api/cases/${id}/contacts`, { method: "POST", body: { contact_id: +b.dataset.addp, role: $(`[data-role="${b.dataset.addp}"]`).value } }); toast(x2.conflicts.length ? "Added — check the possible conflicts on the contact" : "Added"); reload(); }); }, 300); };
    liveConflicts($("#ppNew"));
    $("#ppNew").onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); if (/opposing/.test(b.role)) b.kind = "opposing";
      try { const x = await api("/api/contacts", { method: "POST", body: { ...b, case_id: id } }); toast(x.conflicts.length ? "Added — possible conflicts found" : "Added"); reload(); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    $$("[data-ppdel]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/cases/${id}/contacts/${b.dataset.ppdel}`, { method: "DELETE" }); reload(); }));
    // tasks
    $("#hbTk").onclick = () => { $("#hbTkF").hidden = !$("#hbTkF").hidden; };
    $("#hbTkF").onsubmit = async e => { e.preventDefault(); try { await api("/api/tasks", { method: "POST", body: { ...Object.fromEntries(new FormData(e.target)), case_id: id } }); reload(); } catch (x) { fail(x); } };
    $$("[data-task]").forEach(x => x.onchange = async () => { await api(`/api/tasks/${x.dataset.task}`, { method: "PATCH", body: { done: x.checked } }); toast(x.checked ? "Done ✓" : "Reopened"); });
    // documents
    // ---- discovery
    $("#dsNew").onclick = () => { $("#dsForm").hidden = !$("#dsForm").hidden; dsSync(); };
    const dsSync = () => { const v = $("#dsDoc").value; $("#dsUpBox").hidden = v !== ""; $("#dsTitleBox").hidden = v !== "hand"; };
    $("#dsDoc").onchange = dsSync;
    $$("[data-ds]").forEach(a => a.onclick = () => discoveryView(+a.dataset.ds, id));
    $("#dsForm").onsubmit = async e => { e.preventDefault(); const btn = $("#dsGo"), err = $("#dsErr"); err.textContent = "";
      try {
        let docId = $("#dsDoc").value;
        if (docId === "") { const f = $("#dsUp").files[0]; if (!f) return err.textContent = "Pick the file with the requests.";
          if (f.size > 15e6) return err.textContent = "That file is over 15 MB.";
          btn.disabled = true; btn.textContent = "Reading the requests…";
          const up = await fetch(`/api/cases/${id}/documents`, { method: "POST", headers: { "X-Requested-With": "tcd", "X-File-Name": encodeURIComponent(f.name), "Content-Type": f.type || "application/octet-stream" }, body: f, credentials: "same-origin" });
          const uj = await up.json().catch(() => ({})); if (!up.ok) throw new Error(uj.error || "Upload failed"); docId = uj.document.id; }
        btn.disabled = true; btn.textContent = "Reading the requests…";
        const body = { served_on: $("#dsServed").value, served_by: $("#dsBy").value };
        if (docId === "hand") body.title = $("#dsTitle").value || "Discovery requests"; else body.document_id = +docId;
        const rr = await api(`/api/cases/${id}/discovery`, { method: "POST", body });
        toast(`${rr.set.counts.total} request${rr.set.counts.total === 1 ? "" : "s"} found · due ${niceDate(rr.set.due_on)} (on the calendar)`); discoveryView(rr.set.id, id);
      } catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Build the response"; }
    };
    $("#docUp").onchange = async e => { for (const f of e.target.files) { if (f.size > 15e6) { toast(`${f.name} is over 15 MB`); continue; }
      const res = await fetch(`/api/cases/${id}/documents`, { method: "POST", headers: { "X-Requested-With": "tcd", "X-File-Name": encodeURIComponent(f.name), "Content-Type": f.type || "application/octet-stream" }, body: f, credentials: "same-origin" });
      if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || "Upload failed"); } } toast("Uploaded"); reload(); };
    $$("[data-share]").forEach(x => x.onchange = async () => { await api(`/api/documents/${x.dataset.share}`, { method: "PATCH", body: { shared: x.checked } }); toast(x.checked ? "Client can see it" : "Hidden from client"); });
    $$("[data-docdel]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/documents/${b.dataset.docdel}`, { method: "DELETE" }); reload(); }));
    const tplSync = () => { const k = $("#tplSel").value; $("#tplAsk").innerHTML = k === "notice_hearing" ? `<div class="grid" style="margin-top:8px"><div class="full"><label>Motion</label><input id="tqMotion" placeholder="Defendant's Motion to Compel"></div><div><label>Date</label><input id="tqDate" type="date"></div><div><label>Time</label><input id="tqTime" placeholder="9:00 AM"></div></div><p class="mute">Blank fields use the next hearing on the calendar.</p>` : ""; };
    $("#tplSel").onchange = tplSync; tplSync();
    $("#tplGo").onclick = () => { const k = $("#tplSel").value; const p = new URLSearchParams(); if (k === "notice_hearing") { if ($("#tqMotion").value) p.set("motion", $("#tqMotion").value); if ($("#tqDate").value) p.set("date", $("#tqDate").value); if ($("#tqTime").value) p.set("time", $("#tqTime").value); }
      const a = document.createElement("a"); a.href = `/api/cases/${id}/templates/${k}?${p}`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); toast("Downloading draft — review before filing"); };
    // billing
    if ($("#hbTime")) { $("#hbTime").onclick = () => { $("#hbTimeBox").hidden = !$("#hbTimeBox").hidden; }; wireTimeForm(id, reload);
      if ($("#hbInv")) $("#hbInv").onclick = async () => { try { const x = await api("/api/invoices", { method: "POST", body: { case_id: id } }); toast(`Invoice #${x.invoice.number} created`); invoiceView(x.invoice.id); } catch (e) { fail(e); } };
      $("#hbRate").onclick = () => { $("#hbRateF").hidden = !$("#hbRateF").hidden; $("#hbRateF [name=billing]").value = c.billing || "hourly"; };
      $("#hbRateF").onsubmit = async e => { e.preventDefault(); await api(`/api/cases/${id}/billing`, { method: "PUT", body: Object.fromEntries(new FormData(e.target)) }); toast("Saved"); reload(); };
      $$("[data-inv]").forEach(x => x.onclick = () => invoiceView(+x.dataset.inv)); }
  }
  window.caseHub = caseHub;
  // ===================== DISCOVERY RESPONSE EDITOR =====================
  let dMeta = null;
  async function discoveryView(setId, caseId) {
    const __v = ++viewSeq; subView = true; window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading…</div>`;
    let d; try { if (!dMeta) dMeta = await api("/api/discovery/meta"); d = await api(`/api/discovery/${setId}`); } catch (e) { return fail(e); }
    if (__v !== viewSeq) return;
    const { set: S, items, case: C } = d, sent = S.status === "sent", t = todayStr();
    const left = Math.round((new Date(S.due_on + "T12:00:00") - new Date(t + "T12:00:00")) / 864e5);
    const KL = dMeta.kinds, total = items.length, appr = items.filter(i => i.approved_at).length;
    const card = it => `<section class="box dsi${it.approved_at ? " ok" : ""}" id="dsi-${it.id}"><div class="dsih"><b>${esc(KL[it.kind])} No. ${it.n}</b>${it.approved_at ? `<span class="tag g">✓ Approved</span>` : it.ai_answer ? `<span class="tag n">AI draft — review</span>` : ""}${it.added_by_hand ? `<span class="tag k">Added by hand</span>` : ""}</div>
      <div class="dsreq">${esc(it.request).replace(/\n/g, "<br>")}</div>
      ${sent ? "" : `<details class="dsobj"${(it.objections || []).length || it.objection_note ? " open" : ""}><summary>Objections${(it.objections || []).length ? ` (${it.objections.length})` : ""}</summary>
        <div class="objs">${dMeta.objections.map(o => `<label title="${esc(o.text)}"><input type="checkbox" data-obj="${o.k}" ${(it.objections || []).includes(o.k) ? "checked" : ""}> ${esc(o.t)}</label>`).join("")}</div>
        <label for="on-${it.id}" style="margin-top:6px">Other objection (optional)</label><textarea id="on-${it.id}" data-onote rows="2">${esc(it.objection_note || "")}</textarea></details>`}
      ${sent ? `<div class="rtv" style="margin-top:6px">${(it.objections || []).length ? `<p><b>Objections:</b> ${it.objections.map(k => esc((dMeta.objections.find(o => o.k === k) || {}).t || k)).join("; ")}</p>` : ""}${renderNotes(it.answer || "")}</div>`
        : `<label style="margin-top:8px">${it.kind === "rog" ? "Answer" : "Response"}</label>${it.kind === "rfa" ? `<div class="row" style="gap:6px;margin-bottom:6px">${["Admit.", "Deny.", "Cannot admit or deny"].map(x => `<button type="button" class="btn sm ghost" data-rfa="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}
          ${richEditor("answer", it.answer || "", (KL[it.kind]) + " " + it.n + " answer", "Type, dictate, or let AI draft it…")}
          ${it.ai_confirm ? `<div class="dsconf"><b>Confirm before approving:</b><ul>${it.ai_confirm.split("\n").filter(Boolean).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
          <div class="row" style="margin-top:8px;gap:6px">${isLawyer() ? `<button type="button" class="btn sm${it.approved_at ? " ghost" : ""}" data-approve>${it.approved_at ? "Un-approve" : "✓ Approve"}</button>` : `<span class="mute" style="font-size:13px">An attorney approves</span>`}<button type="button" class="btn sm ghost" data-save>Save</button>${dMeta.ai && !it.approved_at ? `<button type="button" class="btn sm ghost" data-redraft>Redraft with AI</button>` : ""}<button type="button" class="btn sm ghost" data-del style="margin-left:auto">Remove</button></div>`}
    </section>`;
    $("#app").innerHTML = `<div class="dsv">
      <button type="button" class="btn sm ghost" id="dsBack">${ic("back", 16, 2)}Back to the case</button>
      <h1 class="pt" style="margin:10px 0 2px">${esc(S.title)}</h1><div class="mute">${esc(C.style || "")}${/^PRE-/.test(C.cause_no) ? "" : " · " + esc(C.cause_no)} · ${esc(C.county)} County</div>
      <div class="dshead">
        ${sent ? `<div><b>Served</b> ${esc(new Date(S.sent_at).toLocaleString())} to ${esc(S.sent_to || "")}</div>${S.sent_doc ? `<a class="btn sm ghost" href="/api/documents/${S.sent_doc}">Served copy (Word)</a>` : ""}`
          : `<div><b>Due ${esc(niceDate(S.due_on))}</b> · ${left < 0 ? `<b style="color:var(--bad)">${-left} days late</b>` : `${left} day${left === 1 ? "" : "s"} left`}${items.some(i => i.kind === "rfa") ? ` · <span style="color:var(--bad)">Requests for admission not answered in time are deemed admitted.</span>` : ""}</div>
          <div class="dsprog" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${appr}" aria-label="Approved"><span style="width:${total ? Math.round(appr / total * 100) : 0}%"></span></div><div class="mute">${appr} of ${total} approved</div>
          <div class="row" style="gap:6px;margin-top:8px">${dMeta.ai ? `<button class="btn sm" id="dsAi">${S.ai_status === "running" || d.drafting ? "AI is drafting…" : "Draft all with AI"}</button>` : `<span class="mute" style="font-size:13px">AI drafting turns on when the Anthropic key is added in Render.</span>`}
            <a class="btn sm ghost" href="/api/discovery/${S.id}/docx">Preview Word</a><button class="btn sm ghost" id="dsAdd">+ Add a missing request</button>${isLawyer() ? `<button class="btn sm ghost danger" id="dsDel">Delete</button>` : ""}</div>
          ${S.ai_status === "error" ? `<div class="err" style="margin-top:6px">AI draft didn't finish: ${esc(S.ai_error || "")}</div>` : ""}`}
      </div>
      ${sent ? "" : `<form id="dsAddF" hidden class="box" style="padding:12px 16px"><div class="grid"><div><label for="daK">Type</label><select id="daK">${Object.entries(KL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></div><div><label for="daN">Number</label><input id="daN" type="number" min="1" placeholder="next"></div>
        <div class="full"><label for="daR">The request</label><textarea id="daR" rows="3" required></textarea></div></div><button class="btn sm" style="margin-top:8px">Add</button></form>`}
      ${items.map(card).join("") || `<div class="card mute">No requests yet. Add them with “+ Add a missing request”.</div>`}
      ${sent ? "" : `<section class="box" id="dsSend" style="padding:14px 18px"><h2 style="margin:0 0 6px">Serve the response</h2>
        ${appr < total || !total ? `<p class="mute" style="margin:0">Approve every item first (${total - appr} to go). The Word response then goes from your own email to opposing counsel, with a certificate of service${items.some(i => i.kind === "rog") ? " and a verification page for your client to sign" : ""}.</p>`
          : `<label for="dsTo">Send to (opposing counsel)</label><textarea id="dsTo" rows="2" placeholder="name@lawfirm.com, other@lawfirm.com">${esc(d.recipients.map(x => x.email).join(", "))}</textarea>
             <label for="dsMsg">Note in the email (optional)</label><textarea id="dsMsg" rows="2"></textarea>
             ${items.some(i => i.kind === "rog") ? `<p class="mute" style="font-size:13px">Interrogatory answers must be verified by your client (TRCP 197.2(d)). The verification page is in the Word file; send the signed page when you have it.</p>` : ""}
             <div class="err" id="dsSendErr"></div>${isLawyer() ? `<button class="btn" id="dsServe" style="width:100%;padding:12px;white-space:normal;overflow-wrap:anywhere;height:auto">Serve response to opposing counsel</button>` : `<p class="mute">An attorney serves the response.</p>`}`}</section>`}
    </div>`;
    $("#dsBack").onclick = () => caseHub(caseId || C.id);
    if (sent) return;
    wireRte($("#app"));
    const reload = () => discoveryView(setId, caseId);
    const bodyOf = sec => { syncRte(sec); return { answer: sec.querySelector("input[name=answer]").value, objections: [...sec.querySelectorAll("[data-obj]:checked")].map(x => x.dataset.obj), objection_note: (sec.querySelector("[data-onote]") || {}).value || "" }; };
    items.forEach(it => {
      const sec = $(`#dsi-${it.id}`); if (!sec) return;
      sec.querySelector("[data-save]").onclick = async () => { try { await api(`/api/discovery/items/${it.id}`, { method: "PATCH", body: bodyOf(sec) }); toast("Saved"); reload(); } catch (e) { fail(e); } };
      if (sec.querySelector("[data-approve]")) sec.querySelector("[data-approve]").onclick = async () => { try { await api(`/api/discovery/items/${it.id}`, { method: "PATCH", body: it.approved_at ? { approved: false } : { ...bodyOf(sec), approved: true } }); reload(); } catch (e) { fail(e); } };
      const rd = sec.querySelector("[data-redraft]"); if (rd) rd.onclick = async () => { try { await api(`/api/discovery/${setId}/draft`, { method: "POST", body: { items: [it.id] } }); toast("Redrafting…"); poll(); } catch (e) { fail(e); } };
      sec.querySelector("[data-del]").onclick = e => sure(e.currentTarget, async () => { await api(`/api/discovery/items/${it.id}`, { method: "DELETE" }); reload(); });
      sec.querySelectorAll("[data-rfa]").forEach(b => b.onclick = () => { const ed = sec.querySelector(".rta"); ed.focus(); const cur = ed.innerText.replace(/^(Admit\.|Deny\.|Cannot admit or deny[^.]*\.?)\s*/i, "");
        ed.innerHTML = `<p>${esc(b.dataset.rfa === "Cannot admit or deny" ? "Responding Party cannot admit or deny because, after reasonable inquiry, the information it knows or can easily obtain is insufficient to enable it to admit or deny." : b.dataset.rfa)}${cur.trim() ? " " + esc(cur.trim()) : ""}</p>`; ed.dispatchEvent(new Event("input", { bubbles: true })); });
    });
    const ai = $("#dsAi");
    let polling = false, dirty = false;
    const dsv = $(".dsv"); dsv.addEventListener("input", e => { if (e.target.closest(".dsi")) dirty = true; }); dsv.addEventListener("change", e => { if (e.target.closest(".dsi")) dirty = true; });   // this screen's own element: nothing piles up
    async function poll() { if (polling) return; polling = true; if (ai) { ai.disabled = true; ai.textContent = "AI is drafting…"; }
      for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 4000)); if (!document.getElementById(`dsi-${items[0] && items[0].id}`) && items.length) return;
        const x = await api(`/api/discovery/${setId}`).catch(() => null); if (x && !x.drafting && x.set.ai_status !== "running") {
          if (dirty) { if (ai) { ai.disabled = false; ai.textContent = "AI drafts are in — save your edits, then tap to show them"; ai.onclick = reload; } toast("AI drafts are in. Save your edits, then show them."); polling = false; return; }
          toast(x.set.ai_status === "error" ? "AI draft stopped — see the note at the top" : "AI drafts are in — review and approve each one"); return reload(); } }
      polling = false; }
    if (ai) ai.onclick = async () => { try { await api(`/api/discovery/${setId}/draft`, { method: "POST", body: {} }); poll(); } catch (e) { fail(e); } };
    if (S.ai_status === "running" || d.drafting) poll();
    $("#dsAdd").onclick = () => { $("#dsAddF").hidden = !$("#dsAddF").hidden; if (!$("#dsAddF").hidden) $("#daR").focus(); };
    $("#dsAddF").onsubmit = async e => { e.preventDefault(); try { await api(`/api/discovery/${setId}/items`, { method: "POST", body: { kind: $("#daK").value, n: +$("#daN").value || undefined, request: $("#daR").value } }); toast("Added"); reload(); } catch (x) { fail(x); } };
    if ($("#dsDel")) $("#dsDel").onclick = e => sure(e.currentTarget, async () => { await api(`/api/discovery/${setId}`, { method: "DELETE" }); toast("Deleted"); caseHub(caseId || C.id); });
    const serve = $("#dsServe");
    if (serve) $("#dsTo").addEventListener("input", () => { delete serve.dataset.sure; serve.textContent = "Serve response to opposing counsel"; });
    if (serve) serve.onclick = async () => {
      const to = $("#dsTo").value.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean).map(email => ({ email }));
      if (!to.length) return $("#dsSendErr").textContent = "Add opposing counsel's email.";
      if (!serve.dataset.sure) { serve.dataset.sure = 1; serve.textContent = `Tap again to serve on ${to.map(x => x.email).join(", ")}`; return; }
      serve.disabled = true; serve.textContent = "Serving…";
      try { const r = await api(`/api/discovery/${setId}/send`, { method: "POST", body: { to, message: $("#dsMsg").value, confirm: true } }); toast(`Served on ${r.sent_to.join(", ")} — copy saved to the case`); reload(); }
      catch (x) { $("#dsSendErr").textContent = x.message; serve.disabled = false; delete serve.dataset.sure; serve.textContent = "Serve response to opposing counsel"; }
    };
  }
  window.discoveryView = discoveryView;

  window.contactView = contactView;

  // ===================== FIRM SETTINGS (admin extras) =====================
  window.renderFirmExtras = async function (us) {
    const box = $("#firmExtras"); if (!box) return;
    let cd, tt, sp; try { [cd, tt, sp] = await Promise.all([api("/api/firm/closed-days"), api("/api/firm/task-templates"), api("/api/firm/stripe")]); } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const types = ["*", ...(typeof TYPES !== "undefined" ? TYPES : [])];
    const byType = {}; tt.templates.forEach(x => (byType[x.case_type] = byType[x.case_type] || []).push(x));
    box.innerHTML = `
      <div class="card" data-fs="money"><h2>Card payments (Stripe)</h2>
        ${sp.on ? `<p><span class="tag g">On</span> <span class="mute">Key ${esc(sp.hint)}</span></p>` : `<p class="mute" style="margin-top:0">Clients pay invoices online by card or bank; the money goes straight to your Stripe account.</p>`}
        <details ${sp.on ? "" : "open"}><summary>${sp.on ? "Replace key or change the fee" : "How to turn it on"}</summary><ol style="padding-left:20px;line-height:1.6;font-size:15px"><li>Sign in at <a class="link" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">dashboard.stripe.com → Developers → API keys</a> (create a free Stripe account first if you don't have one).</li><li>Copy the <b>Secret key</b> (starts with <code>sk_live_</code>) and paste it below.</li><li>Enter your card rate from your Stripe pricing so invoices show the fee up front.</li></ol>
        <form id="spF"><div class="grid"><div class="full"><label>Stripe secret key</label><input name="secret" type="password" autocomplete="off" placeholder="${sp.on ? "leave blank to keep the current key" : "sk_live_…"}"></div>
          <div><label>Card fee %</label><input name="fee_pct" inputmode="decimal" value="${sp.fee_pct ?? ""}"></div><div><label>+ fixed fee ($)</label><input name="fee_fixed" inputmode="decimal" value="${sp.fee_fixed ?? ""}"></div></div>
          <div class="err"></div><div class="row"><button class="btn">Save</button>${sp.on ? `<button type="button" class="btn danger" id="spOff">Turn off</button>` : ""}</div></form></details></div>
      <div class="card" data-fs="court"><h2>Court closed days</h2><p class="mute" style="margin-top:0">National holidays are already skipped and Texas state holidays are flagged. Add any other days your courts or clerk's office close (county holidays, weather closures) — deadlines will roll past them.</p>
        ${cd.days.map((x, i) => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${niceDate(x.date)} — ${esc(x.name)}</span><button class="btn sm ghost" data-cdd="${i}">Remove</button></div>`).join("")}
        <div class="row" style="margin-top:8px"><input type="date" id="cdDate" style="max-width:180px"><input id="cdName" placeholder="Hidalgo County holiday" style="flex:1;min-width:160px"><button class="btn sm" id="cdAdd">Add</button></div></div>
      <div class="card" data-fs="court"><h2>Checklists for new cases</h2><p class="mute" style="margin-top:0">These tasks are added automatically when a case is created — by hand, by import, or from a court email. "Every case" applies to all.</p>
        ${Object.entries(byType).map(([k, v]) => `<div style="margin-top:8px;font-weight:700">${k === "*" ? "Every case" : esc(k)}</div>${v.map(x => `<div class="row" style="border-top:1px solid var(--line);padding:4px 0"><span style="flex:1">${esc(x.title)}${x.due_days != null ? ` <span class="mute">· due in ${x.due_days} day${x.due_days === 1 ? "" : "s"}</span>` : ""}</span><button class="btn sm ghost" data-ttd="${x.id}">Remove</button></div>`).join("")}`).join("")}
        <form id="ttF" style="margin-top:10px"><div class="grid"><div><label>Case type</label><select name="case_type">${types.map(x => `<option value="${esc(x)}">${x === "*" ? "Every case" : esc(x)}</option>`).join("")}</select></div><div><label>Due in (days)</label><input name="due_days" inputmode="numeric"></div><div class="full"><label>Task</label><input name="title" required></div></div><button class="btn sm">Add to checklist</button></form></div>
      <div class="card" data-fs="money"><h2>Billing rates</h2>${us.filter(u => u.active).map(u => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${esc(u.name)} <span class="mute">${esc(u.role)}</span></span><input data-rate="${u.id}" inputmode="decimal" placeholder="$/hour" value="${(people || []).find(p => p.id === u.id)?.rate ?? ""}" style="max-width:120px"></div>`).join("")}<button class="btn sm" id="rtSave" style="margin-top:8px">Save rates</button></div>
      <div class="card" data-fs="data"><h2>Export everything</h2><p class="mute" style="margin-top:0">Your data is yours. Download any of it as a spreadsheet (CSV) at any time.</p><div class="row">${["cases", "contacts", "calendar", "tasks", "time", "invoices", "trust"].map(w => `<a class="btn sm ghost" href="/export/${w}.csv" style="text-decoration:none">${w[0].toUpperCase() + w.slice(1)}</a>`).join("")}</div></div>`;
    if (!people) { await loadPeople().catch(() => {}); $$("[data-rate]").forEach(i => { const p = (people || []).find(x => x.id === +i.dataset.rate); if (p && p.rate != null) i.value = p.rate; }); }
    $("#spF").onsubmit = async e => { e.preventDefault(); try { await api("/api/firm/stripe", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Saved"); firmView(); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    if ($("#spOff")) $("#spOff").onclick = () => sure($("#spOff"), async () => { await api("/api/firm/stripe", { method: "DELETE" }); firmView(); });
    $("#cdAdd").onclick = async () => { if (!$("#cdDate").value) return toast("Pick a date"); await api("/api/firm/closed-days", { method: "PUT", body: { days: [...cd.days, { date: $("#cdDate").value, name: $("#cdName").value }] } }); toast("Added"); firmView(); };
    $$("[data-cdd]").forEach(b => b.onclick = async () => { await api("/api/firm/closed-days", { method: "PUT", body: { days: cd.days.filter((_, i) => i !== +b.dataset.cdd) } }); firmView(); });
    $$("[data-ttd]").forEach(b => b.onclick = async () => { await api(`/api/firm/task-templates/${b.dataset.ttd}`, { method: "DELETE" }); firmView(); });
    $("#ttF").onsubmit = async e => { e.preventDefault(); try { await api("/api/firm/task-templates", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); firmView(); } catch (y) { fail(y); } };
    $("#rtSave").onclick = async () => { for (const i of $$("[data-rate]")) await api(`/api/firm/users/${i.dataset.rate}/rate`, { method: "PUT", body: { rate: i.value } }); people = null; toast("Rates saved"); };
  };

  // ===================== phone app (installable) =====================
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
})();
