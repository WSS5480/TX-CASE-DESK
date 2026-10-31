// TX Case Desk — front end
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(m) { const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = "none", 3000); }

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || "GET", headers: { "Content-Type": "application/json", "X-Requested-With": "tcd" }, body: opts.body ? JSON.stringify(opts.body) : undefined, credentials: "same-origin" });
  let data = {}; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data.error || "Request failed"); err.status = res.status; err.code = data.code; throw err; }
  return data;
}

let META = null, me = null, tab = "cases";
const caseF = { view: "mine", county: "", type: "", attorney: "" };
let firmUsers = null;
const law = { q: "", court: "", after: "", results: null, open: null };

// ---------------- auth screens ----------------
function authView(mode = "login", msg = "") {
  $("#nav").hidden = true; $("#who").textContent = "";
  const signup = mode === "signup";
  $("#app").innerHTML = `<div class="narrow card"><h2>${signup ? "Create firm account" : "Attorney sign in"}</h2>
   <form id="f">
   ${signup ? `<label>Firm name</label><input name="firm" required><br><br>
   <label>Your full name</label><input name="name" required><br><br>
   <label>Texas Bar # (8 digits)</label><input name="bar" inputmode="numeric" pattern="\\d{8}" required><br><br>` : ""}
   <label>Email</label><input name="email" type="email" autocomplete="username" required><br><br>
   <label>Password${signup ? " (10+ chars, letters & numbers)" : ""}</label><input name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}" required>
   <div class="err" id="err">${esc(msg)}</div>
   <button class="btn" style="width:100%">${signup ? "Create account" : "Continue"}</button></form>
   <p class="mute" style="text-align:center"><a class="link" id="sw">${signup ? "Have an account? Sign in" : "New firm? Create an account"}</a></p></div>`;
  $("#sw").onclick = () => authView(signup ? "login" : "signup");
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
function start() {
  if (me.must_change_pw) return changePwView(true);
  $("#who").textContent = `${me.name}${me.bar_number ? " · Bar #" + me.bar_number : ""}`;
  if (!me.counties.length && tab === "cases") tab = "counties";
  renderNav(); show();
}
function renderNav() {
  const tabs = [["cases", "Pending Cases"], ["law", "Case Law"], ["saved", "Saved"], ["counties", "My Counties"], ["court", "Court Logins"]];
  if (me.role === "admin") tabs.push(["firm", "Firm Seats"]);
  tabs.push(["account", "Account"]);
  const n = $("#nav"); n.hidden = false;
  n.innerHTML = tabs.map(([k, v]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${v}</button>`).join("");
  n.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.t; renderNav(); show(); });
}
function show() { clearTimeout(courtPoll); ({ cases: casesView, law: lawView, saved: savedView, counties: countiesView, court: courtView, firm: firmView, account: accountView })[tab](); window.scrollTo(0, 0); }

// ---------------- court logins / county sync ----------------
let courtPoll;
async function courtView() {
  clearTimeout(courtPoll);
  let d; try { d = await api("/api/court-logins"); } catch (e) { return fail(e); }
  const byCounty = Object.fromEntries(d.logins.map(l => [l.county, l]));
  const ago = t => t ? new Date(t).toLocaleString() : "never";
  $("#app").innerHTML = `<div class="card"><h2>Court logins</h2>
   <p class="mute">Your cases are pulled from each county portal under <b>your</b> login and <b>your</b> bar # (${esc(me.bar_number || "not set")}) — only for counties you picked. Pulls run when you sign in, nightly, and when you tap Sync now. Passwords are encrypted and never shown again.</p>
   ${d.bar_ok ? "" : `<p class="err">Your account needs an 8-digit bar # before cases can be pulled.</p>`}</div>
   ${d.available.length ? "" : `<div class="card mute">None of your counties has an automatic feed yet. Live now: ${esc(Object.keys(META.connectors).join(", "))}. Add one under My Counties.</div>`}
   ${d.available.map(c => { const l = byCounty[c.county];
     const st = !l ? "" : l.status === "ok" ? `<span class="tag g">Synced</span>` : l.status === "error" ? `<span class="tag r">Error</span>` : `<span class="tag y">${l.status === "syncing" ? "Pulling cases…" : "Starting…"}</span>`;
     return `<div class="card" data-county="${esc(c.county)}"><div class="row"><h3 style="margin:0">${esc(c.county)} County</h3>${st}<span class="tag n">${esc(c.status)}</span></div>
     <div class="mute">${esc(c.name)} · <a class="link" href="${esc(c.url)}" target="_blank" rel="noopener">open portal</a></div>
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
  const insp = $("#insp");
  if (insp) insp.onclick = async () => { insp.disabled = true; insp.textContent = "Checking…"; const out = $("#inspOut"); out.hidden = false;
    try { out.textContent = JSON.stringify(await api(`/api/admin/inspect/${encodeURIComponent(d.available[0].county)}`), null, 2); } catch (e) { out.textContent = e.message; } insp.disabled = false; insp.textContent = "Check again"; };
  if (d.logins.some(l => l.status === "syncing" || l.status === "new")) courtPoll = setTimeout(() => { if (tab === "court") courtView(); }, 4000);
}
function fail(err) {
  if (err.status === 401) { me = null; return authView("login", "Session ended — sign in again."); }
  if (err.code === "CHANGE_PW") return changePwView(true);
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
  ${data.alerts ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4"><b>⚠ ${data.alerts} court date change${data.alerts === 1 ? "" : "s"}</b> on watched cases. <a class="link" id="seeAlerts">Show them</a></div>` : ""}
  ${!me.counties.length ? `<div class="card"><b>Pick your counties first.</b> <span class="mute">You only see and add cases in counties you practice in.</span></div>` : ""}
  <div class="card"><div class="mute">Your counties</div><div style="font-weight:600">${esc(me.counties.join(", ") || "None selected")}</div>
   <div class="mute" style="margin-top:4px">Auto-pull: connect under <a class="link" id="goCourt">Court Logins</a> (live: ${esc(Object.keys(META.connectors).join(", "))}). Other counties: add cases below or import a CSV.</div></div>
  <div class="card"><div class="grid">
   <div><label>Show</label><select id="v"><option value="mine">My cases</option><option value="firm">Whole firm (my counties)</option><option value="tracked">Tracked cases</option><option value="watched">Watching court dates</option><option value="alerts">Court date changes</option></select></div>
   ${me.role === "admin" ? `<div><label>Attorney</label><select id="af2"><option value="">All attorneys</option>${(firmUsers || []).filter(u => u.role !== "paralegal").map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div>` : ""}
   <div><label>County</label><select id="cf"><option value="">All my counties</option>${me.counties.map(c => `<option>${esc(c)}</option>`).join("")}</select></div>
   <div><label>Case type</label><select id="tf"><option value="">All types</option>${TYPES.map(t => `<option>${t}</option>`).join("")}</select></div></div></div>
  <div class="row" style="margin:0 0 12px"><button class="btn sm ghost" id="watchAll">☑ Watch court dates on all ${caseF.attorney && firmUsers ? esc((firmUsers.find(u => u.id === +caseF.attorney) || {}).name || "") + "'s" : "my"} cases</button></div>
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
    el.querySelector("[data-a=watch]").onchange = async e => { try { await api(`/api/cases/${c.id}`, { method: "PATCH", body: { watch_dates: e.target.checked } }); c.watch_dates = e.target.checked; toast(e.target.checked ? "Watching court dates" : "Stopped watching"); } catch (err) { fail(err); } };
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
   ${c.date_alert ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4;margin:10px 0 0;padding:10px"><b>⚠ Court date changed</b><div>${esc(c.date_alert)}</div><div class="mute">${c.date_alert_at ? new Date(c.date_alert_at).toLocaleString() : ""}</div><button class="btn sm" data-a="ack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.notes ? `<p class="mute" style="margin:8px 0 0">${esc(c.notes)}</p>` : ""}
   ${c.source === "county_sync" ? `<p class="mute" style="margin:6px 0 0">↻ Pulled from county portal${c.last_synced ? " · " + new Date(c.last_synced).toLocaleString() : ""}</p>` : ""}
   ${c.external_url ? `<a class="btn sm ghost" style="margin-top:8px;display:inline-block;text-decoration:none" href="${esc(c.external_url)}" target="_blank" rel="noopener">Open on county portal ↗</a>` : ""}
   <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-a="edit">Edit</button><button class="btn sm ghost" data-a="track">${c.tracked ? "★ Untrack" : "☆ Track"}</button><button class="btn sm ghost" data-a="law">Research case law</button></div>
   <label style="margin-top:10px;display:flex;align-items:center;gap:8px;font-size:14px;color:var(--ink)"><input type="checkbox" data-a="watch" style="width:auto" ${c.watch_dates ? "checked" : ""}> Watch court dates (alert me when the setting changes)</label>
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

// ---------------- case law ----------------
function lawView(autoSearch) {
  if (law.open) return opinionView(law.open);
  $("#app").innerHTML = `<div class="card"><h2>Texas case law</h2>
   <form id="lf"><div class="grid"><div class="full"><label>Search words (use quotes for phrases, AND / OR)</label><input name="q" value="${esc(law.q)}" placeholder='"constructive notice" AND premises'></div>
   <div><label>Court</label><select name="court"><option value="">All Texas courts</option>${Object.entries(META.courts).map(([k, v]) => `<option value="${k}" ${law.court === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
   <div><label>Decided after</label><input name="after" type="date" value="${esc(law.after)}"></div></div><br><button class="btn">Search</button></form>
   <p class="mute" style="margin-bottom:0">Source: public Texas court opinions (via CourtListener / Free Law Project). Flags are our own citator, not Lexis/Westlaw.</p></div><div id="res"></div>`;
  $("#lf").onsubmit = e => { e.preventDefault(); Object.assign(law, Object.fromEntries(new FormData(e.target))); runSearch(); };
  if (law.results) renderResults(); else if (autoSearch && law.q) runSearch();
}
async function runSearch() {
  if (law.q.trim().length < 2) return toast("Enter search words");
  $("#res").innerHTML = `<div class="card mute">Searching Texas opinions…</div>`;
  try { law.results = await api(`/api/law/search?${new URLSearchParams({ q: law.q, court: law.court, after: law.after })}`); renderResults(); }
  catch (e) { $("#res").innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function renderResults() {
  const r = law.results;
  $("#res").innerHTML = `<div class="mute" style="margin:0 4px 8px">${(r.count || 0).toLocaleString()} opinions${r.stale ? " (cached)" : ""}</div>` +
    (r.results.map(o => `<div class="card"><div class="mute">${esc(o.court)} · ${esc(o.date_filed || "")}</div>
     <h3 style="margin-top:4px"><a class="link" data-c="${o.cluster_id}">${esc(o.case_name)}</a></h3>
     <div class="mute">${esc(o.citation || "No reporter cite")} · cited ${o.cite_count}×</div>
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
    const c = await api(`/api/law/citator/${op.opinion_id}`);
    $("#flag").innerHTML = c.flag === "caution" ? `<span class="tag y">⚠ Caution – ${c.negative_count} citing opinion(s) use negative-treatment language. Review.</span>`
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
  $("#app").innerHTML = `<div class="card"><h2>${esc(me.firm_name)} – seats</h2>${us.map(u => `<div style="border-top:1px solid var(--line);padding:10px 0" data-u="${u.id}">
    <b>${esc(u.name)}</b> <span class="tag ${u.active ? "g" : "r"}">${u.active ? u.role : "disabled"}</span> ${u.totp_enabled ? "" : `<span class="tag y">2FA not set</span>`}
    <div class="mute">${esc(u.email)}${u.bar_number ? " · Bar #" + esc(u.bar_number) : ""}</div><div class="mute">Counties: ${esc((u.counties || []).join(", ") || "none")} · Last login: ${u.last_login ? new Date(u.last_login).toLocaleString() : "never"}</div>
    ${u.id !== me.id ? `<div class="row" style="margin-top:6px"><button class="btn sm ghost" data-a="reset">Reset password & 2FA</button><button class="btn sm ${u.active ? "danger" : "ghost"}" data-a="toggle">${u.active ? "Disable" : "Enable"}</button></div>` : ""}</div>`).join("")}</div>
   <div class="card"><h2>Add a seat</h2><form id="af"><div class="grid"><div><label>Name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email" required></div>
   <div><label>Bar # (attorneys)</label><input name="bar" inputmode="numeric"></div><div><label>Role</label><select name="role"><option value="attorney">Attorney</option><option value="paralegal">Paralegal</option><option value="admin">Firm admin</option></select></div></div>
   <div class="err" id="aerr"></div><button class="btn">Add seat</button></form><div id="temp"></div></div>`;
  const showTemp = (who, pw) => $("#temp").innerHTML = `<div class="card" style="background:#fff4d6;margin-top:10px"><b>Temporary password for ${esc(who)}:</b><div class="secret" style="margin-top:6px">${esc(pw)}</div><p class="mute">Shown once. Give it to them privately — they'll set their own password and 2FA at first sign-in.</p></div>`;
  $("#af").onsubmit = async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); try { const r = await api("/api/firm/users", { method: "POST", body: b }); await firmView(); showTemp(b.email, r.temp_password); } catch (err) { $("#aerr").textContent = err.message; } };
  $$("[data-u]").forEach(row => {
    const u = us.find(x => x.id === +row.dataset.u);
    row.querySelector("[data-a=reset]")?.addEventListener("click", async () => { try { const r = await api(`/api/firm/users/${u.id}`, { method: "PATCH", body: { reset: true } }); await firmView(); showTemp(u.email, r.temp_password); } catch (e) { fail(e); } });
    row.querySelector("[data-a=toggle]")?.addEventListener("click", async () => { try { await api(`/api/firm/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }); firmView(); } catch (e) { fail(e); } });
  });
}

// ---------------- account ----------------
function accountView() {
  $("#app").innerHTML = `<div class="card"><h2>Account</h2><div class="kv"><div><b>Name</b>${esc(me.name)}</div><div><b>Email</b>${esc(me.email)}</div><div><b>Bar #</b>${esc(me.bar_number || "—")}</div>
   <div><b>Firm</b>${esc(me.firm_name)}</div><div><b>Role</b>${esc(me.role)}</div><div><b>2FA</b>${me.totp_enabled ? "On" : "Off"}</div></div>
   <div class="row" style="margin-top:12px"><button class="btn ghost" id="pw">Change password</button><button class="btn danger" id="out">Sign out</button></div></div>`;
  $("#pw").onclick = () => changePwView(false);
  $("#out").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); me = null; authView(); };
}

// ---------------- boot ----------------
(async () => {
  try { META = await api("/api/meta"); } catch (e) { $("#app").innerHTML = `<div class="card err">Can't reach server.</div>`; return; }
  try { me = (await api("/api/me")).user; start(); }
  catch (e) { e.code === "CHANGE_PW" ? (me = { must_change_pw: true }, changePwView(true)) : authView(); }
})();
