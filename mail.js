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
const domainOf = a => String(a || "").split("@")[1]?.toLowerCase() || "";
const GMAIL_QUERY = "from:(efiletexas.gov OR tylertech.com OR tylertech.cloud OR tylerhost.net OR txcourts.gov OR tx.us OR clerk)";
const redirect = p => `${APP}/api/mail/callback/${p}`;
const configured = () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, !!(v.id() && v.secret())]));

// OAuth state lives server-side (our session cookie is SameSite=Strict, so it won't come back on the provider redirect)
const states = new Map();
function startUrl(provider, userId) {
  const P = PROVIDERS[provider];
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, { userId, provider, exp: Date.now() + 10 * 60e3 });
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  const p = new URLSearchParams({ client_id: P.id(), response_type: "code", redirect_uri: redirect(provider), scope: P.scope, state });
  if (provider === "google") { p.set("access_type", "offline"); p.set("prompt", "consent"); p.set("include_granted_scopes", "true"); }
  if (provider === "microsoft") p.set("prompt", "select_account");
  return `${P.auth}?${p}`;
}

async function tokenCall(provider, params) {
  const P = PROVIDERS[provider];
  const r = await fetch(P.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: P.id(), client_secret: P.secret(), ...params }), signal: AbortSignal.timeout(20000) });
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
  const t = await tokenCall(provider, { grant_type: "authorization_code", code, redirect_uri: redirect(provider) });
  if (!t.refresh_token) throw new Error("The provider didn't grant ongoing access. Tap Connect again and approve all permissions.");
  const email = emailFromIdToken(t.id_token);
  const { rows } = await q(`INSERT INTO mailboxes(user_id, provider, email, enc_refresh, enc_access, access_expires, status, last_error)
    VALUES($1,$2,$3,$4,$5,now() + ($6 || ' seconds')::interval,'ok',NULL)
    ON CONFLICT(user_id, provider) DO UPDATE SET email=$3, enc_refresh=$4, enc_access=$5, access_expires=EXCLUDED.access_expires, status='ok', last_error=NULL
    RETURNING id`, [st.userId, provider, email, box.seal(t.refresh_token), box.seal(t.access_token), String((t.expires_in || 3600) - 120)]);
  await q("INSERT INTO audit_log(user_id, action, detail) VALUES($1,'mailbox_connected',$2)", [st.userId, { provider, email }]);
  syncMailbox(rows[0].id, { days: 30 }).catch(() => {}); // first pull: last 30 days
  return { userId: st.userId, email };
}

async function accessToken(mb) {
  if (mb.enc_access && mb.access_expires && new Date(mb.access_expires) > new Date()) return box.open(mb.enc_access);
  const t = await tokenCall(mb.provider, { grant_type: "refresh_token", refresh_token: box.open(mb.enc_refresh), ...(mb.provider === "microsoft" ? { scope: PROVIDERS.microsoft.scope } : {}) });
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

const running = new Set();
async function syncMailbox(id, { days = 2, fresh = false } = {}) {
  if (running.has(id)) return { skipped: "running" };
  running.add(id);
  try {
    const { rows } = await q("SELECT m.*, u.firm_id, u.counties, u.active, u.name AS user_name FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE m.id=$1", [id]);
    const mb = rows[0]; if (!mb || !mb.active) return { skipped: "gone" };
    // No court email found yet = keep looking back 30 days, not just 2.
    const lookback = fresh || !mb.last_seen ? Math.max(days, 30) : days;
    const since = !fresh && mb.last_seen ? new Date(new Date(mb.last_seen).getTime() - 60e3) : new Date(Date.now() - lookback * 864e5);
    const token = await accessToken(mb);
    const r = mb.provider === "microsoft" ? await fetchMicrosoft(token, since) : await fetchGoogle(token, since);
    const user = { id: mb.user_id, firm_id: mb.firm_id, counties: mb.counties };
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
    if (r.scanned === 0 && lookback >= 30) {
      const det = await detect(mb.email);
      let inboxTotal = null;
      if (mb.provider === "microsoft") inboxTotal = await api("https://graph.microsoft.com/v1.0/me/mailFolders/inbox?$select=totalItemCount", token).then(j => j.totalItemCount).catch(e => "error: " + e.message);
      console.log(`[mail] mailbox ${id} diag: no email in last 30 days; inbox total=${inboxTotal}; @${det.domain} mail hosted by ${det.host || "unknown"} (mx ${(det.mx || []).slice(0, 2).join(", ") || "none"})`);
      const em = mb.email || "your email";
      note = det.provider === mb.provider
        ? `Connected, but this mailbox has no email from the last 30 days. Make sure you signed in with the ${mb.provider === "microsoft" ? "Microsoft 365" : "Google"} account for ${em}.`
        : det.provider === "google"
          ? `Your ${det.domain} email runs on Google Workspace, not Microsoft — the Microsoft sign-in opened an empty mailbox. Disconnect, then use Sign in with Gmail.`
          : `Your ${det.domain || ""} email is hosted by ${det.host || "another provider"}, not Microsoft — the Microsoft sign-in opened an empty mailbox, so there's nothing to read. Disconnect, and use forwarding under Court Updates → Other ways for now.`;
    }
    const stats = { note, scanned: r.scanned, from: r.first, to: r.last, court: r.msgs.length, checked: r.msgs.length, added, matched, created, dup, near: Object.fromEntries(nearTop), at: new Date().toISOString() };
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
async function rescanOld() {
  const { rows } = await q("SELECT m.id FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE u.active AND m.status <> 'reconnect' AND (m.stats IS NULL OR m.stats->>'scanned' IS NULL)");
  for (const r of rows) await syncMailbox(r.id, { days: 30, fresh: true });
  return rows.length;
}
async function syncAll() {
  const { rows } = await q("SELECT m.id FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE u.active AND m.status <> 'reconnect' ORDER BY m.last_sync NULLS FIRST LIMIT 200");
  for (const r of rows) await syncMailbox(r.id);
  return rows.length;
}

module.exports = { PROVIDERS, configured, startUrl, finish, syncMailbox, syncAll, rescanOld, running };

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
function adminConsentUrl(firmId, domain) {
  const state = crypto.randomBytes(16).toString("hex");
  adminStates.set(state, { firmId, domain, exp: Date.now() + 15 * 60e3 });
  const p = new URLSearchParams({ client_id: PROVIDERS.microsoft.id(), redirect_uri: `${APP}/api/mail/admin-callback/microsoft`, scope: "https://graph.microsoft.com/.default", state });
  return `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${p}`;
}
async function finishAdminConsent(query) {
  const st = adminStates.get(query.state); adminStates.delete(query.state);
  if (!st || st.exp < Date.now()) throw new Error("This approval link expired. Start again from Firm Seats.");
  if (query.error) throw new Error(query.error_description || "The admin did not approve access.");
  if (!query.tenant) throw new Error("Microsoft didn't return the firm's tenant.");
  await q(`INSERT INTO firm_mail(firm_id, provider, tenant, domain, status, last_error) VALUES($1,'microsoft',$2,$3,'ok',NULL)
    ON CONFLICT(firm_id) DO UPDATE SET provider='microsoft', tenant=$2, domain=$3, status='ok', last_error=NULL`, [st.firmId, query.tenant, st.domain]);
  await q("INSERT INTO audit_log(firm_id, action, detail) VALUES($1,'firm_mail_connected',$2)", [st.firmId, { provider: "microsoft", tenant: query.tenant, domain: st.domain }]);
  syncFirm(st.firmId, { days: 30 }).catch(() => {});
  return st;
}
const appTokens = new Map();
async function msAppToken(tenant) {
  const c = appTokens.get(tenant); if (c && c.exp > Date.now()) return c.tok;
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: PROVIDERS.microsoft.id(), client_secret: PROVIDERS.microsoft.secret(), grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }), signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || "Microsoft 365 firm access failed — the admin may need to approve again."), { reconnect: true });
  appTokens.set(tenant, { tok: j.access_token, exp: Date.now() + (j.expires_in - 120) * 1000 });
  return j.access_token;
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
async function connectGoogleFirm(firmId, domain, testEmail) {
  await googleDelegatedToken(testEmail); // throws if the admin hasn't authorized us yet
  await q(`INSERT INTO firm_mail(firm_id, provider, tenant, domain, status, last_error) VALUES($1,'google',NULL,$2,'ok',NULL)
    ON CONFLICT(firm_id) DO UPDATE SET provider='google', tenant=NULL, domain=$2, status='ok', last_error=NULL`, [firmId, domain]);
  await q("INSERT INTO audit_log(firm_id, action, detail) VALUES($1,'firm_mail_connected',$2)", [firmId, { provider: "google", domain }]);
  syncFirm(firmId, { days: 30 }).catch(() => {});
}

// ======================= Firm-wide sync =======================
async function syncFirm(firmId, { days = 2 } = {}) {
  const key = "firm" + firmId; if (running.has(key)) return { skipped: "running" }; running.add(key);
  try {
    const f = (await q("SELECT * FROM firm_mail WHERE firm_id=$1", [firmId])).rows[0]; if (!f) return { skipped: "none" };
    const users = (await q(`SELECT u.id, u.firm_id, u.counties, u.email, c.last_seen FROM users u LEFT JOIN mail_cursor c ON c.user_id=u.id
      WHERE u.firm_id=$1 AND u.active AND lower(split_part(u.email,'@',2))=lower($2)`, [firmId, f.domain])).rows;
    let checked = 0, added = 0, created = 0, people = 0; const errors = [];
    const appTok = f.provider === "microsoft" ? await msAppToken(f.tenant) : null;
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
