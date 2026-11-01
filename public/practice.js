// TX Case Desk — practice screens: Today, Calendar (+ Texas deadlines), Clients, Tasks, Billing, Trust, Case hub, Firm settings.
// Uses helpers from app.js: $, $$, esc, api, toast, fail, me, META, tab, renderNav, show, VIEWS, emailView, TYPES.
(() => {
  const pf = { who: "mine", attorney: "", county: "" };       // one set of filters shared by Today, Calendar and Tasks
  const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const d10 = v => v ? String(v).slice(0, 10) : "";
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const addD = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const niceDate = s => { const d = new Date(d10(s) + "T12:00:00"); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }); };
  const KIND_TAG = { hearing: ["n", "Hearing"], deadline: ["a", "Deadline"], meeting: ["k", "Meeting"], event: ["k", "Event"] };
  const go = t => { tab = t; renderNav(); show(); };
  const isLawyer = () => me.role !== "paralegal";
  let people = null, caseCache = null, caseAt = 0;
  async function loadPeople() { if (!people) people = (await api("/api/firm/people")).people; return people; }
  async function loadCases() { if (!caseCache || Date.now() - caseAt > 60e3) { caseCache = (await api("/api/cases?view=firm")).cases; caseAt = Date.now(); } return caseCache; }
  const caseOptions = (cs, sel) => `<option value="">— No case —</option>` + cs.map(c => `<option value="${c.id}" ${+sel === c.id ? "selected" : ""}>${esc(c.cause_no)} · ${esc((c.style || "").slice(0, 50))}</option>`).join("");
  const peopleOptions = (ps, sel) => ps.map(p => `<option value="${p.id}" ${+sel === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const sure = (btn, fn) => { if (!btn.dataset.sure) { btn.dataset.sure = 1; btn.dataset.t = btn.textContent; btn.textContent = "Tap again"; setTimeout(() => { delete btn.dataset.sure; btn.textContent = btn.dataset.t; }, 3000); return; } fn(); };

  // ---------- shared filter bar ----------
  async function filterBar(id, onChange, title) {
    const ps = me.role === "admin" ? await loadPeople().catch(() => []) : [];
    setTimeout(() => {
      const el = $("#" + id); if (!el) return;
      el.querySelector("[name=who]").value = pf.who; el.querySelector("[name=county]").value = pf.county;
      const at = el.querySelector("[name=attorney]"); if (at) at.value = pf.attorney;
      el.querySelectorAll("select").forEach(s => s.onchange = () => { pf[s.name] = s.value; if (s.name === "attorney" && s.value) pf.who = "firm"; onChange(); });
    });
    return `<div class="ph" id="${id}" aria-label="${esc(title || "Filters")}"><div class="row">
      <select name="who" aria-label="Show"><option value="mine">Mine</option><option value="firm">Whole firm</option></select>
      ${me.role === "admin" ? `<select name="attorney" aria-label="Attorney"><option value="">All attorneys</option>${peopleOptions(ps.filter(p => p.role !== "paralegal"))}</select>` : ""}
      <select name="county" aria-label="County"><option value="">All my counties</option>${me.counties.map(c => `<option>${esc(c)}</option>`).join("")}</select></div></div>`;
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
  VIEWS.today = async function todayView() {
    $("#app").innerHTML = `<div class="card mute">Loading today…</div>`;
    const ps = me.role === "admin" ? await loadPeople().catch(() => []) : [];
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
    if (isLawyer()) gl.push(["Hours this month", d.hours, "billing"], ["Unbilled", usd(d.unbilled), "billing"], ["Outstanding", usd(d.outstanding) + (d.outstandingCount ? ` · ${d.outstandingCount}` : ""), "billing"], ["Collected this month", usd(d.collected), "billing"], ["Trust held", usd(d.trust), "trust"]);
    const bars = rows => { const mx = Math.max(1, ...rows.map(r => r.n)); return rows.map(r => `<div style="margin:8px 0"><div class="row" style="justify-content:space-between;font-size:14px"><span>${esc(r.k)}</span><b>${r.n}</b></div><div style="height:6px;background:var(--chip);border-radius:4px;margin-top:4px"><div style="height:6px;width:${Math.round(r.n / mx * 100)}%;background:var(--navy);border-radius:4px"></div></div></div>`).join("") || `<div class="mute">No open cases.</div>`; };
    $("#app").innerHTML = `
      <div class="ph"><div><div class="eyebrow">${esc(longDate)}</div><h1 class="pt">${hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening"}${first ? ", " + esc(first) : ""}</h1></div>
        <div class="row" id="pfToday"><div class="seg" role="group" aria-label="Show"><button type="button" data-who="mine" aria-pressed="${mine}">Mine</button><button type="button" data-who="firm" aria-pressed="${!mine}">Whole firm</button></div>
        ${me.role === "admin" ? `<select name="attorney" aria-label="Attorney"><option value="">All attorneys</option>${peopleOptions(ps.filter(p => p.role !== "paralegal"), pf.attorney)}</select>` : ""}
        ${me.counties.length > 1 ? `<select name="county" aria-label="County"><option value="">All my counties</option>${me.counties.map(c => `<option ${pf.county === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>` : ""}</div></div>
      <div class="cols"><div class="cmain">
        <section class="box" aria-labelledby="tdCourt"><div class="bh"><h2 id="tdCourt">In court today</h2><a data-go="calendar">Open calendar</a></div>
          <ul style="list-style:none;margin:0;padding:0">${courtToday.map(courtRow).join("") || `<li class="empty">Nothing in court today.${nextCourt ? ` Next: <b>${esc(nextCourt.title)}</b> on ${esc(niceDate(nextCourt.date))}${nextCourt.time ? " at " + esc(nextCourt.time) : ""}${nextCourt.case ? " · " + caseLink(nextCourt.case) : ""}` : ""}</li>`}</ul>
          <div class="mute" style="padding:10px 18px;border-top:1px solid var(--line2)">Court dates on watched cases are checked every hour.</div></section>
        <section class="box" aria-labelledby="tdDl"><div class="bh"><h2 id="tdDl">Deadlines</h2><a data-qa="deadline">Calculate a deadline</a></div>
          <ul style="list-style:none;margin:0;padding:0">${dls.map(dlRow).join("") || `<li class="empty">No deadlines in the next two weeks.</li>`}</ul></section>
        <section class="box" aria-labelledby="tdMail"><div class="bh"><h2 id="tdMail">New from court email</h2><a data-go="inbox">Open court mail</a></div>
          <ul style="list-style:none;margin:0;padding:0">${mail.map(mailRow).join("") || `<li class="empty">No new court email.</li>`}</ul></section>
        <section class="box" aria-labelledby="tdNext"><div class="bh"><h2 id="tdNext">Next 14 days</h2><a data-go="calendar">Open calendar</a></div>
          ${Object.entries(byDay).map(([day, items]) => `<div class="dayh">${day === t ? "Today" : esc(niceDate(day))}</div><div class="dayb">${items.map(i => itemRow(i)).join("")}</div>`).join("") || `<div class="empty">Nothing else on the calendar for the next two weeks.</div>`}</section>
      </div><div class="cside">
        ${isLawyer() ? timerCard(cs) : ""}
        <section class="box" aria-labelledby="tdTasks"><div class="bh"><h2 id="tdTasks">${mine ? "My tasks" : "Tasks due this week"}</h2><a data-go="tasks">All tasks</a></div>
          ${d.tasksDue.slice(0, 8).map(x => { const late = x.due_date && d10(x.due_date) < t; return `<label class="tk"><input type="checkbox" data-task="${x.id}"><span>${esc(x.title)}<small${late ? ' style="color:var(--bad);font-weight:600"' : ""}>${x.cause_no ? esc(String(x.style || x.cause_no).slice(0, 44)) + " · " : ""}${late ? "Overdue · " : ""}${x.due_date ? esc(niceDate(x.due_date)) : ""}</small></span></label>`; }).join("") || `<div class="empty">No tasks due this week.</div>`}
          ${d.tasksDue.length > 8 ? `<div class="empty"><a data-go="tasks">${d.tasksDue.length - 8} more due this week</a></div>` : ""}
          <div style="padding:12px 18px;border-top:1px solid var(--line2)"><button type="button" class="btn sm ghost" data-qa="task">${ic("plus", 16, 2)}Add task</button></div></section>
        <section class="box" aria-labelledby="tdGl"><div class="bh"><h2 id="tdGl">At a glance</h2>${isLawyer() && d.hoursToday ? `<span class="mute">${d.hoursToday} h logged today</span>` : ""}</div>
          <div class="glance">${gl.map(([k, v, g]) => `<button type="button" data-go="${g}"><span>${k}</span><b>${esc(String(v))}</b></button>`).join("")}</div></section>
        <section class="box" aria-labelledby="tdLoad"><div class="bh"><h2 id="tdLoad">Open cases by county</h2></div><div style="padding:0 18px 12px">${bars(d.byCounty)}
          <details style="margin-top:6px"><summary class="mute">By court</summary>${bars(d.byCourt)}</details></div></section>
      </div></div>`;
    $$("#app [data-go]").forEach(b => b.onclick = e => { e.preventDefault(); go(b.dataset.go); });
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

  // ===================== CALENDAR (+ Texas deadline calculator + feed) =====================
  const cal = { range: "upcoming" };
  let rules = null;
  VIEWS.calendar = async function calendarView() {
    $("#app").innerHTML = `<div class="card mute">Loading calendar…</div>`;
    const bar = await filterBar("pfCal", calendarView, "Calendar");
    const t = todayStr(), from = cal.range === "past" ? addD(t, -60) : t, to = cal.range === "past" ? addD(t, -1) : addD(t, cal.range === "upcoming" ? 45 : 180);
    let r, cs; try { [r, cs] = await Promise.all([api("/api/calendar?" + qs({ from, to })), loadCases()]); if (!rules) rules = (await api("/api/deadlines/rules")).rules; } catch (e) { return fail(e); }
    const byDay = {}; r.items.forEach(i => (byDay[i.date] = byDay[i.date] || []).push(i));
    const groups = [...new Set(rules.map(x => x.group))];
    $("#app").innerHTML = `${bar}
      <details class="card" id="dlBox" ${cal.openDl ? "open" : ""}><summary>Texas deadline calculator</summary>
        <p class="mute" style="margin:6px 0">Counts under TRCP 4: weekends and legal holidays push the last day forward. Texas state holidays are flagged so you can check the clerk's office. Always confirm against the rules and any court order.</p>
        <div class="grid"><div class="full"><label>Deadline</label><select id="dlRule">${groups.map(g => `<optgroup label="${esc(g)}">${rules.filter(x => x.group === g).map(x => `<option value="${x.key}">${esc(x.label)} — ${esc(x.cite)}</option>`).join("")}</optgroup>`).join("")}</select></div>
        <div><label id="dlTrigLabel">Date</label><input type="date" id="dlTrig"></div>
        <div id="dlOpts" class="full"></div></div>
        <div class="row" style="margin-top:8px"><button class="btn" id="dlCalc">Calculate</button></div><div class="err" id="dlErr"></div><div id="dlOut"></div></details>
      <details class="card"><summary>+ Add to calendar</summary><form id="evF" style="margin-top:8px"><div class="grid">
        <div class="full"><label>What</label><input name="title" required placeholder="Mediation with opposing counsel"></div>
        <div><label>Date</label><input type="date" name="on_date" required value="${t}"></div><div><label>Time</label><input name="at_time" placeholder="10:00 AM"></div>
        <div><label>Type</label><select name="kind"><option value="hearing">Hearing</option><option value="deadline">Deadline</option><option value="meeting">Meeting</option><option value="event" selected>Other</option></select></div>
        <div class="full"><label>Case</label><select name="case_id">${caseOptions(cs)}</select></div>
        <div class="full"><label>Where</label><input name="location"></div><div class="full"><label>Notes</label><input name="notes"></div></div>
        <div class="err"></div><button class="btn">Add</button></form></details>
      <div class="card"><div class="row"><button class="btn sm ${cal.range === "upcoming" ? "" : "ghost"}" data-range="upcoming">Next 45 days</button><button class="btn sm ${cal.range === "long" ? "" : "ghost"}" data-range="long">Next 6 months</button><button class="btn sm ${cal.range === "past" ? "" : "ghost"}" data-range="past">Past 60 days</button></div></div>
      ${Object.keys(byDay).length ? Object.entries(byDay).map(([day, items]) => `<div class="card"><div style="font-weight:700;margin-bottom:4px">${niceDate(day)}</div>${items.map(i => itemRow(i) + (i.src === "event" ? `<div class="row" style="margin:2px 0 6px 74px"><label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" data-done="${i.id}" ${i.done ? "checked" : ""} style="width:auto"> Done</label><button class="btn sm ghost" data-del="${i.id}">Delete</button></div>` : "")).join("")}</div>`).join("") : `<div class="card mute">Nothing in this range.</div>`}
      <details class="card"><summary>See this calendar in Outlook, Google or your iPhone</summary><div id="feedBox" class="mute" style="margin-top:8px">Loading…</div></details>`;
    $$("[data-range]").forEach(b => b.onclick = () => { cal.range = b.dataset.range; calendarView(); });
    $$("[data-case]").forEach(a => a.onclick = () => caseHub(+a.dataset.case));
    $$("[data-done]").forEach(c => c.onchange = async () => { await api(`/api/events/${c.dataset.done}`, { method: "PATCH", body: { done: c.checked } }); toast(c.checked ? "Marked done" : "Reopened"); });
    $$("[data-del]").forEach(b => b.onclick = () => sure(b, async () => { await api(`/api/events/${b.dataset.del}`, { method: "DELETE" }); calendarView(); }));
    $("#evF").onsubmit = async e => { e.preventDefault(); try { await api("/api/events", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Added"); calendarView(); } catch (x) { e.target.querySelector(".err").textContent = x.message; } };
    $("#dlBox").ontoggle = () => cal.openDl = $("#dlBox").open;
    wireDeadline(cs, null, calendarView);
    $("#feedBox").parentElement.ontoggle = async function () { if (!this.open || $("#feedBox").dataset.done) return; try { const f = await api("/api/calendar/feed"); $("#feedBox").dataset.done = 1; $("#feedBox").innerHTML = feedHelp(f); wireFeed(); } catch (e) { $("#feedBox").textContent = e.message; } };
  };
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
    $("#app").innerHTML = `<div class="card mute">Loading clients…</div>`;
    let r; try { r = await api(`/api/contacts?${new URLSearchParams({ q: cl.q, kind: cl.kind })}`); } catch (e) { return fail(e); }
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
    let st; $("#clQ").oninput = e => { clearTimeout(st); st = setTimeout(() => { cl.q = e.target.value; clientsView().then(() => { const i = $("#clQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 400); };
    $("#clK").onchange = e => { cl.kind = e.target.value; clientsView(); };
    $$("[data-ct]").forEach(c => c.onclick = () => contactView(+c.dataset.ct));
    liveConflicts($("#ctF"));
    $("#ctF").onsubmit = async e => { e.preventDefault(); try { const x = await api("/api/contacts", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast(x.conflicts.length ? "Saved — possible conflicts shown on the contact" : "Saved"); contactView(x.contact.id, x.conflicts); } catch (y) { e.target.querySelector(".err").textContent = y.message; } };
    $("#imWhat").onchange = () => $("#imCounty").hidden = $("#imWhat").value !== "matters";
    $("#imFile").onchange = async e => { const f = e.target.files[0]; if (f) $("#imCsv").value = await f.text(); };
    $("#imGo").onclick = async () => { try { const w = $("#imWhat").value; const x = await api(`/api/import/${w}`, { method: "POST", body: { csv: $("#imCsv").value, county: $("#imCo").value } }); toast(`Imported ${x.added}, skipped ${x.skipped}`); caseCache = null; clientsView(); } catch (e) { $("#imErr").textContent = e.message; } };
  };
  async function contactView(id, conflicts) {
    window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading…</div>`;
    let r; try { r = await api(`/api/contacts/${id}`); } catch (e) { return fail(e); }
    const c = r.contact;
    const next = r.cases.map(x => x.next_setting).find(Boolean);
    const sms = c.phone && next ? `sms:${encodeURIComponent(c.phone)}?&body=${encodeURIComponent(`Reminder from ${me.firm_name}: your next court date is ${next}. Please call us with any questions.`)}` : null;
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
    $("#app").innerHTML = `<div class="card mute">Loading tasks…</div>`;
    const bar = await filterBar("pfTasks", tasksView, "Tasks");
    let r, cs, ps; try { [r, cs, ps] = await Promise.all([api("/api/tasks?" + qs({ status: tk.status })), loadCases(), loadPeople()]); } catch (e) { return fail(e); }
    const t = todayStr();
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
    $("#app").innerHTML = `<div class="card mute">Loading billing…</div>`;
    let t, inv, cs; try { [t, inv, cs] = await Promise.all([api("/api/time?unbilled=1&who=" + (me.role === "admin" ? "firm" : "mine")), api("/api/invoices" + (bl.inv ? "?status=" + bl.inv : "")), loadCases()]); } catch (e) { return fail(e); }
    const byCase = {}; t.entries.forEach(e => { const k = e.case_id || 0; (byCase[k] = byCase[k] || { label: e.case_id ? `${e.cause_no} · ${e.style || ""}` : "No case", total: 0, n: 0, id: e.case_id }); byCase[k].total += Number(e.value); byCase[k].n++; });
    $("#app").innerHTML = `${timerCard(cs)}
      <details class="card"><summary>+ Log time or a charge</summary><div style="margin-top:8px">${timeForm(cs)}</div></details>
      <div class="card"><h2>Unbilled ${me.role === "admin" ? "(whole firm)" : "(mine)"}</h2>
        ${Object.values(byCase).map(g => `<div style="border-top:1px solid var(--line);padding:8px 0"><div class="row"><b style="flex:1">${esc(g.label)}</b><b>${usd(g.total)}</b></div><div class="row" style="margin-top:4px"><span class="mute">${g.n} entr${g.n === 1 ? "y" : "ies"}</span>${g.id ? `<button class="btn sm" data-bill="${g.id}" style="margin-left:auto">Create invoice</button>` : ""}</div></div>`).join("") || `<div class="mute">Nothing unbilled.</div>`}
        <details style="margin-top:8px"><summary class="mute">Show entries</summary>${t.entries.map(e => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><span style="flex:1">${esc(e.description || "—")}</span><b>${usd(e.value)}</b></div><div class="row"><span class="mute">${d10(e.on_date)} · ${e.amount != null ? "flat" : (e.minutes / 60).toFixed(2) + " h × " + usd(e.rate)} · ${esc(e.who || "")}${e.cause_no ? " · " + esc(e.cause_no) : ""}</span><button class="btn sm ghost" data-tedel="${e.id}" style="margin-left:auto">Delete</button></div></div>`).join("") || ""}</details></div>
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
    window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading invoice…</div>`;
    let r; try { r = await api(`/api/invoices/${id}`); } catch (e) { return fail(e); }
    const i = r.invoice;
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
    $("#app").innerHTML = `<div class="card mute">Loading trust…</div>`;
    let r, ct, cs; try { [r, ct, cs] = await Promise.all([api("/api/trust"), api("/api/contacts?kind=client"), loadCases()]); } catch (e) { return fail(e); }
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
  const hub = { id: null, sec: "overview" }, hubList = { mine: true, q: "" };
  // desktop: case list beside the open case (hidden on smaller screens)
  function clist(cs, id) {
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
    subView = true; window.scrollTo(0, 0); $("#app").innerHTML = `<div class="card mute">Loading case…</div>`;
    let r, cs, tpl, ps; try { [r, cs, tpl, ps] = await Promise.all([api(`/api/cases/${id}/hub`), loadCases(), api("/api/templates"), loadPeople()]); if (!rules) rules = (await api("/api/deadlines/rules")).rules; } catch (e) { return fail(e); }
    const c = r.case, t = todayStr();
    const unbilled = r.time.filter(x => x.billable && !x.invoice_id).reduce((s, x) => s + (x.amount != null ? Number(x.amount) : x.minutes / 60 * x.rate), 0);
    const groups = [...new Set(rules.map(x => x.group))];
    const back = titleOf(tab);
    if (hub.id !== id) { hub.id = id; hub.sec = "overview"; }
    const SECS = [["overview", "Overview"], ["dates", "Dates", r.events.filter(e => e.date >= t && !e.done).length], ["people", "People", r.contacts.length], ["tasks", "Tasks", r.tasks.filter(x => !x.done).length], ["docs", "Documents", r.documents.length]];
    if (isLawyer()) SECS.push(["billing", "Time & billing"]);
    const st = c.status || "Open", stCls = /closed|dismiss|dispos/i.test(st) ? "k" : /new/i.test(st) ? "n" : "g";
    const up = r.events.filter(e => e.date >= t && !e.done), nextH = up.find(e => e.kind === "hearing");
    const openTasks = r.tasks.filter(x => !x.done);
    const trustHeld = r.contacts.reduce((s, x) => s + Number(x.trust || 0), 0);
    const cap = s => String(s || "").replace(/^./, m => m.toUpperCase());
    const tkRow = x => `<label class="tk"><input type="checkbox" data-task="${x.id}"><span>${esc(x.title)}<small${x.due_date && d10(x.due_date) < t ? ' style="color:var(--bad);font-weight:600"' : ""}>${x.due_date ? "Due " + esc(niceDate(x.due_date)) : "No due date"}${x.assignee_name ? " · " + esc(x.assignee_name) : ""}</small></span></label>`;
    const qaBtns = [["date", "Add date", "calendar"], ["task", "Add task", "tasks"], ["draft", "Draft", "file"], isLawyer() ? ["time", "Log time", "clock"] : ["people", "People", "clients"]];
    const nh = nextH ? new Date(nextH.date + "T12:00:00") : null;
    $("#app").innerHTML = `<div class="ld">${clist(cs, id)}<div class="cdet">
      <nav class="crumb" aria-label="Breadcrumb"><button type="button" id="bk">${esc(back)}</button>${ic("chev", 14, 2)}<span>${esc(c.style || c.cause_no)}</span></nav>
      <button type="button" class="btn sm ghost phone-back" id="bk2">${ic("back", 16, 2)}${esc(back)}</button>
      <div class="chead"><div style="min-width:0"><h1 class="pt">${esc(c.style || c.cause_no)}</h1>
          <div class="chips"><span class="tag ${stCls}">${esc(st)}</span>${c.case_type ? `<span class="tag k">${esc(c.case_type)}</span>` : ""}${c.watch_dates ? `<span class="tag n">Watching court dates</span>` : ""}</div></div>
        <div class="row acts">${isLawyer() ? `<button type="button" class="btn ghost" data-act="time">${ic("clock")}Log time</button>` : ""}<button type="button" class="btn ghost" data-act="draft">${ic("file")}Draft document</button><button type="button" class="btn" data-act="date">${ic("plus", 18, 2)}Add date</button></div></div>
      <div class="qa">${qaBtns.map(([k, v, i]) => `<button type="button" data-act="${k}">${ic(i, 22)}${v}</button>`).join("")}</div>
      <dl class="cmeta"><div><dt>Cause No.</dt><dd>${esc(c.cause_no)}</dd></div><div><dt>Court</dt><dd>${esc([c.court, c.county ? c.county + " County" : ""].filter(Boolean).join(", "))}</dd></div><div><dt>Attorney</dt><dd>${esc(c.attorney || "—")}</dd></div><div><dt>Appeals to</dt><dd>${esc(META.appeals[c.county] || "—")}</dd></div></dl>
      <nav class="secnav" aria-label="Case sections">${SECS.map(([k, v, n]) => `<button type="button" data-sec-go="${k}"${hub.sec === k ? ' aria-current="page"' : ""}>${v}${n != null ? `<span>${n}</span>` : ""}</button>`).join("")}</nav>
      <div class="secsel"><label for="secSel">Section</label><select id="secSel">${SECS.map(([k, v, n]) => `<option value="${k}"${hub.sec === k ? " selected" : ""}>${v}${n != null ? ` (${n})` : ""}</option>`).join("")}</select></div>
      <div class="cols" data-sec="overview"><div class="cmain">
        ${nextH ? `<section class="box" style="padding:16px 18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap"><div class="datebox" aria-hidden="true"><small>${nh.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</small><b>${nh.getDate()}</b></div>
          <div style="flex:1;min-width:200px"><div style="font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mute)">Next court date</div><div style="font-weight:600;font-size:16px">${esc(nextH.title)} · ${esc(niceDate(nextH.date))}${nextH.time ? " " + esc(nextH.time) : ""}</div><div class="mute">${esc(nextH.location || c.court || "")}${c.watch_dates ? " · checked every hour" : ""}</div></div></section>` : ""}
        <section class="box"><div class="bh"><h2>Coming up</h2><button type="button" class="lk" data-sec-go="dates">All dates</button></div><div class="dayb">${up.slice(0, 4).map(e => itemRow(e, { date: true, noCase: true })).join("") || `<div class="mute" style="padding:0 0 14px">No upcoming dates.</div>`}</div></section>
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
      <div class="card" data-sec="people"><div class="row" style="justify-content:space-between"><h3 style="margin:0">People</h3><button class="btn sm" id="hbPp">+ Add</button></div>
        <div id="hbPpBox" hidden style="margin-top:8px"><label>Existing contact</label><input id="ppSearch" placeholder="Type a name"><div id="ppRes"></div>
          <details style="margin-top:8px"><summary class="mute">Or a new person</summary><form id="ppNew" style="margin-top:6px">${contactFields()}<label>Role on this case</label><select name="role"><option value="client">Client</option><option value="opposing party">Opposing party</option><option value="opposing counsel">Opposing counsel</option><option value="witness">Witness</option><option value="other">Other</option></select><div class="cfOut"></div><div class="err"></div><button class="btn sm">Add</button></form></details></div>
        ${r.contacts.map(p => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><a class="link" data-ct="${p.id}">${esc(p.name)}</a><span class="tag ${p.role === "client" ? "g" : /opposing/.test(p.role) ? "r" : "n"}">${esc(p.role)}</span>${Number(p.trust) && isLawyer() ? `<span class="tag y">Trust ${usd(p.trust)}</span>` : ""}<button class="btn sm ghost" data-ppdel="${p.id}" style="margin-left:auto">Remove</button></div><div class="mute">${[p.company, p.phone, p.email].filter(Boolean).map(esc).join(" · ")}</div></div>`).join("") || `<div class="mute" style="margin-top:6px">Add the client and the other side — every name is checked for conflicts.</div>`}</div>
      <div class="card" data-sec="tasks"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Tasks</h3><button class="btn sm" id="hbTk">+ Task</button></div>
        <form id="hbTkF" hidden style="margin-top:8px"><div class="grid"><div class="full"><label>Task</label><input name="title" required></div><div><label>Due</label><input type="date" name="due_date"></div><div><label>For</label><select name="assignee">${peopleOptions(ps, c.user_id || me.id)}</select></div></div><button class="btn sm">Add</button></form>
        ${r.tasks.map(x => `<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:15px;color:var(--ink)"><input type="checkbox" data-task="${x.id}" ${x.done ? "checked" : ""} style="width:auto;margin-top:3px"><span style="${x.done ? "text-decoration:line-through;color:var(--mute)" : ""}">${esc(x.title)}<br><span class="mute" style="${!x.done && x.due_date && d10(x.due_date) < t ? "color:var(--bad)" : ""}">${x.due_date ? "Due " + niceDate(x.due_date) : ""}${x.assignee_name ? " · " + esc(x.assignee_name) : ""}</span></span></label>`).join("") || `<div class="mute" style="margin-top:6px">No tasks.</div>`}</div>
      <div class="card" data-sec="docs"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Documents</h3><label class="btn sm" style="cursor:pointer">Upload<input type="file" id="docUp" multiple hidden></label></div>
        <div class="row" style="margin-top:8px"><select id="tplSel" style="flex:1;min-width:200px">${tpl.templates.map(x => `<option value="${x.key}">${esc(x.label)}</option>`).join("")}</select><button class="btn sm ghost" id="tplGo">Draft in Word</button></div><div id="tplAsk"></div>
        ${r.documents.map(d => `<div style="border-top:1px solid var(--line);padding:6px 0"><div class="row"><a class="link" href="/api/documents/${d.id}" style="flex:1">${esc(d.name)}</a><span class="mute">${Math.max(1, Math.round(d.size / 1024))} KB</span></div>
          <div class="row"><label style="display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink)"><input type="checkbox" data-share="${d.id}" ${d.shared ? "checked" : ""} style="width:auto"> Show on client page</label><button class="btn sm ghost" data-docdel="${d.id}" style="margin-left:auto">Delete</button></div></div>`).join("")}
        ${r.emails.length ? `<h3 style="margin-top:12px">Court emails</h3>${r.emails.map(m => `<div style="border-top:1px solid var(--line);padding:6px 0"><a class="link" data-mail="${m.id}">${esc(m.subject || "(no subject)")}</a><div class="mute">${new Date(m.received_at).toLocaleString()}</div></div>`).join("")}` : ""}
        ${!r.documents.length && !r.emails.length ? `<div class="mute" style="margin-top:6px">Upload files, or draft a notice or letter from the case details.</div>` : ""}</div>
      ${isLawyer() ? `<div class="card" data-sec="billing"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Time & billing</h3><button class="btn sm" id="hbTime">+ Time</button></div>
        <div id="hbTimeBox" hidden style="margin-top:8px">${timeForm(cs, c.id)}</div>
        <div class="kv"><div><b>Unbilled</b>${usd(unbilled)}</div><div><b>Billing</b>${esc(c.billing || "hourly")}</div><div><b>Case rate</b>${c.rate != null ? usd(c.rate) + "/h" : "attorney's rate"}</div></div>
        <div class="row" style="margin-top:8px">${unbilled > 0 ? `<button class="btn sm" id="hbInv">Create invoice</button>` : ""}<button class="btn sm ghost" id="hbRate">Billing settings</button></div>
        <form id="hbRateF" hidden style="margin-top:8px"><div class="grid"><div><label>Billing</label><select name="billing"><option value="hourly">Hourly</option><option value="flat">Flat fee</option><option value="contingency">Contingency</option></select></div><div><label>Case hourly rate</label><input name="rate" inputmode="decimal" value="${c.rate ?? ""}" placeholder="use attorney's"></div></div><button class="btn sm">Save</button></form>
        ${r.invoices.map(i => `<div style="border-top:1px solid var(--line);padding:6px 0;cursor:pointer" data-inv="${i.id}"><div class="row"><b>#${esc(i.number)}</b><span class="tag ${i.status === "paid" ? "g" : i.status === "sent" ? "y" : "n"}">${esc(i.status)}</span><b style="margin-left:auto">${usd(i.total)}</b></div></div>`).join("")}
        ${r.time.slice(0, 8).map(x => `<div class="mute" style="border-top:1px solid var(--line);padding:4px 0">${d10(x.on_date)} · ${esc(x.description || "—")} · ${x.amount != null ? usd(x.amount) : (x.minutes / 60).toFixed(2) + " h"}${x.invoice_id ? " · billed" : ""}</div>`).join("")}</div>` : ""}
      </div></div>`;
    $("#bk").onclick = $("#bk2").onclick = () => { subView = false; show(); };
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
  window.contactView = contactView;

  // ===================== FIRM SETTINGS (admin extras) =====================
  window.renderFirmExtras = async function (us) {
    const box = $("#firmExtras"); if (!box) return;
    let cd, tt, sp; try { [cd, tt, sp] = await Promise.all([api("/api/firm/closed-days"), api("/api/firm/task-templates"), api("/api/firm/stripe")]); } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
    const types = ["*", ...(typeof TYPES !== "undefined" ? TYPES : [])];
    const byType = {}; tt.templates.forEach(x => (byType[x.case_type] = byType[x.case_type] || []).push(x));
    box.innerHTML = `
      <div class="card"><h2>Card payments (Stripe)</h2>
        ${sp.on ? `<p><span class="tag g">On</span> <span class="mute">Key ${esc(sp.hint)}</span></p>` : `<p class="mute" style="margin-top:0">Clients pay invoices online by card or bank; the money goes straight to your Stripe account.</p>`}
        <details ${sp.on ? "" : "open"}><summary>${sp.on ? "Replace key or change the fee" : "How to turn it on"}</summary><ol style="padding-left:20px;line-height:1.6;font-size:15px"><li>Sign in at <a class="link" href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener">dashboard.stripe.com → Developers → API keys</a> (create a free Stripe account first if you don't have one).</li><li>Copy the <b>Secret key</b> (starts with <code>sk_live_</code>) and paste it below.</li><li>Enter your card rate from your Stripe pricing so invoices show the fee up front.</li></ol>
        <form id="spF"><div class="grid"><div class="full"><label>Stripe secret key</label><input name="secret" type="password" autocomplete="off" placeholder="${sp.on ? "leave blank to keep the current key" : "sk_live_…"}"></div>
          <div><label>Card fee %</label><input name="fee_pct" inputmode="decimal" value="${sp.fee_pct ?? ""}"></div><div><label>+ fixed fee ($)</label><input name="fee_fixed" inputmode="decimal" value="${sp.fee_fixed ?? ""}"></div></div>
          <div class="err"></div><div class="row"><button class="btn">Save</button>${sp.on ? `<button type="button" class="btn danger" id="spOff">Turn off</button>` : ""}</div></form></details></div>
      <div class="card"><h2>Court closed days</h2><p class="mute" style="margin-top:0">National holidays are already skipped and Texas state holidays are flagged. Add any other days your courts or clerk's office close (county holidays, weather closures) — deadlines will roll past them.</p>
        ${cd.days.map((x, i) => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${niceDate(x.date)} — ${esc(x.name)}</span><button class="btn sm ghost" data-cdd="${i}">Remove</button></div>`).join("")}
        <div class="row" style="margin-top:8px"><input type="date" id="cdDate" style="max-width:180px"><input id="cdName" placeholder="Hidalgo County holiday" style="flex:1;min-width:160px"><button class="btn sm" id="cdAdd">Add</button></div></div>
      <div class="card"><h2>Checklists for new cases</h2><p class="mute" style="margin-top:0">These tasks are added automatically when a case is created — by hand, by import, or from a court email. "Every case" applies to all.</p>
        ${Object.entries(byType).map(([k, v]) => `<div style="margin-top:8px;font-weight:700">${k === "*" ? "Every case" : esc(k)}</div>${v.map(x => `<div class="row" style="border-top:1px solid var(--line);padding:4px 0"><span style="flex:1">${esc(x.title)}${x.due_days != null ? ` <span class="mute">· due in ${x.due_days} day${x.due_days === 1 ? "" : "s"}</span>` : ""}</span><button class="btn sm ghost" data-ttd="${x.id}">Remove</button></div>`).join("")}`).join("")}
        <form id="ttF" style="margin-top:10px"><div class="grid"><div><label>Case type</label><select name="case_type">${types.map(x => `<option value="${esc(x)}">${x === "*" ? "Every case" : esc(x)}</option>`).join("")}</select></div><div><label>Due in (days)</label><input name="due_days" inputmode="numeric"></div><div class="full"><label>Task</label><input name="title" required></div></div><button class="btn sm">Add to checklist</button></form></div>
      <div class="card"><h2>Billing rates</h2>${us.filter(u => u.active).map(u => `<div class="row" style="border-top:1px solid var(--line);padding:6px 0"><span style="flex:1">${esc(u.name)} <span class="mute">${esc(u.role)}</span></span><input data-rate="${u.id}" inputmode="decimal" placeholder="$/hour" value="${(people || []).find(p => p.id === u.id)?.rate ?? ""}" style="max-width:120px"></div>`).join("")}<button class="btn sm" id="rtSave" style="margin-top:8px">Save rates</button></div>
      <div class="card"><h2>Export everything</h2><p class="mute" style="margin-top:0">Your data is yours. Download any of it as a spreadsheet (CSV) at any time.</p><div class="row">${["cases", "contacts", "calendar", "tasks", "time", "invoices", "trust"].map(w => `<a class="btn sm ghost" href="/export/${w}.csv" style="text-decoration:none">${w[0].toUpperCase() + w.slice(1)}</a>`).join("")}</div></div>`;
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
