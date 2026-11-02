// Connected mailboxes: attorneys tap "Connect Outlook" or "Connect Gmail" once.
// We get READ-ONLY access, pull only court emails (eFileTexas, Tyler, re:SearchTX, clerks, txcourts),
// and feed them through the same pipeline as forwarded emails (create/update cases, alerts, Inbox).
const crypto = require("crypto");
const { q } = require("./db");
const box = require("./crypto-box");
const inbound = require("./inbound");

const APP = (process.env.APP_URL || "https://tx-case-desk.onrender.com").replace(/\/$/, "");
const PROVIDERS = {
  microsoft: {
    name: "Outlook / Microsoft 365",
    id: () => (process.env.MS_CLIENT_ID || "").trim(), secret: () => (process.env.MS_CLIENT_SECRET || "").trim(),
    auth: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Connecting for court emails asks only to read mail (works even where IT limits what apps may request).
    // Full mail in the app (organize, send) + calendar is a separate, explicit "Turn on full mail" step (FULL_MS_SCOPE).
    scope: "openid email offline_access User.Read Mail.Read"
  },
  google: {
    name: "Gmail / Google Workspace",
    id: () => (process.env.GOOGLE_CLIENT_ID || "").trim(), secret: () => (process.env.GOOGLE_CLIENT_SECRET || "").trim(),
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email https://www.googleapis.com/auth/gmail.readonly"
  }
};
// Court senders we read. Everything else in the mailbox is ignored and never stored.
const COURT_SENDER = /(efiletexas\.gov|efile|tylertech\.(com|cloud)|tylerhost\.net|txcourts\.gov|courts\.state\.tx\.us|\.tx\.us\b|countytx\.gov|county(tx)?\.(us|org|gov|net)\b|hctx\.net|bexar\.org|texasbar\.com|odyssey|research\.tylertech|clerk|courts?\b)/i;
// Senders that look official but aren't on the list above — logged by domain only, so missed court senders can be added.
const NEAR_MISS = /(county|court|clerk|judic|\.tx\.us|\.gov$|tyler|efile|texas)/i;
// A court notice someone forwarded (to themselves or the firm): the sender is a person, so look inside for the court system's own footprints.
const COURT_DOMAIN = /(efiletexas\.gov|tylertech\.(com|cloud)|tylerhost\.net|txcourts\.gov|courts\.state\.tx\.us|\.tx\.us$|countytx\.gov|hctx\.net|bexar\.org|texasbar\.com)$/i;
const FWD_SUBJECT = /^\s*(fwd?|fw)\s*:/i;
const COURT_BODY = /(efiletexas\.gov|tylertech\.(com|cloud)|tylerhost\.net|txcourts\.gov|courts\.state\.tx\.us|re:?searchtx|notification of service|envelope (number|#|no\.?))/i;
const domainOf = a => String(a || "").split("@")[1]?.toLowerCase() || "";
const GMAIL_QUERY = "from:(efiletexas.gov OR tylertech.com OR tylertech.cloud OR tylerhost.net OR txcourts.gov OR tx.us OR clerk)";
const redirect = p => `${APP}/api/mail/callback/${p}`;
const MS_OLD_SCOPE = "openid email offline_access User.Read Mail.Read";   // what mailboxes connected before Nov 2026 approved
const FULL_MS_SCOPE = "openid email offline_access User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite";
const configured = () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, !!(v.id() && v.secret())]));
const NAMES = { ...Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.name])), imap: "Email (password sign-in)" };

// Microsoft keys (decision log, Oct 31 2026 — Option A): TX Case Desk's own multi-tenant app, registered under a
// business account, is the default — one sign-in per attorney. A firm whose IT insists can enter its own Azure keys in
// Firm Settings; those win for that firm. Each mailbox remembers which keys it was connected with.
async function msKeys(firmId, source) {
  if (source !== "app" && firmId) {
    const f = (await q("SELECT ms_client_id, ms_tenant, ms_secret_enc FROM firms WHERE id=$1", [firmId])).rows[0];
    if (f && f.ms_client_id && f.ms_secret_enc) return { id: f.ms_client_id, secret: box.open(f.ms_secret_enc), tenant: f.ms_tenant || "common", source: "firm" };
    if (source === "firm") throw Object.assign(new Error("Your firm's Microsoft keys were removed — reconnect."), { reconnect: true });
  }
  const P = PROVIDERS.microsoft;
  if (!P.id() || !P.secret()) throw Object.assign(new Error("Outlook sign-in isn't switched on yet."), { reconnect: true });
  return { id: P.id(), secret: P.secret(), tenant: "common", source: "app" };
}
async function configuredFor(firmId) {
  const c = configured();
  if (firmId) { const f = (await q("SELECT ms_client_id, ms_secret_enc FROM firms WHERE id=$1", [firmId])).rows[0]; if (f && f.ms_client_id && f.ms_secret_enc) c.microsoft = true; }
  c.imap = true;
  return c;
}
const msAuth = (tenant, kind) => `https://login.microsoftonline.com/${tenant || "common"}/oauth2/v2.0/${kind}`;

// OAuth state lives server-side (our session cookie is SameSite=Strict, so it won't come back on the provider redirect)
const states = new Map();
async function startUrl(provider, user, opts = {}) {
  const P = PROVIDERS[provider];
  const keys = provider === "microsoft" ? await msKeys(user.firm_id) : { id: P.id(), source: "app" };
  const state = crypto.randomBytes(16).toString("hex");
  const scope = provider === "microsoft" && opts.full ? FULL_MS_SCOPE : P.scope;
  states.set(state, { userId: user.id, firmId: user.firm_id, provider, keySource: keys.source, shared: !!opts.shared, dev: !!opts.dev, scope, exp: Date.now() + 10 * 60e3 });
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  const p = new URLSearchParams({ client_id: keys.id, response_type: "code", redirect_uri: redirect(provider), scope, state });
  if (provider === "google") { p.set("access_type", "offline"); p.set("prompt", "consent"); p.set("include_granted_scopes", "true"); }
  if (provider === "microsoft") p.set("prompt", "select_account");
  return `${provider === "microsoft" ? msAuth(keys.tenant, "authorize") : P.auth}?${p}`;
}

async function tokenCall(provider, params, keys) {
  const P = PROVIDERS[provider];
  keys = keys || { id: P.id(), secret: P.secret(), tenant: "common" };
  const r = await fetch(provider === "microsoft" ? msAuth(keys.tenant, "token") : P.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.id, client_secret: keys.secret, ...params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || `token error ${r.status}`);
  return j;
}
function emailFromIdToken(idt) {
  try { const p = JSON.parse(Buffer.from(String(idt).split(".")[1], "base64url").toString()); return p.email || p.preferred_username || null; } catch (e) { return null; }
}

async function finish(provider, code, state) {
  const st = states.get(state); states.delete(state);
  if (!st || st.exp < Date.now() || st.provider !== provider) throw new Error("This sign-in link expired. Tap Connect again.");
  const keys = provider === "microsoft" ? await msKeys(st.firmId, st.keySource) : null;
  const t = await tokenCall(provider, { grant_type: "authorization_code", code, redirect_uri: redirect(provider) }, keys);
  if (!t.refresh_token) throw new Error("The provider didn't grant ongoing access. Tap Connect again and approve all permissions.");
  const email = emailFromIdToken(t.id_token);
  // the firm's shared court inbox (one per firm), connected by the firm admin
  const { rows } = st.shared ? await q(`INSERT INTO mailboxes(user_id, provider, email, enc_refresh, enc_access, access_expires, status, last_error, key_source, scope_req, scope_got, shared_firm)
    VALUES($1,$2,$3,$4,$5,now() + ($6 || ' seconds')::interval,'ok',NULL,$7,$8,$9,$10)
    ON CONFLICT(shared_firm) WHERE shared_firm IS NOT NULL DO UPDATE SET user_id=$1, provider=$2, email=$3, enc_refresh=$4, enc_access=$5, access_expires=EXCLUDED.access_expires, status='ok', last_error=NULL, key_source=$7, last_seen=NULL, stats=NULL, scope_req=$8, scope_got=$9
    RETURNING id`, [st.userId, provider, email, box.seal(t.refresh_token), box.seal(t.access_token), String((t.expires_in || 3600) - 120), keys ? keys.source : "app", st.scope || PROVIDERS[provider].scope, t.scope || null, st.firmId])
  : await q(`INSERT INTO mailboxes(user_id, provider, email, enc_refresh, enc_access, access_expires, status, last_error, key_source, scope_req, scope_got)
    VALUES($1,$2,$3,$4,$5,now() + ($6 || ' seconds')::interval,'ok',NULL,$7,$8,$9)
    ON CONFLICT(user_id, provider) WHERE shared_firm IS NULL DO UPDATE SET email=$3, enc_refresh=$4, enc_access=$5, access_expires=EXCLUDED.access_expires, status='ok', last_error=NULL, key_source=$7, last_seen=NULL, stats=NULL, scope_req=$8, scope_got=$9
    RETURNING id`, [st.userId, provider, email, box.seal(t.refresh_token), box.seal(t.access_token), String((t.expires_in || 3600) - 120), keys ? keys.source : "app", st.scope || PROVIDERS[provider].scope, t.scope || null]);
  await q("INSERT INTO audit_log(user_id, action, detail) VALUES($1,'mailbox_connected',$2)", [st.userId, { provider, email, ...(st.shared ? { shared: true } : {}), ...(st.dev ? { dev: true } : {}) }]);
  syncMailbox(rows[0].id, { days: 30 }).catch(() => {}); // first pull: last 90 days (lookback)
  return { userId: st.userId, email, shared: st.shared };
}

async function accessToken(mb) {
  if (mb.enc_access && mb.access_expires && new Date(mb.access_expires) > new Date()) return box.open(mb.enc_access);
  const keys = mb.provider === "microsoft" ? await msKeys(mb.firm_id, mb.key_source || "app") : null;
  const t = await tokenCall(mb.provider, { grant_type: "refresh_token", refresh_token: box.open(mb.enc_refresh), ...(mb.provider === "microsoft" ? { scope: mb.scope_req || MS_OLD_SCOPE } : {}) }, keys);
  await q("UPDATE mailboxes SET enc_access=$2, access_expires=now() + ($3 || ' seconds')::interval, enc_refresh=COALESCE($4, enc_refresh) WHERE id=$1",
    [mb.id, box.seal(t.access_token), String((t.expires_in || 3600) - 120), t.refresh_token ? box.seal(t.refresh_token) : null]);
  return t.access_token;
}

async function api(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error("Mailbox access was revoked or expired — reconnect."), { reconnect: true });
  if (!r.ok) throw new Error(`Mail API error ${r.status}`);
  return r.json();
}

// ---- fetch new court emails since `since` ----
async function fetchMicrosoft(token, since, base = "https://graph.microsoft.com/v1.0/me/messages") {
  // 1) scan headers only (fast, up to 20,000 messages), 2) download bodies only for court emails.
  const hits = [], near = {}; let scanned = 0, first = null, last = null;
  let url = `${base}?$filter=receivedDateTime ge ${since.toISOString()}&$orderby=receivedDateTime asc&$top=500&$select=id,from,subject,receivedDateTime`;
  for (let page = 0; url && page < 40; page++) {
    const j = await api(url, token);
    for (const m of j.value || []) {
      scanned++; first = first || m.receivedDateTime; last = m.receivedDateTime;
      const from = m.from?.emailAddress?.address || "";
      if (COURT_SENDER.test(from + " " + (m.subject || ""))) hits.push({ id: m.id, from, subject: m.subject, received: m.receivedDateTime });
      else { const d = domainOf(from); if (NEAR_MISS.test(d)) near[d] = (near[d] || 0) + 1; }
    }
    url = j["@odata.nextLink"];
  }
  const out = [];
  for (const h of hits) {
    const b = await api(`${base}/${h.id}?$select=body`, token);
    out.push({ ext_id: "ms:" + h.id, from: h.from, subject: h.subject, html: b.body?.contentType === "html" ? b.body.content : null, text: b.body?.contentType === "text" ? b.body.content : null, received: h.received });
  }
  return { msgs: out, scanned, first, last, near, more: !!url };
}
function gmailBody(payload) {
  let text = "", html = "";
  const walk = p => {
    if (!p) return;
    const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
    if (p.mimeType === "text/plain" && data) text += data;
    if (p.mimeType === "text/html" && data) html += data;
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { text, html };
}
async function fetchGoogle(token, since) {
  const out = [];
  const qstr = `${GMAIL_QUERY} after:${Math.floor(since.getTime() / 1000)}`;
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const list = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(qstr)}${pageToken ? "&pageToken=" + pageToken : ""}`, token);
    for (const m of list.messages || []) {
      const full = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, token);
      const h = Object.fromEntries((full.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
      const from = (h.from || "").replace(/.*<([^>]+)>.*/, "$1");
      if (!COURT_SENDER.test(from + " " + (h.subject || ""))) continue;
      out.push({ ext_id: "g:" + m.id, from, subject: h.subject || "", ...gmailBody(full.payload), received: new Date(+full.internalDate).toISOString() });
    }
    pageToken = list.nextPageToken; if (!pageToken) break;
  }
  out.sort((a, b) => a.received.localeCompare(b.received));
  return { msgs: out, scanned: out.length, first: out[0]?.received || null, last: out[out.length - 1]?.received || null, near: {}, more: false };
}

// ======================= Password sign-in (IMAP) — Titan, GoDaddy, Zoho and other hosts =======================
// The attorney enters their email + password once. It's encrypted like court logins and used read-only.
const IMAP_HOSTS = [
  [/titan\.email/, ["imap.titan.email", "imap.secureserver.net"], "Titan (GoDaddy Professional Email)"],
  [/secureserver\.net/, ["imap.secureserver.net"], "GoDaddy email"],
  [/zoho/, ["imap.zoho.com"], "Zoho Mail"],
  [/yahoodns|yahoo/, ["imap.mail.yahoo.com"], "Yahoo Mail"],
  [/icloud|me\.com/, ["imap.mail.me.com"], "iCloud Mail"],
  [/hostinger/, ["imap.hostinger.com"], "Hostinger email"],
  [/ionos|1and1/, ["imap.ionos.com"], "IONOS email"]
];
async function imapGuess(email) {
  const det = await detect(email);
  const mx = (det.mx || []).join(" ");
  const hit = IMAP_HOSTS.find(([re]) => re.test(mx));
  if (hit) return { hosts: hit[1], label: hit[2], det };
  if (det.provider === "microsoft") return { hosts: ["outlook.office365.com"], label: "Microsoft 365", det };
  if (det.provider === "google") return { hosts: ["imap.gmail.com"], label: "Google", det };
  return { hosts: det.domain ? ["imap." + det.domain, "mail." + det.domain] : [], label: det.host || "your email host", det };
}
function imapClient(c) {
  const { ImapFlow } = require("imapflow");
  return new ImapFlow({ host: c.host, port: c.port || 993, secure: c.tls !== false, ...(c.tls === false ? { doSTARTTLS: false } : {}), auth: { user: c.user, pass: c.pass }, logger: false,
    socketTimeout: 60000, connectionTimeout: 15000, greetingTimeout: 15000 });
}
function imapError(e, label) {
  const m = String(e.responseText || e.message || e);
  if (e.authenticationFailed || /auth|credential|password|LOGIN failed|invalid/i.test(m))
    return Object.assign(new Error(`${label} didn't accept that email and password. ` + (/titan|godaddy/i.test(label)
      ? "In Titan/GoDaddy webmail: make sure Third-party email access is ON and Two-step (2FA) login is OFF — Titan blocks other apps while 2FA is on — then try again."
      : "If two-step login is on for this email, create an app password and use that instead.")), { reconnect: true, auth: true });
  return new Error(`Couldn't reach ${label} (${m.slice(0, 120)}).`);
}
async function connectImap(user, { email, password, host }, opts = {}) {
  email = String(email || "").trim().toLowerCase(); password = String(password || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password) throw new Error("Enter your email address and its password.");
  const g = await imapGuess(email);
  const hosts = host ? [String(host).trim().toLowerCase()] : g.hosts;
  if (!hosts.length) throw new Error("We couldn't tell who hosts that email. Enter the incoming (IMAP) server from your email provider.");
  let lastErr;
  for (const h of hosts) {
    const [hn, hp] = h.split(":");
    const c = { host: hn, port: +hp || 993, user: email, pass: password };
    const cl = imapClient(c);
    try { await cl.connect(); await cl.logout().catch(() => {});
      const { rows } = opts.shared
        ? await q(`INSERT INTO mailboxes(user_id, provider, email, enc_refresh, status, last_error, key_source, shared_firm) VALUES($1,'imap',$2,$3,'ok',NULL,'imap',$4)
            ON CONFLICT(shared_firm) WHERE shared_firm IS NOT NULL DO UPDATE SET user_id=$1, provider='imap', email=$2, enc_refresh=$3, enc_access=NULL, status='ok', last_error=NULL, key_source='imap', last_seen=NULL, stats=NULL, scope_req=NULL, scope_got=NULL RETURNING id`, [user.id, email, box.seal(JSON.stringify(c)), user.firm_id])
        : await q(`INSERT INTO mailboxes(user_id, provider, email, enc_refresh, status, last_error, key_source) VALUES($1,'imap',$2,$3,'ok',NULL,'imap')
            ON CONFLICT(user_id, provider) WHERE shared_firm IS NULL DO UPDATE SET email=$2, enc_refresh=$3, status='ok', last_error=NULL, last_seen=NULL, stats=NULL RETURNING id`, [user.id, email, box.seal(JSON.stringify(c))]);
      await q("INSERT INTO audit_log(user_id, action, detail) VALUES($1,'mailbox_connected',$2)", [user.id, { provider: "imap", email, host: h, ...(opts.shared ? { shared: true } : {}), ...(opts.dev ? { dev: true } : {}) }]);
      console.log(`[mail] imap connected for user ${user.id} @${domainOf(email)} via ${h}`);
      syncMailbox(rows[0].id, { days: 30 }).catch(() => {});
      return { id: rows[0].id, email, host: h, label: g.label };
    } catch (e) { try { cl.close(); } catch {} const err = imapError(e, g.label); if (!lastErr || err.auth) lastErr = err; }
  }
  throw lastErr || new Error("Couldn't connect.");
}
const SKIP_FOLDER = /\\(Sent|Drafts)|^(sent|drafts|outbox)/i;   // Spam/Junk, Trash and Archive ARE read (court notices get filed or deleted there), but only real court addresses count in them
const LOOSE_FOLDER = /junk|spam|trash|deleted|\bbin\b|archive/i;
async function fetchImap(c, since) {
  const { simpleParser } = require("mailparser");
  const cl = imapClient(c);
  try { await cl.connect(); } catch (e) { throw imapError(e, c.host); }
  const hits = [], near = {}, folders = {}; let scanned = 0, first = null, last = null, more = false;
  try {
    const boxes = (await cl.list()).filter(b => !b.flags?.has("\\Noselect") && !SKIP_FOLDER.test(b.specialUse || "") && !SKIP_FOLDER.test(b.name)).slice(0, 25);
    for (const b of boxes) {
      const lock = await cl.getMailboxLock(b.path);
      try {
        let uids = (await cl.search({ since }, { uid: true })) || [];
        // some servers mishandle SINCE — fall back to the newest 5,000 and filter by date ourselves
        if (!uids.length && cl.mailbox && cl.mailbox.exists && !LOOSE_FOLDER.test((b.specialUse || "") + " " + b.path)) uids = ((await cl.search({ all: true }, { uid: true })) || []).slice(-5000);
        if (!uids.length) continue;
        for await (const m of cl.fetch(uids.slice(-20000).join(","), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const when = new Date(m.internalDate || m.envelope?.date || Date.now()).toISOString();
          if (new Date(when) < since) continue;
          scanned++; folders[b.path] = (folders[b.path] || 0) + 1; if (!first || when < first) first = when; if (!last || when > last) last = when;
          const from = m.envelope?.from?.[0]?.address || "";
          const junk = LOOSE_FOLDER.test((b.specialUse || "") + " " + b.path);   // in Spam/Trash/Archive only a real court address counts, not a subject that says "court"
          if (junk ? COURT_DOMAIN.test(domainOf(from)) : COURT_SENDER.test(from + " " + (m.envelope?.subject || ""))) hits.push({ box: b.path, uid: m.uid, from, subject: m.envelope?.subject || "", received: when, mid: m.envelope?.messageId || null });
          else if (!junk && FWD_SUBJECT.test(m.envelope?.subject || "")) hits.push({ fwd: true, box: b.path, uid: m.uid, from, subject: m.envelope?.subject || "", received: when, mid: m.envelope?.messageId || null });
          else { const d = domainOf(from); if (NEAR_MISS.test(d)) near[d] = (near[d] || 0) + 1; }
        }
      } finally { lock.release(); }
    }
    // forwards: open only the newest 40 per check (each one is downloaded to look inside)
    const fwds = hits.filter(h => h.fwd).sort((a, b) => b.received.localeCompare(a.received)), drop = new Set(fwds.slice(40));
    const out = [];
    for (const h of hits.filter(h => !drop.has(h)).sort((a, b) => a.received.localeCompare(b.received))) {
      const lock = await cl.getMailboxLock(h.box);
      try {
        const msg = await cl.fetchOne(String(h.uid), { source: true }, { uid: true });
        const parsed = msg && msg.source ? await simpleParser(msg.source) : {};
        if (h.fwd) {   // a forward that isn't a court notice: skipped, never stored. "Forward as attachment" puts the notice inside an attached email.
          let inner = (parsed.text || "") + " " + String(parsed.html || "").replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, " ");
          for (const a of (parsed.attachments || []).filter(a => /message\/rfc822|\.eml$/i.test(a.contentType + " " + (a.filename || ""))).slice(0, 3)) {
            try { const m2 = await simpleParser(a.content); inner += " " + (m2.from ? m2.from.text : "") + " " + (m2.subject || "") + " " + (m2.text || "") + " " + String(m2.html || "").replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, " ");
              parsed.text = `${parsed.text || ""}\n\n---------- Attached email ----------\nFrom: ${m2.from ? m2.from.text : ""}\nSubject: ${m2.subject || ""}\n\n${m2.text || String(m2.html || "").replace(/<style[\s\S]*?<\/style>|<[^>]+>/gi, " ")}`; parsed.html = null; } catch (e) {}
          }
          if (!COURT_BODY.test(inner.slice(0, 400000))) continue;
        }
        out.push({ ext_id: "imap:" + (h.mid || h.box + ":" + h.uid), from: h.from, subject: h.subject, html: parsed.html || null, text: parsed.text || null, received: h.received });
      } finally { lock.release(); }
    }
    console.log(`[mail] imap folders read: ${Object.entries(folders).map(([f, n]) => `${f}=${n}`).join(", ") || "none"}; court hits ${hits.filter(h => !h.fwd).length}, forwards checked ${hits.filter(h => h.fwd).length}, kept ${out.length}`);
    return { msgs: out, scanned, first, last, near, more };
  } finally { await cl.logout().catch(() => cl.close?.()); }
}

const running = new Set();
async function syncMailbox(id, { days = 2, fresh = false } = {}) {
  if (running.has(id)) return { skipped: "running" };
  running.add(id);
  try {
    const { rows } = await q("SELECT m.*, u.firm_id, u.counties, u.active, u.name AS user_name FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE m.id=$1", [id]);
    const mb = rows[0]; if (!mb || (!mb.active && !mb.shared_firm)) return { skipped: "gone" };
    // No court email found yet = keep looking back 90 days, not just 2.
    const lookback = fresh || !mb.last_seen ? Math.max(days, 90) : days;
    const since = !fresh && mb.last_seen ? new Date(new Date(mb.last_seen).getTime() - 60e3) : new Date(Date.now() - lookback * 864e5);
    const token = mb.provider === "imap" ? null : await accessToken(mb);
    const r = mb.provider === "imap" ? await fetchImap(JSON.parse(box.open(mb.enc_refresh)), since)
      : mb.provider === "microsoft" ? await fetchMicrosoft(token, since) : await fetchGoogle(token, since);
    const user = mb.shared_firm ? { id: null, firm_id: mb.shared_firm, shared: true } : { id: mb.user_id, firm_id: mb.firm_id, counties: mb.counties };
    let added = 0, created = 0, matched = 0, dup = 0, newest = fresh ? null : mb.last_seen;
    for (const m of r.msgs) {
      const x = await inbound.processEmail(user, { ...m, source: mb.provider });
      if (x.ok) { added++; created += (x.created || []).length; matched += (x.matched || []).length; } else if (x.duplicate) dup++;
    }
    // Advance the cursor past everything scanned (court or not) so the next check starts where this one ended.
    const seen = r.more ? r.last : (r.last && (!newest || r.last > new Date(newest).toISOString()) ? r.last : newest);
    const nearTop = Object.entries(r.near).sort((a, b) => b[1] - a[1]).slice(0, 8);
    // Empty mailbox: the attorney likely signed in to a Microsoft account that isn't where their mail lives.
    let note = null;
    if (r.scanned === 0 && lookback >= 30 && mb.provider !== "imap") {
      const det = await detect(mb.email);
      let inboxTotal = null;
      if (mb.provider === "microsoft") inboxTotal = await api("https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount", token).then(j => j.totalItemCount).catch(e => "error: " + e.message);
      console.log(`[mail] mailbox ${id} diag: no email in last 90 days; inbox total=${inboxTotal}; @${det.domain} mail hosted by ${det.host || "unknown"} (mx ${(det.mx || []).slice(0, 2).join(", ") || "none"})`);
      const em = mb.email || "your email";
      note = det.provider === mb.provider
        ? `Connected, but this mailbox has no email from the last 90 days. Make sure you signed in with the ${mb.provider === "microsoft" ? "Microsoft 365" : "Google"} account for ${em}.`
        : det.provider === "google"
          ? `Your ${det.domain} email runs on Google Workspace, not Microsoft — the Microsoft sign-in opened an empty mailbox. Disconnect, then use Sign in with Gmail.`
          : `Your ${det.domain || ""} email is hosted by ${(await imapGuess(mb.email)).label}, not Microsoft — the Microsoft sign-in opened an empty mailbox, so there's nothing to read. Disconnect this, then use "Connect with your email password" below.`;
    }
    const stats = { v: SCAN_V, note, scanned: r.scanned, from: r.first, to: r.last, court: r.msgs.length, checked: r.msgs.length, added, matched, created, dup, near: Object.fromEntries(nearTop), at: new Date().toISOString() };
    await q("UPDATE mailboxes SET status='ok', last_sync=now(), last_seen=COALESCE($2,last_seen), last_error=NULL, stats=$3 WHERE id=$1", [id, seen || null, stats]);
    console.log(`[mail] ${mb.provider} mailbox ${id} (${mb.user_name}, @${domainOf(mb.email)}): scanned ${r.scanned} emails since ${since.toISOString().slice(0, 10)}${r.more ? " (more left, continues next check)" : ""}; ${r.msgs.length} court emails, ${added} new, ${dup} already had, ${created} cases created, ${matched} matched` +
      (nearTop.length ? `; other official-looking senders not read: ${nearTop.map(([d, n]) => d + "×" + n).join(", ")}` : ""));
    return stats;
  } catch (e) {
    console.error(`[mail] mailbox ${id} failed: ${e.message}`);
    await q("UPDATE mailboxes SET status=$2, last_sync=now(), last_error=$3 WHERE id=$1", [id, e.reconnect ? "reconnect" : "error", e.message.slice(0, 300)]).catch(() => {});
    return { error: e.message };
  } finally { running.delete(id); }
}
// One-time: mailboxes checked by the old 500-email scan get a fresh 30-day look.
const SCAN_V = 3;
async function rescanOld() {
  // also look again (90 days) at password-connected mailboxes checked before Spam/Trash/Archive and forwards were read
  const { rows } = await q("SELECT m.id FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE u.active AND m.status <> 'reconnect' AND (m.stats IS NULL OR m.stats->>'scanned' IS NULL OR (m.provider='imap' AND COALESCE(m.stats->>'v','') <> $1))", [String(SCAN_V)]);
  for (const r of rows) await syncMailbox(r.id, { days: 30, fresh: true });
  return rows.length;
}
async function syncAll() {
  const { rows } = await q("SELECT m.id FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE (u.active OR m.shared_firm IS NOT NULL) AND m.status <> 'reconnect' ORDER BY m.last_sync NULLS FIRST LIMIT 200");
  for (const r of rows) await syncMailbox(r.id);
  return rows.length;
}

module.exports = { fetchImap, PROVIDERS, NAMES, configured, configuredFor, msKeys, testFirmKeys, startUrl, finish, syncMailbox, syncAll, rescanOld, running, connectImap, imapGuess, accessToken, imapClient, imapError, COURT_SENDER };

// ======================= Auto-detect who hosts an email domain =======================
const dns = require("dns").promises;
const PUBLIC = { "gmail.com": "google", "googlemail.com": "google", "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft" };
async function detect(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  if (!domain) return { domain: null, provider: null };
  if (PUBLIC[domain]) return { domain, provider: PUBLIC[domain], host: PUBLIC[domain] === "google" ? "Gmail" : "Outlook.com", personal: true };
  try {
    const mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map(m => m.exchange.toLowerCase());
    const top = mx.join(" ");
    if (/protection\.outlook\.com|outlook\.com|office365/.test(top)) return { domain, provider: "microsoft", host: "Microsoft 365", mx };
    if (/google\.com|googlemail\.com/.test(top)) return { domain, provider: "google", host: "Google Workspace", mx };
    const host = /secureserver/.test(top) ? "GoDaddy email" : /zoho/.test(top) ? "Zoho Mail" : /pphosted|mimecast|barracuda|proofpoint/.test(top) ? "a security filter (provider behind it unknown)" : mx[0] || "unknown";
    return { domain, provider: null, host, mx };
  } catch (e) { return { domain, provider: null, host: "unknown (no mail records found)" }; }
}

// ======================= Firm-wide: Microsoft 365 admin consent =======================
// The firm's Microsoft 365 admin approves once; we then read court emails for the firm's attorneys
// (only users registered in TX Case Desk with an address on the firm's domain).
const adminStates = new Map();
async function adminConsentUrl(firmId, domain, opts = {}) {
  const keys = await msKeys(firmId);
  const state = crypto.randomBytes(16).toString("hex");
  adminStates.set(state, { firmId, domain, keySource: keys.source, dev: !!opts.dev, exp: Date.now() + 15 * 60e3 });
  const p = new URLSearchParams({ client_id: keys.id, redirect_uri: `${APP}/api/mail/admin-callback/microsoft`, scope: "https://graph.microsoft.com/.default", state });
  return `https://login.microsoftonline.com/${keys.source === "firm" ? keys.tenant : "organizations"}/v2.0/adminconsent?${p}`;
}
async function finishAdminConsent(query) {
  const st = adminStates.get(query.state); adminStates.delete(query.state);
  if (!st || st.exp < Date.now()) throw new Error("This approval link expired. Start again from Firm Seats.");
  if (query.error) throw new Error(query.error_description || "The admin did not approve access.");
  if (!query.tenant) throw new Error("Microsoft didn't return the firm's tenant.");
  await q(`INSERT INTO firm_mail(firm_id, provider, tenant, domain, status, last_error, key_source) VALUES($1,'microsoft',$2,$3,'ok',NULL,$4)
    ON CONFLICT(firm_id) DO UPDATE SET provider='microsoft', tenant=$2, domain=$3, status='ok', last_error=NULL, key_source=$4`, [st.firmId, query.tenant, st.domain, st.keySource || "app"]);
  await q("INSERT INTO audit_log(firm_id, action, detail) VALUES($1,'firm_mail_connected',$2)", [st.firmId, { provider: "microsoft", tenant: query.tenant, domain: st.domain, ...(st.dev ? { dev: true } : {}) }]);
  syncFirm(st.firmId, { days: 30 }).catch(() => {});
  return st;
}
const appTokens = new Map();
async function msAppToken(tenant, keys) {
  const ck = tenant + ":" + keys.id;
  const c = appTokens.get(ck); if (c && c.exp > Date.now()) return c.tok;
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.id, client_secret: keys.secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || "Microsoft 365 firm access failed — the admin may need to approve again."), { reconnect: true });
  appTokens.set(ck, { tok: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
}
// Check a firm's Azure keys before saving: a client-credentials token request proves ID + secret + tenant match.
async function testFirmKeys({ id, secret, tenant }) {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) return true;
  const d = String(j.error_description || j.error || r.status);
  if (/AADSTS7000215|AADSTS7000222/.test(d)) throw new Error("Microsoft says the secret is wrong or expired. Copy the secret's Value (not the Secret ID) again.");
  if (/AADSTS700016/.test(d)) throw new Error("Microsoft can't find that Application (client) ID in that directory. Check both IDs on the app's Overview page.");
  if (/AADSTS900023|AADSTS90002/.test(d)) throw new Error("That Directory (tenant) ID isn't valid. Copy it from the app's Overview page.");
  throw new Error("Microsoft rejected the keys: " + d.split("\r\n")[0].slice(0, 200));
}

// ======================= Firm-wide: Google Workspace domain-wide delegation =======================
// Our Google service account; the firm's Workspace admin authorizes its Client ID for gmail.readonly once.
const GSA = () => ({ email: (process.env.GOOGLE_SA_EMAIL || "").trim(), key: (process.env.GOOGLE_SA_KEY || "").replace(/\\n/g, "\n").trim(), clientId: (process.env.GOOGLE_SA_CLIENT_ID || "").trim() });
async function googleDelegatedToken(userEmail) {
  const sa = GSA(); if (!sa.email || !sa.key) throw new Error("Google firm-wide access isn't set up on the server yet.");
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({ iss: sa.email, sub: userEmail, scope: "https://www.googleapis.com/auth/gmail.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || "Google Workspace firm access failed — check the admin console setup."), { reconnect: true });
  return j.access_token;
}
async function connectGoogleFirm(firmId, domain, testEmail, opts = {}) {
  await googleDelegatedToken(testEmail); // throws if the admin hasn't authorized us yet
  await q(`INSERT INTO firm_mail(firm_id, provider, tenant, domain, status, last_error) VALUES($1,'google',NULL,$2,'ok',NULL)
    ON CONFLICT(firm_id) DO UPDATE SET provider='google', tenant=NULL, domain=$2, status='ok', last_error=NULL`, [firmId, domain]);
  await q("INSERT INTO audit_log(firm_id, action, detail) VALUES($1,'firm_mail_connected',$2)", [firmId, { provider: "google", domain, ...(opts.dev ? { dev: true } : {}) }]);
  syncFirm(firmId, { days: 30 }).catch(() => {});
}

// ======================= Firm-wide sync =======================
async function syncFirm(firmId, { days = 2 } = {}) {
  const key = "firm" + firmId; if (running.has(key)) return { skipped: "running" }; running.add(key);
  try {
    const f = (await q("SELECT * FROM firm_mail WHERE firm_id=$1", [firmId])).rows[0]; if (!f) return { skipped: "none" };
    const fc = (await q("SELECT court_email, court_seen, court_mode FROM firms WHERE id=$1", [firmId])).rows[0] || {};
    const courtAddr = fc.court_mode !== "each" && fc.court_email && domainOf(fc.court_email) === String(f.domain).toLowerCase() ? fc.court_email.toLowerCase() : null;
    const users = (await q(`SELECT u.id, u.firm_id, u.counties, u.email, c.last_seen FROM users u LEFT JOIN mail_cursor c ON c.user_id=u.id
      WHERE u.firm_id=$1 AND u.active AND lower(split_part(u.email,'@',2))=lower($2)`, [firmId, f.domain])).rows.filter(u => u.email.toLowerCase() !== courtAddr);
    let checked = 0, added = 0, created = 0, people = 0; const errors = [];
    const appTok = f.provider === "microsoft" ? await msAppToken(f.tenant, await msKeys(firmId, f.key_source || "app")) : null;
    for (const u of users) {
      try {
        const since = u.last_seen ? new Date(new Date(u.last_seen).getTime() - 60e3) : new Date(Date.now() - days * 864e5);
        const fr = f.provider === "microsoft" ? await fetchMicrosoft(appTok, since, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(u.email)}/messages`)
          : await fetchGoogle(await googleDelegatedToken(u.email), since);
        const msgs = fr.msgs;
        let newest = fr.last && (!u.last_seen || fr.last > new Date(u.last_seen).toISOString()) ? fr.last : u.last_seen;
        for (const m of msgs) {
          const r = await inbound.processEmail(u, { ...m, source: f.provider + "-firm" });
          if (r.ok) { added++; created += (r.created || []).length; }
          if (!newest || m.received > new Date(newest).toISOString()) newest = m.received;
        }
        checked += msgs.length; people++;
        await q("INSERT INTO mail_cursor(user_id, last_seen) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET last_seen=COALESCE($2, mail_cursor.last_seen)", [u.id, newest]);
      } catch (e) { errors.push(`${u.email}: ${e.message}`); if (e.reconnect && f.provider === "microsoft") throw e; }
    }
    // the firm's shared court inbox (e.g. a Microsoft 365 shared mailbox with no password of its own)
    if (courtAddr) {
      const cs = { address: courtAddr, at: new Date().toISOString(), checked: 0, added: 0, routed: 0, waiting: 0, created: 0 };
      try {
        const since = fc.court_seen ? new Date(new Date(fc.court_seen).getTime() - 60e3) : new Date(Date.now() - 30 * 864e5);
        const fr = f.provider === "microsoft" ? await fetchMicrosoft(appTok, since, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(courtAddr)}/messages`)
          : await fetchGoogle(await googleDelegatedToken(courtAddr), since);
        let newest = fr.last && (!fc.court_seen || fr.last > new Date(fc.court_seen).toISOString()) ? fr.last : fc.court_seen;
        for (const m of fr.msgs) {
          const r = await inbound.processEmail({ id: null, firm_id: firmId, shared: true }, { ...m, source: f.provider + "-shared" });
          if (r.ok) { cs.added++; cs.created += (r.created || []).length; if (r.owner) cs.routed++; else cs.waiting++; }
          if (!newest || m.received > new Date(newest).toISOString()) newest = m.received;
        }
        cs.checked = fr.msgs.length; cs.scanned = fr.scanned;
        await q("UPDATE firms SET court_seen=COALESCE($2, court_seen), court_stats=$3 WHERE id=$1", [firmId, newest, cs]);
        checked += fr.msgs.length; added += cs.added; created += cs.created;
      } catch (e) {
        errors.push(`${courtAddr}: ${e.message}`);
        await q("UPDATE firms SET court_stats=$2 WHERE id=$1", [firmId, { ...cs, error: e.message.slice(0, 300) }]).catch(() => {});
      }
    }
    const stats = { people, checked, added, created, errors: errors.slice(0, 5), at: new Date().toISOString() };
    await q("UPDATE firm_mail SET status='ok', last_sync=now(), last_error=$2, stats=$3 WHERE firm_id=$1", [firmId, errors.length ? errors.slice(0, 3).join(" | ").slice(0, 300) : null, stats]);
    console.log(`[mail] firm ${firmId} ${f.provider}: ${people} attorneys, ${checked} court emails, ${added} new, ${created} cases created`);
    return stats;
  } catch (e) {
    console.error(`[mail] firm ${firmId} failed: ${e.message}`);
    await q("UPDATE firm_mail SET status=$2, last_sync=now(), last_error=$3 WHERE firm_id=$1", [firmId, e.reconnect ? "reconnect" : "error", e.message.slice(0, 300)]).catch(() => {});
    return { error: e.message };
  } finally { running.delete(key); }
}
async function syncAllFirms() {
  const { rows } = await q("SELECT firm_id FROM firm_mail WHERE status <> 'reconnect'");
  for (const r of rows) await syncFirm(r.firm_id);
  return rows.length;
}

module.exports.detect = detect;
module.exports.adminConsentUrl = adminConsentUrl;
module.exports.finishAdminConsent = finishAdminConsent;
module.exports.connectGoogleFirm = connectGoogleFirm;
module.exports.syncFirm = syncFirm;
module.exports.syncAllFirms = syncAllFirms;
module.exports.GSA = GSA;
