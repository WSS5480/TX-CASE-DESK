// Case links (Steve, Nov 20, 2026): private, read-only pages for ONE case.
//  - Client page: one link per client on the case (/c/<token>), made FOR a client contact on the case: style, cause #, court,
//    stage, court status, court dates (hearings and court settings) plus only the calendar items marked "Show on client page"
//    (never event notes), documents marked shared, and the invoices billed to that client on that case, with the pay link.
//  - Co-counsel / outside staff: one link per named person (/cc/<token>): overview, every upcoming date on the case (deadlines
//    included), the conversation log (never deleted entries, never earlier versions) and shared documents. They may ADD a
//    conversation entry (no edits, no deletes); it is stored with user_id NULL and link_id, shown in the app as
//    "NAME (co-counsel link)" with a "via co-counsel link" badge, audited (convo_add with link_id) and in the Activity log.
//    Never billing, invoices, trust, time, case notes, mail, AI or other cases.
// Who: anyone who can see the case sees that links exist; attorneys, partners, managers and firm admins (not paralegals) make,
// copy and turn off links (never shown in developer view). Demo firms can't make links and their pages are never served.
// Tokens: 32 random bytes. The database keeps a SHA-256 hash to find the link (no token comparison in code) and a copy sealed
// with CRED_KEY so the people who manage links can copy it again; a database copy alone can't open any page. Tokens are never
// written to the logs. Views are audited once per link per day, document downloads every time.
const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { q, pool } = require("./db");
const access = require("./access");
const box = require("./crypto-box");
const rt = require("./richtext");
const practice = require("./practice");

const APP = () => (process.env.APP_URL || "https://tx-case-desk.onrender.com").replace(/\/$/, "");
const PROD = process.env.NODE_ENV === "production";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sha = t => crypto.createHash("sha256").update(String(t)).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");   // 43 characters
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const seal = t => { try { return box.seal(t); } catch (e) { return null; } };   // no CRED_KEY: the link is shown once only
const unseal = s => { if (!s) return null; try { return box.open(s); } catch (e) { return null; } };
const MANAGE = u => !!u && u.role !== "paralegal";
const PATHS = { client: "c", cocounsel: "cc" };
const urlOf = (kind, token) => `${APP()}/${PATHS[kind]}/${token}`;
const ID = v => /^\d{1,9}$/.test(String(v)) ? +v : 0;
// control, bidi and zero-width characters: never kept (they can hide or reorder text); line breaks kept only where asked
const ODD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const line = (v, n) => String(v ?? "").normalize("NFC").replace(/[\t\n]/g, " ").replace(ODD, " ").replace(/\s+/g, " ").trim().slice(0, n);
const okEmail = e => !e || /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e);
const ROLES = ["Co-counsel", "Outside staff", "Expert", "Other"];
const KINDS = [["call", "Call"], ["meeting", "Meeting"], ["voicemail", "Voicemail"], ["email", "Email"], ["text", "Text message"], ["court", "Court / clerk"], ["note", "Note to file"]];
const KIND = Object.fromEntries(KINDS);
const ADDS_PER_HOUR = Math.max(1, +process.env.LINK_ADDS_PER_HOUR || 30);
const MAX_BODY = 10000, MAX_COCOUNSEL = 50;
const MSG = {
  manage: "Only attorneys and firm admins can make or turn off links.",
  demo: "Demo firm: client and co-counsel links are off (nothing in a demo is published).",
  off: "This link was turned off by the firm.",
  gone: "This link isn't active. Contact the firm for a new one.",
  noClient: "Add the client to this case first (People), then make their link.",
};
const TZ = "America/Chicago";

// ---- Texas (Central) time for the public form: the input has no time zone, so it's read as Central time
function tzOffset(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
function centralToDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/); if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let t = wall - tzOffset(wall); t = wall - tzOffset(t);   // twice: right across daylight-time changes
  const d = new Date(t); return isNaN(d) ? null : d;
}
const centralNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, "0")}:${p.minute}`; };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// a DATE column comes back from the database as a Date at local midnight: read its own year / month / day, never its text
const p2 = n => String(n).padStart(2, "0");
const ymd = v => v instanceof Date ? (isNaN(v) ? "" : `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`) : String(v || "").slice(0, 10);
const niceDay = d => { const s = ymd(d); const x = new Date(s + "T12:00:00Z"); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(x) ? x.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }) : ""; };
const niceAt = d => { const x = new Date(d); return isNaN(x) ? "" : x.toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); };
const usd = n => "$" + (Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- the form token on the co-counsel page (on top of the link token itself and the same-origin check)
const SECRET = process.env.SESSION_SECRET || "dev-secret";
const formTok = linkId => { const ts = Date.now().toString(36); return ts + "." + crypto.createHmac("sha256", SECRET).update(`cc|${linkId}|${ts}`).digest("base64url"); };
function formTokOk(linkId, v) {
  const [ts, mac] = String(v || "").split("."); if (!ts || !mac) return false;
  const age = Date.now() - parseInt(ts, 36); if (!(age >= 0 && age < 24 * 3600e3)) return false;
  const want = Buffer.from(crypto.createHmac("sha256", SECRET).update(`cc|${linkId}|${ts}`).digest("base64url")), got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Browsers that send Sec-Fetch-Site say exactly where a form came from; with Referrer-Policy no-referrer they send "Origin: null"
// for our own form, so Origin is only checked when it names a site.
function sameOrigin(req) {
  const sfs = req.get("Sec-Fetch-Site"); if (sfs) return sfs === "same-origin";
  const o = req.get("Origin"); if (!o || o === "null") return true;
  try { return new URL(o).host === req.get("host"); } catch (e) { return false; }
}
// "Your entry was added" shows once after the redirect: a short-lived cookie for this page only, cleared when it's shown
const FLASH = "tcd_cc_added";
const flashSet = (res, token) => res.append("Set-Cookie", `${FLASH}=1; Max-Age=120; Path=/cc/${token}; HttpOnly; SameSite=Strict${PROD ? "; Secure" : ""}`);
const flashTake = (req, res) => { if (!/(^|;\s*)tcd_cc_added=1(;|$)/.test(req.get("cookie") || "")) return false;
  res.append("Set-Cookie", `${FLASH}=; Max-Age=0; Path=/cc/${req.params.token}; HttpOnly; SameSite=Strict${PROD ? "; Secure" : ""}`); return true; };

// plain text typed on the public form -> the same safe paragraphs the app's notes use
const textToHtml = s => String(s).trim().split(/\n{2,}/).map(p => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
const cleanBody = s => String(s ?? "").normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(ODD, "");

function mount(app, { requireAuth, wrap, audit }) {
  // ---------------- inside the app ----------------
  const caseFor = async (user, id) => { const pr = [ID(id), user.firm_id], cond = access.caseCond(user, "c", pr);
    return (await q(`SELECT c.* FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0] || null; };
  const clientsOf = caseId => q("SELECT ct.id, ct.name FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1 AND cc.role='client' ORDER BY lower(ct.name), ct.id", [caseId]).then(r => r.rows);
  // the link itself: only to people who manage links, and never in developer view (read-only, it must not hand out access)
  const showUrl = (req, l) => { if (!MANAGE(req.user) || req.devView || l.revoked_at) return null; const t = unseal(l.token_enc); return t ? urlOf(l.kind, t) : null; };
  const shape = (l, req, extra = {}) => ({ id: l.id, kind: l.kind, name: l.kind === "client" ? l.contact_name || l.name : l.name, contact_id: l.contact_id, email: l.email, role_label: l.role_label, created_at: l.created_at, made_by: l.made_by || null,
    last_used_at: l.last_used_at, revoked_at: l.revoked_at, revoked_by: l.revoked_by_name || null, entries: l.entries || 0, url: showUrl(req, l), ...extra });
  const listFor = async (req, c) => {
    const user = req.user;
    const rows = (await q(`SELECT l.*, u.name AS made_by, r.name AS revoked_by_name, ct.name AS contact_name, (SELECT count(*)::int FROM case_convos v WHERE v.link_id=l.id AND v.deleted_at IS NULL) AS entries
      FROM case_links l LEFT JOIN users u ON u.id=l.created_by LEFT JOIN users r ON r.id=l.revoked_by LEFT JOIN contacts ct ON ct.id=l.contact_id
      WHERE l.case_id=$1 AND l.firm_id=$2 ORDER BY l.created_at DESC, l.id DESC LIMIT 300`, [c.id, user.firm_id])).rows;
    // an older per-contact client page (made on the contact before Nov 20, 2026) for a client on this case: still works until turned off
    const legacy = MANAGE(user) ? (await q(`SELECT ct.id, ct.name FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1 AND cc.role='client' AND ct.portal_token IS NOT NULL AND ct.firm_id=$2 ORDER BY ct.name`, [c.id, user.firm_id])).rows : [];
    return { can_manage: MANAGE(user) && !req.devView, demo: !!user.demo_until, client_contacts: await clientsOf(c.id),
      clients: rows.filter(l => l.kind === "client" && !l.revoked_at).map(l => shape(l, req)), cocounsel: rows.filter(l => l.kind === "cocounsel").map(l => shape(l, req)), legacy, roles: ROLES };
  };
  app.get("/api/cases/:id/links", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    res.json(await listFor(req, c));
  }));
  app.post("/api/cases/:id/links", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    if (!MANAGE(req.user)) return res.status(403).json({ error: MSG.manage, code: "ROLE" });
    if (req.user.demo_until) return res.status(403).json({ error: MSG.demo, code: "DEMO" });
    const b = req.body || {}, kind = b.kind === "cocounsel" ? "cocounsel" : b.kind === "client" ? "client" : null;
    if (!kind) return res.status(400).json({ error: "Pick the kind of link." });
    for (const k of ["name", "email", "role_label"]) if (b[k] != null && typeof b[k] !== "string") return res.status(400).json({ error: "Give the details as plain text." });
    let name = line(b.name, 120), email = line(b.email, 200).toLowerCase(), role = line(b.role_label, 60), contactId = null;
    if (kind === "cocounsel") {
      if (!name) return res.status(400).json({ error: "Add the person's name." });
      if (!okEmail(email)) return res.status(400).json({ error: "Check the email address." });
      role = ROLES.find(r => r.toLowerCase() === role.toLowerCase()) || role || "Co-counsel";
    } else {
      // made FOR one client on the case: the one picked, or the only one
      const cls = await clientsOf(c.id);
      if (!cls.length) return res.status(400).json({ error: MSG.noClient, code: "NO_CLIENT" });
      const pick = b.contact_id != null && b.contact_id !== "" ? cls.find(x => x.id === ID(b.contact_id)) : cls.length === 1 ? cls[0] : null;
      if (!pick) return res.status(400).json({ error: cls.length > 1 && (b.contact_id == null || b.contact_id === "") ? "Pick which client the link is for." : "That person isn't a client on this case.", code: "PICK_CLIENT" });
      contactId = pick.id; name = pick.name; email = ""; role = "";
    }
    const token = newToken(); let made, replaced = null, fail = null; const cl = await pool.connect(); let rbErr;
    try {
      await cl.query("BEGIN");
      await cl.query("SELECT id FROM cases WHERE id=$1 AND firm_id=$2 FOR UPDATE", [c.id, req.user.firm_id]);   // one change to this case's links at a time
      if (kind === "client") replaced = (await cl.query("UPDATE case_links SET revoked_at=now(), revoked_by=$4 WHERE case_id=$1 AND firm_id=$2 AND kind='client' AND contact_id=$3 AND revoked_at IS NULL RETURNING id", [c.id, req.user.firm_id, contactId, req.user.id])).rows[0] || null;
      else if ((await cl.query("SELECT count(*)::int n FROM case_links WHERE case_id=$1 AND kind='cocounsel' AND revoked_at IS NULL", [c.id])).rows[0].n >= MAX_COCOUNSEL) throw Object.assign(new Error(`A case can have up to ${MAX_COCOUNSEL} co-counsel links. Turn one off first.`), { status: 400 });
      made = (await cl.query(`INSERT INTO case_links(firm_id, case_id, kind, token_hash, token_enc, name, email, role_label, contact_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [req.user.firm_id, c.id, kind, sha(token), seal(token), name || null, email || null, role || null, contactId, req.user.id])).rows[0];
      await cl.query("COMMIT");
    } catch (e) { await cl.query("ROLLBACK").catch(x => { rbErr = x; }); fail = e; }
    finally { cl.release(rbErr); }
    if (fail) { if (fail.status) return res.status(fail.status).json({ error: fail.message }); throw fail; }
    if (replaced) await audit(req, "link_revoked", { case_id: c.id, link_id: replaced.id, kind, name, replaced_by: made.id });
    await audit(req, "link_made", { case_id: c.id, link_id: made.id, kind, name: made.name, role: made.role_label, contact_id: contactId, replaced: replaced ? replaced.id : null });
    res.json({ link: shape({ ...made, made_by: req.user.name }, req, { url: urlOf(kind, token) }), url: urlOf(kind, token) });   // the full link is returned here even without CRED_KEY
  }));
  app.post("/api/cases/:id/links/:lid/revoke", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    if (!MANAGE(req.user)) return res.status(403).json({ error: MSG.manage, code: "ROLE" });
    const l = (await q("UPDATE case_links SET revoked_at=now(), revoked_by=$4 WHERE id=$1 AND case_id=$2 AND firm_id=$3 AND revoked_at IS NULL RETURNING *", [ID(req.params.lid), c.id, req.user.firm_id, req.user.id])).rows[0];
    if (!l) { const was = (await q("SELECT id FROM case_links WHERE id=$1 AND case_id=$2 AND firm_id=$3", [ID(req.params.lid), c.id, req.user.firm_id])).rows[0];
      return was ? res.json({ ok: true, already: true }) : res.status(404).json({ error: "Not found" }); }
    await audit(req, "link_revoked", { case_id: c.id, link_id: l.id, kind: l.kind, name: l.name });
    res.json({ ok: true });
  }));

  // ---------------- the public pages ----------------
  const pub = rateLimit({ windowMs: 60e3, max: 300, standardHeaders: true, legacyHeaders: false, message: "Too many requests. Wait a minute and try again." });
  // strict policy: no scripts at all, styles inline only, images from this site, the form posts only here, never framed
  const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  const HEAD = { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP };
  const footer = `<footer class="pw"><a href="/" rel="noopener">Powered by <b>TX Case Desk</b></a> — case management for Texas attorneys</footer>`;
  const CSS = `<style>.pw{margin:26px 0 10px;padding-top:14px;border-top:1px solid #e4e2db;text-align:center;color:#545b66;font-size:12.5px}.pw a{color:#3f4652;text-decoration:none;display:inline-block;min-height:24px}.pw a:hover{text-decoration:underline}
.brand a{color:inherit}.greet{font-family:Georgia,serif;font-size:20px;font-weight:600;margin:0 0 2px}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 18px;margin:10px 0 0}.meta div{min-width:0}.meta b{display:block;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#5d6470;font-weight:600}.meta span{overflow-wrap:anywhere}
.it{display:grid;grid-template-columns:1fr;gap:2px;border-top:1px solid #eee;padding:9px 0}.it:first-of-type{border-top:0}.it .d{font-weight:600}.it .t{min-width:0;overflow-wrap:anywhere}
@media (min-width:620px){.it{grid-template-columns:240px 1fr;gap:12px;align-items:baseline}}
.inv{border-top:1px solid #eee;padding:10px 0;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center}.inv:first-of-type{border-top:0}.inv .n{font-weight:600}.inv .a{flex:1;min-width:150px}
.tag{display:inline-block;font-size:12px;border-radius:999px;padding:1px 9px;background:#eef0f4;color:#344054;margin-right:6px}.tag.dl{background:#fdecec;color:#8a1c1c}.tag.h{background:#e8eefc;color:#1d3a8a}.tag.cc{background:#fff4d6;color:#7a5200}
.cv{border-top:1px solid #eee;padding:10px 0}.cv:first-of-type{border-top:0}.cvh{display:flex;gap:6px 10px;flex-wrap:wrap;align-items:center;font-size:14px}.cvh b{overflow-wrap:anywhere;min-width:0}.cvb{margin-top:4px;overflow-wrap:anywhere}.cvb p{margin:0 0 6px}.cvf{color:#5d6470;font-size:12.5px}
form.add label{display:block;font-size:13px;font-weight:600;margin:10px 0 3px}form.add input,form.add select,form.add textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #cfd4dc;border-radius:8px;background:#fff;min-height:44px}
form.add textarea{min-height:130px;resize:vertical}.g2{display:grid;grid-template-columns:1fr;gap:0 14px}
@media (min-width:620px){.g2{grid-template-columns:repeat(3,minmax(0,1fr))}.g2 .w2{grid-column:span 2}}
.err{background:#fdecec;border:1px solid #f3c2c2;color:#8a1c1c;border-radius:10px;padding:10px 12px;margin:0 0 12px}
.docs a{display:flex;align-items:center;min-height:44px;padding:4px 0;border-top:1px solid #eee;overflow-wrap:anywhere}.docs a:first-child{border-top:0}h1{overflow-wrap:anywhere;margin:4px 0 2px}.btn{min-height:44px;box-sizing:border-box;line-height:20px}</style>`;
  const send = (res, status, title, body) => res.status(status).set(HEAD).send(practice.page(title, body + footer).replace("</head>", CSS + "</head>"));
  const brand = l => practice.brandHead({ name: l.firm_name, address: l.firm_address, phone: l.firm_phone, email: l.firm_email, website: l.firm_website, logo_token: l.logo_token });
  async function linkBy(token, kind) {
    if (!TOKEN_RE.test(String(token || ""))) return null;
    // a client link needs its client still on the case as a client (removed from the case: the page is gone)
    return (await q(`SELECT l.*, f.name AS firm_name, f.address AS firm_address, f.phone AS firm_phone, f.firm_email, f.website AS firm_website, f.logo_token, f.demo_until,
        c.style, c.cause_no, c.county, c.court, c.stage, c.status, c.case_type, ct.name AS contact_name,
        (l.kind <> 'client' OR EXISTS (SELECT 1 FROM case_contacts cc WHERE cc.case_id=l.case_id AND cc.contact_id=l.contact_id AND cc.role='client')) AS on_case
      FROM case_links l JOIN firms f ON f.id=l.firm_id JOIN cases c ON c.id=l.case_id AND c.firm_id=l.firm_id LEFT JOIN contacts ct ON ct.id=l.contact_id AND ct.firm_id=l.firm_id
      WHERE l.token_hash=$1 AND l.kind=$2`, [sha(token), kind])).rows[0] || null;
  }
  const auditPub = (req, l, action, detail) => q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES(NULL,$1,$2,$3,$4)", [l.firm_id, action, { case_id: l.case_id, link_id: l.id, kind: l.kind, ...detail }, req.ip])
    .catch(e => console.error(`[links] audit ${action} failed for link ${l.id}:`, e.message));
  // a missing / demo link: 404; a turned-off link: 410 with the firm's name
  async function open(req, res, kind) {
    const l = await linkBy(req.params.token, kind);
    if (!l || l.demo_until || !l.on_case) { send(res, 404, "Link not active", `<div class="card"><h1>Link not active</h1><p>${esc(MSG.gone)}</p></div>`); return null; }
    if (l.revoked_at) { send(res, 410, `${l.firm_name}`, `${brand(l)}<div class="card"><h1>Link turned off</h1><p>${esc(MSG.off)}</p><p class="mute">If you still need access, contact ${esc(l.firm_name)}.</p></div>`); return null; }
    if (!l.last_used_at || Date.now() - new Date(l.last_used_at) > 60e3) await q("UPDATE case_links SET last_used_at=now() WHERE id=$1", [l.id]).catch(() => {});
    // one audit row per link per day for page views (the first view of the day, Texas time)
    if ((await q("UPDATE case_links SET view_day=$2 WHERE id=$1 AND view_day IS DISTINCT FROM $2::date RETURNING id", [l.id, today()]).catch(() => ({ rowCount: 0 }))).rowCount) await auditPub(req, l, "case_link_view", {});
    return l;
  }
  const caseCard = l => `<div class="card"><div class="mute">${esc(l.county ? l.county + " County" : "")}${l.case_type ? " · " + esc(l.case_type) : ""}</div><h1>${esc(l.style || l.cause_no)}</h1>
    <div class="meta"><div><b>Cause No.</b><span>${/^PRE-/.test(l.cause_no || "") ? "Not filed yet" : esc(l.cause_no)}</span></div><div><b>Court</b><span>${esc([l.court, l.county ? l.county + " County" : ""].filter(Boolean).join(", ") || "—")}</span></div>
      <div><b>Stage</b><span>${esc(l.stage || "—")}</span></div><div><b>Court status</b><span>${esc(l.status || "—")}</span></div></div></div>`;
  const docsCard = (l, base) => q("SELECT id, name, created_at FROM documents WHERE case_id=$1 AND firm_id=$2 AND shared ORDER BY id DESC LIMIT 200", [l.case_id, l.firm_id])
    .then(r => `<div class="card"><h2>Documents</h2>${r.rows.length ? `<div class="docs">${r.rows.map(d => `<a href="${base}/doc/${d.id}">${esc(d.name)}</a>`).join("")}</div>` : `<p class="mute" style="margin:0">No documents shared yet.</p>`}</div>`);
  const dates = async l => (await practice.SHARED.calendarItems(l.firm_id, { from: today(), to: addDays(today(), 365), caseId: l.case_id })).filter(i => !i.done);
  const KL = { hearing: ["Court date", "h"], deadline: ["Deadline", "dl"], meeting: ["Meeting", ""], event: ["Date", ""] };
  // date first on its own line on phones, beside on wider screens; the type tag always sits before the title (never any notes)
  const dateRow = e => `<div class="it"><span class="d">${esc(niceDay(e.date))}${e.time ? " · " + esc(e.time) : ""}</span><span class="t"><span class="tag ${KL[e.kind]?.[1] || ""}">${esc(KL[e.kind]?.[0] || "Date")}</span>${esc(e.title)}${e.location ? ` <span class="mute">· ${esc(e.location)}</span>` : ""}</span></div>`;

  // Client page
  app.all(["/c/:token", "/c/:token/*"], pub, (req, res, next) => req.method === "GET" || req.method === "HEAD" ? next() : res.status(405).set({ Allow: "GET", "Cache-Control": "no-store" }).send("This page is read-only."));
  app.get("/c/:token", wrap(async (req, res) => {
    const l = await open(req, res, "client"); if (!l) return;
    // court dates (hearings, court settings) always; anything else only when marked "Show on client page"
    const ev = (await dates(l)).filter(e => e.kind === "hearing" || e.client_visible), next = ev.find(e => e.kind === "hearing");
    const invs = (await q("SELECT number, total, paid, pay_token, due, status FROM invoices WHERE case_id=$1 AND firm_id=$2 AND contact_id=$3 AND status IN ('sent','paid') ORDER BY id DESC LIMIT 50", [l.case_id, l.firm_id, l.contact_id])).rows;
    const first = String(l.contact_name || l.name || "").trim().split(/\s+/)[0];
    send(res, 200, `${l.firm_name} — your case`, `${brand(l)}<p class="greet">${first ? `Hello, ${esc(first)}` : "Your case"}</p><p class="mute" style="margin-top:0">Updates on your case from ${esc(l.firm_name)}. This page is read-only. Questions? Contact your attorney directly.</p>
      ${caseCard(l)}
      <div class="card"><h2>Next court date</h2><p style="margin:0">${next ? `<b>${esc(niceDay(next.date))}${next.time ? " at " + esc(next.time) : ""}</b> — ${esc(next.title)}` : "None scheduled yet."}</p></div>
      <div class="card"><h2>Upcoming dates</h2>${ev.length ? ev.slice(0, 20).map(dateRow).join("") : `<p class="mute" style="margin:0">Nothing scheduled yet.</p>`}</div>
      ${await docsCard(l, `/c/${esc(req.params.token)}`)}
      <div class="card"><h2>Invoices</h2>${invs.length ? invs.map(i => { const bal = Number(i.total) - Number(i.paid), open = bal > 0.004 && i.status !== "paid";
        return `<div class="inv"><span class="n">#${esc(i.number)}</span><span class="a">${usd(i.total)}${i.due ? ` <span class="mute">· due ${esc(niceDay(i.due))}</span>` : ""}${open ? ` <span class="mute">· balance ${usd(bal)}</span>` : ""}</span>${open ? (i.pay_token ? `<a class="btn" href="/pay/${esc(i.pay_token)}">View and pay</a>` : "") : `<span class="tag">Paid</span>`}</div>`; }).join("") : `<p class="mute" style="margin:0">No invoices.</p>`}</div>`);
  }));
  // Co-counsel / outside staff page
  app.all(["/cc/:token", "/cc/:token/*"], pub, (req, res, next) => req.method === "GET" || req.method === "HEAD" || (req.method === "POST" && req.path.endsWith("/log")) ? next() : res.status(405).set({ Allow: "GET", "Cache-Control": "no-store" }).send("Not allowed."));
  async function ccPage(req, res, l, { status = 200, err = "", form = {}, added = false } = {}) {
    const ev = await dates(l);
    const log = (await q(`SELECT v.id, v.at, v.kind, v.with_name, v.direction, v.minutes, v.body, v.updated_at, v.link_id, u.name AS staff, k.name AS link_name, k.role_label AS link_role
      FROM case_convos v LEFT JOIN users u ON u.id=v.user_id LEFT JOIN case_links k ON k.id=v.link_id WHERE v.case_id=$1 AND v.firm_id=$2 AND v.deleted_at IS NULL ORDER BY v.at DESC, v.id DESC LIMIT 300`, [l.case_id, l.firm_id])).rows;
    const base = `/cc/${esc(req.params.token)}`, f = { kind: "call", at: centralNow(), direction: "", ...form };
    send(res, status, `${l.firm_name} — ${l.style || l.cause_no}`, `${brand(l)}<p class="mute" style="margin:0 0 10px">Shared with <b>${esc(l.name || "you")}</b>${l.role_label ? ` (${esc(l.role_label)})` : ""} by ${esc(l.firm_name)}. This link shows this one case only.</p>
      ${caseCard(l)}
      <div class="card"><h2>Upcoming dates</h2>${ev.length ? ev.slice(0, 50).map(dateRow).join("") : `<p class="mute" style="margin:0">Nothing scheduled.</p>`}</div>
      <div class="card" id="log"><h2>Conversation log</h2>${added ? `<div class="card ok" role="status" style="margin:0 0 10px">Your entry was added to the log.</div>` : ""}
        ${log.length ? log.map(v => `<div class="cv"><div class="cvh"><span class="tag">${esc(KIND[v.kind] || "Entry")}</span>${v.direction === "in" ? `<span class="mute">Incoming</span>` : v.direction === "out" ? `<span class="mute">Outgoing</span>` : ""}${v.with_name ? `<b>${esc(v.with_name)}</b>` : ""}<span class="mute">${esc(niceAt(v.at))}${v.minutes ? " · " + +v.minutes + " min" : ""}</span>${v.link_id ? `<span class="tag cc">via co-counsel link</span>` : ""}</div>
          <div class="cvb">${rt.isRich(v.body) ? rt.sanitize(v.body) : esc(v.body || "").replace(/\n/g, "<br>")}</div><div class="cvf">Logged by ${esc(v.link_id ? `${v.link_name || "Co-counsel"} (co-counsel link)` : v.staff || "the firm")}${v.updated_at ? " · edited" : ""}</div></div>`).join("") : `<p class="mute" style="margin:0">No conversations logged yet.</p>`}</div>
      <div class="card"><h2>Add to the conversation log</h2><p class="mute" style="margin:0">Your entry goes to ${esc(l.firm_name)}'s log for this case with your name. Once added it can't be changed or removed from here.</p>
        ${err ? `<div class="err" role="alert" style="margin-top:10px">${esc(err)}</div>` : ""}
        <form class="add" method="post" action="${base}/log"><input type="hidden" name="ft" value="${esc(formTok(l.id))}">
          <div class="g2"><div><label for="k">Type</label><select id="k" name="kind">${KINDS.map(([k, v]) => `<option value="${k}"${f.kind === k ? " selected" : ""}>${v}</option>`).join("")}</select></div>
            <div><label for="at">When (Texas time)</label><input id="at" type="datetime-local" name="at" required value="${esc(f.at)}"></div>
            <div><label for="dir">Direction</label><select id="dir" name="direction"><option value="">—</option><option value="in"${f.direction === "in" ? " selected" : ""}>Incoming</option><option value="out"${f.direction === "out" ? " selected" : ""}>Outgoing</option></select></div>
            <div class="w2"><label for="w">With whom</label><input id="w" name="with_name" maxlength="200" value="${esc(f.with_name || "")}" placeholder="e.g. adjuster"></div>
            <div><label for="m">Minutes</label><input id="m" name="minutes" type="number" min="0" max="1440" step="1" inputmode="numeric" value="${esc(f.minutes ?? "")}"></div></div>
          <label for="b">What was said</label><textarea id="b" name="body" maxlength="${MAX_BODY}" required>${esc(f.body || "")}</textarea>
          <p style="margin:12px 0 0"><button class="btn" type="submit">Add to the log</button></p></form></div>
      ${await docsCard(l, base)}`);
  }
  app.get("/cc/:token", wrap(async (req, res) => { const l = await open(req, res, "cocounsel"); if (l) await ccPage(req, res, l, { added: flashTake(req, res) }); }));
  app.post("/cc/:token/log", express.urlencoded({ extended: false, limit: "200kb", parameterLimit: 20 }), wrap(async (req, res) => {
    const l = await open(req, res, "cocounsel"); if (!l) return;
    const b = req.body || {}, s = k => typeof b[k] === "string" ? b[k] : "";
    const form = { kind: s("kind"), at: s("at"), with_name: s("with_name").slice(0, 200), direction: s("direction"), minutes: s("minutes"), body: s("body").slice(0, MAX_BODY + 1000) };
    const bad = (status, err) => ccPage(req, res, l, { status, err, form });
    if (!sameOrigin(req) || !formTokOk(l.id, s("ft"))) return bad(403, "This form expired. Reload the page and try again.");
    const kind = KINDS.some(([k]) => k === form.kind) ? form.kind : null; if (!kind) return bad(400, "Pick a type.");
    const at = centralToDate(form.at); if (!at || at.getFullYear() < 1990 || at > new Date(Date.now() + 366 * 864e5)) return bad(400, "Check the date and time.");
    const minutes = form.minutes.trim() === "" ? null : Number(form.minutes); if (minutes != null && !(Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440)) return bad(400, "Check the minutes (0 to 1440).");
    const direction = ["in", "out"].includes(form.direction) ? form.direction : null;
    const text = cleanBody(s("body")); if (!text.trim()) return bad(400, "Write what was said.");
    if (text.length > MAX_BODY) return bad(400, `That's too long (${MAX_BODY.toLocaleString("en-US")} characters at most).`);
    const body = rt.cleanNotes(textToHtml(text)), withName = line(form.with_name, 200) || null;
    let id = null, fail = null; const cl = await pool.connect(); let rbErr;
    try {
      await cl.query("BEGIN");
      const cur = (await cl.query("SELECT revoked_at FROM case_links WHERE id=$1 FOR UPDATE", [l.id])).rows[0];   // adds through one link go one at a time
      if (!cur || cur.revoked_at) throw Object.assign(new Error(MSG.off), { status: 410 });
      const n = (await cl.query("SELECT count(*)::int n FROM case_convos WHERE link_id=$1 AND created_at > now() - interval '1 hour'", [l.id])).rows[0].n;
      if (n >= ADDS_PER_HOUR) throw Object.assign(new Error(`That's ${ADDS_PER_HOUR} entries in the last hour, the most this link can add. Try again later.`), { status: 429 });
      // the same entry sent twice (a double tap, or the browser re-sending the form): same type, time and words, saved once
      const dup = (await cl.query("SELECT 1 FROM case_convos WHERE link_id=$1 AND kind=$2 AND at=$3 AND body=$4 AND created_at > now() - interval '10 minutes'", [l.id, kind, at.toISOString(), body])).rowCount > 0;
      if (!dup) id = (await cl.query(`INSERT INTO case_convos(firm_id, case_id, at, kind, with_name, body, user_id, direction, minutes, link_id) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9) RETURNING id`,
        [l.firm_id, l.case_id, at.toISOString(), kind, withName, body, direction, minutes, l.id])).rows[0].id;
      await cl.query("COMMIT");
    } catch (e) { await cl.query("ROLLBACK").catch(x => { rbErr = x; }); fail = e; }
    finally { cl.release(rbErr); }   // a connection that couldn't roll back is closed, not reused
    if (fail) {
      if (fail.status === 410) return send(res, 410, l.firm_name, `${brand(l)}<div class="card"><h1>Link turned off</h1><p>${esc(MSG.off)}</p></div>`);
      if (fail.status) return bad(fail.status, fail.message);
      throw fail;
    }
    if (id) await auditPub(req, l, "convo_add", { convo_id: id, kind, via: "cocounsel_link", name: l.name });
    flashSet(res, req.params.token);
    res.redirect(303, `/cc/${req.params.token}#log`);
  }));
  // shared documents of THIS case only; every download audited
  for (const [kind, p] of [["client", "c"], ["cocounsel", "cc"]]) app.get(`/${p}/:token/doc/:id`, wrap(async (req, res) => {
    const l = await open(req, res, kind); if (!l) return;
    const d = (await q("SELECT id, name, mime, data FROM documents WHERE id=$1 AND case_id=$2 AND firm_id=$3 AND shared", [ID(req.params.id), l.case_id, l.firm_id])).rows[0];
    if (!d) return send(res, 404, "Not found", `<div class="card"><h1>Not found</h1><p>This document isn't shared on this page.</p></div>`);
    await auditPub(req, l, "case_link_download", { doc_id: d.id, name: d.name });
    const n = String(d.name || "file");
    res.set({ "Content-Type": d.mime || "application/octet-stream", "Content-Disposition": `attachment; filename="${n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(n)}`,
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": "default-src 'none'; sandbox" }).send(d.data);
  }));
  // anything that goes wrong on these pages: a plain page (never raw JSON), and the token never goes into the log
  app.use(["/c", "/cc"], (err, req, res, next) => {
    const big = err && (err.type === "entity.too.large" || err.type === "parameters.too.many" || err.status === 413);
    const bad = err && (err.type === "entity.parse.failed" || err.type === "encoding.unsupported" || err.type === "charset.unsupported");
    const path = String(req.originalUrl || "").split("?")[0];
    console.warn(`[links] ${err && err.type ? err.type : "error"} on ${req.method} ${path.replace(/^\/(c|cc)\/[^/]+/, "/$1/[token]")}${big || bad ? "" : ": " + String(err && err.message).replace(/[A-Za-z0-9_-]{43}/g, "[token]")}`);
    const back = String(req.originalUrl || "").split("?")[0].replace(/\/log$/, ""), backOk = /^\/(c|cc)\/[A-Za-z0-9_-]{43}$/.test(back);
    const msg = big ? "That was too much to send at once. Go back, shorten the entry and try again." : bad ? "That form couldn't be read. Go back and try again." : "Something went wrong. Please try again in a moment.";
    send(res, big ? 413 : bad ? 400 : 500, "Couldn't save", `<div class="card"><h1>${big ? "Too long to send" : "Something went wrong"}</h1><p>${esc(msg)}</p>${backOk ? `<p><a class="btn" href="${esc(back)}">Back to the page</a></p>` : ""}</div>`);
  });
}
module.exports = { mount, MSG, _test: { centralToDate, sha, TOKEN_RE, niceDay, cleanBody } };
