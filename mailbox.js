// Full mail client (works like Outlook) for each person's connected mailbox.
// Outlook / Microsoft 365 goes through Microsoft Graph; Titan, GoDaddy, Gmail (app password), Yahoo, Zoho,
// iCloud and other hosts go through IMAP (reading) + SMTP (sending).
// Mail is read live from the provider every time. Nothing is stored here except a few minutes of
// in-memory cache so an open email's body and attachments don't have to be downloaded twice.
const crypto = require("crypto");
const express = require("express");
const cheerio = require("cheerio");
const { q } = require("./db");
const box = require("./crypto-box");
const mail = require("./mail");
const access = require("./access");

const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE = 40;
const MAX_TOTAL = 25 * 1024 * 1024;           // attachments per email
const fail = (msg, extra) => Object.assign(new Error(msg), extra || {});
const enc = encodeURIComponent;
const addr = a => a && (a.address || a.email) ? { name: String(a.name || "").trim(), email: String(a.address || a.email).trim().toLowerCase() } : null;
const isCourt = (from, subject) => mail.COURT_SENDER.test(`${from || ""} ${subject || ""}`);
const iso = d => { const t = new Date(d || 0); return isNaN(t) ? null : t.toISOString(); };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const REMOTE_IMG = /<img[^>]+src\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:|background\s*=\s*["']?\s*https?:/i;

// ---------- small caches ----------
// An open email is kept a few minutes so its body and attachments aren't downloaded twice. Keyed by mailbox AND
// its saved sign-in (a reconnect with another account never sees the old cache), capped in size, purged on a timer.
const ver = mb => crypto.createHash("sha1").update(String(mb.enc_refresh || "") + "|" + (mb.email || "")).digest("hex").slice(0, 10);
const ck = (mb, id) => `${mb.id}:${ver(mb)}|${id}`;
const msgCache = new Map();        // key -> { at, m, size }
const CACHE_TTL = 5 * 60e3, CACHE_MAX = 60 * 1024 * 1024, CACHE_ONE = 15 * 1024 * 1024;
let cacheBytes = 0;
const sizeOf = m => String(m.html || "").length + String(m.text || "").length + (m._atts || []).reduce((t, a) => t + (a.content ? a.content.length : 0), 0);
function cacheDel(key) { const e = msgCache.get(key); if (e) { cacheBytes -= e.size; msgCache.delete(key); } }
function cacheGet(mb, id) { const k = ck(mb, id), e = msgCache.get(k); if (!e) return null; if (Date.now() - e.at > CACHE_TTL) { cacheDel(k); return null; } return e.m; }
function cachePut(mb, id, m) {
  const k = ck(mb, id), size = sizeOf(m); cacheDel(k);
  if (size > CACHE_ONE) return;                    // very large emails aren't kept
  msgCache.set(k, { at: Date.now(), m, size }); cacheBytes += size;
  while (msgCache.size && (cacheBytes > CACHE_MAX || msgCache.size > 40)) cacheDel(msgCache.keys().next().value);
}
function cacheDrop(mb, id) { cacheDel(ck(mb, id)); }
setInterval(() => { const now = Date.now(); for (const [k, e] of msgCache) if (now - e.at > CACHE_TTL) cacheDel(k); }, 60e3).unref();
const folderCache = new Map();     // mbId -> { at, list }

// attachments the person uploaded for an email they're writing (kept in memory for an hour)
const uploads = new Map();         // token -> { userId, name, type, data, exp }
function sweepUploads() { const now = Date.now(); for (const [k, v] of uploads) if (v.exp < now) uploads.delete(k); }
setInterval(sweepUploads, 10 * 60e3).unref();

// your own mailboxes, plus the firm's shared court inbox if you're one of the people who assign court notices
const handler = u => u.role === "admin" || !!u.court_handler;
async function loadBox(user, id) {
  const { rows } = await q(`SELECT m.*, u.firm_id, u.name AS user_name FROM mailboxes m JOIN users u ON u.id=m.user_id
    WHERE m.id=$1 AND ((m.user_id=$2 AND m.shared_firm IS NULL) OR (m.shared_firm=$3 AND $4))`, [+id || 0, user.id, user.firm_id, handler(user)]);
  if (!rows[0]) throw fail("That mailbox isn't connected.", { status: 404 });
  return rows[0];
}
const msScopes = mb => mb.scope_got || mb.scope_req || "";
const msFull = mb => /Mail\.ReadWrite/i.test(msScopes(mb)) && /Mail\.Send/i.test(msScopes(mb));
async function markReconnect(mb, why) {
  await q("UPDATE mailboxes SET status='reconnect', last_error=$2 WHERE id=$1", [mb.id, why]).catch(() => {});
}

// ======================================================================
// Microsoft Graph (Outlook / Microsoft 365)
// ======================================================================
async function gfetch(mb, path, { method = "GET", body, raw, headers = {} } = {}) {
  const url = path.startsWith("https://") ? path : GRAPH + path;
  if (!url.startsWith(GRAPH + "/")) throw fail("Bad link.", { status: 400 });
  for (let attempt = 0; attempt < 2; attempt++) {
    let token;
    try { token = await mail.accessToken(mb); }
    catch (e) { await markReconnect(mb, e.message); throw fail("Outlook sign-in expired — reconnect Outlook.", { reconnect: true, status: 409 }); }
    const json = body !== undefined && !Buffer.isBuffer(body);
    const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : json ? JSON.stringify(body) : body, signal: AbortSignal.timeout(60000) });
    if (r.status === 401 && attempt === 0) { mb.enc_access = null; continue; }        // token went stale — refresh once
    if (r.status === 401) { await markReconnect(mb, "401 from Microsoft"); throw fail("Outlook sign-in expired — reconnect Outlook.", { reconnect: true, status: 409 }); }
    if (r.status === 403) throw msFull(mb) ? fail("Microsoft didn't allow that for this mailbox.", { status: 403 })
      : fail("Reconnect Outlook once to turn on full mail (organize and send).", { reconnect: true, status: 409 });
    if (r.status === 404) throw fail("That email isn't there anymore — it may have been moved or deleted in Outlook.", { status: 404 });
    if (r.status === 429 || r.status === 503 || r.status === 504) throw fail("Microsoft is busy — try again in a minute.", { status: 503 });
    if (!r.ok) {
      const t = await r.text().catch(() => ""); let m = ""; try { m = JSON.parse(t).error?.message || ""; } catch {}
      throw fail(`Outlook error ${r.status}${m ? ": " + m.slice(0, 160) : ""}`, { status: 502 });
    }
    if (raw) return Buffer.from(await r.arrayBuffer());
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
}

const MS_ROLES = { inbox: "inbox", drafts: "drafts", sentitems: "sent", deleteditems: "deleted", junkemail: "junk", archive: "archive" };
const roleCache = new Map();
async function msRoles(mb) {
  const c = roleCache.get(mb.id); if (c && Date.now() - c.at < 30 * 60e3) return c.map;
  const keys = Object.keys(MS_ROLES);
  const j = await gfetch(mb, "/$batch", { method: "POST", body: { requests: keys.map((k, i) => ({ id: String(i), method: "GET", url: `/me/mailFolders/${k}?$select=id` })) } });
  const map = {};
  for (const r of j?.responses || []) if (r.status === 200 && r.body?.id) map[r.body.id] = MS_ROLES[keys[+r.id]];
  roleCache.set(mb.id, { at: Date.now(), map }); return map;
}
const MS_HIDE = /^(outbox|sync issues|conversation history|rss feeds|rss subscriptions|yammer root|social activity notifications|files|externalcontacts|quick step settings)$/i;
const MSEL = "id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,flag,hasAttachments,bodyPreview,parentFolderId,isDraft,importance";
const msRow = m => {
  const from = addr(m.from?.emailAddress);
  return { id: m.id, folder: m.parentFolderId || null, from, to: (m.toRecipients || []).map(r => addr(r.emailAddress)).filter(Boolean),
    subject: m.subject || "", preview: String(m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 180), date: iso(m.isDraft ? (m.sentDateTime || m.receivedDateTime) : m.receivedDateTime),
    unread: m.isRead === false, flagged: m.flag?.flagStatus === "flagged", att: !!m.hasAttachments, draft: !!m.isDraft, important: m.importance === "high",
    court: isCourt(from?.email, m.subject) };
};
const rc = list => (list || []).map(a => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } }));
function mergeBody(mine, quoted) {
  const i = String(quoted || "").search(/<body[^>]*>/i);
  if (i < 0) return mine + (quoted || "");
  const end = quoted.indexOf(">", i) + 1;
  return quoted.slice(0, end) + mine + quoted.slice(end);
}

const MS = {
  async folders(mb) {
    const sel = "$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount,parentFolderId&$top=250";
    const [roles, top] = await Promise.all([msRoles(mb), gfetch(mb, `/me/mailFolders?${sel}`)]);
    const all = [], seen = new Set();
    const add = (f, depth) => { if (MS_HIDE.test(f.displayName || "") || seen.has(f.id)) return; seen.add(f.id);
      all.push({ id: f.id, name: f.displayName || "Folder", role: roles[f.id] || null, unread: f.unreadItemCount || 0, total: f.totalItemCount || 0, depth, parent: depth ? f.parentFolderId : null }); };
    for (const f of top?.value || []) add(f, 0);
    const parents = (top?.value || []).filter(f => f.childFolderCount > 0 && !MS_HIDE.test(f.displayName || "")).slice(0, 15);
    const kids = await Promise.all(parents.map(p => gfetch(mb, `/me/mailFolders/${enc(p.id)}/childFolders?${sel}`).catch(() => ({ value: [] }))));
    kids.forEach(k => (k?.value || []).forEach(f => add(f, 1)));
    return all;
  },
  async list(mb, { folder, search, cursor }) {
    let url;
    if (cursor) url = cursor;                                     // Microsoft's own "next page" link
    else if (search) url = `/me/messages?$search=${enc(`"${search.replace(/["\\]/g, " ")}"`)}&$top=${PAGE}&$select=${MSEL}`;
    else url = `/me/mailFolders/${enc(folder || "inbox")}/messages?$top=${PAGE}&$select=${MSEL}&$orderby=receivedDateTime desc`;
    const j = await gfetch(mb, url);
    return { items: (j?.value || []).map(msRow), next: j?.["@odata.nextLink"] || null };
  },
  async get(mb, id, { markRead = true } = {}) {
    const hit = cacheGet(mb, id); if (hit) return hit;
    const m = await gfetch(mb, `/me/messages/${enc(id)}?$select=${MSEL},ccRecipients,bccRecipients,replyTo,body,internetMessageId`, { headers: { Prefer: 'outlook.body-content-type="html"' } });
    let atts = [];
    const html = m.body?.contentType === "html" ? m.body.content || "" : null;
    if (m.hasAttachments || (html && /cid:/i.test(html))) {
      const a = await gfetch(mb, `/me/messages/${enc(id)}/attachments?$select=id,name,contentType,size,isInline`);
      atts = (a?.value || []).map(x => ({ id: x.id, name: x.name || "attachment", type: x.contentType || "", size: x.size || 0, inline: !!x.isInline }));
    }
    if (markRead && m.isRead === false && msFull(mb)) { await gfetch(mb, `/me/messages/${enc(id)}`, { method: "PATCH", body: { isRead: true } }).catch(() => {}); m.isRead = true; }
    const out = { ...msRow(m), cc: (m.ccRecipients || []).map(r => addr(r.emailAddress)).filter(Boolean), bcc: (m.bccRecipients || []).map(r => addr(r.emailAddress)).filter(Boolean),
      replyTo: (m.replyTo || []).map(r => addr(r.emailAddress)).filter(Boolean), html, text: html == null ? m.body?.content || "" : null,
      attachments: atts.filter(a => !a.inline), inlineAtts: atts.filter(a => a.inline), messageId: m.internetMessageId || null };
    cachePut(mb, id, out); return out;
  },
  async inline(mb, id, m) {
    const map = {};
    if (!m.html || !/cid:/i.test(m.html)) return map;
    for (const a of (m.inlineAtts || []).filter(x => x.size < 3e6).slice(0, 20)) {
      const f = await gfetch(mb, `/me/messages/${enc(id)}/attachments/${enc(a.id)}`).catch(() => null);
      if (f?.contentId && f.contentBytes && /^image\//i.test(f.contentType || "")) map[String(f.contentId).replace(/^<|>$/g, "").toLowerCase()] = `data:${f.contentType};base64,${f.contentBytes}`;
    }
    return map;
  },
  async attachment(mb, id, attId) {
    const meta = await gfetch(mb, `/me/messages/${enc(id)}/attachments/${enc(attId)}?$select=name,contentType,size`);
    const data = await gfetch(mb, `/me/messages/${enc(id)}/attachments/${enc(attId)}/$value`, { raw: true });
    return { name: meta?.name || "attachment", type: meta?.contentType || "application/octet-stream", data };
  },
  async source(mb, id) { return gfetch(mb, `/me/messages/${enc(id)}/$value`, { raw: true }); },
  async flags(mb, id, { read, flagged }) {
    const body = {};
    if (read !== undefined) body.isRead = !!read;
    if (flagged !== undefined) body.flag = { flagStatus: flagged ? "flagged" : "notFlagged" };
    await gfetch(mb, `/me/messages/${enc(id)}`, { method: "PATCH", body }); cacheDrop(mb, id);
  },
  async move(mb, ids, dest) {
    for (const id of ids) { await gfetch(mb, `/me/messages/${enc(id)}/move`, { method: "POST", body: { destinationId: dest } }); cacheDrop(mb, id); }
  },
  async remove(mb, ids) {
    const roles = await msRoles(mb);
    let permanent = false;
    for (const id of ids) {
      // decide by the folder the email is actually in (a search can show emails from any folder)
      const where = await gfetch(mb, `/me/messages/${enc(id)}?$select=parentFolderId`);
      if (roles[where?.parentFolderId] === "deleted") { permanent = true; await gfetch(mb, `/me/messages/${enc(id)}`, { method: "DELETE" }); }
      else await gfetch(mb, `/me/messages/${enc(id)}/move`, { method: "POST", body: { destinationId: "deleteditems" } });
      cacheDrop(mb, id);
    }
    return { permanent };
  },
  async attach(mb, msgId, f) {
    if (f.data.length < 3 * 1024 * 1024)
      return gfetch(mb, `/me/messages/${enc(msgId)}/attachments`, { method: "POST", body: { "@odata.type": "#microsoft.graph.fileAttachment", name: f.name, contentType: f.type || "application/octet-stream", contentBytes: f.data.toString("base64") } });
    // bigger files: upload session in ~3.75 MB pieces (Microsoft's pre-signed link takes no sign-in header)
    const s = await gfetch(mb, `/me/messages/${enc(msgId)}/attachments/createUploadSession`, { method: "POST", body: { AttachmentItem: { attachmentType: "file", name: f.name, size: f.data.length } } });
    const CH = 12 * 327680;
    for (let start = 0; start < f.data.length; start += CH) {
      const part = f.data.subarray(start, Math.min(start + CH, f.data.length));
      const r = await fetch(s.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${start + part.length - 1}/${f.data.length}` }, body: part, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw fail(`Couldn't upload ${f.name} to Outlook (${r.status}).`, { status: 502 });
    }
  },
  async send(mb, { mode, ref, to, cc, bcc, subject, html, files, draftOnly, draftId }) {
    const fields = { subject, toRecipients: rc(to), ccRecipients: rc(cc), bccRecipients: rc(bcc) };
    let id;
    if (draftId) { id = draftId; await gfetch(mb, `/me/messages/${enc(id)}`, { method: "PATCH", body: { ...fields, body: { contentType: "HTML", content: html } } }); cacheDrop(mb, draftId); }
    else if (ref && ["reply", "replyAll", "forward"].includes(mode)) {
      const act = { reply: "createReply", replyAll: "createReplyAll", forward: "createForward" }[mode];
      const d = await gfetch(mb, `/me/messages/${enc(ref)}/${act}`, { method: "POST", body: {} });
      id = d.id;
      await gfetch(mb, `/me/messages/${enc(id)}`, { method: "PATCH", body: { ...fields, body: { contentType: "HTML", content: mergeBody(html, d.body?.content || "") } } });
    } else {
      const d = await gfetch(mb, "/me/messages", { method: "POST", body: { ...fields, body: { contentType: "HTML", content: html } } });
      id = d.id;
    }
    for (const f of files) await MS.attach(mb, id, f);
    cacheDrop(mb, id); if (ref) cacheDrop(mb, ref);
    if (draftOnly) return { draft: true };
    await gfetch(mb, `/me/messages/${enc(id)}/send`, { method: "POST" });
    return { sent: true };
  }
};

// ======================================================================
// IMAP + SMTP (Titan, GoDaddy, Gmail app password, Yahoo, Zoho, iCloud, others)
// ======================================================================
const pool = new Map();            // mbId -> { cl, p, timer }
function dropConn(id) {
  const e = pool.get(id); if (!e) return; pool.delete(id); clearTimeout(e.timer);
  if (e.cl) e.cl.logout().catch(() => { try { e.cl.close(); } catch {} });
}
const creds = mb => JSON.parse(box.open(mb.enc_refresh));
async function imapConn(mb) {
  const e = pool.get(mb.id);
  if (e && e.ver !== ver(mb)) { dropConn(mb.id); return imapConn(mb); }   // reconnected with another account or password
  if (e) {
    if (e.p) return e.p;
    if (e.cl.usable) { clearTimeout(e.timer); e.timer = setTimeout(() => dropConn(mb.id), 120e3); return e.cl; }
    dropConn(mb.id);
  }
  const c = creds(mb);
  const cl = mail.imapClient(c);
  const entry = { cl, p: null, timer: null, ver: ver(mb) };
  cl.on("error", () => { if (pool.get(mb.id) === entry) dropConn(mb.id); });
  cl.on("close", () => { if (pool.get(mb.id) === entry) { clearTimeout(entry.timer); pool.delete(mb.id); } });
  entry.p = cl.connect().then(() => { entry.p = null; entry.timer = setTimeout(() => dropConn(mb.id), 120e3); return cl; },
    async ex => { pool.delete(mb.id); const er = mail.imapError(ex, c.host); if (er.auth) await markReconnect(mb, er.message); throw Object.assign(er, { status: er.auth ? 409 : 502 }); });
  pool.set(mb.id, entry);
  return entry.p;
}
async function inFolder(mb, path, fn) {
  for (let attempt = 0; ; attempt++) {
    const cl = await imapConn(mb);
    let lock;
    try {
      lock = await cl.getMailboxLock(path);
      try { return await fn(cl); } finally { lock.release(); }
    } catch (e) {
      if (attempt === 0 && !cl.usable) { dropConn(mb.id); continue; }   // connection dropped mid-way — once more on a fresh one
      if (/Mailbox doesn't exist|NONEXISTENT|not exist|Unknown Mailbox/i.test(String(e.responseText || e.message))) throw fail("That folder isn't there anymore.", { status: 404 });
      throw e;
    }
  }
}
const iid = (path, uid) => Buffer.from(JSON.stringify([path, uid])).toString("base64url");
function unId(id) {
  try { const [p, u] = JSON.parse(Buffer.from(String(id), "base64url").toString()); if (typeof p === "string" && Number.isInteger(u)) return { path: p, uid: u }; } catch {}
  throw fail("Bad message id.", { status: 400 });
}
const SPECIAL = { "\\Inbox": "inbox", "\\Sent": "sent", "\\Drafts": "drafts", "\\Trash": "deleted", "\\Junk": "junk", "\\Archive": "archive" };
function roleOf(b) {
  if (String(b.path).toUpperCase() === "INBOX") return "inbox";
  if (SPECIAL[b.specialUse]) return SPECIAL[b.specialUse];
  const n = String(b.name || "").toLowerCase();
  if (/^(sent|sent items|sent mail|sent messages)$/.test(n)) return "sent";
  if (/^(drafts?)$/.test(n)) return "drafts";
  if (/^(trash|deleted|deleted items|deleted messages|bin)$/.test(n)) return "deleted";
  if (/^(junk|spam|junk e-?mail|bulk mail)$/.test(n)) return "junk";
  if (/^archive$/.test(n)) return "archive";
  return null;
}
function hasAtt(n) {
  if (!n) return false;
  if (n.childNodes) return n.childNodes.some(hasAtt);
  if (n.disposition === "attachment") return true;
  const named = n.dispositionParameters?.filename || n.parameters?.name;
  return !!named && !/^text\//i.test(n.type || "") && !(n.disposition === "inline" && n.id);
}
function textPart(n, want) {
  if (!n) return null;
  if (n.childNodes) { for (const c of n.childNodes) { const r = textPart(c, want); if (r) return r; } return null; }
  if ((n.type || "").toLowerCase() === want && n.disposition !== "attachment") return n;
  return null;
}
function decodePart(buf, node) {
  const iconv = require("iconv-lite");
  let s = Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf || "");
  let out;
  const e = String(node.encoding || "").toLowerCase();
  if (e === "base64") { s = s.replace(/[^A-Za-z0-9+/=]/g, ""); out = Buffer.from(s.slice(0, s.length - (s.length % 4)), "base64"); }
  else if (e === "quoted-printable") out = require("libqp").decode(s.replace(/=[0-9A-F]?$/i, ""));
  else out = Buffer.from(s, "latin1");
  const cs = String(node.parameters?.charset || "utf-8").toLowerCase();
  return iconv.encodingExists(cs) ? iconv.decode(out, cs) : out.toString("utf8");
}
function htmlText(h) {
  try { const $ = cheerio.load(String(h)); $("style,script,head,title").remove(); return $.root().text(); } catch { return String(h).replace(/<[^>]*>/g, " "); }
}
async function previews(cl, rows) {
  const groups = new Map();
  for (const m of rows) {
    let n = textPart(m.bodyStructure, "text/plain"), html = false;
    if (!n) { n = textPart(m.bodyStructure, "text/html"); html = !!n; }
    if (!n) continue;
    const key = n.part || "TEXT";
    const g = groups.get(key) || []; g.push({ m, n, html }); groups.set(key, g);
  }
  for (const [key, list] of groups) {
    try {
      const want = new Map(list.map(x => [x.m.uid, x]));
      for await (const r of cl.fetch(list.map(x => x.m.uid).join(","), { uid: true, bodyParts: [{ key, maxLength: 1500 }] }, { uid: true })) {
        const x = want.get(r.uid); if (!x || !r.bodyParts) continue;
        const buf = [...r.bodyParts.values()][0]; if (!buf) continue;
        let t = decodePart(buf, x.n); if (x.html) t = htmlText(t);
        x.m.preview = t.replace(/\s+/g, " ").trim().slice(0, 180);
      }
    } catch { /* previews are a nicety */ }
  }
}
const imRow = (path, m) => {
  const e = m.envelope || {}; const from = addr((e.from || [])[0]);
  return { id: iid(path, m.uid), folder: path, from, to: (e.to || []).map(addr).filter(Boolean), subject: e.subject || "", preview: m.preview || "",
    date: iso(e.date) || iso(m.internalDate), unread: !m.flags?.has("\\Seen"), flagged: !!m.flags?.has("\\Flagged"), att: hasAtt(m.bodyStructure),
    draft: !!m.flags?.has("\\Draft"), important: false, court: isCourt(from?.email, e.subject) };
};
const flatAddr = v => (v?.value || []).flatMap(a => a.group ? a.group : [a]).map(addr).filter(Boolean);

const IM = {
  async folders(mb) {
    const cl = await imapConn(mb);
    const list = (await cl.list({ statusQuery: { unseen: true, messages: true } })).filter(b => !b.flags?.has("\\Noselect") && !b.flags?.has("\\NonExistent"));
    const paths = new Set(list.map(b => b.path));
    const out = list.map(b => {
      const role = roleOf(b);
      let depth = 0;
      if (!role && b.delimiter) { const segs = b.path.split(b.delimiter); for (let i = 1; i < segs.length; i++) if (paths.has(segs.slice(0, i).join(b.delimiter))) depth++; }
      return { id: b.path, name: role === "inbox" ? "Inbox" : b.name, role, unread: b.status?.unseen || 0, total: b.status?.messages || 0, depth: Math.min(depth, 2), parent: b.parentPath || null };
    });
    folderCache.set(mb.id, { at: Date.now(), list: out });
    return out;
  },
  async roleFolder(mb, role) {
    let c = folderCache.get(mb.id);
    if (!c || Date.now() - c.at > 10 * 60e3) { await IM.folders(mb); c = folderCache.get(mb.id); }
    return (c.list.find(f => f.role === role) || {}).id || null;
  },
  async list(mb, { folder, search, cursor }) {
    const path = folder || "INBOX";
    return inFolder(mb, path, async cl => {
      const total = cl.mailbox?.exists || 0;
      let range, byUid = false, next = null;
      if (search) {
        const found = ((await cl.search({ text: search }, { uid: true })) || []).sort((a, b) => b - a);
        const off = Math.max(0, +cursor || 0);
        const uids = found.slice(off, off + PAGE);
        if (!uids.length) return { items: [], next: null };
        range = uids.join(","); byUid = true; next = off + PAGE < found.length ? String(off + PAGE) : null;
      } else {
        if (!total) return { items: [], next: null };
        const hi = cursor ? Math.min(+cursor || total, total) : total, lo = Math.max(1, hi - PAGE + 1);
        range = `${lo}:${hi}`; next = lo > 1 ? String(lo - 1) : null;
      }
      const rows = [];
      for await (const m of cl.fetch(range, { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true }, { uid: byUid })) rows.push(m);
      await previews(cl, rows);
      const t = m => new Date(m.internalDate || m.envelope?.date || 0).getTime() || 0;
      rows.sort((a, b) => t(b) - t(a) || b.uid - a.uid);      // newest received first, like Outlook
      return { items: rows.map(m => imRow(path, m)), next };
    });
  },
  async get(mb, id, { markRead = true } = {}) {
    const hit = cacheGet(mb, id); if (hit) return hit;
    const { path, uid } = unId(id);
    const { simpleParser } = require("mailparser");
    const out = await inFolder(mb, path, async cl => {
      const m = await cl.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
      if (!m || !m.source) throw fail("That email isn't there anymore — it may have been moved or deleted.", { status: 404 });
      const p = await simpleParser(m.source, { skipTextToHtml: true, skipImageLinks: true });
      let unread = !m.flags?.has("\\Seen");
      if (markRead && unread) { await cl.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {}); unread = false; }
      const atts = (p.attachments || []).map((a, i) => ({ id: String(i), name: a.filename || (a.contentType === "message/rfc822" ? "attached-email.eml" : "attachment"), type: a.contentType || "application/octet-stream",
        size: a.size || a.content?.length || 0, inline: !!(a.related || (a.contentDisposition === "inline" && a.contentId && /^image\//i.test(a.contentType || ""))), cid: a.contentId ? String(a.contentId).replace(/^<|>$/g, "").toLowerCase() : null, content: a.content }));
      const from = flatAddr(p.from)[0] || null;
      const refs = [].concat(p.references || []).filter(Boolean);
      return { id, folder: path, from, to: flatAddr(p.to), cc: flatAddr(p.cc), bcc: flatAddr(p.bcc), replyTo: flatAddr(p.replyTo), subject: p.subject || "",
        date: iso(p.date) || new Date().toISOString(), unread, flagged: !!m.flags?.has("\\Flagged"), draft: !!m.flags?.has("\\Draft"), important: /^high|^1/i.test(String(p.headers?.get("x-priority") || p.priority || "")),
        att: atts.some(a => !a.inline), court: isCourt(from?.email, p.subject),
        html: p.html || null, text: p.html ? null : (p.text || ""), preview: "",
        attachments: atts.filter(a => !a.inline).map(({ content, cid, ...a }) => a), _atts: atts, messageId: p.messageId || null, references: refs };
    });
    cachePut(mb, id, out); return out;
  },
  async inline(mb, id, m) {
    const map = {};
    for (const a of m._atts || []) if (a.cid && /^image\//i.test(a.type) && a.content) map[a.cid] = `data:${a.type};base64,${a.content.toString("base64")}`;
    return map;
  },
  async attachment(mb, id, attId) {
    const m = await IM.get(mb, id, { markRead: false });
    const a = (m._atts || [])[+attId]; if (!a) throw fail("Attachment not found.", { status: 404 });
    return { name: a.name, type: a.type, data: a.content };
  },
  async source(mb, id) {
    const { path, uid } = unId(id);
    return inFolder(mb, path, async cl => { const m = await cl.fetchOne(String(uid), { uid: true, source: true }, { uid: true }); if (!m?.source) throw fail("That email isn't there anymore.", { status: 404 }); return m.source; });
  },
  async flags(mb, id, { read, flagged }) {
    const { path, uid } = unId(id);
    await inFolder(mb, path, async cl => {
      if (read !== undefined) await (read ? cl.messageFlagsAdd : cl.messageFlagsRemove).call(cl, String(uid), ["\\Seen"], { uid: true });
      if (flagged !== undefined) await (flagged ? cl.messageFlagsAdd : cl.messageFlagsRemove).call(cl, String(uid), ["\\Flagged"], { uid: true });
    });
    cacheDrop(mb, id);
  },
  byFolder(ids) { const g = new Map(); for (const id of ids) { const { path, uid } = unId(id); g.set(path, [...(g.get(path) || []), uid]); } return g; },
  async move(mb, ids, dest) {
    for (const [path, uids] of IM.byFolder(ids)) { if (path === dest) continue; await inFolder(mb, path, cl => cl.messageMove(uids.join(","), dest, { uid: true })); }
    ids.forEach(id => cacheDrop(mb, id));
  },
  async remove(mb, ids) {
    const trash = await IM.roleFolder(mb, "deleted");
    let permanent = false;
    for (const [path, uids] of IM.byFolder(ids)) {
      if (!trash || path === trash) { permanent = true; await inFolder(mb, path, cl => cl.messageDelete(uids.join(","), { uid: true })); }
      else await inFolder(mb, path, cl => cl.messageMove(uids.join(","), trash, { uid: true }));
    }
    ids.forEach(id => cacheDrop(mb, id));
    return { permanent };
  },
  // a replaced or sent draft is erased, not moved to Deleted (draft text can be privileged)
  async erase(mb, ids) {
    for (const [path, uids] of IM.byFolder(ids)) await inFolder(mb, path, cl => cl.messageDelete(uids.join(","), { uid: true }));
    ids.forEach(id => cacheDrop(mb, id));
  },
  async send(mb, opt, user) {
    const MailComposer = require("nodemailer/lib/mail-composer");
    const c = creds(mb);
    const quoted = { html: "", atts: [] };
    let orig = null;
    if (opt.ref && ["reply", "replyAll", "forward"].includes(opt.mode)) {
      orig = await IM.get(mb, opt.ref, { markRead: false });
      quoted.html = quoteBlock(orig, opt.mode === "forward");
      quoted.atts = (orig._atts || []).filter(a => a.content && (a.inline ? a.cid : opt.mode === "forward"))
        .map(a => ({ filename: a.name, content: a.content, contentType: a.type, ...(a.inline && a.cid ? { cid: a.cid } : {}) }));
    }
    const refs = orig && opt.mode !== "forward" ? [...(orig.references || []), orig.messageId].filter(Boolean) : undefined;
    // re-saving or sending a draft keeps the files already attached to it
    if (opt.draftId) { const d = await IM.get(mb, opt.draftId, { markRead: false }).catch(() => null);
      if (d) quoted.atts.push(...(d._atts || []).filter(a => a.content && (!a.inline || a.cid)).map(a => ({ filename: a.name, content: a.content, contentType: a.type, ...(a.inline && a.cid ? { cid: a.cid } : {}) }))); }
    const msg = {
      from: { name: user.name || "", address: c.user }, to: fmt(opt.to), cc: fmt(opt.cc), bcc: fmt(opt.bcc), subject: opt.subject,
      html: emailDoc(opt.html + quoted.html), text: htmlText(opt.html + quoted.html).replace(/\n{3,}/g, "\n\n").trim(),
      attachments: [...quoted.atts, ...opt.files.map(f => ({ filename: f.name, content: f.data, contentType: f.type || "application/octet-stream" }))],
      messageId: `<${crypto.randomUUID()}@${(c.user.split("@")[1] || "txcasedesk")}>`, date: new Date(),
      ...(refs ? { inReplyTo: orig.messageId || undefined, references: refs } : {})
    };
    const build = async keepBcc => { const node = new MailComposer(msg).compile(); node.keepBcc = keepBcc; return node.build(); };
    if (opt.draftOnly) {
      const drafts = await IM.roleFolder(mb, "drafts");
      if (!drafts) throw fail("This mailbox has no Drafts folder.", { status: 400 });
      const cl = await imapConn(mb); await cl.append(drafts, await build(true), ["\\Draft", "\\Seen"]);
      if (opt.draftId) await IM.erase(mb, [opt.draftId]).catch(() => {});
      return { draft: true };
    }
    await smtpSend(mb, c, msg);
    // keep a copy in Sent (Gmail and Microsoft do this on their own)
    if (!/gmail|office365|outlook/i.test(c.host)) {
      const sent = await IM.roleFolder(mb, "sent").catch(() => null);
      if (sent) { try { const cl = await imapConn(mb); await cl.append(sent, await build(true), ["\\Seen"]); } catch (e) { console.warn("[mailx] couldn't save to Sent:", e.message); } }
    }
    if (orig) { const { path, uid } = unId(opt.ref); inFolder(mb, path, cl => cl.messageFlagsAdd(String(uid), [opt.mode === "forward" ? "$Forwarded" : "\\Answered"], { uid: true })).catch(() => {}); cacheDrop(mb, opt.ref); }
    if (opt.draftId) await IM.erase(mb, [opt.draftId]).catch(() => {});
    return { sent: true };
  }
};
const fmt = list => (list || []).map(a => a.name ? { name: a.name, address: a.email } : a.email);
function quoteBlock(o, forward) {
  const who = a => a ? esc(a.name ? `${a.name} <${a.email}>` : a.email) : "";
  const d = o.date ? new Date(o.date).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  let body;
  if (o.html) { const $ = cheerio.load(o.html); strip($); body = ($("head style").toString() || "") + ($("body").html() ?? $.root().html()); }
  else body = `<div style="white-space:pre-wrap">${esc(o.text || "")}</div>`;
  return `<br><div style="border:none;border-top:1px solid #e1e1e1;padding:8px 0 0"><p style="margin:0;font-size:13px"><b>From:</b> ${who(o.from)}<br><b>Sent:</b> ${esc(d)}<br>` +
    `<b>To:</b> ${o.to.map(who).join("; ")}${o.cc?.length ? `<br><b>Cc:</b> ${o.cc.map(who).join("; ")}` : ""}<br><b>Subject:</b> ${esc(o.subject)}</p></div><br>${body}`;
}
const emailDoc = inner => `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt">${inner}</body></html>`;

function smtpFor(c) {
  if (c.smtp) return [c.smtp];
  const h = String(c.host || "").toLowerCase();
  const MAP = [[/^outlook\.office365\.com$/, "smtp.office365.com", 587], [/gmail/, "smtp.gmail.com", 465], [/titan\.email/, "smtp.titan.email", 465],
    [/secureserver\.net/, "smtpout.secureserver.net", 465], [/zoho/, h.replace(/^imap/, "smtp"), 465], [/yahoo/, "smtp.mail.yahoo.com", 465],
    [/mail\.me\.com/, "smtp.mail.me.com", 587], [/hostinger/, "smtp.hostinger.com", 465], [/ionos/, "smtp.ionos.com", 587]];
  const hit = MAP.find(([re]) => re.test(h));
  if (hit) return [{ host: hit[1], port: hit[2] }];
  const base = h.replace(/^(imap|mail)\./, "");
  return [{ host: "smtp." + base, port: 465 }, { host: "smtp." + base, port: 587 }, { host: "mail." + base, port: 465 }, { host: "mail." + base, port: 587 }];
}
async function smtpSend(mb, c, msg) {
  const nodemailer = require("nodemailer");
  let last;
  for (const s of smtpFor(c)) {
    // 465 = TLS from the start; anything else must upgrade with STARTTLS before the password is sent (local tests set tls:false)
    const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.tls === false ? false : s.port === 465, ...(s.tls === false ? { ignoreTLS: true } : s.port !== 465 ? { requireTLS: true } : {}),
      auth: { user: c.user, pass: c.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 });
    try {
      await t.sendMail(msg);
      if (!c.smtp) { c.smtp = s; await q("UPDATE mailboxes SET enc_refresh=$2 WHERE id=$1", [mb.id, box.seal(JSON.stringify(c))]); }
      return;
    } catch (e) {
      last = e;
      if (e.code === "EAUTH") {
        const m = String(e.response || e.message);
        throw fail(/SmtpClientAuthentication is disabled|5\.7\.139/i.test(m)
          ? "Your Microsoft 365 admin has sending from other apps (SMTP AUTH) turned off. Connect with \"Connect Outlook\" instead, or ask IT to allow SMTP AUTH for your mailbox."
          : `Your email host didn't accept your password for sending (${m.slice(0, 120)}). If two-step login is on, use an app password.`, { status: 400 });
      }
      if (!/ECONNECTION|ETIMEDOUT|ESOCKET|EDNS|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETLS/.test(e.code || e.message)) break;   // the host answered — don't try others
    } finally { t.close(); }
  }
  throw fail(`Couldn't send: ${String(last?.response || last?.message || "no outgoing server found").slice(0, 160)}`, { status: 502 });
}

// ======================================================================
// safe display of an email's body (shown in a sandboxed frame, scripts never run, pictures off until asked)
// ======================================================================
function strip($) {
  $("script,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,meta,link,base,noscript,svg script").remove();
  $("*").each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      const v = String(el.attribs[a] || "");
      if (/^on/i.test(a) || /^(formaction|srcdoc|ping|http-equiv)$/i.test(a)) $(el).removeAttr(a);
      else if (/^(href|src|xlink:href|background|action|lowsrc|dynsrc)$/i.test(a) && /^\s*(javascript|vbscript|data:(?!image\/(png|jpe?g|gif|webp)))/i.test(v)) $(el).removeAttr(a);
    }
  });
}
const linkify = s => s.replace(/\bhttps?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const APP_HOST = (() => { try { return new URL(process.env.APP_URL || "https://tx-case-desk.onrender.com").host.toLowerCase(); } catch { return "tx-case-desk.onrender.com"; } })();
const outside = u => { try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) && x.host.toLowerCase() !== APP_HOST; } catch { return false; } };
const cssUrls = css => String(css).replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m0, q, u) => /^data:image\//i.test(u.trim()) || outside(u) ? m0 : "url(about:invalid)");
function renderSafe(m, inline, images) {
  let body;
  if (m.html) {
    const $ = cheerio.load(m.html);
    strip($);
    $("img").each((_, el) => { const s = String(el.attribs.src || "");
      if (/^cid:/i.test(s)) { const k = s.slice(4).replace(/^<|>$/g, "").toLowerCase(); if (inline[k]) $(el).attr("src", inline[k]); else $(el).removeAttr("src"); }
      else if (!images && /^\s*https?:/i.test(s)) $(el).removeAttr("src").removeAttr("srcset").attr("data-blocked", "1");   // pictures from the web stay off until asked (no tracking pixels)
      else if (s && !/^data:image\//i.test(s) && !outside(s)) $(el).removeAttr("src").removeAttr("srcset");      // nothing loads from the app itself
    });
    $("[background]").each((_, el) => { if (!outside(el.attribs.background)) $(el).removeAttr("background"); });
    $("[style]").each((_, el) => $(el).attr("style", cssUrls(el.attribs.style)));
    $("style").each((_, el) => $(el).text(cssUrls($(el).text())));
    $("a[href]").attr("target", "_blank").attr("rel", "noopener noreferrer");
    body = ($("head style").toString() || "") + ($("body").html() ?? $.root().html());
  } else body = `<div class="pt">${linkify(esc(m.text || ""))}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<style>html,body{margin:0;background:#fff}body{padding:14px 18px 28px;font:14px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1d2433;overflow-wrap:anywhere}` +
    `img{max-width:100%;height:auto}img[data-blocked]{display:none}a{color:#1f4fbf}.pt{white-space:pre-wrap}blockquote{margin:0 0 0 .8ex;border-left:2px solid #ccd;padding-left:1ex}</style></head><body>${body}</body></html>`;
}

// ======================================================================
// routes
// ======================================================================
const PROV = mb => mb.provider === "microsoft" ? MS : mb.provider === "imap" ? IM : null;
function adapter(mb) {
  const a = PROV(mb);
  if (!a) throw fail("Full mail for this account needs your email's app password. Disconnect it, then use \"Connect with your email password\".", { status: 409, reconnect: true });
  return a;
}
const EMAIL = /^[^@\s<>"(),;:]+@[^@\s<>"(),;:]+\.[^@\s<>"(),;:]+$/;
function people(list) {
  return (Array.isArray(list) ? list : []).slice(0, 100).map(a => ({ name: String(a?.name || "").replace(/[\r\n<>"]/g, "").trim().slice(0, 120), email: String(a?.email || "").trim().toLowerCase() }))
    .filter(a => { if (!EMAIL.test(a.email)) throw fail(`"${a.email}" isn't an email address.`, { status: 400 }); return true; });
}
// Strict allow-list for HTML that goes back into the app page (editing a draft) or out in an email you write:
// simple formatting only, no styles, no pictures, links only to web/mail addresses. Everything else is
// unwrapped (its text kept) or, for dangerous elements, removed with its content.
const SAFE_TAGS = new Set(["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "a", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "pre", "code", "sup", "sub", "small"]);
const DROP_TAGS = new Set(["script", "style", "svg", "math", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "noscript",
  "textarea", "title", "head", "meta", "link", "base", "form", "input", "button", "select", "option", "xmp", "noembed", "noframes",
  "plaintext", "video", "audio", "canvas", "img", "picture", "source", "map", "area", "dialog", "portal"]);
function safeHtml(h) {
  const $ = cheerio.load(String(h || ""), null, false);
  const walk = node => {
    for (const el of [...(node.children || [])]) {
      if (el.type === "text") continue;
      if (el.type !== "tag") { $(el).remove(); continue; }            // comments, CDATA, scripts, styles
      const name = String(el.name || "").toLowerCase();
      if (DROP_TAGS.has(name) || name.includes(":")) { $(el).remove(); continue; }
      walk(el);
      if (!SAFE_TAGS.has(name)) { $(el).replaceWith($(el).contents()); continue; }
      for (const a of Object.keys(el.attribs || {})) {
        const v = String(el.attribs[a] || "");
        const keep = (name === "a" && a === "href" && /^(https?:|mailto:)/i.test(v.replace(/[\u0000-\u0020\u007f-\u009f]/g, "")))
          || ((name === "td" || name === "th") && (a === "colspan" || a === "rowspan") && /^\d{1,2}$/.test(v));
        if (!keep) $(el).removeAttr(a);
      }
      if (name === "a") $(el).attr("rel", "noopener noreferrer");
    }
  };
  walk($.root()[0]);
  return $.html();
}
const cleanHtml = safeHtml;

function mount(app, { requireAuth, wrap, audit }) {
  const R = express.Router();
  const send = (res, e) => res.status(e.status || 500).json({ error: e.message || "Mail error", reconnect: !!e.reconnect });
  const h = fn => wrap(async (req, res) => { try { await fn(req, res); } catch (e) { if (!e.status) console.error("[mailx]", e.message); send(res, e); } });
  const boxOf = req => loadBox(req.user, req.query.acct ?? req.body?.acct);

  R.get("/accounts", h(async (req, res) => {
    const { rows } = await q(`SELECT id, provider, email, status, last_error, scope_req, scope_got, shared_firm FROM mailboxes
      WHERE (user_id=$1 AND shared_firm IS NULL) OR (shared_firm=$2 AND $3) ORDER BY shared_firm NULLS FIRST, id`, [req.user.id, req.user.firm_id, handler(req.user)]);
    res.json({ accounts: rows.map(r => ({ id: r.id, provider: r.provider, email: r.email, status: r.status, shared: !!r.shared_firm,
      label: r.shared_firm ? "Shared court inbox" : r.provider === "microsoft" ? "Outlook" : r.provider === "google" ? "Gmail" : (r.email || "").split("@")[1] || "Email",
      full: r.provider === "microsoft" ? msFull(r) : r.provider === "imap",
      reconnect: r.status === "reconnect" || r.provider === "google" || (r.provider === "microsoft" && !msFull(r)),
      search: r.provider === "microsoft" ? "all" : "folder" })) });
  }));
  R.get("/folders", h(async (req, res) => { const mb = await boxOf(req); res.json({ folders: await adapter(mb).folders(mb) }); }));
  R.get("/messages", h(async (req, res) => {
    const mb = await boxOf(req);
    const search = String(req.query.q || "").trim().slice(0, 200);
    res.json(await adapter(mb).list(mb, { folder: String(req.query.folder || ""), search, cursor: req.query.cursor ? String(req.query.cursor) : null }));
  }));
  R.get("/message", h(async (req, res) => {
    const mb = await boxOf(req); const id = String(req.query.id || "");
    const m = await adapter(mb).get(mb, id, { markRead: req.query.peek !== "1" });
    const { html, text, _atts, inlineAtts, references, ...out } = m;
    out.remote = !!(html && REMOTE_IMG.test(html));
    if (req.query.body === "1") out.body = html ? safeHtml((() => { const $ = cheerio.load(html); return $("body").html() ?? ""; })()) : esc(text || "").replace(/\n/g, "<br>");
    res.json(out);
  }));
  R.get("/view", h(async (req, res) => {
    const mb = await boxOf(req); const id = String(req.query.id || ""); const a = adapter(mb);
    const m = await a.get(mb, id, { markRead: false });
    const images = req.query.images === "1";
    const page = renderSafe(m, await a.inline(mb, id, m).catch(() => ({})), images);
    res.set({ "Content-Security-Policy": `default-src 'none'; img-src data:${images ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:${images ? " https:" : ""}; frame-ancestors 'self'; form-action 'none'`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN" }).type("html").send(page);
  }));
  R.get("/attachment", h(async (req, res) => {
    const mb = await boxOf(req);
    const a = await adapter(mb).attachment(mb, String(req.query.id || ""), String(req.query.att || ""));
    const name = String(a.name || "attachment").replace(/[\r\n"\\/]/g, "_").slice(0, 180);
    const img = /^image\/(png|jpe?g|gif|webp)$/i.test(a.type), pdf = /^application\/pdf$/i.test(a.type) || /\.pdf$/i.test(name);
    const inline = req.query.inline === "1" && (img || pdf);
    res.set({ "Content-Type": inline ? (pdf ? "application/pdf" : a.type) : "application/octet-stream", "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${enc(name)}`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", ...(inline && img ? { "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; sandbox" } : {}) });
    res.send(a.data);
  }));
  R.patch("/message", h(async (req, res) => {
    const mb = await boxOf(req); const b = req.body || {};
    await adapter(mb).flags(mb, String(b.id || ""), { read: b.read, flagged: b.flagged });
    res.json({ ok: true });
  }));
  R.post("/move", h(async (req, res) => {
    const mb = await boxOf(req); const ids = [].concat(req.body?.ids || []).map(String).slice(0, 200);
    const dest = String(req.body?.folder || ""); if (!ids.length || !dest) return res.status(400).json({ error: "Pick emails and a folder." });
    await adapter(mb).move(mb, ids, dest); res.json({ ok: true, moved: ids.length });
  }));
  R.post("/delete", h(async (req, res) => {
    const mb = await boxOf(req); const ids = [].concat(req.body?.ids || []).map(String).slice(0, 200);
    if (!ids.length) return res.status(400).json({ error: "Pick emails." });
    const r = await adapter(mb).remove(mb, ids, String(req.body?.folder || ""));
    await audit(req, "mail_deleted", { mailbox: mb.id, n: ids.length, permanent: !!r.permanent });
    res.json({ ok: true, ...r });
  }));
  R.post("/upload", express.raw({ type: () => true, limit: "25mb" }), h(async (req, res) => {
    sweepUploads();
    if (!req.body || !req.body.length) return res.status(400).json({ error: "Empty file." });
    let mine = 0, all = 0; for (const v of uploads.values()) { all += v.data.length; if (v.userId === req.user.id) mine += v.data.length; }
    if (mine + req.body.length > 40 * 1024 * 1024) return res.status(400).json({ error: "Too many attachments waiting — send or discard your draft first." });
    if (all + req.body.length > 200 * 1024 * 1024) return res.status(503).json({ error: "The server is busy with other attachments — try again in a few minutes." });
    const token = crypto.randomBytes(16).toString("hex");
    let raw = String(req.get("X-File-Name") || "file"); try { raw = decodeURIComponent(raw); } catch { /* not encoded — use as is */ }
    const name = raw.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "file";
    const type = String(req.get("X-File-Type") || "application/octet-stream").replace(/[^\w.+\/-]/g, "").slice(0, 100) || "application/octet-stream";
    uploads.set(token, { userId: req.user.id, name, type, data: req.body, exp: Date.now() + 3600e3 });
    res.json({ token, name, size: req.body.length });
  }));
  R.post("/send", h(async (req, res) => {
    const mb = await boxOf(req); const a = adapter(mb); const b = req.body || {};
    const mode = ["new", "reply", "replyAll", "forward"].includes(b.mode) ? b.mode : "new";
    const to = people(b.to), cc = people(b.cc), bcc = people(b.bcc);
    const draftOnly = !!b.draft;
    if (!draftOnly && !to.length && !cc.length && !bcc.length) return res.status(400).json({ error: "Add at least one recipient." });
    const files = [].concat(b.atts || []).map(t => { const u = uploads.get(String(t)); if (!u || u.userId !== req.user.id) throw fail("An attachment expired — attach it again.", { status: 400 }); return u; });
    if (files.reduce((s, f) => s + f.data.length, 0) > MAX_TOTAL) return res.status(400).json({ error: "Attachments are over 25 MB. Send fewer or smaller files." });
    const r = await a.send(mb, { mode, ref: b.ref ? String(b.ref) : null, to, cc, bcc, subject: String(b.subject || "").replace(/[\r\n]+/g, " ").slice(0, 400),
      html: cleanHtml(b.html), files, draftOnly, draftId: b.draftId ? String(b.draftId) : null }, req.user);
    [].concat(b.atts || []).forEach(t => uploads.delete(String(t)));
    if (!draftOnly) await audit(req, "mail_sent", { mailbox: mb.id, mode, recipients: to.length + cc.length + bcc.length, attachments: files.length });
    res.json({ ok: true, ...r });
  }));
  // File an email (and its attachments) into a case's documents
  R.post("/save-to-case", h(async (req, res) => {
    const mb = await boxOf(req); const a = adapter(mb); const b = req.body || {};
    const pr = [+b.case || 0, req.user.firm_id]; const cond = access.caseCond(req.user, "c", pr);
    const c = (await q(`SELECT c.id, c.cause_no, c.style FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0];
    if (!c) return res.status(404).json({ error: "Case not found." });
    const id = String(b.id || ""); const m = await a.get(mb, id, { markRead: false });
    const saved = [];
    const put = async (name, mime, data) => {
      if (!data?.length) return; if (data.length > 15 * 1024 * 1024) throw fail(`${name} is over 15 MB — too big to save to the case.`, { status: 400 });
      const { rows } = await q("INSERT INTO documents(firm_id, case_id, name, mime, size, data, uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, name",
        [req.user.firm_id, c.id, name.slice(0, 200), mime, data.length, data, req.user.id]); saved.push(rows[0]);
    };
    const day = new Date(m.date || Date.now()).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });   // YYYY-MM-DD, Texas time
    const base = `${day} ${(m.subject || "email").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 120) || "email"}`;
    if (b.email !== false) await put(`${base}.eml`, "message/rfc822", await a.source(mb, id));
    for (const att of [].concat(b.atts || []).map(String)) {
      const f = await a.attachment(mb, id, att);
      await put(String(f.name || "attachment").replace(/[\\/]/g, "_"), f.type || "application/octet-stream", f.data);
    }
    await audit(req, "mail_saved_to_case", { case: c.id, n: saved.length });
    res.json({ ok: true, saved, case: c });
  }));
  app.use("/api/mailx", requireAuth, R);
}

module.exports = { mount, _test: { renderSafe, smtpFor, mergeBody, decodePart, roleOf, hasAtt } };
