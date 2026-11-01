// TX Case Desk — Mail, works like Outlook: folders, message list, reading pane, new / reply / reply all / forward,
// drafts, attachments, move, delete, flag, read/unread, search, save to a case. Court notices live here as their own folder.
// Mail is read live from the person's Outlook / email host — nothing is stored in TX Case Desk.
// Uses helpers from app.js: $, $$, esc, api, toast, fail, me, tab, renderNav, show, VIEWS, ic, ICON, openSheet, closeSheet,
// imapForm, wireImap, TYPE_TAG, queueCards, wireQueue, inboxUnread.
(() => {
  Object.assign(ICON, {
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/>',
    replyall: '<path d="M7 14 2 9l5-5"/><path d="M12 14 7 9l5-5"/><path d="M7 9h8a6 6 0 0 1 6 6v4"/>',
    forward: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0-6 6v4"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11h14V8"/><path d="M10 12h4"/>',
    junk: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    clip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'
  });
  const M = { accounts: null, acct: null, folders: [], folder: null, items: [], next: null, q: "", sel: null, msg: null, images: {}, court: false, reading: false, err: null, seq: 0 };
  window.mailState = M;
  const desk = () => window.matchMedia("(min-width:1000px)").matches;
  const ROLE_ORDER = { inbox: 0, drafts: 1, sent: 2, deleted: 3, junk: 4, archive: 5 };
  const ROLE_ICON = { inbox: "inbox", drafts: "file", sent: "send", deleted: "trash", junk: "junk", archive: "archive" };
  const ROLE_NAME = { inbox: "Inbox", drafts: "Drafts", sent: "Sent", deleted: "Deleted", junk: "Junk", archive: "Archive" };
  const acct = () => (M.accounts || []).find(a => a.id === M.acct) || null;
  const fold = id => M.folders.find(f => f.id === id) || null;
  const roleOf = id => (fold(id) || {}).role || null;
  const who = a => a ? (a.name || a.email) : "";
  const initials = a => (who(a) || "?").replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase() || "?";
  const shortDate = s => { if (!s) return ""; const d = new Date(s), n = new Date(); const same = d.toDateString() === n.toDateString();
    if (same) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (n - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== n.getFullYear() ? "numeric" : undefined }); };
  const longDate = s => s ? new Date(s).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  const qsx = o => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""))).toString();

  // ---------- data ----------
  async function loadAccounts() {
    const r = await api("/api/mailx/accounts"); M.accounts = r.accounts;
    if (!M.accounts.some(a => a.id === M.acct)) { const own = M.accounts.find(a => !a.shared) || M.accounts[0]; M.acct = own ? own.id : null; M.folder = null; }
    if (!M.acct) M.court = true;
  }
  async function loadFolders() {
    if (!M.acct) { M.folders = []; return; }
    try { const r = await api(`/api/mailx/folders?acct=${M.acct}`); M.err = null;
      M.folders = r.folders.slice().sort((a, b) => (a.role in ROLE_ORDER ? ROLE_ORDER[a.role] : 9) - (b.role in ROLE_ORDER ? ROLE_ORDER[b.role] : 9) || 0);
      // keep sub-folders right after their parent
      const top = M.folders.filter(f => f.role || !f.depth), out = [];
      const kids = M.folders.filter(f => !f.role && f.depth);
      const rest = top.filter(f => !f.role).sort((a, b) => a.name.localeCompare(b.name));
      for (const f of [...top.filter(f => f.role), ...rest]) { out.push(f); kids.filter(k => k.parent === f.id || (k.parent && k.parent === f.name)).forEach(k => out.push(k)); }
      kids.filter(k => !out.includes(k)).forEach(k => out.push(k));
      M.folders = out;
      if (!M.folder || !fold(M.folder)) M.folder = (M.folders.find(f => f.role === "inbox") || M.folders[0] || {}).id || null;
    } catch (e) { M.folders = []; M.err = e; }
  }
  async function loadList(more) {
    const seq = ++M.seq;
    if (M.court) return loadCourt(seq);
    if (!M.acct || !M.folder) { M.items = []; M.next = null; return; }
    try {
      const r = await api(`/api/mailx/messages?` + qsx({ acct: M.acct, folder: M.folder, q: M.q, cursor: more ? M.next : null }));
      if (seq !== M.seq) return;
      M.items = more ? M.items.concat(r.items) : r.items; M.next = r.next; M.err = null;
    } catch (e) { if (seq === M.seq) { M.items = more ? M.items : []; M.err = e; } }
  }
  async function loadCourt(seq) {
    const [ib, qd] = await Promise.all([api("/api/inbox").catch(() => ({ emails: [], unread: 0 })), me.court_handler ? api("/api/court-queue").catch(() => null) : null]);
    if (seq !== M.seq) return;
    inboxUnread = ib.unread; renderNav();
    M.queue = qd; M.next = null; M.err = null;
    const q = (M.q || "").toLowerCase(), hit = m => !q || `${m.subject} ${m.from_addr} ${m.preview}`.toLowerCase().includes(q);
    M.items = [...(qd ? qd.emails.filter(hit).map(m => ({ ...m, kind: "queue" })) : []), ...ib.emails.filter(hit).map(m => ({ ...m, kind: "notice" }))];
  }

  // ---------- rendering ----------
  function folderPane() {
    const a = acct(), multi = (M.accounts || []).length > 1;
    const fl = M.folders.map(f => `<button type="button" class="mfold${!M.court && f.id === M.folder ? " on" : ""}" data-f="${esc(f.id)}" style="padding-left:${12 + (f.depth || 0) * 16}px">
        ${ic(ROLE_ICON[f.role] || "folder", 17)}<span class="mfn">${esc(f.role ? (ROLE_NAME[f.role] || f.name) : f.name)}</span>${f.role !== "sent" && f.role !== "deleted" && f.unread ? `<span class="mcnt">${f.unread}</span>` : f.role === "drafts" && f.total ? `<span class="mcnt k">${f.total}</span>` : ""}</button>`).join("");
    const qn = M.queueCount || 0;
    return `<div class="mfh">${multi ? `<label class="sr" for="mxAcct">Account</label><select id="mxAcct">${M.accounts.map(x => `<option value="${x.id}"${x.id === M.acct ? " selected" : ""}>${esc(x.shared ? "Shared court inbox · " + x.email : x.email)}</option>`).join("")}</select>`
        : a ? `<div class="macct" title="${esc(a.email)}">${a.shared ? "Shared court inbox · " : ""}${esc(a.email)}</div>` : ""}
      <button type="button" class="btn mnew" data-compose>${ic("edit", 17)}New email</button></div>
      <nav class="mfl" aria-label="Folders">
        <button type="button" class="mfold${M.court ? " on" : ""}" data-court>${ic("court", 17)}<span class="mfn">Court notices</span>${qn ? `<span class="mcnt y" title="Needs assigning">${qn}</span>` : inboxUnread ? `<span class="mcnt">${inboxUnread}</span>` : ""}</button>
        ${fl}
      </nav>
      ${!M.acct ? `<div class="mconn"><p>Connect your email to read, send and organize all of it here.</p><button type="button" class="btn sm" data-connect>Connect email</button></div>`
        : `<div class="mfoot"><button type="button" class="lk" data-connect>Email accounts</button></div>`}`;
  }
  function phoneBar() {
    const multi = (M.accounts || []).length > 1;
    const opts = `<option value="__court"${M.court ? " selected" : ""}>Court notices${M.queueCount ? ` (${M.queueCount} to assign)` : inboxUnread ? ` (${inboxUnread})` : ""}</option>` +
      M.folders.map(f => `<option value="${esc(f.id)}"${!M.court && f.id === M.folder ? " selected" : ""}>${"  ".repeat(f.depth || 0)}${esc(f.role ? (ROLE_NAME[f.role] || f.name) : f.name)}${f.unread && f.role !== "sent" ? ` (${f.unread})` : ""}</option>`).join("");
    return `<div class="mpb">${multi ? `<select id="mxAcctP" aria-label="Account">${M.accounts.map(x => `<option value="${x.id}"${x.id === M.acct ? " selected" : ""}>${esc(x.shared ? "Shared court inbox" : x.email)}</option>`).join("")}</select>` : ""}
      <select id="mxFoldP" aria-label="Folder">${opts}</select>
      <button type="button" class="btn sm" data-compose aria-label="New email">${ic("edit", 16)}New</button></div>`;
  }
  function banner() {
    const a = acct();
    if (M.court) return "";
    if (M.err && M.err.reconnect || (a && a.reconnect)) {
      const ms = a && a.provider === "microsoft";
      return `<div class="mban">${ms ? `<b>Reconnect Outlook once</b> to see all your email and send from here (it only had permission for court emails).<a class="btn sm" href="/api/mail/connect/microsoft">Reconnect Outlook</a>`
        : a && a.provider === "google" ? `<b>Gmail:</b> to see all your email here, disconnect Gmail under Court Updates and connect with an <b>app password</b> instead.`
        : `<b>Sign in again:</b> ${esc((M.err && M.err.message) || "your email host stopped accepting the saved password.")} <button type="button" class="btn sm" data-connect>Fix</button>`}</div>`;
    }
    if (M.err) return `<div class="mban r">${esc(M.err.message)} <button type="button" class="lk" data-retry>Try again</button></div>`;
    return "";
  }
  function row(m) {
    if (M.court) {
      const isQ = m.kind === "queue";
      return `<button type="button" class="mrow${!isQ && !m.read ? " u" : ""}${String(M.sel) === "c" + m.id ? " on" : ""}" data-cid="${m.id}" data-k="${m.kind}">
        <span class="mfrom">${esc(m.from_addr || "")}</span><span class="mdate">${esc(shortDate(m.received_at))}</span>
        <span class="msub">${esc(m.subject || "(no subject)")}</span><span class="mico">${isQ ? `<span class="tag y">To assign</span>` : `<span class="tag ${TYPE_TAG[m.type] || "n"}">${esc(m.type)}</span>`}</span>
        <span class="mprev">${esc(m.preview || "")}</span></button>`;
    }
    const sentish = ["sent", "drafts"].includes(roleOf(M.folder));
    const name = sentish ? "To: " + (m.to || []).map(who).join(", ") : who(m.from);
    return `<button type="button" class="mrow${m.unread ? " u" : ""}${M.sel === m.id ? " on" : ""}" data-id="${esc(m.id)}">
      <span class="mfrom">${m.draft ? `<span class="mdr">Draft</span> ` : ""}${esc(name || "(no sender)")}</span><span class="mdate">${esc(shortDate(m.date))}</span>
      <span class="msub">${esc(m.subject || "(no subject)")}</span><span class="mico">${m.court ? `<span class="tag n">Court</span>` : ""}${m.important ? `<span class="tag r">!</span>` : ""}${m.att ? ic("clip", 15) : ""}${m.flagged ? `<span class="mflag">${ic("flag", 15, 2)}</span>` : ""}</span>
      <span class="mprev">${esc(m.preview || "")}</span></button>`;
  }
  function listPane() {
    const a = acct(), f = fold(M.folder);
    const title = M.court ? "Court notices" : f ? (f.role ? ROLE_NAME[f.role] || f.name : f.name) : "Mail";
    const ph = M.court ? "Search court notices" : a && a.search === "all" ? "Search all mail" : `Search ${title}`;
    return `<div class="mlh"><div class="mlt"><h2>${esc(title)}</h2><button type="button" class="iconb" data-refresh aria-label="Refresh">${ic("refresh", 18)}</button></div>
        <form class="msrch" role="search"><span aria-hidden="true">${ic("search", 16)}</span><input type="search" id="mxQ" placeholder="${esc(ph)}" value="${esc(M.q)}" aria-label="${esc(ph)}">${M.q ? `<button type="button" class="lk" data-clearq>Clear</button>` : ""}</form></div>
      ${banner()}
      ${M.court && M.queue && M.queue.emails.length ? `<div class="mban y"><b>${M.queue.emails.length} court notice${M.queue.emails.length === 1 ? "" : "s"} to assign</b> — from the shared court inbox. Open one to pick the attorney.</div>` : ""}
      <div class="mlist" id="mxList">${M.items.map(row).join("") || `<div class="mempty">${M.loading ? "Loading…" : M.q ? "Nothing matches." : M.court ? "No court notices yet." : M.acct ? "This folder is empty." : "No email account connected yet."}</div>`}
      ${M.next ? `<button type="button" class="btn ghost mmore" data-more>Load more</button>` : ""}</div>`;
  }
  const emptyReader = () => `<div class="mnone">${ic("mail", 40, 1.3)}<p>Select an email to read it.</p></div>`;

  function paint() {
    const app = $("#app");
    if (!$("#mx")) app.innerHTML = `<div class="mx" id="mx"><aside class="mxf" id="mxF"></aside><section class="mxl" id="mxL" aria-label="Messages"></section><section class="mxr" id="mxR" aria-label="Reading pane"></section></div>`;
    $("#mx").classList.toggle("reading", M.reading);
    $("#mxF").innerHTML = folderPane();
    $("#mxL").innerHTML = (desk() ? "" : phoneBar()) + listPane();
    if (!M.sel && !$("#mxR").dataset.keep) $("#mxR").innerHTML = emptyReader();
    wire();
  }
  function paintList() { const el = $("#mxL"); if (!el) return paint(); const st = $("#mxList") ? $("#mxList").scrollTop : 0; el.innerHTML = (desk() ? "" : phoneBar()) + listPane(); if ($("#mxList")) $("#mxList").scrollTop = st; wire(); }

  function wire() {
    $$("#mx [data-compose]").forEach(b => b.onclick = () => compose({ mode: "new" }));
    $$("#mx [data-connect]").forEach(b => b.onclick = connectSheet);
    $$("#mx [data-court]").forEach(b => b.onclick = () => openCourt());
    $$("#mx [data-f]").forEach(b => b.onclick = () => openFolder(b.dataset.f));
    $$("#mx [data-refresh]").forEach(b => b.onclick = () => refresh(true));
    $$("#mx [data-retry]").forEach(b => b.onclick = () => refresh(true));
    $$("#mx [data-more]").forEach(b => b.onclick = async () => { b.disabled = true; b.textContent = "Loading…"; await loadList(true); paintList(); });
    $$("#mx [data-clearq]").forEach(b => b.onclick = () => { M.q = ""; refresh(); });
    const acctSel = $("#mxAcct") || $("#mxAcctP"); if (acctSel) acctSel.onchange = e => { M.acct = +e.target.value; M.folder = null; M.court = false; M.sel = null; M.reading = false; start(); };
    if ($("#mxFoldP")) $("#mxFoldP").onchange = e => e.target.value === "__court" ? openCourt() : openFolder(e.target.value);
    const f = $("#mx .msrch"); if (f) f.onsubmit = e => { e.preventDefault(); M.q = $("#mxQ").value.trim(); refresh(); };
    $$("#mxList [data-id]").forEach(b => b.onclick = () => openMsg(b.dataset.id));
    $$("#mxList [data-cid]").forEach(b => b.onclick = () => openNotice(b.dataset.cid, b.dataset.k));
  }
  async function refresh(full) {
    M.loading = true; paintList();
    if (full) await loadFolders();
    await loadList(); M.loading = false;
    if (full) paint(); else paintList();
  }
  function openFolder(id) { M.court = false; M.folder = id; M.sel = null; M.q = ""; M.reading = false; $("#mxR").innerHTML = emptyReader(); refresh(); if (!desk()) window.scrollTo(0, 0); $("#mxF").innerHTML = folderPane(); wire(); }
  function openCourt() { M.court = true; M.sel = null; M.q = ""; M.reading = false; if ($("#mxR")) $("#mxR").innerHTML = emptyReader(); refresh(); if ($("#mxF")) { $("#mxF").innerHTML = folderPane(); wire(); } }
  window.mailOpenCourt = () => { M.court = true; M.sel = null; M.reading = false; tab = "inbox"; renderNav(); show(); };
  function back() { M.reading = false; M.sel = null; $("#mx").classList.remove("reading"); paintList(); }

  // ---------- reading pane ----------
  async function openMsg(id) {
    M.sel = id; M.reading = true; $("#mx").classList.add("reading");
    $$("#mxList .mrow").forEach(r => r.classList.toggle("on", r.dataset.id === id));
    const R = $("#mxR"); R.innerHTML = `<div class="mnone"><p>Loading…</p></div>`; if (!desk()) window.scrollTo(0, 0);
    let m; try { m = await api(`/api/mailx/message?acct=${M.acct}&id=${encodeURIComponent(id)}`); } catch (e) { R.innerHTML = `${readerBack()}<div class="mban r" style="margin:16px">${esc(e.message)}</div>`; wireBack(); return; }
    if (M.sel !== id) return;
    M.msg = m;
    const it = M.items.find(x => x.id === id);
    if (it && it.unread) { it.unread = false; const f = fold(M.folder); if (f && f.unread) f.unread--; $("#mxF").innerHTML = folderPane(); wire(); const r = $(`#mxList [data-id="${CSS.escape(id)}"]`); if (r) r.classList.remove("u"); }
    const a = acct(), canAct = a && a.full;
    const ppl = l => (l || []).map(x => `<span title="${esc(x.email)}">${esc(x.name ? `${x.name} <${x.email}>` : x.email)}</span>`).join("; ");
    const isDraft = m.draft || roleOf(M.folder) === "drafts";
    R.innerHTML = `<div class="rd">
      <div class="rbar">${readerBack()}${isDraft ? `<button type="button" class="btn sm" data-r="edit">${ic("edit", 16)}Edit draft</button>` : `
        <button type="button" class="btn sm ghost" data-r="reply">${ic("reply", 16)}<span>Reply</span></button>
        <button type="button" class="btn sm ghost" data-r="replyAll">${ic("replyall", 16)}<span>Reply all</span></button>
        <button type="button" class="btn sm ghost" data-r="forward">${ic("forward", 16)}<span>Forward</span></button>`}
        <button type="button" class="btn sm ghost" data-r="case">${ic("cases", 16)}<span>Save to case</span></button>
        <span class="rsp"></span>
        <button type="button" class="iconb" data-r="delete" aria-label="Delete" title="Delete">${ic("trash", 18)}</button>
        <button type="button" class="iconb" data-r="move" aria-label="Move to folder" title="Move">${ic("folder", 18)}</button>
        <button type="button" class="iconb${m.flagged ? " fl" : ""}" data-r="flag" aria-label="${m.flagged ? "Clear flag" : "Flag"}" title="${m.flagged ? "Clear flag" : "Flag"}">${ic("flag", 18, m.flagged ? 2.4 : 1.75)}</button>
        <button type="button" class="iconb" data-r="unread" aria-label="Mark unread" title="Mark unread">${ic("mail", 18)}</button></div>
      ${canAct ? "" : `<div class="mban" style="margin:0 18px 10px">Reading only — reconnect this account to reply, move or delete.</div>`}
      <h2 class="rsub">${esc(m.subject || "(no subject)")}</h2>
      <div class="rhead"><span class="av" aria-hidden="true">${esc(initials(m.from))}</span>
        <div class="rwho"><div><b>${esc(who(m.from))}</b>${m.from && m.from.name ? ` <span class="mute">&lt;${esc(m.from.email)}&gt;</span>` : ""}</div>
          <div class="mute">To: ${ppl(m.to) || "—"}${m.cc && m.cc.length ? `<br>Cc: ${ppl(m.cc)}` : ""}${m.bcc && m.bcc.length ? `<br>Bcc: ${ppl(m.bcc)}` : ""}</div></div>
        <span class="mute rdt">${esc(longDate(m.date))}</span></div>
      ${m.court ? `<div class="rtags"><span class="tag n">Court email</span> <span class="mute">Court emails also update your cases automatically.</span></div>` : ""}
      ${m.attachments && m.attachments.length ? `<div class="ratt">${m.attachments.map(x => { const viewable = /^image\/(png|jpe?g|gif|webp)$|^application\/pdf$/i.test(x.type) || /\.pdf$/i.test(x.name);
        const href = `/api/mailx/attachment?${qsx({ acct: M.acct, id, att: x.id })}`;
        return `<span class="achip">${ic("clip", 15)}<a href="${esc(href + (viewable ? "&inline=1" : ""))}" target="_blank" rel="noopener" class="an">${esc(x.name)}</a><span class="mute">${kb(x.size)}</span><a href="${esc(href)}" class="lk" download>Download</a></span>`; }).join("")}</div>` : ""}
      ${m.remote && !M.images[id] ? `<div class="rimg">${ic("junk", 15)}Pictures from the web are hidden to protect your privacy. <button type="button" class="lk" data-r="images">Show pictures</button></div>` : ""}
      <iframe class="rframe" title="Email body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" src="/api/mailx/view?${qsx({ acct: M.acct, id, images: M.images[id] ? 1 : null })}"></iframe></div>`;
    wireBack(); fitFrame(R.querySelector(".rframe"));
    const act = (k, fn) => { const b = R.querySelector(`[data-r=${k}]`); if (b) b.onclick = fn; };
    act("reply", () => compose({ mode: "reply", ref: m }));
    act("replyAll", () => compose({ mode: "replyAll", ref: m }));
    act("forward", () => compose({ mode: "forward", ref: m }));
    act("edit", () => editDraft(m));
    act("delete", () => del([id]));
    act("move", () => moveSheet([id]));
    act("flag", async () => { try { await api("/api/mailx/message", { method: "PATCH", body: { acct: M.acct, id, flagged: !m.flagged } }); const it2 = M.items.find(x => x.id === id); if (it2) it2.flagged = !m.flagged; paintList(); openMsg(id); } catch (e) { toast(e.message); } });
    act("unread", async () => { try { await api("/api/mailx/message", { method: "PATCH", body: { acct: M.acct, id, read: false } }); const it2 = M.items.find(x => x.id === id); if (it2) it2.unread = true; const f = fold(M.folder); if (f) f.unread++; back(); $("#mxF").innerHTML = folderPane(); wire(); } catch (e) { toast(e.message); } });
    act("case", () => caseSheet(id, m));
    act("images", () => { M.images[id] = true; openMsg(id); });
  }
  const readerBack = () => `<button type="button" class="btn sm ghost rback" data-back>${ic("back", 16, 2)}Back</button>`;
  function wireBack() { const b = $("#mxR [data-back]"); if (b) b.onclick = back; }
  function fitFrame(fr) {
    if (!fr) return;
    const fit = () => { try { const d = fr.contentDocument; if (!d || !d.documentElement) return; fr.style.height = Math.max(240, d.documentElement.scrollHeight + 4) + "px"; } catch {} };
    fr.addEventListener("load", () => { fit(); try { new ResizeObserver(fit).observe(fr.contentDocument.body); } catch {} setTimeout(fit, 400); });
  }

  // court notices in the reading pane (summary + exact email), and assigning shared-inbox notices
  async function openNotice(cid, kind) {
    M.sel = "c" + cid; M.reading = true; $("#mx").classList.add("reading");
    $$("#mxList .mrow").forEach(r => r.classList.toggle("on", r.dataset.cid === cid));
    const R = $("#mxR"); R.innerHTML = `<div class="mnone"><p>Loading…</p></div>`; if (!desk()) window.scrollTo(0, 0);
    if (kind === "queue") {
      const one = { people: M.queue.people, emails: M.queue.emails.filter(x => String(x.id) === String(cid)) };
      R.innerHTML = `<div class="rd">${readerBack()}<div class="rpad" style="padding-top:14px">${queueCards(one)}</div></div>`; wireBack();
      wireQueue(one, () => { M.sel = null; M.reading = false; R.innerHTML = emptyReader(); countQueue().then(() => refresh()); });
      return;
    }
    let r; try { r = await api(`/api/email-alerts/${cid}`); } catch (e) { R.innerHTML = `${readerBack()}<div class="mban r" style="margin:16px">${esc(e.message)}</div>`; wireBack(); return; }
    const m = r.email, sm = r.summary;
    const it = M.items.find(x => String(x.id) === String(cid) && x.kind === "notice"); if (it && !it.read) { it.read = true; inboxUnread = Math.max(0, inboxUnread - 1); renderNav(); }
    R.innerHTML = `<div class="rd">${readerBack()}<h2 class="rsub">${esc(m.subject || "(no subject)")}</h2>
      <div class="rhead"><span class="av" aria-hidden="true">${ic("court", 16)}</span><div class="rwho"><b class="brk">${esc(m.from_addr)}</b><div class="mute"><span class="tag ${TYPE_TAG[sm.type] || "n"}">${esc(sm.type)}</span></div></div><span class="mute rdt">${esc(longDate(m.received_at))}</span></div>
      <div class="rpad"><div class="card" style="margin:0 0 12px"><h3 style="margin-top:0">Summary</h3>
        ${sm.action ? `<p style="margin:6px 0"><b>${esc(sm.action)}</b></p>` : ""}
        ${sm.cases.length ? `<div style="margin:6px 0"><b>Cases:</b> ${sm.cases.map(c => c.case ? `<button type="button" class="lk" data-case="${c.case.id}">${esc(c.cause_no)} · ${esc(c.case.style || "")}</button>` : `${esc(c.cause_no)} <span class="mute">(not in your cases)</span>`).join(", ")}</div>` : ""}
        ${sm.dates.length ? `<div style="margin:6px 0"><b>Dates:</b> ${sm.dates.map(esc).join(" · ")}</div>` : ""}
        ${sm.lines.length ? `<ul style="padding-left:18px;margin:6px 0">${sm.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="mute">No key lines found — see the exact email below.</p>`}
        ${sm.links.length ? `<div style="margin:6px 0"><b>Links:</b><br>${sm.links.map(u => `<a class="link brk" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.length > 70 ? u.slice(0, 70) + "…" : u)}</a>`).join("<br>")}</div>` : ""}
        <p class="mute" style="margin-bottom:0;font-size:12px">Summary is pulled from the email automatically — check the exact email before relying on it.</p></div>
        <h3>Exact email</h3></div>
      ${m.html ? `<iframe class="rframe" title="Email body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>` : `<div class="rpad"><div class="optext">${esc(m.body || "(empty)")}</div></div>`}</div>`;
    wireBack();
    const fr = R.querySelector(".rframe");
    if (fr) { fitFrame(fr); fr.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{margin:0;padding:14px 18px;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1d2433;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` + m.html; }
    $$("#mxR [data-case]").forEach(b => b.onclick = () => window.caseHub && caseHub(+b.dataset.case));
  }
  async function countQueue() { if (!me.court_handler) { M.queueCount = 0; return; } try { M.queueCount = (await api("/api/court-queue")).emails.length; } catch { M.queueCount = 0; } }

  // ---------- actions ----------
  async function del(ids) {
    try { const r = await api("/api/mailx/delete", { method: "POST", body: { acct: M.acct, ids, folder: M.folder } });
      toast(r.permanent ? "Deleted for good" : "Moved to Deleted");
      M.items = M.items.filter(x => !ids.includes(x.id)); M.sel = null; M.reading = false; $("#mxR").innerHTML = emptyReader(); $("#mx").classList.remove("reading");
      await loadFolders(); paint();
    } catch (e) { toast(e.message); }
  }
  function moveSheet(ids) {
    const list = M.folders.filter(f => f.id !== M.folder);
    openSheet("Move to folder", `<div class="mvl">${list.map(f => `<button type="button" class="mfold" data-mv="${esc(f.id)}" style="padding-left:${12 + (f.depth || 0) * 16}px">${ic(ROLE_ICON[f.role] || "folder", 17)}<span class="mfn">${esc(f.role ? (ROLE_NAME[f.role] || f.name) : f.name)}</span></button>`).join("")}</div>`, sh => {
      sh.querySelectorAll("[data-mv]").forEach(b => b.onclick = async () => {
        try { await api("/api/mailx/move", { method: "POST", body: { acct: M.acct, ids, folder: b.dataset.mv } }); closeSheet(); toast("Moved to " + b.textContent.trim());
          M.items = M.items.filter(x => !ids.includes(x.id)); M.sel = null; M.reading = false; $("#mxR").innerHTML = emptyReader(); $("#mx").classList.remove("reading"); await loadFolders(); paint(); }
        catch (e) { toast(e.message); }
      });
    });
  }
  async function caseSheet(id, m) {
    let cs = []; try { cs = (await api("/api/cases?view=firm")).cases; } catch (e) { return toast(e.message); }
    const opt = c => `<option value="${c.id}">${esc(c.cause_no)} · ${esc((c.style || "").slice(0, 60))}</option>`;
    openSheet("Save to a case", `<label for="scQ">Find the case</label><input id="scQ" placeholder="Cause # or name">
      <label for="scC">Case</label><select id="scC" size="6" style="min-height:150px">${cs.map(opt).join("")}</select>
      <fieldset class="chk" style="border:0;padding:0;margin:6px 0 0;flex-direction:column"><legend class="mute" style="font-size:13px;padding:0">Save</legend>
        <label class="ck"><input type="checkbox" id="scE" checked>The email itself (.eml)</label>
        ${(m.attachments || []).map(x => `<label class="ck brk"><input type="checkbox" data-sa="${esc(x.id)}" checked>${esc(x.name)} <span class="mute">${kb(x.size)}</span></label>`).join("")}</fieldset>
      <div class="err" id="scErr"></div><button type="button" class="btn" id="scGo">Save to case</button>`, sh => {
      const q = sh.querySelector("#scQ"), sel = sh.querySelector("#scC");
      q.oninput = () => { const v = q.value.toLowerCase(); sel.innerHTML = cs.filter(c => !v || `${c.cause_no} ${c.style || ""}`.toLowerCase().includes(v)).map(opt).join(""); };
      sh.querySelector("#scGo").onclick = async () => {
        if (!sel.value) { sh.querySelector("#scErr").textContent = "Pick the case."; return; }
        const b = sh.querySelector("#scGo"); b.disabled = true; b.textContent = "Saving…";
        try { const r = await api("/api/mailx/save-to-case", { method: "POST", body: { acct: M.acct, id, case: +sel.value, email: sh.querySelector("#scE").checked, atts: [...sh.querySelectorAll("[data-sa]:checked")].map(x => x.dataset.sa) } });
          closeSheet(); toast(`Saved ${r.saved.length} file${r.saved.length === 1 ? "" : "s"} to ${r.case.cause_no}`); }
        catch (e) { sh.querySelector("#scErr").textContent = e.message; b.disabled = false; b.textContent = "Save to case"; }
      };
    });
  }
  async function connectSheet() {
    let mb; try { mb = await api("/api/mail"); } catch (e) { return toast(e.message); }
    const list = mb.mailboxes.map(x => `<div class="row" style="justify-content:space-between;border-top:1px solid var(--line);padding:8px 0"><span class="brk"><b>${esc(x.email || mb.names[x.provider])}</b><br><span class="mute">${esc(mb.names[x.provider] || x.provider)} · ${esc(x.status)}</span></span><button type="button" class="btn sm danger" data-dis="${x.id}">Disconnect</button></div>`).join("");
    openSheet("Email accounts", `${list ? `<div>${list}</div>` : `<p class="mute" style="margin:0">Sign in once with your work email. You'll see all of it here, and court emails keep updating your cases.</p>`}
      ${mb.configured.microsoft ? `<a class="btn" href="/api/mail/connect/microsoft" style="display:block;text-align:center;text-decoration:none;padding:12px">Sign in with Outlook / Microsoft 365</a>` : ""}
      ${imapForm(mb, !mb.configured.microsoft)}`, sh => {
      wireImap(() => { closeSheet(); M.accounts = null; start(); });
      sh.querySelectorAll("[data-dis]").forEach(b => b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = "Tap again"; return; } await api(`/api/mail/${b.dataset.dis}`, { method: "DELETE" }); closeSheet(); M.accounts = null; M.acct = null; start(); });
    });
  }

  // ---------- compose (new, reply, reply all, forward, drafts) ----------
  const parseAddr = s => { s = String(s || "").trim().replace(/[;,]$/, ""); if (!s) return null; const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/); const email = (m ? m[2] : s).trim().toLowerCase(), name = m ? m[1].trim() : "";
    return /^[^@\s<>"(),;:]+@[^@\s<>"(),;:]+\.[^@\s<>"(),;:]+$/.test(email) ? { name, email } : { name, email, bad: true }; };
  let contactList = null;
  async function contacts() { if (!contactList) { try { contactList = (await api("/api/contacts")).contacts.filter(c => c.email).map(c => ({ name: c.name, email: c.email })); } catch { contactList = []; } } return contactList; }
  function signature() {
    const lines = [me.name, me.title, me.firm_name, me.phone, me.email].filter(Boolean);
    return `<br><br><div class="sig">${lines.map((l, i) => i === 0 ? `<b>${esc(l)}</b>` : esc(l)).join("<br>")}</div>`;
  }
  function compose({ mode, ref, draft }) {
    const a = acct();
    if (!a) return connectSheet();
    if (!a.full) return toast("Reconnect this account first (see the note at the top of the list).");
    const self = String(a.email || "").toLowerCase();
    let to = [], cc = [], bcc = [], subject = "";
    if (ref && mode !== "forward") {
      const base = ref.replyTo && ref.replyTo.length ? ref.replyTo : ref.from ? [ref.from] : [];
      to = base.slice();
      if (mode === "replyAll") { to = to.concat(ref.to || []); cc = (ref.cc || []).slice(); }
      const seen = new Set(); const uniq = l => l.filter(x => x && x.email && x.email !== self && !seen.has(x.email) && seen.add(x.email));
      to = uniq(to); cc = uniq(cc);
      subject = /^re:/i.test(ref.subject || "") ? ref.subject : "RE: " + (ref.subject || "");
    } else if (ref && mode === "forward") subject = /^fw:|^fwd:/i.test(ref.subject || "") ? ref.subject : "FW: " + (ref.subject || "");
    if (draft) { to = draft.to || []; cc = draft.cc || []; bcc = draft.bcc || []; subject = draft.subject || ""; }
    const ttl = draft ? "Draft" : { new: "New email", reply: "Reply", replyAll: "Reply all", forward: "Forward" }[mode];
    closeCompose();
    const box = document.createElement("div"); box.className = "cmp"; box.id = "cmp"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", ttl);
    const field = (k, lab, hidden) => `<div class="frow"${hidden ? " hidden" : ""} data-row="${k}"><label for="cf_${k}">${lab}</label><div class="chipin" data-f="${k}"><input id="cf_${k}" list="cfPeople" autocomplete="off" inputmode="email"></div>${k === "to" ? `<button type="button" class="lk" data-ccbcc>Cc Bcc</button>` : ""}</div>`;
    box.innerHTML = `<div class="cmph"><b>${esc(ttl)}</b><span class="mute brk">${esc(a.email)}</span><button type="button" class="iconb" data-x aria-label="Close">${ic("close", 20, 2)}</button></div>
      <div class="cmpb">${field("to", "To")}${field("cc", "Cc", !cc.length)}${field("bcc", "Bcc", !bcc.length)}
        <div class="frow"><label for="cfSub">Subject</label><input id="cfSub" value="${esc(subject)}"></div>
        <div class="tbx" role="toolbar" aria-label="Formatting"><button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button><button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button><button type="button" data-cmd="underline" aria-label="Underline"><u>U</u></button>
          <button type="button" data-cmd="insertUnorderedList" aria-label="Bulleted list">• List</button><button type="button" data-cmd="insertOrderedList" aria-label="Numbered list">1. List</button><button type="button" data-cmd="link" aria-label="Add link">Link</button><button type="button" data-cmd="removeFormat" aria-label="Clear formatting">Clear</button></div>
        <div class="ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message"></div>
        ${ref && !draft ? `<p class="mute cnote">${mode === "forward" ? "The original email and its attachments are included below your message." : "The original email is included below your message."}</p>` : ""}
        <div class="atts" id="cfAtts"></div></div>
      <div class="cmpf"><button type="button" class="btn" data-send>${ic("send", 16)}Send</button><label class="btn ghost" style="cursor:pointer">${ic("clip", 16)}Attach<input type="file" multiple hidden id="cfFile"></label>
        <button type="button" class="btn ghost" data-save>Save draft</button><button type="button" class="lk" data-discard>Discard</button><div class="err" id="cfErr"></div></div>
      <datalist id="cfPeople"></datalist>`;
    document.body.appendChild(box); document.body.classList.add("composing");
    const ed = box.querySelector(".ed");
    ed.innerHTML = draft ? (draft.body || "") : signature();
    const files = [];   // {token,name,size}
    const lists = { to, cc, bcc };
    const drawChips = k => { const w = box.querySelector(`[data-f=${k}]`), inp = w.querySelector("input"); w.querySelectorAll(".ch").forEach(x => x.remove());
      lists[k].forEach((p, i) => { const s = document.createElement("span"); s.className = "ch" + (p.bad ? " bad" : ""); s.title = p.email; s.innerHTML = `${esc(p.name || p.email)}<button type="button" aria-label="Remove ${esc(p.email)}">×</button>`; s.querySelector("button").onclick = () => { lists[k].splice(i, 1); drawChips(k); }; w.insertBefore(s, inp); }); };
    const take = (k, txt) => { String(txt).split(/[;,\n]+/).map(parseAddr).filter(Boolean).forEach(p => { if (!lists[k].some(x => x.email === p.email)) lists[k].push(p); }); drawChips(k); };
    ["to", "cc", "bcc"].forEach(k => { drawChips(k); const inp = box.querySelector(`#cf_${k}`);
      inp.onkeydown = e => { if (["Enter", ",", ";", "Tab"].includes(e.key) && inp.value.trim()) { e.preventDefault(); take(k, inp.value); inp.value = ""; } else if (e.key === "Backspace" && !inp.value && lists[k].length) { lists[k].pop(); drawChips(k); } };
      inp.onblur = () => { if (inp.value.trim()) { take(k, inp.value); inp.value = ""; } };
      inp.onpaste = e => { const t = (e.clipboardData || window.clipboardData).getData("text"); if (/[;,\n]/.test(t)) { e.preventDefault(); take(k, t); } };
      box.querySelector(`[data-f=${k}]`).onclick = e => { if (e.target === e.currentTarget) inp.focus(); }; });
    contacts().then(cs => { box.querySelector("#cfPeople").innerHTML = cs.map(c => `<option value="${esc(c.name ? `${c.name} <${c.email}>` : c.email)}">`).join(""); });
    box.querySelector("[data-ccbcc]").onclick = () => { box.querySelector("[data-row=cc]").hidden = false; box.querySelector("[data-row=bcc]").hidden = false; box.querySelector("#cf_cc").focus(); };
    box.querySelectorAll("[data-cmd]").forEach(b => b.onmousedown = e => { e.preventDefault(); const c = b.dataset.cmd;
      if (c === "link") { const u = prompt("Link address (https://…)"); if (u && /^(https?:|mailto:)/i.test(u.trim())) document.execCommand("createLink", false, u.trim()); }
      else document.execCommand(c, false, null); ed.focus(); });
    const drawFiles = () => { box.querySelector("#cfAtts").innerHTML = files.map((f, i) => `<span class="achip">${ic("clip", 15)}<span class="an">${esc(f.name)}</span><span class="mute">${f.token ? kb(f.size) : "Uploading…"}</span><button type="button" class="lk" data-rm="${i}" aria-label="Remove ${esc(f.name)}">Remove</button></span>`).join("");
      box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { files.splice(+b.dataset.rm, 1); drawFiles(); }); };
    box.querySelector("#cfFile").onchange = async e => {
      for (const file of [...e.target.files]) {
        const total = files.reduce((s, f) => s + f.size, 0) + file.size;
        if (total > 25 * 1024 * 1024) { toast("Attachments can be 25 MB in all."); break; }
        const f = { name: file.name, size: file.size, token: null }; files.push(f); drawFiles();
        try { const r = await fetch("/api/mailx/upload", { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "tcd", "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name), "X-File-Type": file.type || "application/octet-stream" }, body: file });
          const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || "Upload failed"); f.token = j.token; }
        catch (x) { files.splice(files.indexOf(f), 1); toast(`${file.name}: ${x.message}`); }
        drawFiles();
      }
      e.target.value = "";
    };
    const sendIt = async asDraft => {
      ["to", "cc", "bcc"].forEach(k => { const inp = box.querySelector(`#cf_${k}`); if (inp.value.trim()) { take(k, inp.value); inp.value = ""; } });
      const er = box.querySelector("#cfErr"); er.textContent = "";
      const bad = [...lists.to, ...lists.cc, ...lists.bcc].find(p => p.bad); if (bad) { er.textContent = `"${bad.email}" isn't an email address.`; return; }
      if (!asDraft && !lists.to.length && !lists.cc.length && !lists.bcc.length) { er.textContent = "Add who it's to."; box.querySelector("#cf_to").focus(); return; }
      if (files.some(f => !f.token)) { er.textContent = "Wait for the attachments to finish uploading."; return; }
      if (!asDraft && !box.querySelector("#cfSub").value.trim() && !confirm("Send without a subject?")) return;
      const btn = box.querySelector(asDraft ? "[data-save]" : "[data-send]"); btn.disabled = true; const t0 = btn.innerHTML; btn.textContent = asDraft ? "Saving…" : "Sending…";
      try {
        await api("/api/mailx/send", { method: "POST", body: { acct: M.acct, mode: draft ? "new" : mode, ref: ref && !draft ? ref.id : null, draftId: draft ? draft.id : null, draft: asDraft,
          to: lists.to, cc: lists.cc, bcc: lists.bcc, subject: box.querySelector("#cfSub").value, html: ed.innerHTML, atts: files.map(f => f.token) } });
        closeCompose(true); toast(asDraft ? "Saved to Drafts" : "Sent");
        if (["sent", "drafts"].includes(roleOf(M.folder)) || draft) { await loadFolders(); await loadList(); paint(); } else { loadFolders().then(() => { if ($("#mxF")) { $("#mxF").innerHTML = folderPane(); wire(); } }); }
      } catch (x) { er.textContent = x.message; btn.disabled = false; btn.innerHTML = t0; }
    };
    box.querySelector("[data-send]").onclick = () => sendIt(false);
    box.querySelector("[data-save]").onclick = () => sendIt(true);
    const dirty = () => lists.to.length || lists.cc.length || box.querySelector("#cfSub").value.trim() !== subject.trim() || ed.innerText.trim().length > (draft ? 0 : signature().replace(/<[^>]+>/g, "").trim().length + 2) || files.length;
    box.querySelector("[data-discard]").onclick = () => { if (dirty() && !confirm("Discard this email?")) return; closeCompose(true); };
    box.querySelector("[data-x]").onclick = () => { if (dirty() && !draft && confirm("Save it to Drafts before closing?")) return sendIt(true); closeCompose(true); };
    box.onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendIt(false); } if (e.key === "Escape") box.querySelector("[data-x]").click(); };
    setTimeout(() => (to.length ? ed : box.querySelector("#cf_to")).focus(), 30);
  }
  function closeCompose() { const c = $("#cmp"); if (c) c.remove(); document.body.classList.remove("composing"); }
  async function editDraft(m) {
    let full; try { full = await api(`/api/mailx/message?acct=${M.acct}&id=${encodeURIComponent(m.id)}&body=1&peek=1`); } catch (e) { return toast(e.message); }
    compose({ mode: "new", draft: { id: m.id, to: full.to, cc: full.cc, bcc: full.bcc, subject: full.subject, body: full.body } });
  }

  // ---------- view ----------
  async function start() {
    document.body.classList.add("mailmode");
    $("#app").innerHTML = `<div class="card mute">Loading mail…</div>`;
    try { if (!M.accounts) await loadAccounts(); } catch (e) { return fail(e); }
    await Promise.all([loadFolders(), countQueue()]);
    M.loading = true; paint(); await loadList(); M.loading = false;
    if (tab !== "inbox") return;
    paint();
    if (M.sel && !M.court) openMsg(M.sel); else if (desk() && M.reading) M.reading = false;
  }
  VIEWS.inbox = function mailView() { M.sel = null; M.reading = false; $("#app").innerHTML = ""; return start(); };
  // leaving Mail: drop the full-width layout
  const _show = show;
  show = function () { document.body.classList.remove("mailmode"); closeCompose(); return _show.apply(this, arguments); };
  window.mailRefresh = async () => {
    if (tab !== "inbox" || $("#cmp") || !$("#mx")) return;
    await Promise.all([M.acct ? loadFolders() : null, countQueue()]);
    if (!M.next || M.court) { await loadList(); paintList(); }
    if ($("#mxF")) { $("#mxF").innerHTML = folderPane(); wire(); }
  };
  addEventListener("keydown", e => {
    if (tab !== "inbox" || $("#cmp") || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "") || !M.sel || M.court) return;
    if (e.key === "Delete") del([M.sel]);
  });
  let lastDesk = desk();
  addEventListener("resize", () => { const d = desk(); if (d !== lastDesk && tab === "inbox" && $("#mx")) { lastDesk = d; paintList(); } });
})();
