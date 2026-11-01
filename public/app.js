// TX Case Desk — front end
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const ordn = n => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"); // 1st..15th
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 3000); }

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json", "X-Requested-With": "tcd" }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
  let data = {}; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data.error || "Request failed"); err.status = res.status; err.code = data.code; throw err; }
  return data;
}

let META = null, me = null, tab = "today";
const VIEWS = {}; // extra views registered by practice.js
let moreOpen = false;
const caseF = { view: "mine", county: "", type: "", attorney: "" };
let firmUsers = null;
let inboxUnread = 0;
const law = { q: "", court: "", after: "", county: "", results: null, open: null };

// ---------------- auth screens ----------------
function authView(mode = "login", msg = "") {
  shellOff();
  const signup = mode === "signup";
  $("#app").innerHTML = `<div class="narrow card"><h2>${signup ? "Create firm account" : "Attorney sign in"}</h2>
   <form id="f">
   ${signup ? `<fieldset style="border:0;padding:0;margin:0 0 12px"><legend style="font-size:12px;color:var(--mute);font-weight:500;margin-bottom:6px;padding:0">How do you practice?</legend>
     <div class="row" style="gap:8px"><label class="ck chipr"><input type="radio" name="kind" value="solo" checked>Solo attorney</label><label class="ck chipr"><input type="radio" name="kind" value="firm">Law firm</label></div>
     <p class="mute" style="margin:4px 0 0">Solo gets everything for one attorney. A firm adds partners, attorneys and staff with their own sign-ins.</p></fieldset>
   <label id="firmLbl">Practice name (optional)</label><input name="firm" id="firmIn" placeholder="Law Office of …"><br><br>
   <label>Your full name</label><input name="name" required><br><br>
   <label>Texas Bar # (8 digits)</label><input name="bar" inputmode="numeric" pattern="\\d{8}" required><br><br>
   <label>Free-time code (optional)</label><input name="code" value="${esc(new URLSearchParams(location.search).get("code") || "")}" placeholder="TXC-30D-…"><br><br>` : ""}
   <label>Email</label><input name="email" type="email" autocomplete="username" required><br><br>
   <label>Password${signup ? " (10+ chars, letters & numbers)" : ""}</label><input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" required>
   <div class="err" id="err">${esc(msg)}</div>
   <button class="btn" style="width:100%">${signup ? "Create account" : "Continue"}</button></form>
   ${signup ? `<p class="mute" style="text-align:center">Every new firm starts with a free 14-day trial.</p>` : ""}
   <p class="mute" style="text-align:center"><a class="link" id="sw">${signup ? "Have an account? Sign in" : "New firm? Create an account"}</a></p></div>`;
  $("#sw").onclick = () => authView(signup ? "login" : "signup");
  $$("[name=kind]").forEach(r => r.onchange = () => { const solo = $("[name=kind]:checked").value === "solo"; $("#firmLbl").textContent = solo ? "Practice name (optional)" : "Firm name"; $("#firmIn").required = !solo; $("#firmIn").placeholder = solo ? "Law Office of …" : ""; });
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(e.target));
    try { const r = await api(signup ? "/api/signup" : "/api/login", { method: "POST", body: b }); r.next === "verify_2fa" ? verifyView() : enrollView(); }
    catch (err) { $("#err").textContent = err.message; }
  };
}
function verifyView() {
  $("#app").innerHTML = `<div class="narrow card"><h2>Two-factor code</h2><p class="mute">Open your authenticator app and enter the 6-digit code for TX Case Desk.</p>
   <form id="f"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus><div class="err" id="err"></div><button class="btn" style="width:100%">Sign in</button></form></div>`;
  $("#f").onsubmit = async e => { e.preventDefault(); try { const r = await api("/api/login/2fa", { method: "POST", body: { code: e.target.code.value } }); me = r.user; start(); } catch (err) { $("#err").textContent = err.message; } };
}
async function enrollView() {
  $("#app").innerHTML = `<div class="narrow card"><h2>Set up two-factor</h2><div class="mute">Loading…</div></div>`;
  try {
    const s = await api("/api/2fa/setup");
    $("#app").innerHTML = `<div class="narrow card"><h2>Set up two-factor</h2>
    <p class="mute">Required for every account. Scan with Google Authenticator, Microsoft Authenticator or Authy, then enter the code.</p>
    <img class="qr" src="${s.qr}" alt="2FA QR code"><p class="mute">Can't scan? Enter this key:</p><div class="secret">${esc(s.secret)}</div><br>
    <form id="f"><label>6-digit code</label><input name="code" inputmode="numeric" maxlength="7" required><div class="err" id="err"></div><button class="btn" style="width:100%">Turn on 2FA</button></form></div>`;
    $("#f").onsubmit = async e => { e.preventDefault(); try { const r = await api("/api/2fa/enable", { method: "POST", body: { code: e.target.code.value } }); me = r.user; toast("Two-factor is on"); start(); } catch (err) { $("#err").textContent = err.message; } };
  } catch (err) { authView("login", err.message); }
}
function changePwView(forced) {
  $("#app").innerHTML = `<div class="narrow card"><h2>${forced ? "Set your own password" : "Change password"}</h2>${forced ? `<p class="mute">You signed in with a temporary password.</p>` : ""}
   <form id="f"><label>Current password</label><input name="current" type="password" required><br><br>
   <label>New password (10+ chars, letters & numbers)</label><input name="next" type="password" autocomplete="new-password" required>
   <div class="err" id="err"></div><button class="btn" style="width:100%">Save</button></form></div>`;
  $("#f").onsubmit = async e => { e.preventDefault(); try { await api("/api/password", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); me.must_change_pw = false; toast("Password updated"); start(); } catch (err) { $("#err").textContent = err.message; } };
}

// ---------------- shell ----------------
const ICON = {
  today: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4M9 14.5l2 2 4-4"/>',
  dashboard: '<path d="M4 20h16M6.5 16.5V11M11.5 16.5V5.5M16.5 16.5v-8"/>',
  cases: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12.5h18"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  inbox: '<path d="M3 13l2.5-7.5A1.5 1.5 0 0 1 6.9 4.5h10.2a1.5 1.5 0 0 1 1.4 1L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  clients: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.4 3.5 5.2"/>',
  tasks: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M8 12l3 3 5-6"/>',
  billing: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  trust: '<path d="M12 3l7 3v5.5c0 4.5-3 7.8-7 9.5-4-1.7-7-5-7-9.5V6z"/>',
  law: '<path d="M12 4v16M7 20h10M4 7h16M6 7l-3 6.5a3 3 0 0 0 6 0zM18 7l-3 6.5a3 3 0 0 0 6 0z"/>',
  saved: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  counties: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  court: '<path d="M3 9.5L12 4l9 5.5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20.5h18"/>',
  firm: '<path d="M4 6h9M18 6h2M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15.5" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  account: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1-3.8 4-5.5 7.5-5.5s6.5 1.7 7.5 5.5"/>',
  more: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  file: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  text: '<path d="M4 5h16v11H9l-5 4z"/>'
};
const ic = (k, s = 18, w = 1.75) => `<svg aria-hidden="true" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICON[k] || ""}</svg>`;
const initials = n => String(n || "").split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0].toUpperCase()).join("") || "?";
function navGroups() {
  const g = [["Practice", [["today", "Today"], ["dashboard", "Dashboard"], ["cases", "Cases"], ["calendar", "Calendar"], ["inbox", "Court mail"], ["clients", "Clients"], ["tasks", "Tasks"]]]];
  const money = []; if (me.role !== "paralegal") money.push(["billing", "Billing"]); if (me.trust_access) money.push(["trust", "Trust"]);
  if (money.length) g.push(["Money", money]);
  g.push(["Research", [["law", "Case law"], ["saved", "Saved"]]]);
  const set = [["counties", "My counties"], ["court", "Court updates"]]; if (me.role === "admin") set.push(["firm", "Firm settings"]);
  g.push(["Setup", set]);
  return g;
}
const PRIMARY = [["today", "Today"], ["cases", "Cases"], ["calendar", "Calendar"], ["inbox", "Court mail"]];
function titleOf(k) { if (k === "account") return "Account"; for (const [, items] of navGroups()) for (const [kk, v] of items) if (kk === k) return v; return "TX Case Desk"; }
function shellOff() {
  document.body.classList.add("out"); ["#side", "#tabs", "#fab", "#srch", "#tact"].forEach(s => $(s).hidden = true);
  document.body.classList.remove("timing"); closeSheet();
  $("#ttl").innerHTML = `<span class="mark" aria-hidden="true">TX</span><span class="tname">TX Case Desk</span>`;
}
function shellOn() {
  document.body.classList.remove("out"); ["#side", "#tabs", "#fab", "#srch", "#tact"].forEach(s => $(s).hidden = false);
  $("#avBtn").textContent = initials(me.name);
}
function start() {
  if (me.must_change_pw) return changePwView(true);
  api("/api/inbox").then(r => { if (r.unread !== inboxUnread) { inboxUnread = r.unread; renderNav(); } }).catch(() => {});
  if (!me.counties.length && (tab === "cases" || tab === "today")) tab = "counties";
  shellOn(); renderNav(); renderTimer(); show();
}
function renderNav() {
  if (!me) return;
  const badge = k => k === "inbox" && inboxUnread ? `<span class="badge">${inboxUnread}</span>` : "";
  const item = ([k, v]) => `<a href="#${k}" data-t="${k}" class="ni${tab === k ? " on" : ""}"${tab === k ? ' aria-current="page"' : ""}>${ic(k)}<span>${v}</span>${badge(k)}</a>`;
  const role = me.firm_kind === "solo" ? "Solo attorney" : ROLE_LBL[me.role] || "Attorney";
  $("#side").innerHTML = (me.firm_logo ? `<div class="brand withlogo"><span class="blogo"><img src="${esc(me.firm_logo)}" alt=""></span><span class="bt"><b>${esc(me.firm_name || "")}</b><small>TX Case Desk</small></span></div>`
    : `<div class="brand"><span class="mark" aria-hidden="true">TX</span><span><b>TX Case Desk</b><small>${esc(me.firm_name || "")}</small></span></div>`) + `
    <nav aria-label="Main" style="display:flex;flex-direction:column;gap:18px">${navGroups().map(([h, items]) => `<div class="ng"><div class="nh">${h}</div>${items.map(item).join("")}</div>`).join("")}</nav>
    <a href="#account" data-t="account" class="me${tab === "account" ? " on" : ""}"><span class="av">${esc(initials(me.name))}</span><span><b>${esc(me.name)}</b><small>${role}${me.bar_number ? " · Bar #" + esc(me.bar_number) : ""}</small></span></a>`;
  const inMore = !PRIMARY.some(([k]) => k === tab);
  $("#tabs").innerHTML = PRIMARY.map(([k, v]) => `<a href="#${k}" data-t="${k}" class="tb${tab === k ? " on" : ""}"${tab === k ? ' aria-current="page"' : ""}><span class="ti">${ic(k, 22, tab === k ? 2 : 1.75)}${k === "inbox" && inboxUnread ? `<span class="bdg">${inboxUnread}</span>` : ""}</span>${v}</a>`).join("")
    + `<button type="button" class="tb${inMore ? " on" : ""}" id="moreBtn"><span class="ti">${ic("more", 22)}</span>More</button>`;
  document.body.dataset.tab = tab;
  $("#ttl").innerHTML = tab !== "today" ? `<span class="tname">${esc(titleOf(tab))}</span>`
    : me.firm_logo ? `<img class="tlogo" src="${esc(me.firm_logo)}" alt="${esc(me.firm_name || "Firm")} logo">` : `<span class="mark" aria-hidden="true">TX</span><span class="tname">TX Case Desk</span>`;
  $$("#side [data-t], #tabs [data-t]").forEach(a => a.onclick = e => { e.preventDefault(); nav(a.dataset.t); });
  $("#moreBtn").onclick = moreSheet;
}
function nav(k) { tab = k; closeSheet(); closeSearch(); renderNav(); return show(); }
function show() { subView = false; clearTimeout(courtPoll); const v = VIEWS[tab] || ({ inbox: inboxView, cases: casesView, law: lawView, saved: savedView, counties: countiesView, court: courtView, firm: firmView, account: accountView })[tab] || casesView; const r = v(); window.scrollTo(0, 0); return r; }

// sheet: menus on desktop, bottom sheet on phones
function openSheet(title, html, wire) {
  const sh = $("#sheet");
  sh.innerHTML = `<div class="sh"><h2>${esc(title)}</h2><button type="button" class="iconb" id="shX" aria-label="Close">${ic("close", 20, 2)}</button></div>${html}`;
  sh.hidden = false; $("#scrim").hidden = false;
  $("#shX").onclick = closeSheet; $("#scrim").onclick = closeSheet;
  if (wire) wire(sh);
  const f = sh.querySelector("input,select,textarea,.sbtn"); if (f && window.matchMedia("(min-width:1000px)").matches) f.focus();
}
function closeSheet() { const sh = $("#sheet"); if (sh) { sh.hidden = true; sh.innerHTML = ""; } const s = $("#scrim"); if (s) s.hidden = true; }
function moreSheet() {
  const items = navGroups().flatMap(([, it]) => it).filter(([k]) => !PRIMARY.some(([p]) => p === k)).concat([["account", "Account"]]);
  openSheet("More", `<div class="sgrid">${items.map(([k, v]) => `<button type="button" class="sbtn${tab === k ? " on" : ""}" data-go="${k}">${ic(k, 20)}<span>${v}</span></button>`).join("")}</div>`,
    sh => sh.querySelectorAll("[data-go]").forEach(b => b.onclick = () => nav(b.dataset.go)));
}
// quick add: opens the right screen with its add form ready
const QUICK = [["case", "New case", "cases", "#addBox", "cases"], ["client", "New client", "clients", "#ctF", "clients"], ["task", "Task", "tasks", "#tkF", "tasks"],
  ["event", "Hearing or meeting", "calendar", "#evF", "calendar"], ["deadline", "Texas deadline", "calendar", "#dlBox", "law"], ["time", "Log time", "billing", "#teF", "clock"]];
function quickSheet() {
  const items = QUICK.filter(q => q[0] !== "time" || me.role !== "paralegal");
  openSheet("Add new", `<div class="sgrid">${items.map(([k, v, , , i]) => `<button type="button" class="sbtn" data-qa="${k}">${ic(i, 20)}<span>${v}</span></button>`).join("")}</div>`,
    sh => sh.querySelectorAll("[data-qa]").forEach(b => b.onclick = () => quickAdd(b.dataset.qa)));
}
async function quickAdd(k) {
  const q = QUICK.find(x => x[0] === k); if (!q) return;
  await nav(q[2]);
  const el = $(q[3]); const d = el && (el.tagName === "DETAILS" ? el : el.closest("details"));
  if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(() => { const i = d.querySelector("input:not([type=hidden]):not([type=checkbox]),select,textarea"); if (i) i.focus({ preventScroll: true }); }, 350); }
}
// running timer (kept on this device; same storage the Today and Billing screens use)
const TM = { get() { try { return JSON.parse(localStorage.getItem("tcd_timer") || "null"); } catch { return null; } }, set(v) { try { v ? localStorage.setItem("tcd_timer", JSON.stringify(v)) : localStorage.removeItem("tcd_timer"); } catch {} renderTimer(); } };
const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
let tmTick = null;
function renderTimer() {
  const t = me && TM.get(), pill = $("#tpill"), bar = $("#tbar");
  if (!t) { pill.hidden = true; bar.innerHTML = ""; document.body.classList.remove("timing"); clearInterval(tmTick); tmTick = null; return; }
  const el = hms(Date.now() - t.start);
  pill.hidden = false; pill.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="tel">${el}</span>`; pill.title = "Timer: " + (t.label || "No case"); pill.setAttribute("aria-label", `Timer running ${el}, ${t.label || "no case"}. Stop timer`);
  bar.innerHTML = `<span class="dot" aria-hidden="true"></span><button type="button" class="tt" id="tbOpen"><b class="tel">${el}</b><small>${esc(t.label || "No case")}</small></button><button type="button" class="btn sm navy" id="tbStop" style="min-height:44px">Stop</button>`;
  document.body.classList.add("timing");
  pill.onclick = stopSheet; $("#tbStop").onclick = stopSheet; $("#tbOpen").onclick = stopSheet;
  if (!tmTick) tmTick = setInterval(() => { const x = TM.get(); if (!x) return renderTimer(); $$(".tel").forEach(n => n.textContent = hms(Date.now() - x.start)); }, 1000);
}
window.renderTimer = renderTimer;
function stopSheet() {
  const t = TM.get(); if (!t) return;
  const mins = Math.max(1, Math.round((Date.now() - t.start) / 60000));
  openSheet("Stop timer", `<div><div class="stat">${Math.floor(mins / 60)}h ${mins % 60}m</div><div class="mute">${esc(t.label || "No case")}</div></div>
    <form id="stF"><label for="stD">What did you work on?</label><input id="stD" name="description" placeholder="Prep for hearing"><div class="err"></div>
    <div class="row" style="margin-top:8px"><button class="btn" style="flex:1">Stop and save</button><button type="button" class="btn ghost" id="stDis">Discard</button></div></form>`, sh => {
    sh.querySelector("#stF").onsubmit = async e => { e.preventDefault(); const m = Math.max(1, Math.round((Date.now() - t.start) / 60000));
      try { await api("/api/time", { method: "POST", body: { case_id: t.case_id, minutes: m, description: e.target.description.value } }); TM.set(null); closeSheet(); toast(`Saved ${m} minutes`); if (["today", "billing"].includes(tab) && !subView) show(); }
      catch (x) { e.target.querySelector(".err").textContent = x.message; } };
    const dis = sh.querySelector("#stDis"); dis.onclick = () => { if (!dis.dataset.sure) { dis.dataset.sure = 1; dis.textContent = "Tap again to discard"; return; } TM.set(null); closeSheet(); if (["today", "billing"].includes(tab) && !subView) show(); };
  });
}
// search cases and people from the top bar
let qT = null, qCases = null, qAt = 0;
function openSearch() { $("#top").classList.add("searching"); $("#q").focus(); }
function closeSearch() { const t = $("#top"); if (!t) return; t.classList.remove("searching"); $("#qres").hidden = true; }
async function topSearch(v) {
  const box = $("#qres"); if (v.length < 2) { box.hidden = true; return; }
  try { if (!qCases || Date.now() - qAt > 60e3) { qCases = (await api("/api/cases?view=firm")).cases; qAt = Date.now(); } } catch { qCases = qCases || []; }
  const lv = v.toLowerCase();
  const cs = qCases.filter(c => `${c.cause_no} ${c.style || ""} ${c.court || ""} ${c.county || ""}`.toLowerCase().includes(lv)).slice(0, 6);
  let ct = []; try { ct = (await api("/api/contacts?q=" + encodeURIComponent(v))).contacts.slice(0, 4); } catch {}
  if ($("#q").value.trim() !== v) return;
  box.innerHTML = (cs.length ? `<div class="qh">Cases</div>` + cs.map(c => `<button type="button" class="qi" data-qc="${c.id}"><b>${esc(c.style || c.cause_no)}</b><small>${esc(c.cause_no)}${c.court ? " · " + esc(c.court) : ""} · ${esc(c.county)}</small></button>`).join("") : "")
    + (ct.length ? `<div class="qh">People</div>` + ct.map(p => `<button type="button" class="qi" data-qp="${p.id}"><b>${esc(p.name)}</b><small>${esc(p.kind)}${p.company ? " · " + esc(p.company) : ""}</small></button>`).join("") : "")
    || `<div class="qe">No cases or people match “${esc(v)}”.</div>`;
  box.hidden = false;
  box.querySelectorAll("[data-qc]").forEach(b => b.onclick = () => { $("#q").value = ""; closeSearch(); if (tab !== "cases") { tab = "cases"; renderNav(); } window.caseHub && caseHub(+b.dataset.qc); });
  box.querySelectorAll("[data-qp]").forEach(b => b.onclick = () => { $("#q").value = ""; closeSearch(); if (tab !== "clients") { tab = "clients"; renderNav(); } window.contactView && contactView(+b.dataset.qp); });
}
$("#q").oninput = e => { clearTimeout(qT); const v = e.target.value.trim(); qT = setTimeout(() => topSearch(v), 200); };
$("#q").onkeydown = e => { if (e.key === "Enter") { const f = $("#qres [data-qc], #qres [data-qp]"); if (f) f.click(); } };
$("#qBtn").onclick = openSearch; $("#qClose").onclick = () => { $("#q").value = ""; closeSearch(); };
$("#newBtn").onclick = quickSheet; $("#fab").onclick = quickSheet; $("#avBtn").onclick = () => nav("account");
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && me && !document.body.classList.contains("out")) { e.preventDefault(); openSearch(); }
  if (e.key === "Escape") { closeSheet(); closeSearch(); }
});
document.addEventListener("click", e => { if (!e.target.closest("#srch") && !e.target.closest("#qBtn")) { $("#qres").hidden = true; } });

// ---------------- inbox (court emails) ----------------
const TYPE_TAG = { "Hearing / setting": "y", "New filing": "g", "Order / judgment": "r", "Case notice": "n", "Account activation": "n", "Email": "n" };
let subView = false;
// copy boxes: value in its own box + Copy button (no stray spaces)
function copyBox(val) { return `<div class="row" style="margin:4px 0;flex-wrap:nowrap"><div class="secret" style="flex:1">${esc(val)}</div><button type="button" class="btn sm" data-copy="${esc(val)}">Copy</button></div>`; }
document.addEventListener("click", async e => { const b = e.target.closest("[data-copy]"); if (!b) return; try { await navigator.clipboard.writeText(b.dataset.copy.trim()); toast("Copied"); } catch { toast(b.dataset.copy); } });
// "Connect with your email password" (IMAP) — Titan / GoDaddy / Zoho and other hosts
function imapForm(mb, open) {
  const lab = mb && mb.other && mb.other.label ? mb.other.label : "your email host";
  const titan = /titan|godaddy/i.test(lab);
  return `<details class="imapBox" ${open ? "open" : ""} style="margin:8px 0"><summary style="cursor:pointer;font-weight:600">Connect with your email password${open ? "" : " (GoDaddy, Titan, Zoho, others)"}</summary>
    <p class="mute" style="margin:6px 0">For email that isn't Outlook or Gmail${mb && mb.other && mb.other.label ? ` — yours is hosted by <b>${esc(lab)}</b>` : ""}. Your password is encrypted and used only to read court emails.</p>
    ${titan ? `<p style="margin:6px 0;font-size:14px"><b>Titan / GoDaddy first:</b> sign in to <a class="link" href="https://app.titan.email" target="_blank" rel="noopener">app.titan.email</a> → Settings → turn <b>Third-party email access ON</b> and <b>Two-step login OFF</b> (Titan blocks other apps while two-step is on).</p>` : ""}
    <form class="imapF"><label>Email address</label><input name="email" type="email" autocomplete="email" value="${esc(me.email || "")}" required>
    <label>Email password</label><input name="password" type="password" autocomplete="current-password" required>
    <details style="margin:6px 0"><summary class="mute" style="cursor:pointer;font-size:13px">Advanced: mail server</summary><label>Incoming (IMAP) server — leave blank to detect</label><input name="host" placeholder="imap.example.com"></details>
    <div class="err imapErr"></div><button class="btn" style="width:100%;padding:12px">Connect email</button></form></details>`;
}
function wireImap(after) {
  $$(".imapF").forEach(f => f.onsubmit = async e => {
    e.preventDefault(); const btn = f.querySelector("button.btn"), err = f.querySelector(".imapErr"); err.textContent = ""; btn.disabled = true; btn.textContent = "Checking…";
    try { const r = await api("/api/mail/imap", { method: "POST", body: Object.fromEntries(new FormData(f)) }); toast(`Connected ${r.email} — checking court emails now`); after(); }
    catch (x) { err.textContent = x.message; btn.disabled = false; btn.textContent = "Connect email"; }
  });
}
async function inboxView(quiet) {
  subView = false;
  if (!quiet) $("#app").innerHTML = `<div class="card mute">Loading inbox…</div>`;
  let r, mb; try { [r, mb] = await Promise.all([api("/api/inbox"), api("/api/mail").catch(() => null)]); } catch (e) { return fail(e); }
  inboxUnread = r.unread; renderNav();
  const conn = mb && mb.mailboxes.find(x => x.status === "ok" || x.status === "syncing");
  const connCard = !mb ? "" : conn
    ? `<div class="card"><span class="tag g">Connected</span> <b>${esc(conn.email || mb.names[conn.provider])}</b> <span class="mute">· court emails are checked every hour</span>
       ${conn.stats && conn.stats.scanned != null ? `<div class="mute" style="font-size:13px;margin-top:4px">Last check ${new Date(conn.stats.at).toLocaleString()}: looked at ${conn.stats.scanned} emails, found ${conn.stats.court} from courts${conn.stats.created ? `, added ${conn.stats.created} cases` : ""}.</div>` : ""}
       ${conn.stats && conn.stats.note ? `<p class="err" style="margin:6px 0 0">${esc(conn.stats.note)}</p>${conn.provider !== "imap" ? imapForm(mb, true) : ""}` : ""}</div>`
    : `<div class="card"><h2 style="margin-top:0">Connect your email</h2><p style="margin-top:0">Sign in once with the email you get court notices at. We read only court emails and build and update your cases from them.</p>
       ${mb.other && !mb.other.provider && mb.other.label ? `<p style="margin:0 0 6px"><b>Your email is hosted by ${esc(mb.other.label)}</b> — use the password sign-in below (the Outlook button won't see that mail).</p>` : ""}
       ${mb.configured.microsoft ? `<a class="btn ${mb.other && !mb.other.provider ? "ghost" : ""}" href="/api/mail/connect/microsoft" style="display:block;text-align:center;text-decoration:none;margin:8px 0;padding:14px">Sign in with Outlook / Microsoft 365</a>` : `<p class="mute" style="margin:6px 0">Outlook / Microsoft 365 sign-in isn't switched on yet.</p>`}
       ${mb.configured.google ? `<a class="btn" href="/api/mail/connect/google" style="display:block;text-align:center;text-decoration:none;margin:8px 0;padding:14px">Sign in with Gmail</a>` : ""}
       ${imapForm(mb, mb.other && !mb.other.provider)}
       <p class="mute" style="margin-bottom:0;font-size:13px">Read-only. Personal email is ignored and never stored. Disconnect anytime under Court Updates.</p></div>`;
  $("#app").innerHTML = `${connCard}<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Inbox</h2>${r.unread ? `<button class="btn sm ghost" id="readAll">Mark all read</button>` : ""}</div>
   <p class="mute" style="margin-bottom:0">Every court email from your connected email. Tap one for the summary and the exact email.</p></div>
   ${r.emails.map(m => `<div class="card" data-open="${m.id}" style="cursor:pointer;${m.read ? "" : "border-left:4px solid var(--acc)"}">
     <div class="row"><span class="tag ${TYPE_TAG[m.type] || "n"}">${esc(m.type)}</span>${m.read ? "" : `<span class="tag r">New</span>`}<span class="mute" style="margin-left:auto">${new Date(m.received_at).toLocaleString()}</span></div>
     <h3 style="margin-top:6px">${esc(m.subject || "(no subject)")}</h3>
     <div class="mute">${esc(m.from_addr)}</div>
     ${m.cases.length ? `<div style="margin-top:4px">${m.cases.map(c => `<span class="chip">${esc(c.cause_no)}${c.case ? " · " + esc(c.case.style || "") : " · not in your cases"}</span>`).join("")}</div>` : ""}
     ${m.dates.length ? `<div class="mute" style="margin-top:4px">${m.dates.map(esc).join(" · ")}</div>` : ""}
     <div style="font-size:14px;margin-top:4px">${esc(m.preview)}</div></div>`).join("") || `<div class="card mute">No emails yet. Set up your address under <a class="link" id="goCU">Court Updates</a>.</div>`}`;
  wireImap(() => setTimeout(() => inboxView(), 2500));
  if ($("#readAll")) $("#readAll").onclick = async () => { await api("/api/inbox/read-all", { method: "POST" }); inboxView(); };
  if ($("#goCU")) $("#goCU").onclick = () => { tab = "court"; renderNav(); show(); };
  $$("[data-open]").forEach(c => c.onclick = () => emailView(+c.dataset.open));
}
async function emailView(id) {
  subView = true;
  window.scrollTo(0, 0);
  let r; try { r = await api(`/api/email-alerts/${id}`); } catch (e) { return fail(e); }
  const m = r.email, sm = r.summary;
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, u => `<a class="link" href="${u}" target="_blank" rel="noopener">${u.length > 70 ? u.slice(0, 70) + "…" : u}</a>`);
  $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Inbox</button>
   <div class="card" style="margin-top:10px"><div class="row"><span class="tag ${TYPE_TAG[sm.type] || "n"}">${esc(sm.type)}</span><span class="mute" style="margin-left:auto">${new Date(m.received_at).toLocaleString()}</span></div>
   <h2 style="margin-top:8px">${esc(m.subject || "(no subject)")}</h2><div class="mute">From: ${esc(m.from_addr)}</div></div>
   <div class="card"><h3>Summary</h3>
     ${sm.action ? `<p style="margin:6px 0"><b>${esc(sm.action)}</b></p>` : ""}
     ${sm.cases.length ? `<div style="margin:6px 0"><b>Cases:</b> ${sm.cases.map(c => c.case ? `<a class="link" data-case="${c.case.id}">${esc(c.cause_no)} · ${esc(c.case.style || "")}</a>` : `${esc(c.cause_no)} <span class="mute">(not in your cases)</span>`).join(", ")}</div>` : ""}
     ${sm.dates.length ? `<div style="margin:6px 0"><b>Dates:</b> ${sm.dates.map(esc).join(" · ")}</div>` : ""}
     ${sm.lines.length ? `<ul style="padding-left:18px;margin:6px 0">${sm.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="mute">No key lines found — see the exact email below.</p>`}
     ${sm.links.length ? `<div style="margin:6px 0"><b>Links:</b><br>${sm.links.map(u => `<a class="link" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.length > 70 ? u.slice(0, 70) + "…" : u)}</a>`).join("<br>")}</div>` : ""}
     <p class="mute" style="margin-bottom:0;font-size:12px">Summary is pulled from the email automatically — check the exact email before relying on it.</p></div>
   <div class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Exact email</h3>
     <div class="row">${m.html ? `<button class="btn sm" id="vF">Formatted</button>` : ""}<button class="btn sm ${m.html ? "ghost" : ""}" id="vT">Plain text</button></div></div>
     <div id="exact" style="margin-top:10px"></div></div>`;
  const showF = () => { const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox"); f.style.cssText = "width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff";
    f.srcdoc = '<base target="_blank">' + m.html; $("#exact").replaceChildren(f); $("#vF").className = "btn sm"; $("#vT").className = "btn sm ghost"; };
  const showT = () => { $("#exact").innerHTML = `<div class="optext" style="font-family:inherit;font-size:14px">${linkify(m.body || "(empty)")}</div>`; $("#vT").className = "btn sm"; if ($("#vF")) $("#vF").className = "btn sm ghost"; };
  if ($("#vF")) $("#vF").onclick = showF; $("#vT").onclick = showT;
  m.html ? showF() : showT();
  $("#bk").onclick = () => inboxView();
  $$("[data-case]").forEach(a => a.onclick = () => { tab = "cases"; caseF.view = "firm"; renderNav(); show(); });
  inboxUnread = Math.max(0, inboxUnread - 1); renderNav();
}

// ---------------- court logins / county sync ----------------
let courtPoll;
async function courtView() {
  clearTimeout(courtPoll);
  let d, ea, mb, det; try { [d, ea, mb, det] = await Promise.all([api("/api/court-logins"), api("/api/email-alerts"), api("/api/mail"), api("/api/mail/detect")]); } catch (e) { return fail(e); }
  const order = det.provider === "google" ? ["google", "microsoft"] : ["microsoft", "google"];
  const byCounty = Object.fromEntries(d.logins.map(l => [l.county, l]));
  const ago = t => t ? new Date(t).toLocaleString() : "never";
  $("#app").innerHTML = `<div class="card"><h2>Court logins</h2>
   <p class="mute">Your cases are pulled from each county portal under <b>your</b> login and <b>your</b> bar # (${esc(me.bar_number || "not set")}) — only for counties you picked. Pulls run when you sign in, nightly, and when you tap Sync now. Passwords are encrypted and never shown again.</p>
   ${d.bar_ok ? "" : `<p class="err">Your account needs an 8-digit bar # before cases can be pulled.</p>`}</div>
   <div class="card"><h2>Connect your email</h2>
   <p style="margin-top:0">You already get court emails — eFileTexas service notices, clerk notices, hearing settings. Connect your email once and TX Case Desk reads <b>only those court emails</b>, adds new cases, and updates your existing ones automatically.</p>
   ${det.domain ? `<p class="mute" style="margin:0 0 6px">Your email <b>${esc(det.domain)}</b> is hosted by <b>${esc(det.host || "unknown")}</b>.${det.provider ? " Use the button below." : " Use <b>Connect with your email password</b> below."}</p>` : ""}
   ${order.map((p, i) => { const m = mb.mailboxes.find(x => x.provider === p);
     if (!m && det.provider && p !== det.provider) return i === 1 ? `<p class="mute" style="font-size:13px;margin:4px 0">Use a different email? <a class="link" href="/api/mail/connect/${p}">Connect ${p === "microsoft" ? "Outlook" : "Gmail"} instead</a>${mb.configured[p] ? "" : " (coming soon)"}</p>` : "";
     if (m) return `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row"><b>${esc(mb.names[p])}</b>
       <span class="tag ${m.status === "ok" ? "g" : m.status === "syncing" ? "y" : "r"}">${m.status === "ok" ? "Connected" : m.status === "syncing" ? "Checking…" : m.status === "reconnect" ? "Reconnect needed" : "Error"}</span></div>
       <div class="mute">${esc(m.email || "")}${m.last_sync ? " · last checked " + new Date(m.last_sync).toLocaleString() : ""}${m.stats ? ` · ${m.stats.added} new court emails, ${m.stats.created} cases added` : ""}</div>
       ${m.last_error ? `<p class="err" style="margin:4px 0">${esc(m.last_error)}</p>` : m.stats && m.stats.note ? `<p class="err" style="margin:4px 0">${esc(m.stats.note)}</p>` : ""}
       <div class="row" style="margin-top:6px">${m.status === "reconnect" ? `<a class="btn sm" href="/api/mail/connect/${p}" style="text-decoration:none">Reconnect</a>` : `<button class="btn sm" data-msync="${m.id}">Check now</button>`}<button class="btn sm danger" data-mdel="${m.id}">Disconnect</button></div></div>`;
     return mb.configured[p] ? `<a class="btn" href="/api/mail/connect/${p}" style="display:block;text-align:center;text-decoration:none;margin:8px 0;padding:14px">Connect ${p === "microsoft" ? "Outlook / Microsoft 365" : "Gmail"}</a>`
       : p === "microsoft" ? `<p class="mute" style="margin:8px 0">Outlook / Microsoft 365 sign-in isn't switched on yet.</p>` : ""; }).join("")}
   ${(() => { const m = mb.mailboxes.find(x => x.provider === "imap"); if (!m) return imapForm(mb, !det.provider && !!det.domain);
     return `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row"><b>${esc(mb.names.imap)}</b>
       <span class="tag ${m.status === "ok" ? "g" : m.status === "syncing" ? "y" : "r"}">${m.status === "ok" ? "Connected" : m.status === "syncing" ? "Checking…" : m.status === "reconnect" ? "Password needed" : "Error"}</span></div>
       <div class="mute">${esc(m.email || "")}${m.last_sync ? " · last checked " + new Date(m.last_sync).toLocaleString() : ""}${m.stats && m.stats.scanned != null ? ` · looked at ${m.stats.scanned} emails, ${m.stats.court} from courts, ${m.stats.created} cases added` : ""}</div>
       ${m.last_error ? `<p class="err" style="margin:4px 0">${esc(m.last_error)}</p>` : ""}
       <div class="row" style="margin-top:6px">${m.status === "reconnect" ? "" : `<button class="btn sm" data-msync="${m.id}">Check now</button>`}<button class="btn sm danger" data-mdel="${m.id}">Disconnect</button></div>
       ${m.status === "reconnect" ? imapForm(mb, true) : ""}</div>`; })()}
   <p class="mute" style="margin-bottom:0;font-size:13px">Read-only. Only emails from courts, clerks, eFileTexas and re:SearchTX are read; everything else is ignored and never stored. Checked every hour. Disconnect anytime.</p></div>
   <details class="card"><summary>Other ways (re:SearchTX alerts / forwarding)</summary>
   <div class="card" style="margin-top:10px"><h2>Court updates (re:SearchTX)</h2>
   ${!ea.configured ? `<p class="mute">Court updates aren't switched on for this app yet.</p>` : `
   <p style="margin-top:0">Get filing and hearing updates on your cases automatically — no email settings to change.</p>
   ${ea.emails.some(m => /re:?search|tylertech/i.test(m.from_addr + m.subject)) ? `<p><span class="tag g">Connected</span> <span class="mute">re:SearchTX is sending to this app.</span></p>` : `<p><span class="tag n">Not connected yet</span></p>`}
   <ol style="padding-left:20px;font-size:15px;line-height:1.6">
     <li><b>Copy your app address:</b><div class="row" style="margin:4px 0"><div class="secret" style="flex:1">${esc(ea.address)}</div><button class="btn sm" id="cpAddr">Copy</button></div></li>
     <li><b>Register at re:SearchTX</b> with that address as your email: <a class="link" href="https://research.txcourts.gov" target="_blank" rel="noopener">research.txcourts.gov</a> → <b>Register</b> (top right).</li>
     <li><b>Activate:</b> open your <a class="link" id="goInbox">Inbox</a> here → <b>re:SearchTX - Activate Account</b> → tap the activation link.</li>
     <li><b>Turn on alerts:</b> <a class="link" href="https://research.txcourts.gov" target="_blank" rel="noopener">Sign in to re:SearchTX</a> with that address → search each case by cause # → turn on <b>alerts</b>.</li>
   </ol>
   <p class="mute" style="margin:0">Updates then show in your <b>Inbox</b> and on matching cases in <b>Pending Cases</b>. Keep your State Bar eService email as your real inbox (<a class="link" href="https://www.texasbar.com" target="_blank" rel="noopener">texasbar.com</a> → My Bar Page) — don't change it.
   Help: <a class="link" href="https://research.txcourts.gov/CourtRecordsSearch/Assets/site/faq/TX_faq_Jan_1_2022.html" target="_blank" rel="noopener">re:SearchTX FAQ</a> · research.support@tylertech.com · (844) 307-8720</p>
   <details style="margin-top:8px"><summary class="mute">Already get re:SearchTX emails at your own address?</summary><p class="mute" style="font-size:14px">You can forward any of them to the address above (one at a time, or with a Gmail/Outlook rule) and they'll match the same way.</p></details>
   </div></details><div class="card">
   <h3 style="margin-top:0">Recent court emails</h3>
   ${ea.emails.length ? ea.emails.map(m => `<div style="border-top:1px solid var(--line);padding:8px 0"><b>${esc(m.subject || "(no subject)")}</b><div class="mute">${new Date(m.received_at).toLocaleString()} · ${esc(m.from_addr)}</div>
     <div class="mute">${(m.matched_case_ids || []).length} matched case(s)${m.unmatched.length ? ` · not in your list yet: ${m.unmatched.map(esc).join(", ")}` : ""}</div>
     <button class="btn sm ghost" data-view="${m.id}" style="margin-top:6px">View email</button><div data-body="${m.id}"></div></div>`).join("") : `<p class="mute">No alert emails received yet.</p>`}`}</div>
   ${d.available.length ? "" : `<div class="card mute">None of your counties has an automatic feed yet. Live now: ${esc(Object.entries(META.connectors).filter(([, v]) => v.status !== "blocked").map(([k]) => k).join(", ") || "none")}. Add one under My Counties.</div>`}
   ${d.available.map(c => { const l = byCounty[c.county];
     const st = !l ? "" : l.status === "ok" ? `<span class="tag g">Synced</span>` : l.status === "error" ? `<span class="tag r">Error</span>` : `<span class="tag y">${l.status === "syncing" ? "Pulling cases…" : "Starting…"}</span>`;
     return `<div class="card" data-county="${esc(c.county)}"><div class="row"><h3 style="margin:0">${esc(c.county)} County</h3>${st}<span class="tag n">${esc(c.status)}</span></div>
     <div class="mute">${esc(c.name)} · <a class="link" href="${esc(c.url)}" target="_blank" rel="noopener">open portal</a></div>
     ${c.status === "blocked" ? `<p class="err" style="margin:6px 0 0">${esc(c.note || "Automatic pulls paused.")} Use re:SearchTX alerts above, or add cases by hand / CSV.</p>` : ""}
     ${l ? `<div class="kv"><div><b>Pulls by</b>${c.login === "none" ? "Your bar # (public portal)" : esc(l.username || "Your bar #")}</div><div><b>Last pull</b>${ago(l.last_sync)}</div>
       ${l.last_result ? `<div><b>Found</b>${l.last_result.found} cases</div><div><b>New / updated</b>${l.last_result.added} / ${l.last_result.updated}</div>` : ""}</div>
       ${l.last_error ? `<p class="err">${esc(l.last_error)}</p>` : ""}
       ${l.last_result?.notes?.length ? `<details style="margin-top:6px"><summary class="mute">Details</summary><div class="mute">${l.last_result.notes.map(esc).join("<br>")}</div></details>` : ""}
       <div class="row" style="margin-top:10px"><button class="btn sm" data-a="sync" ${l.status === "syncing" ? "disabled" : ""}>Sync now</button>${c.login === "none" ? "" : `<button class="btn sm ghost" data-a="edit">Change login</button>`}<button class="btn sm danger" data-a="del">Remove</button></div>` : ""}
     <form ${l ? "hidden" : ""} style="margin-top:10px">${c.login === "none" ? `<p class="mute">Public portal — no login needed. One tap pulls every open case under bar #${esc(me.bar_number || "")}.</p>` : `<div class="grid">
       <div><label>Portal username</label><input name="username" autocomplete="off" value="${esc(l?.username || "")}"></div>
       <div><label>Portal password</label><input name="password" type="password" autocomplete="new-password"></div></div>`}
       <div class="err"></div><button class="btn">${l ? "Save & pull" : "Pull my " + esc(c.county) + " cases"}</button></form></div>`; }).join("")}
   ${me.role === "admin" && d.available.length ? `<div class="card"><h3>Admin: portal check</h3><p class="mute">Reads the county portal's public pages and shows its layout (for troubleshooting).</p><button class="btn sm ghost" id="insp">Check ${esc(d.available[0].county)} portal</button><pre id="inspOut" class="optext" hidden></pre></div>` : ""}`;
  $$("[data-county]").forEach(card => {
    const county = card.dataset.county, l = byCounty[county], form = card.querySelector("form");
    form.onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(form)); b.county = county;
      try { await api("/api/court-logins", { method: "POST", body: b }); toast("Connected — pulling your cases"); courtView(); } catch (err) { form.querySelector(".err").textContent = err.message; } };
    if (!l) return;
    card.querySelector("[data-a=sync]").onclick = async () => { try { await api(`/api/court-logins/${l.id}/sync`, { method: "POST" }); toast("Pulling cases…"); setTimeout(courtView, 800); } catch (e) { fail(e); } };
    const ed = card.querySelector("[data-a=edit]"); if (ed) ed.onclick = () => { form.hidden = false; };
    const del = card.querySelector("[data-a=del]");
    del.onclick = async () => { if (!del.dataset.sure) { del.dataset.sure = 1; del.textContent = "Tap again to remove"; return; } await api(`/api/court-logins/${l.id}`, { method: "DELETE" }); courtView(); };
  });
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, u => `<a class="link" href="${u}" target="_blank" rel="noopener">${u.length > 70 ? u.slice(0, 70) + "…" : u}</a>`);
  $$("[data-view]").forEach(b => b.onclick = async () => {
    const box = $(`[data-body="${b.dataset.view}"]`);
    if (box.innerHTML) { box.innerHTML = ""; b.textContent = "View email"; return; }
    try { const m = (await api(`/api/email-alerts/${b.dataset.view}`)).email;
      box.innerHTML = `<div class="optext" style="font-family:inherit;font-size:14px;margin-top:8px;max-height:50vh">${linkify(m.body || "(empty)")}</div>`; b.textContent = "Hide email"; } catch (e) { fail(e); }
  });
  $$("[data-msync]").forEach(b => b.onclick = async () => { await api(`/api/mail/${b.dataset.msync}/sync`, { method: "POST" }); toast("Checking your email…"); setTimeout(courtView, 1500); });
  $$("[data-mdel]").forEach(b => b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again to disconnect"; return; } await api(`/api/mail/${b.dataset.mdel}`, { method: "DELETE" }); courtView(); });
  wireImap(() => setTimeout(courtView, 2500));
  if (mb.mailboxes.some(m => m.status === "syncing")) courtPoll = setTimeout(() => { if (tab === "court") courtView(); }, 4000);
  if ($("#goInbox")) $("#goInbox").onclick = () => { tab = "inbox"; renderNav(); show(); };
  const cpa = $("#cpAddr"); if (cpa) cpa.onclick = async () => { try { await navigator.clipboard.writeText(ea.address); toast("Address copied"); } catch (e) { toast(ea.address); } };
  const insp = $("#insp");
  if (insp) insp.onclick = async () => { insp.disabled = true; insp.textContent = "Checking…"; const out = $("#inspOut"); out.hidden = false;
    try { out.textContent = JSON.stringify(await api(`/api/admin/inspect/${encodeURIComponent(d.available[0].county)}`), null, 2); } catch (e) { out.textContent = e.message; } insp.disabled = false; insp.textContent = "Check again"; };
  if (d.logins.some(l => l.status === "syncing" || l.status === "new")) courtPoll = setTimeout(() => { if (tab === "court") courtView(); }, 4000);
}
function fail(err) {
  if (err.status === 401) { me = null; return authView("login", "Session ended — sign in again."); }
  if (err.code === "CHANGE_PW") return changePwView(true);
  if (err.code === "PLAN_EXPIRED" || err.code === "FIRM_OFF") return subWall(err);
  toast(err.message);
}

// ---------------- pending cases ----------------
const TYPES = ["Civil – Contract", "Civil – Personal Injury", "Civil – DTPA / Consumer", "Civil – Real Property", "Eviction", "Family", "Probate", "Criminal – Felony", "Criminal – Misdemeanor", "Other"];
async function casesView() {
  const app = $("#app");
  app.innerHTML = `<div class="card mute">Loading cases…</div>`;
  let data; try { data = await api(`/api/cases?${new URLSearchParams(caseF)}`); } catch (e) { return fail(e); }
  const cs = data.cases;
  if (me.role === "admin" && !firmUsers) { try { firmUsers = (await api("/api/firm/users")).users; } catch (e) { firmUsers = []; } }
  app.innerHTML = `
  ${data.alerts ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4"><b>${data.alerts} case alert${data.alerts === 1 ? "" : "s"}</b> (court dates, court emails, new case law). <a class="link" id="seeAlerts">Show them</a></div>` : ""}
  ${!me.counties.length ? `<div class="card"><b>Pick your counties first.</b> <span class="mute">You only see and add cases in counties you practice in.</span></div>` : ""}
  <div class="card"><div class="mute">Your counties</div><div style="font-weight:600">${esc(me.counties.join(", ") || "None selected")}</div>
   <div class="mute" style="margin-top:4px">Auto-pull: connect under <a class="link" id="goCourt">Court Logins</a> (live: ${esc(Object.entries(META.connectors).filter(([, v]) => v.status !== "blocked").map(([k]) => k).join(", ") || "none right now — use re:SearchTX alerts")}). Other counties: add cases below or import a CSV.</div></div>
  <div class="card"><div class="grid">
   <div><label>Show</label><select id="v"><option value="mine">${me.sees_firm ? "My cases" : "My cases (and cases I'm on)"}</option>${me.sees_firm && me.firm_kind !== "solo" ? `<option value="firm">Whole firm (my counties)</option>` : ""}<option value="tracked">Tracked cases</option><option value="watched">Watching court dates</option><option value="alerts">Alerts (dates, filings, case law)</option></select></div>
   ${me.role === "admin" ? `<div><label>Attorney</label><select id="af2"><option value="">All attorneys</option>${(firmUsers || []).filter(u => u.role !== "paralegal").map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div>` : ""}
   <div><label>County</label><select id="cf"><option value="">All my counties</option>${me.counties.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
   <div><label>Case type</label><select id="tf"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join("")}</select></div></div></div>
  <div class="row" style="margin:0 0 12px"><button class="btn sm ghost" id="watchAll">Watch court dates on all ${caseF.attorney && firmUsers ? esc((firmUsers.find(u => u.id === +caseF.attorney) || {}).name || "") + "'s" : "my"} cases</button></div>
  <details class="card" id="addBox"><summary>+ Add a case</summary><br>${caseForm()}</details>
  <details class="card"><summary>Import CSV</summary><p class="mute">Header row with: county, cause_no, court, style, case_type, filed_date (YYYY-MM-DD), status, next_setting, notes</p>
   <input type="file" id="csvFile" accept=".csv,text/csv"><br><br><textarea id="csv" placeholder="county,cause_no,court,style,case_type,filed_date,status,next_setting"></textarea>
   <div class="err" id="csvErr"></div><button class="btn" id="imp">Import</button></details>
  <div class="mute" style="margin:0 4px 8px">${cs.length} case${cs.length === 1 ? "" : "s"}</div>
  ${cs.map(caseCard).join("") || `<div class="card mute">No cases here yet.</div>`}`;
  $("#goCourt").onclick = () => { tab = "court"; renderNav(); show(); };
  if ($("#seeAlerts")) $("#seeAlerts").onclick = () => { caseF.view = "alerts"; casesView(); };
  if ($("#af2")) { $("#af2").value = caseF.attorney; $("#af2").onchange = e => { caseF.attorney = e.target.value; if (e.target.value && caseF.view === "mine") caseF.view = "firm"; casesView(); }; }
  const wa = $("#watchAll");
  if (wa) wa.onclick = async () => { try { const r = await api("/api/cases/watch-all", { method: "POST", body: { user_id: +caseF.attorney || null, on: true } }); toast(`Watching court dates on ${r.updated} case(s)`); casesView(); } catch (e) { fail(e); } };
  $("#v").value = caseF.view; $("#cf").value = caseF.county; $("#tf").value = caseF.type;
  $("#v").onchange = e => { caseF.view = e.target.value; casesView(); };
  $("#cf").onchange = e => { caseF.county = e.target.value; casesView(); };
  $("#tf").onchange = e => { caseF.type = e.target.value; casesView(); };
  bindCaseForm($("#addBox form"), null);
  $("#csvFile").onchange = async e => { const f = e.target.files[0]; if (f) $("#csv").value = await f.text(); };
  $("#imp").onclick = async () => {
    try { const r = await api("/api/cases/import", { method: "POST", body: { csv: $("#csv").value } }); toast(`Imported ${r.added}. Skipped ${r.skipped.length}.`); if (r.skipped.length) $("#csvErr").textContent = r.skipped.slice(0, 8).join(" · "); else casesView(); }
    catch (e) { $("#csvErr").textContent = e.message; }
  };
  cs.forEach(c => {
    const el = $(`#case-${c.id}`);
    el.querySelector("[data-a=track]").onclick = async () => { try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { tracked: !c.tracked } }); casesView(); } catch (e) { fail(e); } };
    el.querySelector("[data-a=law]").onclick = () => { law.q = (c.case_type || "").replace(/^.*– /, ""); law.results = null; law.open = null; tab = "law"; renderNav(); lawView(true); };
    el.querySelector("[data-a=edit]").onclick = () => { el.innerHTML = caseForm(c); bindCaseForm(el.querySelector("form"), c); };
    el.querySelector("[data-a=open]").onclick = () => window.caseHub && caseHub(c.id);
    el.querySelector("[data-a=watch]").onchange = async e => { try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { watch_dates: e.target.checked } }); c.watch_dates = e.target.checked; toast(e.target.checked ? "Watching court dates" : "Stopped watching"); } catch (err) { fail(err); } };
    el.querySelector("[data-a=analyze]").onclick = () => analysisView(c);
    el.querySelector("[data-a=lawwatch]").onchange = async e => { if (e.target.checked && !c.issues) { e.target.checked = false; return toast("Add the case's issues first (Edit → Issues)"); } try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { law_watch: e.target.checked } }); toast(e.target.checked ? "Watching for new case law" : "Stopped"); } catch (err) { fail(err); } };
    const fack = el.querySelector("[data-a=fileack]"); if (fack) fack.onclick = async () => { await api(`/api/cases/${c.id}/filing-ack`, { method: "POST" }); casesView(); };
    const lack = el.querySelector("[data-a=lawack]"); if (lack) lack.onclick = async () => { await api(`/api/cases/${c.id}/law-ack`, { method: "POST" }); casesView(); };
    const ack = el.querySelector("[data-a=ack]"); if (ack) ack.onclick = async () => { await api(`/api/cases/${c.id}/ack`, { method: "POST" }); casesView(); };
    el.querySelector("[data-a=hist]").onclick = async () => { const out = el.querySelector("[data-a=histOut]"); const ch = (await api(`/api/cases/${c.id}/changes`)).changes;
      out.innerHTML = ch.length ? ch.map(x => `<div class="mute">${new Date(x.at).toLocaleDateString()}: ${esc(x.old_value || "none")} → ${esc(x.new_value)}</div>`).join("") : `<div class="mute">No date changes recorded yet.</div>`; };
  });
}
function caseCard(c) {
  const st = /new/i.test(c.status || "") ? "n" : /trial|mediation|hearing/i.test(c.status || "") ? "y" : "g";
  return `<div class="card" id="case-${c.id}"><div class="row">${c.status ? `<span class="tag ${st}">${esc(c.status)}</span>` : ""}${c.tracked ? `<span class="tag y">★ Tracked</span>` : ""}<span class="mute">${esc(c.county)} County${c.court ? " · " + esc(c.court) : ""}</span></div>
   <h3 style="margin-top:6px">${esc(c.style || c.cause_no)}</h3>
   <div class="kv"><div><b>Cause #</b>${esc(c.cause_no)}</div><div><b>Type</b>${esc(c.case_type || "—")}</div><div><b>Filed</b>${c.filed_date ? String(c.filed_date).slice(0, 10) : "—"}</div>
   <div><b>Next</b>${esc(c.next_setting || "—")}</div><div><b>Appeals to</b>${esc(META.appeals[c.county] || "—")}</div><div><b>Attorney</b>${esc(c.attorney || "—")}</div></div>
   ${c.date_alert ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4;margin:10px 0 0;padding:10px"><b>Court date changed</b><div>${esc(c.date_alert)}</div><div class="mute">${c.date_alert_at ? new Date(c.date_alert_at).toLocaleString() : ""}</div><button class="btn sm" data-a="ack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.filing_alert ? `<div class="card" style="background:#e3f4ea;border-color:#bfe3cd;margin:10px 0 0;padding:10px"><b>Court email</b><div style="font-size:14px">${esc(c.filing_alert)}</div><div class="mute">${c.filing_alert_at ? new Date(c.filing_alert_at).toLocaleString() : ""}</div><button class="btn sm" data-a="fileack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.law_alert ? `<div class="card" style="background:#e8eefc;border-color:#c9d6f5;margin:10px 0 0;padding:10px"><b>New case law</b><div style="font-size:14px">${esc(c.law_alert)}</div><button class="btn sm" data-a="lawack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.issues ? `<p class="mute" style="margin:8px 0 0">Issues: ${esc(c.issues)}</p>` : ""}
   ${c.notes ? `<p class="mute" style="margin:8px 0 0">${esc(c.notes)}</p>` : ""}
   ${c.source === "county_sync" ? `<p class="mute" style="margin:6px 0 0">↻ Pulled from county portal${c.last_synced ? " · " + new Date(c.last_synced).toLocaleString() : ""}</p>` : ""}
   ${c.external_url ? `<a class="btn sm ghost" style="margin-top:8px;display:inline-block;text-decoration:none" href="${esc(c.external_url)}" target="_blank" rel="noopener">Open on county portal ↗</a>` : ""}
   <div class="row" style="margin-top:10px"><button class="btn sm" data-a="open">Open case</button><button class="btn sm ghost" data-a="edit">Edit</button><button class="btn sm ghost" data-a="track">${c.tracked ? "★ Untrack" : "☆ Track"}</button><button class="btn sm" data-a="analyze">Analyze case law</button><button class="btn sm ghost" data-a="law">Search case law</button></div>
   <label style="margin-top:10px;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" data-a="watch" style="width:auto" ${c.watch_dates ? "checked" : ""}> Watch court dates (alert me when the setting changes)</label>
   <label style="margin-top:4px;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" data-a="lawwatch" style="width:auto" ${c.law_watch ? "checked" : ""}> Watch for new case law on these issues (checked daily)</label>
   <a class="link mute" data-a="hist" style="font-size:13px">Date history</a><div data-a="histOut"></div></div>`;
}
function caseForm(c) {
  const v = k => esc(c?.[k] ?? "");
  const counties = c ? [c.county] : me.counties;
  return `<form><div class="grid">
   <div><label>County</label><select name="county" ${c ? "disabled" : ""}>${counties.map(x => `<option ${c?.county === x ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
   <div><label>Cause #</label><input name="cause_no" value="${v("cause_no")}" ${c ? "disabled" : "required"}></div>
   <div class="full"><label>Style (e.g. Smith v. Jones)</label><input name="style" value="${v("style")}"></div>
   <div><label>Court</label><input name="court" value="${v("court")}" placeholder="275th District Court"></div>
   <div><label>Case type</label><select name="case_type"><option value=""></option>${TYPES.map(t => `<option ${c?.case_type === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
   <div><label>Filed</label><input name="filed_date" type="date" value="${c?.filed_date ? String(c.filed_date).slice(0, 10) : ""}"></div>
   <div><label>Status</label><input name="status" value="${v("status")}" placeholder="Discovery"></div>
   <div class="full"><label>Next setting</label><input name="next_setting" value="${v("next_setting")}" placeholder="2026-11-18 – Hearing on MTC"></div>
   <div class="full"><label>Issues (comma-separated — used for case-law analysis)</label><input name="issues" value="${v("issues")}" placeholder="slip and fall, constructive notice, grocery store"></div>
   <div class="full"><label>Notes</label><input name="notes" value="${v("notes")}"></div>
   ${c ? "" : `<div class="full"><label><input type="checkbox" name="tracked" style="width:auto"> Track this case</label></div>`}
  </div><div class="err"></div><div class="row"><button class="btn">${c ? "Save" : "Add case"}</button>${c ? `<button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn danger" data-a="del">Delete</button>` : ""}</div></form>`;
}
function bindCaseForm(form, c) {
  if (!form) return;
  form.onsubmit = async e => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(form)); b.tracked = !!b.tracked; if (c) delete b.tracked;
    try { c ? await api(`/api/cases/${c.id}`, { method: "PATCH", body: b }) : await api("/api/cases", { method: "POST", body: b }); toast(c ? "Saved" : "Case added"); casesView(); }
    catch (err) { form.querySelector(".err").textContent = err.message; }
  };
  const cancel = form.querySelector("[data-a=cancel]"); if (cancel) cancel.onclick = casesView;
  const del = form.querySelector("[data-a=del]");
  if (del) del.onclick = async () => { if (del.dataset.sure) { try { await api(`/api/cases/${c.id}`, { method: "DELETE" }); toast("Deleted"); casesView(); } catch (e) { fail(e); } } else { del.dataset.sure = 1; del.textContent = "Tap again to delete"; } };
}

// ---------------- case analysis (rule-based) ----------------
async function analysisView(c) {
  window.scrollTo(0, 0);
  $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Back to cases</button>
   <div class="card" style="margin-top:10px"><h2>Case-law analysis</h2><div class="mute">${esc(c.cause_no)} · ${esc(c.style || "")} · ${esc(c.county)} County</div>
   <label style="margin-top:10px">Issues (comma-separated)</label><input id="iss" value="${esc(c.issues || "")}" placeholder="slip and fall, constructive notice, grocery store">
   <div class="row" style="margin-top:10px"><button class="btn" id="run">Run analysis</button>
   <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" id="lw" style="width:auto" ${c.law_watch ? "checked" : ""}> Watch for new case law (daily)</label></div>
   <p class="mute" style="margin-bottom:0">Takes about a minute. Uses public Texas opinions only — no AI.</p></div><div id="ar"></div>`;
  $("#bk").onclick = () => casesView();
  $("#lw").onchange = async e => { if (e.target.checked && !$("#iss").value.trim()) { e.target.checked = false; return toast("Enter issues first"); }
    try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { law_watch: e.target.checked, issues: $("#iss").value } }); c.law_watch = e.target.checked; c.issues = $("#iss").value; toast(e.target.checked ? "Watching for new case law" : "Stopped"); } catch (err) { fail(err); } };
  $("#run").onclick = async () => {
    const btn = $("#run"); btn.disabled = true; btn.textContent = "Analyzing…";
    $("#ar").innerHTML = `<div class="card mute">Searching Texas opinions and counting outcomes…</div>`;
    try { const r = await api(`/api/cases/${c.id}/analyze`, { method: "POST", body: { issues: $("#iss").value } }); c.issues = r.issues; renderAnalysis(r.result, r.created_at); }
    catch (e) { $("#ar").innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
    btn.disabled = false; btn.textContent = "Run again";
  };
  try { const a = (await api(`/api/cases/${c.id}/analysis`)).analysis; if (a) { renderAnalysis(a.result, a.created_at); $("#run").textContent = "Run again"; } } catch (e) {}
}
function renderAnalysis(r, at) {
  const bar = pct => `<div style="background:var(--chip);border-radius:6px;height:8px;margin-top:6px"><div style="width:${pct}%;background:var(--ok);height:8px;border-radius:6px"></div></div>`;
  const op = o => `<a class="link" data-c="${o.cluster_id}">${esc(o.case_name)}</a> <span class="mute">${esc(o.citation || "")} · ${esc(o.court)} · ${esc(o.date_filed || "")}</span>`;
  const ranked = r.paths.filter(p => p.enough), thin = r.paths.filter(p => !p.enough);
  $("#ar").innerHTML = `
  <div class="card"><div class="mute">Run ${new Date(at).toLocaleString()} · ${r.total_opinions.toLocaleString()} Texas opinions (last 10 yrs) match: ${esc(r.mode)}${r.source ? ` · Source: ${esc(r.source)}` : ""}</div>
   ${r.trend ? `<p style="margin:8px 0 0"><b>Trend:</b> ${esc(r.trend.path)} — ${r.trend.recentRate ?? "–"}% upheld in the last 3 years (${r.trend.recentN} cases) vs ${r.trend.olderRate ?? "–"}% before (${r.trend.olderN}). <b>${esc(r.trend.direction)}</b>.</p>` : ""}</div>
  <div class="card"><h3>Ways forward — ranked</h3><p class="mute">How often Texas appeals courts upheld each path in cases on these issues.</p>
   ${ranked.map((p, i) => `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row"><span class="tag ${i === 0 ? "g" : "n"}">#${i + 1}</span><b>${esc(p.label)}</b></div>
     <div style="font-size:14px;margin-top:4px">Upheld <b>${p.rate}%</b> <span class="mute">(${esc(p.basis)})</span></div>${bar(p.rate)}
     ${p.binding ? `<div class="mute" style="margin-top:4px">Binding courts (Tex. Sup. Ct. + ${esc(r.appeals || "")}): ${p.binding.upheld} upheld, ${p.binding.reversed} reversed${p.binding.rate != null ? ` (${p.binding.rate}%)` : ""}</div>` : ""}
     <div class="mute">All Texas courts: ${p.upheld} upheld, ${p.reversed} reversed (${p.n} cases)</div>
     ${p.examples?.length ? `<div style="margin-top:8px;font-size:14px">${p.examples.map(op).join("<br>")}</div>` : ""}</div>`).join("") || `<p class="mute">Not enough appellate cases on these issues to rank paths. Try broader issues.</p>`}
   ${thin.length ? `<p class="mute" style="margin-bottom:0">Too few cases to rank: ${thin.map(p => `${esc(p.label)} (${p.n})`).join(", ")}</p>` : ""}</div>
  <div class="card"><h3>Top authorities</h3><p class="mute">Ranked by court (Texas Supreme Court first), how recent, and how often cited.</p>
   ${r.authorities.map((o, i) => `<div style="margin:10px 0">${i + 1}. ${op(o)}<div class="mute">${esc(o.binding)} · cited ${o.cite_count}×</div>${o.snippet ? `<div style="font-size:13px">${esc(o.snippet)}…</div>` : ""}</div>`).join("") || `<p class="mute">No opinions found.</p>`}</div>
  <div class="card mute" style="font-size:13px"><b>How this works:</b> ${esc(r.method)}<br>Search used: <code>${esc(r.query)}</code></div>`;
  $$("#ar [data-c]").forEach(a => a.onclick = () => { law.open = +a.dataset.c; tab = "law"; renderNav(); opinionView(law.open); window.scrollTo(0, 0); });
}

// ---------------- case law ----------------
function lawView(autoSearch) {
  if (law.open) return opinionView(law.open);
  $("#app").innerHTML = `<div class="card"><h2>Texas case law</h2>
   <form id="lf"><div class="grid"><div class="full"><label>Search words (use quotes for phrases, AND / OR)</label><input name="q" value="${esc(law.q)}" placeholder='"constructive notice" AND premises'></div>
   <div><label>Court</label><select name="court"><option value="">All Texas courts</option>${Object.entries(META.courts).map(([k, v]) => `<option value="${k}" ${law.court === k ? "selected" : ""}>${v}</option>`).join("")}
     ${META.localLaw ? Array.from({ length: 15 }, (_, i) => i + 1).map(n => `<option value="coa${n}" ${law.court === "coa" + n ? "selected" : ""}>${ordn(n)} Court of Appeals only</option>`).join("") : ""}</select></div>
   ${META.localLaw ? `<div><label>Appeal from county</label><select name="county"><option value="">Any county</option>${META.counties.map(c => `<option ${law.county === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></div>` : ""}
   <div><label>Decided after</label><input name="after" type="date" value="${esc(law.after)}"></div></div><br><button class="btn">Search</button></form>
   <p class="mute" style="margin-bottom:0">Source: public Texas court opinions (CourtListener / Free Law Project)${META.localLaw ? ` — ${Number(META.lawCount).toLocaleString()} opinions in our database` : ""}. Flags are our own citator, not Lexis/Westlaw.</p></div><div id="res"></div>`;
  $("#lf").onsubmit = e => { e.preventDefault(); Object.assign(law, Object.fromEntries(new FormData(e.target))); runSearch(); };
  if (law.results) renderResults(); else if (autoSearch && law.q) runSearch();
}
async function runSearch() {
  if (law.q.trim().length < 2) return toast("Enter search words");
  $("#res").innerHTML = `<div class="card mute">Searching Texas opinions…</div>`;
  const prm = { q: law.q, after: law.after, county: law.county || "" };
  if (/^coa\d+$/.test(law.court)) prm.coa = law.court.slice(3); else prm.court = law.court;
  try { law.results = await api(`/api/law/search?${new URLSearchParams(prm)}`); renderResults(); }
  catch (e) { $("#res").innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function renderResults() {
  const r = law.results;
  $("#res").innerHTML = `<div class="mute" style="margin:0 4px 8px">${(r.count || 0).toLocaleString()} opinions${r.stale ? " (cached)" : ""}</div>` +
    (r.results.map(o => `<div class="card"><div class="mute">${esc(o.court)} · ${esc(o.date_filed || "")}</div>
     <h3 style="margin-top:4px"><a class="link" data-c="${o.cluster_id}">${esc(o.case_name)}</a></h3>
     <div class="mute">${esc(o.citation || "No reporter cite")} · cited ${o.cite_count}×${o.origin_county ? ` · appeal from ${esc(o.origin_county)} County` : ""}</div>
     ${o.snippet ? `<p style="margin:6px 0 0;font-size:14px">${esc(o.snippet)}…</p>` : ""}</div>`).join("") || `<div class="card mute">No opinions found.</div>`);
  $$("[data-c]").forEach(a => a.onclick = () => { law.open = +a.dataset.c; opinionView(law.open); window.scrollTo(0, 0); });
}
async function opinionView(cid) {
  $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Back to results</button><div class="card" style="margin-top:10px"><div class="mute">Loading opinion…</div></div>`;
  $("#bk").onclick = () => { law.open = null; lawView(); };
  let op; try { op = (await api(`/api/law/opinion/${cid}`)).opinion; } catch (e) { $("#app .card").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  let myCases = []; try { myCases = (await api("/api/cases?view=firm")).cases; } catch (e) {}
  const cite = `${op.case_name}${op.citations ? ", " + op.citations : ""}${op.court || op.date_filed ? ` (${[op.court, (op.date_filed || "").slice(0, 4)].filter(Boolean).join(" ")})` : ""}`;
  $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Back to results</button>
   <div class="card" style="margin-top:10px"><div id="flag"><span class="tag n">Checking citing references…</span></div>
   <h2 style="margin-top:8px">${esc(op.case_name)}</h2><div class="mute">${esc(op.citations || "")} · ${esc(op.court || "")} · ${esc(String(op.date_filed || "").slice(0, 10))}${op.judges ? " · " + esc(op.judges) : ""}</div>
   <div class="row" style="margin-top:10px"><button class="btn sm" id="cp">Copy citation</button>${op.absolute_url ? `<a class="btn sm ghost" href="${esc(op.absolute_url)}" target="_blank" rel="noopener" style="text-decoration:none">Source</a>` : ""}</div>
   <hr><div class="grid"><div><label>Save to case</label><select id="sc"><option value="">(no case – just save)</option>${myCases.map(c => `<option value="${c.id}">${esc(c.cause_no)} – ${esc(c.style || "")}</option>`).join("")}</select></div>
   <div><label>Note</label><input id="sn" placeholder="Why it matters"></div></div><br><button class="btn sm" id="save">Save research</button>
   <hr><h3>Opinion text</h3><div class="optext">${esc(op.text || "Full text not available for this opinion — open Source.")}</div></div>
   <div class="card" id="cit"><h3>Citing references</h3><div class="mute">Loading…</div></div>`;
  $("#bk").onclick = () => { law.open = null; lawView(); };
  $("#cp").onclick = async () => { try { await navigator.clipboard.writeText(cite); toast("Citation copied"); } catch (e) { toast(cite); } };
  $("#save").onclick = async () => { try { await api("/api/research", { method: "POST", body: { case_id: +$("#sc").value || null, cluster_id: cid, case_name: op.case_name, citation: op.citations, note: $("#sn").value } }); toast("Saved"); } catch (e) { fail(e); } };
  if (!op.opinion_id) { $("#flag").innerHTML = ""; $("#cit .mute").textContent = "Not available."; return; }
  try {
    const c = await api(`/api/law/citator/${op.opinion_id}?cluster=${cid}`);
    $("#flag").innerHTML = c.flag === "caution" ? `<span class="tag y">Caution – ${c.negative_count} citing opinion(s) use negative-treatment language. Review.</span>`
      : c.flag === "cited" ? `<span class="tag g">Cited by ${c.cited_by} – no negative-treatment language found</span>` : `<span class="tag n">No citing opinions found</span>`;
    $("#cit").innerHTML = `<h3>Citing references (${c.cited_by})</h3>` + (c.citing.map(x => `<div style="margin:8px 0">${x.negative ? `<span class="tag y">review</span> ` : ""}<a class="link" data-c="${x.cluster_id}">${esc(x.case_name)}</a> <span class="mute">${esc(x.citation)} · ${esc(x.court)} · ${esc(x.date_filed || "")}</span></div>`).join("") || `<p class="mute">None found.</p>`);
    $$("#cit [data-c]").forEach(a => a.onclick = () => { law.open = +a.dataset.c; opinionView(law.open); window.scrollTo(0, 0); });
  } catch (e) { $("#flag").innerHTML = ""; $("#cit").innerHTML = `<h3>Citing references</h3><div class="err">${esc(e.message)}</div>`; }
}

// ---------------- saved research ----------------
async function savedView() {
  $("#app").innerHTML = `<div class="card mute">Loading…</div>`;
  let r; try { r = (await api("/api/research")).research; } catch (e) { return fail(e); }
  $("#app").innerHTML = `<div class="card"><h2>Saved research</h2></div>` + (r.map(x => `<div class="card"><h3><a class="link" data-c="${x.cluster_id}">${esc(x.case_name)}</a></h3><div class="mute">${esc(x.citation || "")}</div>
   ${x.cause_no ? `<div class="mute">Case: ${esc(x.cause_no)} – ${esc(x.case_style || "")}</div>` : ""}${x.note ? `<p style="margin:6px 0 0">${esc(x.note)}</p>` : ""}
   <button class="btn sm danger" data-d="${x.id}" style="margin-top:8px">Remove</button></div>`).join("") || `<div class="card mute">Nothing saved yet. Open an opinion and tap Save research.</div>`);
  $$("[data-c]").forEach(a => a.onclick = () => { law.open = +a.dataset.c; tab = "law"; renderNav(); opinionView(law.open); });
  $$("[data-d]").forEach(b => b.onclick = async () => { await api(`/api/research/${b.dataset.d}`, { method: "DELETE" }); savedView(); });
}

// ---------------- counties ----------------
function countiesView() {
  let sel = new Set(me.counties), filter = "";
  const draw = () => {
    $("#list").innerHTML = META.counties.filter(c => !filter || c.toLowerCase().includes(filter)).map(c => `<span class="chip ${sel.has(c) ? "sel" : ""}" data-c="${esc(c)}">${sel.has(c) ? "✓ " : ""}${esc(c)}</span>`).join("");
    $("#picked").textContent = [...sel].sort().join(", ") || "None";
    $$("#list [data-c]").forEach(ch => ch.onclick = () => { const c = ch.dataset.c; sel.has(c) ? sel.delete(c) : sel.add(c); draw(); });
  };
  $("#app").innerHTML = `<div class="card"><h2>My counties</h2><p class="mute">You only see and add pending cases in these counties. Appeals courts follow automatically.</p>
   <label>Find a county</label><input id="fc" placeholder="Type to filter (254 Texas counties)"><br><br><div class="counties" id="list"></div>
   <p><b>Selected:</b> <span id="picked"></span></p><button class="btn" id="sv">Save counties</button></div>
   <div class="card"><h3>County feeds</h3><p class="mute">Automatic pulls are added county by county after each court portal is tested.</p>
   ${Object.entries(META.connectors).map(([c, v]) => `<div><b>${esc(c)}</b> – ${esc(v.name)} <span class="tag ${v.status === "live" ? "g" : "n"}">${esc(v.status)}</span></div>`).join("")}</div>`;
  $("#fc").oninput = e => { filter = e.target.value.toLowerCase(); draw(); };
  $("#sv").onclick = async () => { try { const r = await api("/api/me/counties", { method: "PUT", body: { counties: [...sel] } }); me.counties = r.counties; toast("Counties saved"); caseF.county = ""; } catch (e) { fail(e); } };
  draw();
}

// ---------------- firm seats ----------------
async function firmView() {
  $("#app").innerHTML = `<div class="card mute">Loading…</div>`;
  let us; try { us = (await api("/api/firm/users")).users; } catch (e) { return fail(e); }
  let fm = null; try { fm = await api("/api/firm/mail"); } catch (e) {}
  let mk = null; try { mk = await api("/api/firm/ms-keys"); } catch (e) {}
  let fp = null; try { fp = (await api("/api/firm/profile")).profile; } catch (e) { fp = { name: me.firm_name }; }
  const mkCard = !mk ? "" : `<div class="card" data-fs="email"><h2>Your firm's Microsoft connection</h2>
   ${mk.own ? `<p><span class="tag g">Using your firm's own keys</span></p>
     <div class="kv"><div><b>Application (client) ID</b>${esc(mk.client_id)}</div><div><b>Directory (tenant) ID</b>${esc(mk.tenant)}</div><div><b>Secret</b>${esc(mk.hint || "saved")} (hidden)</div><div><b>Saved</b>${mk.at ? new Date(mk.at).toLocaleString() : ""}${mk.by ? " by " + esc(mk.by) : ""}</div></div>
     <p class="mute" style="font-size:13px">Attorneys who connected before these keys were saved should tap <b>Reconnect</b> if their email shows an error. Secrets expire — put a reminder on your calendar for the date you picked in Azure.</p>
     <div class="row"><button class="btn sm ghost" id="mkEdit">Replace keys</button><button class="btn sm danger" id="mkDel">Remove (use TX Case Desk's)</button></div>`
   : `<p style="margin-top:0">${mk.shared ? "Your attorneys sign in to Outlook with one tap through the <b>TX Case Desk</b> Microsoft app — each attorney approves only their own mailbox and calendar, and can revoke it anytime." : "Outlook sign-in isn't switched on yet."} <b>Optional:</b> if your IT requires it, use your firm's <b>own</b> Microsoft app instead.</p>`}
   ${mk.own ? "" : mk.help ? `<p><span class="tag y">Setup help requested</span> <span class="mute">${new Date(mk.help).toLocaleString()} — we'll call you to set it up.</span></p>`
     : `<details style="margin:8px 0"><summary>Rather have us set it up? (one-time fee)</summary><p class="mute" style="margin:6px 0">A developer sets up your firm's Microsoft app with your IT person on a short call. One-time fee — we confirm the price with you before starting.</p>
       <form id="shF"><div class="grid"><div><label>Best phone</label><input name="phone" type="tel" required></div><div><label>Best time / notes</label><input name="note" placeholder="Weekdays after 2 PM"></div></div><div class="err"></div><button class="btn sm">Request setup help</button></form></details>`}
   <details id="mkHow" style="margin-top:8px"><summary style="cursor:pointer;font-weight:600">${mk.own ? "Replace keys" : "Set up your firm's own keys"} — step by step (about 10 minutes, free)</summary>
   <ol style="padding-left:20px;line-height:1.6;font-size:15px">
     <li>Your Microsoft 365 admin signs in at <a class="link" href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">entra.microsoft.com → App registrations</a> → <b>+ New registration</b>.</li>
     <li><b>Name:</b>${copyBox("TX Case Desk")}<b>Supported account types:</b> <i>Single tenant only</i> (your organization only).</li>
     <li><b>Redirect URI:</b> pick <b>Web</b> and paste:${copyBox(mk.redirects[0])}Click <b>Register</b>.</li>
     <li>Left menu → <b>Authentication</b> → <b>Add Redirect URI</b> → paste the second one → <b>Configure</b>:${copyBox(mk.redirects[1])}</li>
     <li>Left menu → <b>API permissions</b> → <b>+ Add a permission</b> → <b>Microsoft Graph</b> → <b>Delegated permissions</b> → tick <b>Mail.Read</b>, <b>User.Read</b>, <b>offline_access</b>, <b>openid</b>, <b>email</b>, <b>Calendars.ReadWrite</b> (calendar sync) and <b>Mail.Send</b> (morning agenda email) → <b>Add permissions</b>.<br>
       For firm-wide connect also add → <b>Application permissions</b> → <b>Mail.Read</b>. Then click <b>✓ Grant admin consent</b> for your organization.</li>
     <li>Left menu → <b>Certificates &amp; secrets</b> → <b>+ New client secret</b> → 24 months → <b>Add</b>. Copy the <b>Value</b> right away (shown only once — not the Secret ID).</li>
     <li>Left menu → <b>Overview</b>: copy the <b>Application (client) ID</b> and the <b>Directory (tenant) ID</b>, and paste all three below.</li>
   </ol>
   <form id="mkF"><label>Application (client) ID</label><input name="client_id" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" required>
     <label>Directory (tenant) ID</label><input name="tenant" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autocomplete="off" required>
     <label>Client secret — Value</label><input name="secret" type="password" autocomplete="off" required>
     <div class="err" id="mkErr"></div><button class="btn" style="width:100%;padding:12px">Save &amp; test with Microsoft</button>
     <p class="mute" style="font-size:13px;margin:6px 0 0">We test the keys with Microsoft before saving. The secret is encrypted and never shown again.</p></form></details></div>`;
  const fmCard = !fm ? "" : `<div class="card" data-fs="email"><h2>Firm email — connect everyone at once</h2>
   ${fm.firm ? `<div class="row"><span class="tag ${fm.firm.status === "ok" ? "g" : "r"}">${fm.firm.status === "ok" ? "Connected" : fm.firm.status === "reconnect" ? "Approve again" : "Error"}</span><b>${esc(fm.firm.provider === "microsoft" ? "Microsoft 365" : "Google Workspace")}</b> · @${esc(fm.firm.domain)}</div>
     <div class="mute" style="margin-top:4px">${fm.firm.last_sync ? "Last checked " + new Date(fm.firm.last_sync).toLocaleString() : "First check running…"}${fm.firm.stats ? ` · ${fm.firm.stats.people} attorneys · ${fm.firm.stats.added} new court emails · ${fm.firm.stats.created} cases added` : ""}</div>
     ${fm.firm.last_error ? `<p class="err">${esc(fm.firm.last_error)}</p>` : ""}
     <p class="mute">Covers every TX Case Desk user with an @${esc(fm.firm.domain)} email (${fm.covered.length}): ${fm.covered.map(u => esc(u.name)).join(", ") || "none yet"}. They don't need to do anything.</p>
     <div class="row"><button class="btn sm" id="fmSync">Check now</button><button class="btn sm danger" id="fmDel">Disconnect firm</button></div>`
   : fm.detect.personal || !fm.detect.domain ? `<p class="mute">Firm-wide connect needs a firm email domain. Your login email is a personal address — attorneys can still connect their own email under Court Updates.</p>`
   : fm.detect.provider === "microsoft" ? `<p>Your firm's email (@${esc(fm.detect.domain)}) is on <b>Microsoft 365</b>. Your Microsoft 365 admin approves TX Case Desk once, and every attorney here with an @${esc(fm.detect.domain)} email is covered automatically — read-only, court emails only.</p>
       ${fm.configured.microsoft ? `<a class="btn" href="/api/firm/mail/microsoft" style="display:block;text-align:center;text-decoration:none;padding:14px">Approve for the whole firm (Microsoft 365 admin)</a>
       <p class="mute" style="font-size:13px">Must be done by a Microsoft 365 Global Admin (or Privileged Role Admin). Not your admin? Send them this page's link after they sign in to TX Case Desk as a firm admin.</p>` : `<button class="btn ghost" disabled style="width:100%;padding:14px">Approve for the whole firm — coming soon</button>`}`
   : fm.detect.provider === "google" ? `<p>Your firm's email (@${esc(fm.detect.domain)}) is on <b>Google Workspace</b>. Your Workspace admin authorizes TX Case Desk once in the Google Admin console:</p>
       ${fm.google_sa_client_id ? `<ol style="padding-left:18px;font-size:14px"><li>Open <a class="link" href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener">Google Admin → Security → API controls → Domain-wide delegation</a> → <b>Add new</b>.</li>
       <li>Client ID:<div class="secret">${esc(fm.google_sa_client_id)}</div></li><li>OAuth scope:<div class="secret">https://www.googleapis.com/auth/gmail.readonly</div></li><li>Tap <b>Authorize</b>, then come back and tap the button below.</li></ol>
       <button class="btn" id="fmG" style="width:100%;padding:14px">I've authorized it — turn on for the whole firm</button><div class="err" id="fmGerr"></div>` : `<button class="btn ghost" disabled style="width:100%;padding:14px">Google Workspace firm connect — coming soon</button>`}`
   : `<p class="mute">Your firm's email (@${esc(fm.detect.domain)}) is hosted by ${esc(fm.detect.host)}. Firm-wide connect works with Microsoft 365 and Google Workspace. Each attorney can connect their own email in a minute with <b>Connect with your email password</b> (Inbox or Court Updates).</p>`}</div>`;
  $("#app").innerHTML = secTabs(FS_SECS, fsSec, "fs") + profileCard(fp) + fmCard + mkCard + `<div class="card" data-fs="people"><h2>${esc(me.firm_name)} – seats</h2>${us.map(u => `<div style="border-top:1px solid var(--line);padding:10px 0" data-u="${u.id}">
    <b>${esc(u.name)}</b> <span class="tag ${u.active ? "g" : "r"}">${u.active ? u.role : "disabled"}</span> ${u.totp_enabled ? "" : `<span class="tag y">2FA not set</span>`}
    <div class="mute">${esc(u.email)}${u.bar_number ? " · Bar #" + esc(u.bar_number) : ""}</div><div class="mute">Counties: ${esc((u.counties || []).join(", ") || "none")} · Last login: ${u.last_login ? new Date(u.last_login).toLocaleString() : "never"}</div>
    <div style="margin-top:4px;font-size:14px">${esc(accessSummary(u, us))}</div>
    ${u.id !== me.id ? `<details style="margin-top:6px" data-acc="${u.id}"><summary class="mute">Change role and access</summary>${accessFields(u, us, "u" + u.id)}<div class="err"></div><button type="button" class="btn sm" data-a="acc">Save</button></details>` : ""}
    ${u.id !== me.id ? `<div class="row" style="margin-top:6px"><button class="btn sm ghost" data-a="reset">Reset password & 2FA</button><button class="btn sm ${u.active ? "danger" : "ghost"}" data-a="toggle">${u.active ? "Disable" : "Enable"}</button></div>` : ""}</div>`).join("")}</div>
   ${me.firm_kind === "solo" ? `<div class="card" data-fs="people"><h2>Solo practice</h2><p style="margin-top:0">It's just you, with every feature: the full dashboard, billing, trust and settings.</p><p class="mute">Bringing on a partner, attorney or staff? Change <b>Practice type</b> to <b>Law firm</b> under Firm profile, then add their sign-ins here.</p></div>` : ""}
   <div class="card" data-fs="${me.firm_kind === "solo" ? "never" : "people"}"><h2>Add a seat</h2><p class="mute" style="margin-top:0">Each person gets their own sign-in. You set them up here; they get a temporary password, then set their own password and two-factor at first sign-in.</p><form id="af"><div class="grid"><div><label>Name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email" required></div>
   <div><label>Bar # (attorneys)</label><input name="bar" inputmode="numeric"></div></div><div id="newAcc">${accessFields({ id: 0, role: "attorney", access: "own", works_with: [], trust_access: false }, us, "ns")}</div>
   <div class="err" id="aerr"></div><button class="btn">Add seat</button></form><div id="temp"></div></div><div id="firmExtras"></div>`;
  const setFs = k => { fsSec = k; $$("#app [data-fs]").forEach(s => s.hidden = s.dataset.fs !== k); $$("[data-fs-go]").forEach(b => b.dataset.fsGo === k ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")); $("#fsSel").value = k; };
  $$("[data-fs-go]").forEach(b => b.onclick = () => setFs(b.dataset.fsGo)); $("#fsSel").onchange = e => setFs(e.target.value);
  setFs(fsSec); wireProfileCard(fp);
  Promise.resolve(window.renderFirmExtras && renderFirmExtras(us)).then(() => setFs(fsSec));
  const showTemp = (who, pw) => $("#temp").innerHTML = `<div class="card" style="background:#fff4d6;margin-top:10px"><b>Temporary password for ${esc(who)}:</b><div class="secret" style="margin-top:6px">${esc(pw)}</div><p class="mute">Shown once. Give it to them privately — they'll set their own password and 2FA at first sign-in.</p></div>`;
  if ($("#mkF")) $("#mkF").onsubmit = async e => {
    e.preventDefault(); const f = e.target, btn = f.querySelector("button.btn"); $("#mkErr").textContent = ""; btn.disabled = true; btn.textContent = "Testing with Microsoft…";
    const body = Object.fromEntries([...new FormData(f)].map(([k, v]) => [k, String(v).trim()]));
    try { await api("/api/firm/ms-keys", { method: "POST", body }); toast("Keys saved — Microsoft accepted them"); firmView(); }
    catch (x) { $("#mkErr").textContent = x.message; btn.disabled = false; btn.textContent = "Save & test with Microsoft"; }
  };
  if ($("#shF")) $("#shF").onsubmit = async e => { e.preventDefault(); try { await api("/api/firm/setup-help", { method: "POST", body: Object.fromEntries(new FormData(e.target)) }); toast("Request sent — we'll call you"); firmView(); } catch (x) { e.target.querySelector(".err").textContent = x.message; } };
  if ($("#mkEdit")) $("#mkEdit").onclick = () => { $("#mkHow").open = true; $("#mkHow").scrollIntoView({ behavior: "smooth" }); };
  if ($("#mkDel")) $("#mkDel").onclick = async () => { const b = $("#mkDel"); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again to remove"; return; } await api("/api/firm/ms-keys", { method: "DELETE" }); toast("Removed — using the TX Case Desk app"); firmView(); };
  if ($("#fmSync")) $("#fmSync").onclick = async () => { await api("/api/firm/mail/sync", { method: "POST" }); toast("Checking firm email…"); setTimeout(firmView, 2000); };
  if ($("#fmDel")) $("#fmDel").onclick = async () => { const b = $("#fmDel"); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again to disconnect"; return; } await api("/api/firm/mail", { method: "DELETE" }); firmView(); };
  if ($("#fmG")) $("#fmG").onclick = async () => { try { await api("/api/firm/mail/google", { method: "POST" }); toast("Firm email connected"); firmView(); } catch (e) { $("#fmGerr").textContent = e.message; } };
  const newAcc = wireAccess($("#newAcc"));
  $("#af").onsubmit = async e => { e.preventDefault(); const b = { ...Object.fromEntries(new FormData(e.target)), ...newAcc() }; try { const r = await api("/api/firm/users", { method: "POST", body: b }); await firmView(); showTemp(b.email, r.temp_password); } catch (err) { $("#aerr").textContent = err.message; } };
  $$("[data-u]").forEach(row => {
    const u = us.find(x => x.id === +row.dataset.u);
    row.querySelector("[data-a=reset]")?.addEventListener("click", async () => { try { const r = await api(`/api/firm/users/${u.id}`, { method: "PATCH", body: { reset: true } }); await firmView(); showTemp(u.email, r.temp_password); } catch (e) { fail(e); } });
    const det = row.querySelector("[data-acc]");
    if (det) { const get = wireAccess(det); det.querySelector("[data-a=acc]").onclick = async () => { try { await api(`/api/firm/users/${u.id}`, { method: "PATCH", body: get() }); toast("Role and access saved"); firmView(); } catch (x) { det.querySelector(".err").textContent = x.message; } }; }
    row.querySelector("[data-a=toggle]")?.addEventListener("click", async () => { try { await api(`/api/firm/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }); firmView(); } catch (e) { fail(e); } });
  });
}

// ---------------- subscription ----------------
function subWall(err) {
  $("#app").innerHTML = `<div class="narrow card"><h2>${err.code === "FIRM_OFF" ? "Account turned off" : "Subscription needed"}</h2><p>${esc(err.message)}</p>
   ${err.code === "PLAN_EXPIRED" ? `<label>Have a code?</label><input id="sc" placeholder="TXC-30D-…"><div class="err" id="scErr"></div><button class="btn" id="scGo" style="width:100%">Apply code</button>` : ""}
   <p class="mute">Questions? Email <b>steve.smith@buddyrents.com</b>.</p></div>`;
  if ($("#scGo")) $("#scGo").onclick = async () => { try { await api("/api/subscription/redeem", { method: "POST", body: { code: $("#sc").value } }); toast("Code applied"); show(); } catch (e) { $("#scErr").textContent = e.message; } };
}
function subLine(sub) {
  if (!sub || !sub.plan) return "";
  if (sub.plan === "pro" && sub.expires_on) { const d = Math.ceil((new Date(sub.expires_on) - new Date()) / 864e5); return `${sub.source === "trial" ? "Free trial" : "Active"} — ${d > 0 ? d + " day" + (d === 1 ? "" : "s") + " left" : "ends today"} (until ${String(sub.expires_on).slice(0, 10)})`; }
  if (sub.plan === "pro") return "Active subscription";
  return sub.reason || "Not active";
}

// ---------------- account ----------------
// ---------------- roles and access (admin sets them per person) ----------------
const ROLE_LBL = { admin: "Firm admin", partner: "Partner", manager: "Manager", attorney: "Attorney", paralegal: "Paralegal" };
const ACC_LBL = { own: "Own cases + cases they're added to", team: "Cases of the attorneys they work with", firm: "Whole firm" };
function accessSummary(u, us) {
  const all = ["admin", "partner", "manager"].includes(u.role) || u.access === "firm";
  const ww = (u.works_with || []).map(id => (us.find(x => x.id === id) || {}).name).filter(Boolean);
  const sees = all ? "sees the whole firm" : u.access === "team" ? (ww.length ? `sees cases of ${ww.join(", ")}` : "sees no cases yet — pick who they work with") : "sees own cases and cases they're added to";
  return `${ROLE_LBL[u.role] || u.role} · ${sees}${["admin", "partner", "manager"].includes(u.role) ? " · firm dashboard" : ""}${u.role === "admin" || (u.trust_access && u.role !== "paralegal") ? " · trust ledger" : ""}`;
}
function accessFields(u, us, pre) {
  const atts = us.filter(x => x.active && x.id !== u.id && ["admin", "partner", "manager", "attorney"].includes(x.role));
  return `<div class="grid" style="margin-top:8px">
    <div><label for="${pre}r">Role</label><select id="${pre}r" data-f="role">${Object.entries(ROLE_LBL).map(([k, v]) => `<option value="${k}"${u.role === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <div class="full" data-show="access"><label for="${pre}a">Sees</label><select id="${pre}a" data-f="access">${Object.entries(ACC_LBL).map(([k, v]) => `<option value="${k}"${(u.access || "own") === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
    <fieldset class="full" data-show="ww" style="border:0;padding:0;margin:0"><legend style="font-size:12px;color:var(--mute);font-weight:500;margin-bottom:4px;padding:0">Works with</legend><div class="row" style="gap:0">${atts.map(x => `<label class="ck"><input type="checkbox" data-ww="${x.id}"${(u.works_with || []).includes(x.id) ? " checked" : ""}>${esc(x.name)}</label>`).join("") || `<span class="mute">Add attorneys first.</span>`}</div></fieldset>
    <div class="full" data-show="trust"><label class="ck"><input type="checkbox" data-f="trust"${u.trust_access || (u.role === "manager" && u.trust_access == null) ? " checked" : ""}>Can see the trust ledger</label></div></div>`;
}
function wireAccess(box) {
  const role = () => box.querySelector("[data-f=role]").value, acc = () => box.querySelector("[data-f=access]").value;
  const sync = () => { const r = role(), lim = r === "attorney" || r === "paralegal";
    box.querySelector("[data-show=access]").hidden = !lim; box.querySelector("[data-show=ww]").hidden = !(lim && acc() === "team"); box.querySelector("[data-show=trust]").hidden = r === "admin" || r === "paralegal"; };
  box.querySelectorAll("select").forEach(s => s.addEventListener("change", sync)); sync();
  return () => ({ role: role(), access: acc(), works_with: [...box.querySelectorAll("[data-ww]:checked")].map(x => +x.dataset.ww), trust_access: box.querySelector("[data-f=trust]").checked });
}

// ---------------- firm settings: sections + firm profile + logo ----------------
const FS_SECS = [["profile", "Firm profile"], ["people", "People & sign-ins"], ["email", "Email & Microsoft"], ["money", "Payments & rates"], ["court", "Court days & checklists"], ["data", "Export"]];
let fsSec = "profile";
function secTabs(secs, cur, attr) {
  return `<nav class="secnav" aria-label="Sections">${secs.map(([k, v]) => `<button type="button" data-${attr}-go="${k}"${cur === k ? ' aria-current="page"' : ""}>${v}</button>`).join("")}</nav>
    <div class="secsel"><label for="${attr}Sel">Section</label><select id="${attr}Sel">${secs.map(([k, v]) => `<option value="${k}"${cur === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>`;
}
function profileCard(f) {
  return `<div class="card" data-fs="profile"><h2>Firm profile</h2><p class="mute" style="margin-top:0">Shown in the app and on Word drafts, letters, invoices and the client page.</p>
    <div class="logorow"><div class="logoprev">${f.logo ? `<img src="${esc(f.logo)}" alt="${esc(f.name)} logo">` : `<span class="mute">No logo yet</span>`}</div>
      <div style="display:flex;flex-direction:column;gap:8px"><div class="row"><button type="button" class="btn ghost" id="logoBtn">${f.logo ? "Replace logo" : "Upload logo"}</button>${f.logo ? `<button type="button" class="btn ghost" id="logoDel">Remove</button>` : ""}</div>
        <input type="file" id="logoUp" accept="image/png,image/jpeg" hidden><span class="mute">PNG or JPG, up to 1 MB. A wide logo on a white or clear background looks best.</span><div class="err" id="logoErr"></div></div></div>
    <form id="fpF" style="margin-top:14px"><div class="grid">
      <div class="full"><label for="fpName">Firm name</label><input id="fpName" name="name" required value="${esc(f.name || "")}"></div>
      <div><label for="fpKind">Practice type</label><select id="fpKind"><option value="solo"${f.kind === "solo" ? " selected" : ""}>Solo attorney</option><option value="firm"${f.kind !== "solo" ? " selected" : ""}>Law firm</option></select></div>
      <div class="full"><label for="fpAddr">Office address</label><textarea id="fpAddr" name="address" rows="3" style="min-height:84px" placeholder="123 Main St, Suite 200&#10;McAllen, TX 78501">${esc(f.address || "")}</textarea></div>
      <div><label for="fpPh">Main phone</label><input id="fpPh" name="phone" type="tel" value="${esc(f.phone || "")}"></div>
      <div><label for="fpFax">Fax</label><input id="fpFax" name="fax" type="tel" value="${esc(f.fax || "")}"></div>
      <div><label for="fpEm">Firm email</label><input id="fpEm" name="email" type="email" value="${esc(f.email || "")}"></div>
      <div><label for="fpWeb">Website</label><input id="fpWeb" name="website" value="${esc(f.website || "")}" placeholder="www.yourfirm.com"></div></div>
      <div class="err"></div><button class="btn">Save firm profile</button></form></div>`;
}
function wireProfileCard() {
  $("#fpKind").onchange = async e => { try { await api("/api/firm/kind", { method: "PUT", body: { kind: e.target.value } }); me.firm_kind = e.target.value; me.firm_dash = me.firm_dash || e.target.value === "solo"; renderNav(); toast(e.target.value === "solo" ? "Set up as a solo practice" : "Set up as a law firm"); firmView(); } catch (x) { e.target.value = me.firm_kind; fail(x); } };
  $("#fpF").onsubmit = async e => { e.preventDefault(); const f = e.target;
    try { const r = await api("/api/firm/profile", { method: "PUT", body: Object.fromEntries(new FormData(f)) }); me.firm_name = r.profile.name; renderNav(); toast("Firm profile saved"); }
    catch (x) { f.querySelector(".err").textContent = x.message; } };
  $("#logoBtn").onclick = () => $("#logoUp").click();
  $("#logoUp").onchange = async e => { const file = e.target.files[0]; if (!file) return; $("#logoErr").textContent = "";
    if (!/^image\/(png|jpeg)$/.test(file.type)) { $("#logoErr").textContent = "Use a PNG or JPG image."; return; }
    if (file.size > 1024 * 1024) { $("#logoErr").textContent = "That image is over 1 MB. Save a smaller copy and try again."; return; }
    const res = await fetch("/api/firm/logo", { method: "PUT", headers: { "X-Requested-With": "tcd", "Content-Type": file.type }, body: file, credentials: "same-origin" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { $("#logoErr").textContent = j.error || "Upload failed"; return; }
    me.firm_logo = j.logo; renderNav(); toast("Logo saved"); firmView(); };
  if ($("#logoDel")) $("#logoDel").onclick = async () => { const b = $("#logoDel"); if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again to remove"; return; }
    await api("/api/firm/logo", { method: "DELETE" }); me.firm_logo = null; renderNav(); toast("Logo removed"); firmView(); };
}

// ---------------- account: my profile ----------------
function sigLines(u, f) {
  return [f.name && f.name.toUpperCase(), ...String(f.address || "").split(/\n+/).map(s => s.trim()).filter(Boolean), f.phone && "Telephone: " + f.phone, f.fax && "Facsimile: " + f.fax, "",
    "By: /s/ " + (u.name || ""), u.name, u.title, "State Bar No. " + (u.bar_number || "________"), u.phone && u.phone !== f.phone && "Direct: " + u.phone, u.doc_email || me.email].filter(x => x !== undefined && x !== null && x !== false);
}
function accountView() {
  const role = me.firm_kind === "solo" ? "Solo attorney" : ROLE_LBL[me.role] || "Attorney";
  $("#app").innerHTML = `<div class="card"><h2>My profile</h2><p class="mute" style="margin-top:0">Used in your signature block on Word drafts and letters.</p>
    <form id="mpF"><div class="grid">
      <div><label for="mpN">Full name</label><input id="mpN" name="name" required value="${esc(me.name)}"></div>
      ${me.role !== "paralegal" ? `<div><label for="mpB">Texas Bar # (8 digits)</label><input id="mpB" name="bar_number" inputmode="numeric" maxlength="8" value="${esc(me.bar_number || "")}"></div>` : ""}
      <div><label for="mpT">Title</label><input id="mpT" name="title" value="${esc(me.title || "")}" placeholder="${me.role === "paralegal" ? "Paralegal" : "Attorney at Law"}"></div>
      <div><label for="mpP">Direct phone</label><input id="mpP" name="phone" type="tel" value="${esc(me.phone || "")}"></div>
      <div class="full"><label for="mpE">Email on documents</label><input id="mpE" name="doc_email" type="email" value="${esc(me.doc_email || "")}" placeholder="${esc(me.email)}"><span class="mute">Leave blank to use your sign-in email.</span></div></div>
      <div class="err"></div><button class="btn">Save my profile</button></form>
    ${me.role !== "paralegal" ? `<details style="margin-top:14px"><summary>Signature block preview</summary><div class="sigprev" id="sigPrev"></div></details>` : ""}</div>
   <div class="card"><h2>Sign-in and security</h2><div class="kv"><div><b>Sign-in email</b>${esc(me.email)}</div><div><b>Firm</b>${esc(me.firm_name)}</div><div><b>Role</b>${role}</div><div><b>Two-factor</b>${me.totp_enabled ? "On" : "Off"}</div></div>
   <p class="mute">Your firm admin creates and manages sign-ins.</p>
   <div class="row" style="margin-top:12px"><button class="btn ghost" id="pw">Change password</button><button class="btn danger" id="out">Sign out</button></div></div>
   <div class="card"><h3>Subscription</h3><div id="subInfo" class="mute">Loading…</div>
   <label for="sc" style="margin-top:10px">Have a free-time code?</label><div class="row"><input id="sc" placeholder="TXC-30D-…" style="flex:1"><button class="btn sm" id="scGo">Apply</button></div><div class="err" id="scErr"></div></div>`;
  let firm = { name: me.firm_name };
  const prev = () => { const el = $("#sigPrev"); if (!el) return; const f = $("#mpF"); const u = { name: f.name.value, bar_number: f.bar_number ? f.bar_number.value : "", title: f.title.value, phone: f.phone.value, doc_email: f.doc_email.value };
    el.innerHTML = sigLines(u, firm).map(l => l ? `<div>${esc(l)}</div>` : "<br>").join(""); };
  api("/api/firm/profile").then(r => { firm = r.profile; prev(); }).catch(() => prev());
  $("#mpF").oninput = prev;
  $("#mpF").onsubmit = async e => { e.preventDefault(); const f = e.target;
    try { const r = await api("/api/me/profile", { method: "PUT", body: Object.fromEntries(new FormData(f)) }); me = { ...me, ...r.user }; renderNav(); toast("Profile saved"); f.querySelector(".err").textContent = ""; }
    catch (x) { f.querySelector(".err").textContent = x.message; } };
  api("/api/subscription").then(r => { $("#subInfo").textContent = r.managed ? subLine(r) : "Active"; }).catch(() => {});
  $("#scGo").onclick = async () => { try { await api("/api/subscription/redeem", { method: "POST", body: { code: $("#sc").value } }); toast("Code applied"); accountView(); } catch (e) { $("#scErr").textContent = e.message; } };
  $("#pw").onclick = () => changePwView(false);
  $("#out").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); me = null; authView(); };
}

// ---------------- auto refresh + pull to refresh ----------------
let appVer = null;
async function checkVersion() {
  try { const r = await api("/api/version"); if (appVer && r.v !== appVer) return location.reload(); appVer = r.v;
    const el = document.getElementById("ver"); if (el) el.textContent = `Version ${r.v} · updated ${new Date(r.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · Outlook connect ${r.outlook ? "on" : "OFF"}`; } catch {}
}
function busy() { const a = document.activeElement; return a && /INPUT|TEXTAREA|SELECT/.test(a.tagName); }
async function autoRefresh() {
  if (document.hidden || !me || !me.id || busy()) return;
  await checkVersion();
  if (tab === "inbox" && !subView) { const y = window.scrollY; await inboxView(true); window.scrollTo(0, y); }
  else if (tab === "inbox" || tab === "cases") { try { const r = await api("/api/inbox"); inboxUnread = r.unread; renderNav(); } catch {} }
}
setInterval(autoRefresh, 60e3);
document.addEventListener("visibilitychange", () => { if (!document.hidden) autoRefresh(); });
(() => {
  const ind = document.createElement("div");
  ind.style.cssText = "position:fixed;top:0;left:0;right:0;text-align:center;font-size:14px;padding:8px;color:var(--mute,#666);transform:translateY(-100%);transition:transform .15s;z-index:999;pointer-events:none";
  document.body.appendChild(ind);
  let y0 = null, pull = 0;
  addEventListener("touchstart", e => { y0 = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; pull = 0; }, { passive: true });
  addEventListener("touchmove", e => {
    if (y0 === null) return; pull = e.touches[0].clientY - y0;
    if (pull <= 0) { ind.style.transform = "translateY(-100%)"; return; }
    ind.textContent = pull > 80 ? "↻ Release to refresh" : "↓ Pull to refresh";
    ind.style.transform = `translateY(${Math.min(pull, 100) - 40}px)`;
  }, { passive: true });
  addEventListener("touchend", async () => {
    if (y0 === null) return; y0 = null;
    if (pull > 80 && me && me.id) { ind.textContent = "Refreshing…"; await checkVersion(); if (tab === "inbox" && subView) await inboxView(); else show(); }
    ind.style.transform = "translateY(-100%)"; pull = 0;
  });
})();

// ---------------- boot ----------------
checkVersion();
(async () => {
  try { META = await api("/api/meta"); } catch (e) { $("#app").innerHTML = `<div class="card err">Can't reach server.</div>`; return; }
  const qs = new URLSearchParams(location.search);
  if (qs.get("connected") || qs.get("mailerror")) { tab = /firm/.test(qs.get("connected") || "") ? "firm" : "inbox"; history.replaceState(null, "", "/"); setTimeout(() => toast(qs.get("connected") ? `Email connected: ${qs.get("connected")} — checking court emails now` : qs.get("mailerror")), 600); }
  try { me = (await api("/api/me")).user; start(); }
  catch (e) { e.code === "CHANGE_PW" ? (me = { must_change_pw: true }, changePwView(true)) : authView(qs.get("signup") || qs.get("code") ? "signup" : "login"); }
})();
