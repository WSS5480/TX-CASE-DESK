// Texas Case Desk — server
const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const path = require("path");
const QRCode = require("qrcode");
const { authenticator } = require("otplib");
const { pool, q, migrate } = require("./db");
const cl = require("./courtlistener");
const { COUNTIES, APPEALS, CONNECTORS } = require("./counties");
const sync = require("./sync");
const box = require("./crypto-box");

authenticator.options = { window: 1 };
const PROD = process.env.NODE_ENV === "production";
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"] } } }));
app.use(express.json({ limit: "2mb" }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  name: "tcd.sid",
  secret: process.env.SESSION_SECRET || (PROD ? (() => { throw new Error("SESSION_SECRET required"); })() : "dev-secret"),
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: "strict", secure: PROD, maxAge: 8 * 3600e3 } // 8-hour sessions
}));

// CSRF guard: every state-changing call must come from our own page (custom header can't be sent cross-site).
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.get("X-Requested-With") !== "tcd") return res.status(403).json({ error: "Bad request origin" });
  next();
});

const loginLimiter = rateLimit({ windowMs: 15 * 60e3, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Wait 15 minutes." } });

// ---------- helpers ----------
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
const isBar = s => /^\d{8}$/.test(s || "");
const strongPw = s => typeof s === "string" && s.length >= 10 && /[A-Za-z]/.test(s) && /\d/.test(s);
const tempPw = () => crypto.randomBytes(9).toString("base64url");
async function audit(req, action, detail = {}) {
  const u = req.user || {};
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,$3,$4,$5)", [u.id || req.session?.pendingUid || null, u.firm_id || null, action, detail, req.ip]).catch(() => {});
}
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, bar_number: u.bar_number, role: u.role, firm_id: u.firm_id, firm_name: u.firm_name,
    counties: u.counties || [], totp_enabled: u.totp_enabled, must_change_pw: u.must_change_pw };
}
async function loadUser(id) {
  const { rows } = await q("SELECT u.*, f.name AS firm_name FROM users u JOIN firms f ON f.id=u.firm_id WHERE u.id=$1 AND u.active", [id]);
  return rows[0];
}
const requireAuth = wrap(async (req, res, next) => {
  if (!req.session.uid || !req.session.mfa) return res.status(401).json({ error: "Sign in required" });
  req.user = await loadUser(req.session.uid);
  if (!req.user) { req.session.destroy(() => {}); return res.status(401).json({ error: "Account disabled" }); }
  if (req.user.must_change_pw && !["/api/me", "/api/password", "/api/logout"].includes(req.originalUrl.split("?")[0]))
    return res.status(403).json({ error: "Change your temporary password first", code: "CHANGE_PW" });
  next();
});
const requireAdmin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Firm admins only" });

// ---------- reference ----------
app.get("/api/meta", (req, res) => res.json({ counties: COUNTIES, appeals: APPEALS, connectors: CONNECTORS, courts: cl.TX_COURTS, caseLawLive: true, tokenSet: !!process.env.COURTLISTENER_TOKEN }));
app.get("/healthz", (req, res) => res.send("ok"));

// ---------- signup / login / 2FA ----------
app.post("/api/signup", loginLimiter, wrap(async (req, res) => {
  const { firm, name, email, bar, password } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  if (!firm || !name || !isEmail(em) || !isBar(bar)) return res.status(400).json({ error: "Firm, name, valid email and 8-digit Texas bar # are required." });
  if (!strongPw(password)) return res.status(400).json({ error: "Password must be 10+ characters with letters and numbers." });
  const exists = await q("SELECT 1 FROM users WHERE email=$1", [em]);
  if (exists.rowCount) return res.status(409).json({ error: "That email is already registered." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const f = await client.query("INSERT INTO firms(name) VALUES($1) RETURNING id", [String(firm).trim()]);
    const u = await client.query("INSERT INTO users(firm_id,email,name,bar_number,role,pw_hash) VALUES($1,$2,$3,$4,'admin',$5) RETURNING id",
      [f.rows[0].id, em, String(name).trim(), bar, await bcrypt.hash(password, 12)]);
    await client.query("COMMIT");
    req.session.regenerate(() => { req.session.pendingUid = u.rows[0].id; audit(req, "signup", { email: em }); res.json({ next: "enroll_2fa" }); });
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}));

app.post("/api/login", loginLimiter, wrap(async (req, res) => {
  const em = String(req.body?.email || "").trim().toLowerCase();
  const { rows } = await q("SELECT * FROM users WHERE email=$1 AND active", [em]);
  const u = rows[0];
  const ok = u && await bcrypt.compare(String(req.body?.password || ""), u.pw_hash);
  if (!ok) { await q("INSERT INTO audit_log(action, detail, ip) VALUES('login_failed',$1,$2)", [{ email: em }, req.ip]); return res.status(401).json({ error: "Wrong email or password." }); }
  req.session.regenerate(() => {
    req.session.pendingUid = u.id;
    res.json({ next: u.totp_enabled ? "verify_2fa" : "enroll_2fa" });
  });
}));

app.get("/api/2fa/setup", wrap(async (req, res) => {
  const uid = req.session.pendingUid;
  if (!uid) return res.status(401).json({ error: "Sign in first" });
  const { rows } = await q("SELECT email, totp_enabled, totp_secret FROM users WHERE id=$1", [uid]);
  if (!rows[0] || rows[0].totp_enabled) return res.status(400).json({ error: "2FA already set up" });
  let secret = rows[0].totp_secret;
  if (!secret) { secret = authenticator.generateSecret(); await q("UPDATE users SET totp_secret=$1 WHERE id=$2", [secret, uid]); }
  const uri = authenticator.keyuri(rows[0].email, "TX Case Desk", secret);
  res.json({ qr: await QRCode.toDataURL(uri), secret });
}));

async function finishMfa(req, res, uid, action) {
  await q("UPDATE users SET last_login=now() WHERE id=$1", [uid]);
  req.session.regenerate(async () => {
    req.session.uid = uid; req.session.mfa = true;
    req.user = await loadUser(uid);
    await audit(req, action);
    res.json({ user: publicUser(req.user) });
    sync.syncUserIfStale(uid).catch(() => {}); // pull this attorney's counties when they sign in
  });
}
app.post("/api/2fa/enable", loginLimiter, wrap(async (req, res) => {
  const uid = req.session.pendingUid;
  if (!uid) return res.status(401).json({ error: "Sign in first" });
  const { rows } = await q("SELECT totp_secret FROM users WHERE id=$1", [uid]);
  if (!rows[0]?.totp_secret || !authenticator.check(String(req.body?.code || "").replace(/\s/g, ""), rows[0].totp_secret))
    return res.status(400).json({ error: "Code didn't match. Check your authenticator app's time and try again." });
  await q("UPDATE users SET totp_enabled=true WHERE id=$1", [uid]);
  await finishMfa(req, res, uid, "2fa_enabled");
}));
app.post("/api/login/2fa", loginLimiter, wrap(async (req, res) => {
  const uid = req.session.pendingUid;
  if (!uid) return res.status(401).json({ error: "Sign in first" });
  const { rows } = await q("SELECT totp_secret, totp_enabled FROM users WHERE id=$1 AND active", [uid]);
  if (!rows[0]?.totp_enabled || !authenticator.check(String(req.body?.code || "").replace(/\s/g, ""), rows[0].totp_secret))
    return res.status(401).json({ error: "Wrong code." });
  await finishMfa(req, res, uid, "login");
}));

app.post("/api/logout", (req, res) => req.session.destroy(() => { res.clearCookie("tcd.sid"); res.json({ ok: true }); }));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/password", requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!await bcrypt.compare(String(current || ""), req.user.pw_hash)) return res.status(400).json({ error: "Current password is wrong." });
  if (!strongPw(next)) return res.status(400).json({ error: "New password must be 10+ characters with letters and numbers." });
  await q("UPDATE users SET pw_hash=$1, must_change_pw=false WHERE id=$2", [await bcrypt.hash(next, 12), req.user.id]);
  await audit(req, "password_changed");
  res.json({ ok: true });
}));

app.put("/api/me/counties", requireAuth, wrap(async (req, res) => {
  const list = [...new Set((req.body?.counties || []).filter(c => COUNTIES.includes(c)))];
  await q("UPDATE users SET counties=$1 WHERE id=$2", [list, req.user.id]);
  await audit(req, "counties_set", { counties: list });
  res.json({ counties: list });
}));

// ---------- firm seats (admin) ----------
app.get("/api/firm/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await q("SELECT id,email,name,bar_number,role,counties,totp_enabled,active,last_login FROM users WHERE firm_id=$1 ORDER BY name", [req.user.firm_id]);
  res.json({ users: rows });
}));
app.post("/api/firm/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { name, email, bar, role } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  if (!name || !isEmail(em) || !["admin", "attorney", "paralegal"].includes(role)) return res.status(400).json({ error: "Name, email and role required." });
  if (role !== "paralegal" && !isBar(bar)) return res.status(400).json({ error: "Attorneys need an 8-digit Texas bar #." });
  if ((await q("SELECT 1 FROM users WHERE email=$1", [em])).rowCount) return res.status(409).json({ error: "Email already registered." });
  const pw = tempPw();
  const { rows } = await q("INSERT INTO users(firm_id,email,name,bar_number,role,pw_hash,must_change_pw) VALUES($1,$2,$3,$4,$5,$6,true) RETURNING id",
    [req.user.firm_id, em, String(name).trim(), role === "paralegal" ? (bar || null) : bar, role, await bcrypt.hash(pw, 12)]);
  await audit(req, "seat_added", { id: rows[0].id, email: em, role });
  res.json({ id: rows[0].id, temp_password: pw });
}));
app.patch("/api/firm/users/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id && req.body.active === false) return res.status(400).json({ error: "You can't disable yourself." });
  const { rows } = await q("SELECT id FROM users WHERE id=$1 AND firm_id=$2", [id, req.user.firm_id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  if (typeof req.body.active === "boolean") await q("UPDATE users SET active=$1 WHERE id=$2", [req.body.active, id]);
  if (["admin", "attorney", "paralegal"].includes(req.body.role)) await q("UPDATE users SET role=$1 WHERE id=$2", [req.body.role, id]);
  let temp_password;
  if (req.body.reset) { temp_password = tempPw(); await q("UPDATE users SET pw_hash=$1, must_change_pw=true, totp_enabled=false, totp_secret=NULL WHERE id=$2", [await bcrypt.hash(temp_password, 12), id]); }
  await audit(req, "seat_updated", { id, ...req.body });
  res.json({ ok: true, temp_password });
}));

// ---------- pending cases ----------
// Rule: attorneys only see/add cases in the counties they practice in — plus cases they explicitly track.
const CASE_COLS = ["county", "cause_no", "court", "style", "case_type", "filed_date", "status", "next_setting", "notes", "tracked", "watch_dates"];
function cleanCase(b) {
  const o = {};
  for (const k of CASE_COLS) if (b[k] !== undefined) o[k] = typeof b[k] === "string" ? b[k].trim().slice(0, 500) : b[k];
  if (o.filed_date === "") o.filed_date = null;
  if (o.filed_date && !/^\d{4}-\d{2}-\d{2}$/.test(o.filed_date)) o.filed_date = null;
  if ("tracked" in o) o.tracked = !!o.tracked;
  if ("watch_dates" in o) o.watch_dates = !!o.watch_dates;
  return o;
}
app.get("/api/cases", requireAuth, wrap(async (req, res) => {
  const { view = "mine", county, type } = req.query;
  const params = [req.user.firm_id, req.user.counties || []];
  let where = "c.firm_id=$1 AND (c.county = ANY($2) OR c.tracked)";
  if (view === "mine") { params.push(req.user.id); where += ` AND c.user_id=$${params.length}`; }
  if (view === "tracked") where += " AND c.tracked";
  if (view === "alerts") where += " AND c.date_alert IS NOT NULL";
  if (view === "watched") where += " AND c.watch_dates";
  if (req.query.attorney) { params.push(+req.query.attorney); where += ` AND c.user_id=$${params.length}`; }
  if (county) { params.push(county); where += ` AND c.county=$${params.length}`; }
  if (type) { params.push(type); where += ` AND c.case_type=$${params.length}`; }
  const { rows } = await q(`SELECT c.*, u.name AS attorney FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} ORDER BY (c.date_alert IS NOT NULL) DESC, c.filed_date DESC NULLS LAST, c.id DESC LIMIT 500`, params);
  const al = await q("SELECT count(*)::int n FROM cases WHERE firm_id=$1 AND (county = ANY($2) OR tracked) AND date_alert IS NOT NULL" + (req.user.role === "paralegal" || req.user.role === "admin" ? "" : " AND user_id=$3"), req.user.role === "paralegal" || req.user.role === "admin" ? [req.user.firm_id, req.user.counties || []] : [req.user.firm_id, req.user.counties || [], req.user.id]);
  res.json({ cases: rows, alerts: al.rows[0].n });
}));
app.post("/api/cases", requireAuth, wrap(async (req, res) => {
  const c = cleanCase(req.body || {});
  if (!c.county || !COUNTIES.includes(c.county) || !c.cause_no) return res.status(400).json({ error: "County and cause # are required." });
  if (!(req.user.counties || []).includes(c.county) && !c.tracked) return res.status(403).json({ error: `${c.county} isn't one of your counties. Add it under My Counties, or mark the case as Tracked.` });
  const cols = Object.keys(c);
  const { rows } = await q(`INSERT INTO cases(firm_id,user_id,source,${cols.join(",")}) VALUES($1,$2,'manual',${cols.map((_, i) => "$" + (i + 3)).join(",")})
    ON CONFLICT(firm_id,county,cause_no) DO NOTHING RETURNING *`, [req.user.firm_id, req.user.id, ...cols.map(k => c[k])]);
  if (!rows[0]) return res.status(409).json({ error: "That cause # is already in your firm's list for this county." });
  await audit(req, "case_added", { id: rows[0].id, county: c.county, cause_no: c.cause_no });
  res.json({ case: rows[0] });
}));
app.patch("/api/cases/:id", requireAuth, wrap(async (req, res) => {
  const c = cleanCase(req.body || {}); delete c.county; delete c.cause_no;
  const cols = Object.keys(c);
  if (!cols.length) return res.status(400).json({ error: "Nothing to update" });
  const { rows } = await q(`UPDATE cases SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(",")}, updated_at=now() WHERE id=$1 AND firm_id=$2 RETURNING *`,
    [+req.params.id, req.user.firm_id, ...cols.map(k => c[k])]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  await audit(req, "case_updated", { id: rows[0].id, fields: cols });
  res.json({ case: rows[0] });
}));
app.post("/api/cases/:id/ack", requireAuth, wrap(async (req, res) => {
  await q("UPDATE cases SET date_alert=NULL WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]);
  await audit(req, "date_change_ack", { id: +req.params.id });
  res.json({ ok: true });
}));
app.get("/api/cases/:id/changes", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT ch.* FROM case_changes ch JOIN cases c ON c.id=ch.case_id WHERE ch.case_id=$1 AND c.firm_id=$2 ORDER BY ch.at DESC LIMIT 50", [+req.params.id, req.user.firm_id]);
  res.json({ changes: rows });
}));
// Firm admins: tick "watch court dates" on all of one attorney's cases at once.
app.post("/api/cases/watch-all", requireAuth, wrap(async (req, res) => {
  const uid = req.user.role === "admin" && req.body?.user_id ? +req.body.user_id : req.user.id;
  const r = await q("UPDATE cases SET watch_dates=$3 WHERE firm_id=$1 AND user_id=$2", [req.user.firm_id, uid, req.body?.on !== false]);
  await audit(req, "watch_all", { user_id: uid, on: req.body?.on !== false, count: r.rowCount });
  res.json({ updated: r.rowCount });
}));
app.delete("/api/cases/:id", requireAuth, wrap(async (req, res) => {
  const r = await q("DELETE FROM cases WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]);
  await audit(req, "case_deleted", { id: +req.params.id });
  res.json({ ok: r.rowCount > 0 });
}));

// CSV import: header row with any of county,cause_no,court,style,case_type,filed_date,status,next_setting,notes
function parseCsv(text) {
  const rows = []; let row = [], f = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') inQ = false; else f += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
app.post("/api/cases/import", requireAuth, wrap(async (req, res) => {
  const rows = parseCsv(String(req.body?.csv || ""));
  if (rows.length < 2) return res.status(400).json({ error: "Need a header row plus at least one case." });
  const head = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, "_").replace(/^cause.*/, "cause_no").replace(/^type$/, "case_type").replace(/^filed$/, "filed_date"));
  let added = 0, skipped = [];
  for (const r of rows.slice(1, 2001)) {
    const o = {}; head.forEach((h, i) => { if (CASE_COLS.includes(h)) o[h] = r[i]; });
    const c = cleanCase(o);
    const county = COUNTIES.find(x => x.toLowerCase() === String(c.county || "").toLowerCase().replace(/\s*county$/, ""));
    if (!county || !c.cause_no) { skipped.push(`${c.cause_no || "?"}: missing county/cause #`); continue; }
    if (!(req.user.counties || []).includes(county)) { skipped.push(`${c.cause_no}: ${county} not in your counties`); continue; }
    c.county = county;
    const cols = Object.keys(c);
    const ins = await q(`INSERT INTO cases(firm_id,user_id,source,${cols.join(",")}) VALUES($1,$2,'csv',${cols.map((_, i) => "$" + (i + 3)).join(",")}) ON CONFLICT DO NOTHING`,
      [req.user.firm_id, req.user.id, ...cols.map(k => c[k])]);
    if (ins.rowCount) added++; else skipped.push(`${c.cause_no}: already in list`);
  }
  await audit(req, "cases_imported", { added, skipped: skipped.length });
  res.json({ added, skipped });
}));

// ---------- court logins & county sync (per attorney) ----------
app.get("/api/court-logins", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id, county, username, (enc_password IS NOT NULL) AS has_password, status, last_sync, last_result, last_error FROM court_logins WHERE user_id=$1 ORDER BY county", [req.user.id]);
  for (const r of rows) if (sync.running.has(r.id)) r.status = "syncing";
  const available = (req.user.counties || []).filter(c => CONNECTORS[c]).map(c => ({ county: c, ...CONNECTORS[c] }));
  res.json({ logins: rows, available, bar_ok: isBar(req.user.bar_number) });
}));
app.post("/api/court-logins", requireAuth, wrap(async (req, res) => {
  let { county, username, password } = req.body || {};
  const conn = CONNECTORS[county];
  if (!conn) return res.status(400).json({ error: "No automatic feed for that county yet." });
  if (!(req.user.counties || []).includes(county)) return res.status(403).json({ error: `Add ${county} to My Counties first.` });
  if (!isBar(req.user.bar_number)) return res.status(400).json({ error: "Your account needs an 8-digit Texas bar # to pull cases." });
  if (conn.login === "required" && (!username || !password)) return res.status(400).json({ error: "This county needs your portal username and password." });
  const keepLogin = conn.login !== "none";
  const enc = keepLogin && password ? box.seal(password) : null;
  if (!keepLogin) username = null;
  const { rows } = await q(`INSERT INTO court_logins(user_id, county, username, enc_password, status) VALUES($1,$2,$3,$4,'new')
    ON CONFLICT(user_id, county) DO UPDATE SET username=$3, enc_password=$4, status='new', last_error=NULL RETURNING id`,
    [req.user.id, county, username ? String(username).trim() : null, enc]);
  await audit(req, "court_login_saved", { county, username: username || null });
  sync.runSync(rows[0].id, "connected"); // first pull starts right away in the background
  res.json({ id: rows[0].id, started: true });
}));
app.post("/api/court-logins/:id/sync", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id FROM court_logins WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  sync.runSync(rows[0].id, "manual");
  res.json({ started: true });
}));
app.delete("/api/court-logins/:id", requireAuth, wrap(async (req, res) => {
  await q("DELETE FROM court_logins WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]);
  await audit(req, "court_login_removed", { id: +req.params.id });
  res.json({ ok: true });
}));
// Hourly wake-up ping (free GitHub Actions schedule). Needs the shared SYNC_TOKEN secret.
let lastHourly = 0;
app.post("/api/cron/hourly", wrap(async (req, res) => {
  const tok = process.env.SYNC_TOKEN;
  const given = String(req.get("X-Cron-Token") || "");
  if (!tok || given.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) return res.status(403).json({ error: "Forbidden" });
  if (Date.now() - lastHourly < 50 * 60e3) return res.json({ skipped: "ran recently" });
  lastHourly = Date.now();
  sync.hourly().catch(e => console.error("[cron] hourly", e.message));
  res.json({ started: true });
}));

// Admin diagnostic: show a county portal's page structure (helps tune a connector). Public pages only.
app.get("/api/admin/inspect/:county", requireAuth, requireAdmin, rateLimit({ windowMs: 60e3, max: 3 }), wrap(async (req, res) => {
  const conn = CONNECTORS[req.params.county];
  if (!conn) return res.status(404).json({ error: "No connector" });
  try { const r = await sync.MODULES[conn.type].inspect({ baseUrl: conn.url }); console.log("[inspect]", JSON.stringify(r)); res.json(r); }
  catch (e) { console.error("[inspect] failed", e.message); res.status(502).json({ error: e.message }); }
}));

// ---------- case law ----------
const lawLimiter = rateLimit({ windowMs: 60e3, max: 30, message: { error: "Slow down a little." } });
app.get("/api/law/search", requireAuth, lawLimiter, wrap(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "Enter search words." });
  res.json(await cl.search({ query, court: req.query.court, after: req.query.after, before: req.query.before, page: req.query.page }));
}));
app.get("/api/law/opinion/:cid", requireAuth, lawLimiter, wrap(async (req, res) => {
  const cid = +req.params.cid; if (!cid) return res.status(400).json({ error: "Bad id" });
  const op = await cl.opinion(cid);
  await audit(req, "opinion_viewed", { cluster_id: cid });
  res.json({ opinion: op });
}));
app.get("/api/law/citator/:oid", requireAuth, lawLimiter, wrap(async (req, res) => {
  const oid = +req.params.oid; if (!oid) return res.status(400).json({ error: "Bad id" });
  res.json(await cl.citator(oid));
}));
app.get("/api/research", requireAuth, wrap(async (req, res) => {
  const params = [req.user.id]; let w = "r.user_id=$1";
  if (req.query.case_id) { params.push(+req.query.case_id); w += " AND r.case_id=$2"; }
  const { rows } = await q(`SELECT r.*, c.style AS case_style, c.cause_no FROM saved_research r LEFT JOIN cases c ON c.id=r.case_id WHERE ${w} ORDER BY r.created_at DESC`, params);
  res.json({ research: rows });
}));
app.post("/api/research", requireAuth, wrap(async (req, res) => {
  const { case_id, cluster_id, case_name, citation, note } = req.body || {};
  if (!cluster_id) return res.status(400).json({ error: "Missing opinion" });
  if (case_id && !(await q("SELECT 1 FROM cases WHERE id=$1 AND firm_id=$2", [case_id, req.user.firm_id])).rowCount) return res.status(404).json({ error: "Case not found" });
  const { rows } = await q("INSERT INTO saved_research(user_id,case_id,cluster_id,case_name,citation,note) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
    [req.user.id, case_id || null, cluster_id, case_name, citation, note]);
  res.json({ saved: rows[0] });
}));
app.delete("/api/research/:id", requireAuth, wrap(async (req, res) => {
  await q("DELETE FROM saved_research WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]); res.json({ ok: true });
}));

// ---------- static + errors ----------
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));
app.use((req, res) => req.path.startsWith("/api") ? res.status(404).json({ error: "Not found" }) : res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  if (err instanceof cl.CLError) return res.status(err.status || 502).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 3000;
migrate().then(() => app.listen(PORT, () => { console.log("TX Case Desk on :" + PORT); sync.startScheduler(); })).catch(e => { console.error("DB migrate failed", e); process.exit(1); });
