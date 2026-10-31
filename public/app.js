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

let META = null, me = null, tab = "cases";
const caseF = { view: "mine", county: "", type: "", attorney: "" };
let firmUsers = null;
let inboxUnread = 0;
const law = { q: "", court: "", after: "", county: "", results: null, open: null };

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
  api("/api/inbox").then(r => { if (r.unread !== inboxUnread) { inboxUnread = r.unread; renderNav(); } }).catch(() => {});
  $("#who").textContent = `${me.name}${me.bar_number ? " · Bar #" + me.bar_number : ""}`;
  if (!me.counties.length && tab === "cases") tab = "counties";
  renderNav(); show();
}
function renderNav() {
  const tabs = [["cases", "Pending Cases"], ["inbox", "Inbox" + (inboxUnread ? ` (${inboxUnread})` : "")], ["law", "Case Law"], ["saved", "Saved"], ["counties", "My Counties"], ["court", "Court Updates"]];
  if (me.role === "admin") tabs.push(["firm", "Firm Seats"]);
  tabs.push(["account", "Account"]);
  const n = $("#nav"); n.hidden = false;
  n.innerHTML = tabs.map(([k, v]) => `<button data-t="${k}" class="${tab === k ? "on" : ""}">${v}</button>`).join("");
  n.querySelectorAll("button").forEach(b => b.onclick = () => { tab = b.dataset.t; renderNav(); show(); });
}
function show() { clearTimeout(courtPoll); ({ inbox: inboxView, cases: casesView, law: lawView, saved: savedView, counties: countiesView, court: courtView, firm: firmView, account: accountView })[tab](); window.scrollTo(0, 0); }

// ---------------- inbox (court emails) ----------------
const TYPE_TAG = { "Hearing / setting": "y", "New filing": "g", "Order / judgment": "r", "Case notice": "n", "Account activation": "n", "Email": "n" };
async function inboxView() {
  $("#app").innerHTML = `<div class="card mute">Loading inbox…</div>`;
  let r; try { r = await api("/api/inbox"); } catch (e) { return fail(e); }
  inboxUnread = r.unread; renderNav();
  $("#app").innerHTML = `<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Inbox</h2>${r.unread ? `<button class="btn sm ghost" id="readAll">Mark all read</button>` : ""}</div>
   <p class="mute" style="margin-bottom:0">Every court email sent to your app address. Tap one for the summary and the exact email.</p></div>
   ${r.emails.map(m => `<div class="card" data-open="${m.id}" style="cursor:pointer;${m.read ? "" : "border-left:4px solid var(--acc)"}">
     <div class="row"><span class="tag ${TYPE_TAG[m.type] || "n"}">${esc(m.type)}</span>${m.read ? "" : `<span class="tag r">New</span>`}<span class="mute" style="margin-left:auto">${new Date(m.received_at).toLocaleString()}</span></div>
     <h3 style="margin-top:6px">${esc(m.subject || "(no subject)")}</h3>
     <div class="mute">${esc(m.from_addr)}</div>
     ${m.cases.length ? `<div style="margin-top:4px">${m.cases.map(c => `<span class="chip">${esc(c.cause_no)}${c.case ? " · " + esc(c.case.style || "") : " · not in your cases"}</span>`).join("")}</div>` : ""}
     ${m.dates.length ? `<div class="mute" style="margin-top:4px">📅 ${m.dates.map(esc).join(" · ")}</div>` : ""}
     <div style="font-size:14px;margin-top:4px">${esc(m.preview)}</div></div>`).join("") || `<div class="card mute">No emails yet. Set up your address under <a class="link" id="goCU">Court Updates</a>.</div>`}`;
  if ($("#readAll")) $("#readAll").onclick = async () => { await api("/api/inbox/read-all", { method: "POST" }); inboxView(); };
  if ($("#goCU")) $("#goCU").onclick = () => { tab = "court"; renderNav(); show(); };
  $$("[data-open]").forEach(c => c.onclick = () => emailView(+c.dataset.open));
}
async function emailView(id) {
  window.scrollTo(0, 0);
  let r; try { r = await api(`/api/email-alerts/${id}`); } catch (e) { return fail(e); }
  const m = r.email, sm = r.summary;
  const linkify = t => esc(t).replace(/(https?:\/\/[^\s<]+)/g, u => `<a class="link" href="${u}" target="_blank" rel="noopener">${u.length > 70 ? u.slice(0, 70) + "…" : u}</a>`);
  $("#app").innerHTML = `<button class="btn sm ghost" id="bk">← Inbox</button>
   <div class="card" style="margin-top:10px"><div class="row"><span class="tag ${TYPE_TAG[sm.type] || "n"}">${esc(sm.type)}</span><span class="mute" style="margin-left:auto">${new Date(m.received_at).toLocaleString()}</span></div>
   <h2 style="margin-top:8px">${esc(m.subject || "(no subject)")}</h2><div class="mute">From: ${esc(m.from_addr)}</div></div>
   <div class="card"><h3>Summary</h3>
     ${sm.action ? `<p style="margin:6px 0"><b>👉 ${esc(sm.action)}</b></p>` : ""}
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
  $("#bk").onclick = inboxView;
  $$("[data-case]").forEach(a => a.onclick = () => { tab = "cases"; caseF.view = "firm"; renderNav(); show(); });
  inboxUnread = Math.max(0, inboxUnread - 1); renderNav();
}

// ---------------- court logins / county sync ----------------
let courtPoll;
async function courtView() {
  clearTimeout(courtPoll);
  let d, ea, mb; try { [d, ea, mb] = await Promise.all([api("/api/court-logins"), api("/api/email-alerts"), api("/api/mail")]); } catch (e) { return fail(e); }
  const byCounty = Object.fromEntries(d.logins.map(l => [l.county, l]));
  const ago = t => t ? new Date(t).toLocaleString() : "never";
  $("#app").innerHTML = `<div class="card"><h2>Court logins</h2>
   <p class="mute">Your cases are pulled from each county portal under <b>your</b> login and <b>your</b> bar # (${esc(me.bar_number || "not set")}) — only for counties you picked. Pulls run when you sign in, nightly, and when you tap Sync now. Passwords are encrypted and never shown again.</p>
   ${d.bar_ok ? "" : `<p class="err">Your account needs an 8-digit bar # before cases can be pulled.</p>`}</div>
   <div class="card"><h2>📬 Connect your email</h2>
   <p style="margin-top:0">You already get court emails — eFileTexas service notices, clerk notices, hearing settings. Connect your email once and TX Case Desk reads <b>only those court emails</b>, adds new cases, and updates your existing ones automatically.</p>
   ${["microsoft", "google"].map(p => { const m = mb.mailboxes.find(x => x.provider === p);
     if (m) return `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row"><b>${esc(mb.names[p])}</b>
       <span class="tag ${m.status === "ok" ? "g" : m.status === "syncing" ? "y" : "r"}">${m.status === "ok" ? "Connected" : m.status === "syncing" ? "Checking…" : m.status === "reconnect" ? "Reconnect needed" : "Error"}</span></div>
       <div class="mute">${esc(m.email || "")}${m.last_sync ? " · last checked " + new Date(m.last_sync).toLocaleString() : ""}${m.stats ? ` · ${m.stats.added} new court emails, ${m.stats.created} cases added` : ""}</div>
       ${m.last_error ? `<p class="err" style="margin:4px 0">${esc(m.last_error)}</p>` : ""}
       <div class="row" style="margin-top:6px">${m.status === "reconnect" ? `<a class="btn sm" href="/api/mail/connect/${p}" style="text-decoration:none">Reconnect</a>` : `<button class="btn sm" data-msync="${m.id}">Check now</button>`}<button class="btn sm danger" data-mdel="${m.id}">Disconnect</button></div></div>`;
     return mb.configured[p] ? `<a class="btn" href="/api/mail/connect/${p}" style="display:block;text-align:center;text-decoration:none;margin:8px 0;padding:14px">Connect ${p === "microsoft" ? "Outlook / Microsoft 365" : "Gmail"}</a>`
       : `<button class="btn ghost" disabled style="display:block;width:100%;margin:8px 0;padding:14px">Connect ${p === "microsoft" ? "Outlook / Microsoft 365" : "Gmail"} — coming soon</button>`; }).join("")}
   <p class="mute" style="margin-bottom:0;font-size:13px">Read-only. Only emails from courts, clerks, eFileTexas and re:SearchTX are read; everything else is ignored and never stored. Checked every hour. Disconnect anytime.</p></div>
   <details class="card"><summary>Other ways (re:SearchTX alerts / forwarding)</summary>
   <div class="card" style="margin-top:10px"><h2>📨 Court updates (re:SearchTX)</h2>
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
  ${data.alerts ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4"><b>⚠ ${data.alerts} case alert${data.alerts === 1 ? "" : "s"}</b> (court dates, court emails, new case law). <a class="link" id="seeAlerts">Show them</a></div>` : ""}
  ${!me.counties.length ? `<div class="card"><b>Pick your counties first.</b> <span class="mute">You only see and add cases in counties you practice in.</span></div>` : ""}
  <div class="card"><div class="mute">Your counties</div><div style="font-weight:600">${esc(me.counties.join(", ") || "None selected")}</div>
   <div class="mute" style="margin-top:4px">Auto-pull: connect under <a class="link" id="goCourt">Court Logins</a> (live: ${esc(Object.entries(META.connectors).filter(([, v]) => v.status !== "blocked").map(([k]) => k).join(", ") || "none right now — use re:SearchTX alerts")}). Other counties: add cases below or import a CSV.</div></div>
  <div class="card"><div class="grid">
   <div><label>Show</label><select id="v"><option value="mine">My cases</option><option value="firm">Whole firm (my counties)</option><option value="tracked">Tracked cases</option><option value="watched">Watching court dates</option><option value="alerts">Alerts (dates, filings, case law)</option></select></div>
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
   ${c.date_alert ? `<div class="card" style="background:#fdf1d8;border-color:#f1dfa4;margin:10px 0 0;padding:10px"><b>⚠ Court date changed</b><div>${esc(c.date_alert)}</div><div class="mute">${c.date_alert_at ? new Date(c.date_alert_at).toLocaleString() : ""}</div><button class="btn sm" data-a="ack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.filing_alert ? `<div class="card" style="background:#e3f4ea;border-color:#bfe3cd;margin:10px 0 0;padding:10px"><b>📨 Court email</b><div style="font-size:14px">${esc(c.filing_alert)}</div><div class="mute">${c.filing_alert_at ? new Date(c.filing_alert_at).toLocaleString() : ""}</div><button class="btn sm" data-a="fileack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.law_alert ? `<div class="card" style="background:#e8eefc;border-color:#c9d6f5;margin:10px 0 0;padding:10px"><b>📚 New case law</b><div style="font-size:14px">${esc(c.law_alert)}</div><button class="btn sm" data-a="lawack" style="margin-top:6px">Got it</button></div>` : ""}
   ${c.issues ? `<p class="mute" style="margin:8px 0 0">Issues: ${esc(c.issues)}</p>` : ""}
   ${c.notes ? `<p class="mute" style="margin:8px 0 0">${esc(c.notes)}</p>` : ""}
   ${c.source === "county_sync" ? `<p class="mute" style="margin:6px 0 0">↻ Pulled from county portal${c.last_synced ? " · " + new Date(c.last_synced).toLocaleString() : ""}</p>` : ""}
   ${c.external_url ? `<a class="btn sm ghost" style="margin-top:8px;display:inline-block;text-decoration:none" href="${esc(c.external_url)}" target="_blank" rel="noopener">Open on county portal ↗</a>` : ""}
   <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-a="edit">Edit</button><button class="btn sm ghost" data-a="track">${c.tracked ? "★ Untrack" : "☆ Track"}</button><button class="btn sm" data-a="analyze">Analyze case law</button><button class="btn sm ghost" data-a="law">Search case law</button></div>
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
  const qs = new URLSearchParams(location.search);
  if (qs.get("connected") || qs.get("mailerror")) { tab = "court"; history.replaceState(null, "", "/"); setTimeout(() => toast(qs.get("connected") ? `Email connected: ${qs.get("connected")} — checking court emails now` : qs.get("mailerror")), 600); }
  try { me = (await api("/api/me")).user; start(); }
  catch (e) { e.code === "CHANGE_PW" ? (me = { must_change_pw: true }, changePwView(true)) : authView(); }
})();
