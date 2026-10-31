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
const analysis = require("./analysis");
const lawdb = require("./lawdb");
const inbound = require("./inbound");
const mail = require("./mail");
const myapps = require("./myapps");
const cl = require("./courtlistener");
const { COUNTIES, APPEALS, CONNECTORS } = require("./counties");
const sync = require("./sync");
const box = require("./crypto-box");

authenticator.options = { window: 1 };
const PROD = process.env.NODE_ENV === "production";
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"] } } }));
app.use("/api/ingest", express.json({ limit: "80mb" }));
app.use("/api/inbound", express.json({ limit: "30mb" })); // Postmark inbound email webhook // bulk case-law loader (gzip JSON batches)
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
  if (req.path.startsWith("/inbound/") || req.path.startsWith("/platform/")) return next(); // webhooks / My Apps — protected by their own secret keys
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
  const { rows } = await q("SELECT u.*, f.name AS firm_name, f.plan, f.plan_expires, f.plan_source, f.plan_checked, f.disabled AS firm_disabled FROM users u JOIN firms f ON f.id=u.firm_id WHERE u.id=$1 AND u.active", [id]);
  return rows[0];
}
const requireAuth = wrap(async (req, res, next) => {
  if (!req.session.uid || !req.session.mfa) return res.status(401).json({ error: "Sign in required" });
  req.user = await loadUser(req.session.uid);
  if (!req.user) { req.session.destroy(() => {}); return res.status(401).json({ error: "Account disabled" }); }
  const path = req.originalUrl.split("?")[0];
  if (req.user.must_change_pw && !["/api/me", "/api/password", "/api/logout"].includes(path))
    return res.status(403).json({ error: "Change your temporary password first", code: "CHANGE_PW" });
  // Subscription (managed in My Apps). Account, logout and subscription pages stay open so they can fix it.
  const firm = await myapps.refresh({ id: req.user.firm_id, plan: req.user.plan, plan_expires: req.user.plan_expires, plan_source: req.user.plan_source, plan_checked: req.user.plan_checked, disabled: req.user.firm_disabled });
  req.subscription = { plan: firm.plan, expires_on: firm.plan_expires, source: firm.plan_source, ...myapps.active(firm) };
  if (!req.subscription.ok && !["/api/me", "/api/logout", "/api/password", "/api/subscription", "/api/subscription/redeem"].includes(path))
    return res.status(402).json({ error: req.subscription.reason, code: req.subscription.code });
  next();
});
const requireAdmin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Firm admins only" });

// ---------- reference ----------
const VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);
app.get("/api/version", (req, res) => { res.set("Cache-Control", "no-store"); res.json({ v: VERSION }); });
app.get("/api/meta", wrap(async (req, res) => res.json({ counties: COUNTIES, appeals: APPEALS, connectors: CONNECTORS, courts: cl.TX_COURTS, localLaw: await lawdb.available(), lawCount: await lawdb.size().catch(() => 0), tokenSet: !!process.env.COURTLISTENER_TOKEN })));
app.get("/healthz", (req, res) => res.send("ok"));

// ---------- signup / login / 2FA ----------
app.post("/api/signup", loginLimiter, wrap(async (req, res) => {
  const { firm, name, email, bar, password, code } = req.body || {};
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
    let sub = null; try { sub = await myapps.onSignup(f.rows[0].id, String(firm).trim(), code ? String(code).trim() : null); } catch (e) { console.error("[myapps] trial start failed", e.message); }
    req.session.regenerate(() => { req.session.pendingUid = u.rows[0].id; audit(req, "signup", { email: em, code: code || null }); res.json({ next: "enroll_2fa", codeError: sub?.codeError || null }); });
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
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(req.user), subscription: req.subscription }));
app.get("/api/subscription", requireAuth, (req, res) => res.json({ ...req.subscription, managed: myapps.enabled() }));
app.post("/api/subscription/redeem", requireAuth, wrap(async (req, res) => {
  if (!myapps.enabled()) return res.status(400).json({ error: "Codes aren't available right now." });
  try { const r = await myapps.redeem(req.user.firm_id, req.user.firm_name, req.body?.code); await audit(req, "code_redeemed", { code: req.body?.code }); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
// My Apps console → TX Case Desk (shared secret)
app.get("/api/platform/firms", myapps.platformAuth, wrap(async (req, res) => res.json({ firms: await myapps.listFirms((process.env.APP_URL || "https://tx-case-desk.onrender.com").replace(/\/$/, "")) })));
app.post("/api/platform/firms/:id", myapps.platformAuth, wrap(async (req, res) => {
  try { res.json(await myapps.platformAction(+String(req.params.id).replace(/^firm:/, ""), req.body || {})); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
app.get("/api/platform/info", myapps.platformAuth, wrap(async (req, res) => res.json({
  azure_account: "stevesmith.5480@outlook.com", microsoft_connect: mail.configured().microsoft, google_connect: mail.configured().google,
  postmark: !!process.env.POSTMARK_INBOUND, courtlistener: !!process.env.COURTLISTENER_TOKEN, case_law_opinions: await lawdb.size().catch(() => 0)
})));

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
const CASE_COLS = ["county", "cause_no", "court", "style", "case_type", "filed_date", "status", "next_setting", "notes", "tracked", "watch_dates", "issues", "law_watch"];
function cleanCase(b) {
  const o = {};
  for (const k of CASE_COLS) if (b[k] !== undefined) o[k] = typeof b[k] === "string" ? b[k].trim().slice(0, 500) : b[k];
  if (o.filed_date === "") o.filed_date = null;
  if (o.filed_date && !/^\d{4}-\d{2}-\d{2}$/.test(o.filed_date)) o.filed_date = null;
  if ("tracked" in o) o.tracked = !!o.tracked;
  if ("watch_dates" in o) o.watch_dates = !!o.watch_dates;
  if ("law_watch" in o) o.law_watch = !!o.law_watch;
  if (typeof b.issues === "string") o.issues = b.issues.trim().slice(0, 1000);
  return o;
}
app.get("/api/cases", requireAuth, wrap(async (req, res) => {
  const { view = "mine", county, type } = req.query;
  const params = [req.user.firm_id, req.user.counties || []];
  let where = "c.firm_id=$1 AND (c.county = ANY($2) OR c.tracked)";
  if (view === "mine") { params.push(req.user.id); where += ` AND c.user_id=$${params.length}`; }
  if (view === "tracked") where += " AND c.tracked";
  if (view === "alerts") where += " AND (c.date_alert IS NOT NULL OR c.law_alert IS NOT NULL OR c.filing_alert IS NOT NULL)";
  if (view === "watched") where += " AND c.watch_dates";
  if (req.query.attorney) { params.push(+req.query.attorney); where += ` AND c.user_id=$${params.length}`; }
  if (county) { params.push(county); where += ` AND c.county=$${params.length}`; }
  if (type) { params.push(type); where += ` AND c.case_type=$${params.length}`; }
  const { rows } = await q(`SELECT c.*, u.name AS attorney FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} ORDER BY (c.date_alert IS NOT NULL OR c.law_alert IS NOT NULL OR c.filing_alert IS NOT NULL) DESC, c.filed_date DESC NULLS LAST, c.id DESC LIMIT 500`, params);
  const al = await q("SELECT count(*)::int n FROM cases WHERE firm_id=$1 AND (county = ANY($2) OR tracked) AND (date_alert IS NOT NULL OR law_alert IS NOT NULL OR filing_alert IS NOT NULL)" + (req.user.role === "paralegal" || req.user.role === "admin" ? "" : " AND user_id=$3"), req.user.role === "paralegal" || req.user.role === "admin" ? [req.user.firm_id, req.user.counties || []] : [req.user.firm_id, req.user.counties || [], req.user.id]);
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
// Case-law analysis (rule-based, no AI)
app.post("/api/cases/:id/analyze", requireAuth, rateLimit({ windowMs: 60e3, max: 3, message: { error: "One analysis at a time — try again in a minute." } }), wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM cases WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]);
  const c = rows[0]; if (!c) return res.status(404).json({ error: "Not found" });
  const issues = typeof req.body?.issues === "string" ? req.body.issues.trim().slice(0, 1000) : c.issues;
  if (issues !== c.issues) await q("UPDATE cases SET issues=$2 WHERE id=$1", [c.id, issues]);
  let result;
  try { result = await analysis.analyze({ issues, county: c.county, appeals: APPEALS[c.county] }); }
  catch (e) { return res.status(e.status || 502).json({ error: e.message }); }
  const ins = await q("INSERT INTO analyses(case_id,user_id,issues,result) VALUES($1,$2,$3,$4) RETURNING id, created_at", [c.id, req.user.id, issues, result]);
  await q("UPDATE cases SET law_checked_at=now() WHERE id=$1", [c.id]);
  await audit(req, "case_analyzed", { case_id: c.id });
  res.json({ id: ins.rows[0].id, created_at: ins.rows[0].created_at, issues, result });
}));
app.get("/api/cases/:id/analysis", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT a.id, a.issues, a.result, a.created_at FROM analyses a JOIN cases c ON c.id=a.case_id WHERE a.case_id=$1 AND c.firm_id=$2 ORDER BY a.created_at DESC LIMIT 1", [+req.params.id, req.user.firm_id]);
  res.json({ analysis: rows[0] || null });
}));
app.post("/api/cases/:id/law-ack", requireAuth, wrap(async (req, res) => {
  await q("UPDATE cases SET law_alert=NULL WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true });
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
// Hourly wake-up ping (free GitHub Actions schedule; scripts/hourly-ping.js works for a Render cron too). Needs SYNC_TOKEN.
let lastHourly = 0;
app.post("/api/cron/hourly", wrap(async (req, res) => {
  const tok = (process.env.SYNC_TOKEN || "").trim(); // ignore stray spaces/newlines from copy-paste
  const given = String(req.get("X-Cron-Token") || "").trim();
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

// ---------- connected mailboxes (Connect Outlook / Connect Gmail) ----------
app.get("/api/mail", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id, provider, email, status, last_sync, last_error, stats FROM mailboxes WHERE user_id=$1 ORDER BY provider", [req.user.id]);
  for (const r of rows) if (mail.running.has(r.id)) r.status = "syncing";
  res.json({ configured: mail.configured(), names: Object.fromEntries(Object.entries(mail.PROVIDERS).map(([k, v]) => [k, v.name])), mailboxes: rows });
}));
app.get("/api/mail/detect", requireAuth, wrap(async (req, res) => res.json(await mail.detect(req.user.email))));
// Firm-wide (admin): status + start
app.get("/api/firm/mail", requireAuth, requireAdmin, wrap(async (req, res) => {
  const f = (await q("SELECT provider, domain, status, last_sync, last_error, stats FROM firm_mail WHERE firm_id=$1", [req.user.firm_id])).rows[0] || null;
  const det = await mail.detect(req.user.email);
  const covered = f ? (await q("SELECT name, email FROM users WHERE firm_id=$1 AND active AND lower(split_part(email,'@',2))=lower($2) ORDER BY name", [req.user.firm_id, f.domain])).rows : [];
  res.json({ firm: f, detect: det, covered, configured: mail.configured(), google_sa_client_id: mail.GSA().clientId || null });
}));
app.get("/api/firm/mail/microsoft", requireAuth, requireAdmin, wrap(async (req, res) => {
  const det = await mail.detect(req.user.email);
  if (!mail.configured().microsoft) return res.redirect("/?mailerror=" + encodeURIComponent("Microsoft connection isn't switched on yet."));
  if (det.personal) return res.redirect("/?mailerror=" + encodeURIComponent("Firm-wide connect needs a firm email domain (not a personal Outlook/Gmail address)."));
  res.redirect(mail.adminConsentUrl(req.user.firm_id, det.domain));
}));
app.get("/api/mail/admin-callback/microsoft", async (req, res) => {
  try { await mail.finishAdminConsent(req.query); res.redirect("/?connected=" + encodeURIComponent("whole firm (Microsoft 365)")); }
  catch (e) { console.error("[mail] admin consent failed", e.message); res.redirect("/?mailerror=" + encodeURIComponent(e.message.slice(0, 200))); }
});
app.post("/api/firm/mail/google", requireAuth, requireAdmin, wrap(async (req, res) => {
  const det = await mail.detect(req.user.email);
  if (det.personal || !det.domain) return res.status(400).json({ error: "Firm-wide connect needs a firm email domain." });
  try { await mail.connectGoogleFirm(req.user.firm_id, det.domain, req.user.email); await audit(req, "firm_mail_google"); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post("/api/firm/mail/sync", requireAuth, requireAdmin, wrap(async (req, res) => { mail.syncFirm(req.user.firm_id).catch(() => {}); res.json({ started: true }); }));
app.delete("/api/firm/mail", requireAuth, requireAdmin, wrap(async (req, res) => { await q("DELETE FROM firm_mail WHERE firm_id=$1", [req.user.firm_id]); await audit(req, "firm_mail_disconnected"); res.json({ ok: true }); }));
app.get("/api/mail/connect/:provider", requireAuth, (req, res) => {
  const p = req.params.provider;
  if (!mail.PROVIDERS[p] || !mail.configured()[p]) return res.redirect("/?mailerror=" + encodeURIComponent("That email provider isn't switched on yet."));
  res.redirect(mail.startUrl(p, req.user.id));
});
app.get("/api/mail/callback/:provider", async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error_description || "Access was not allowed.");
    const r = await mail.finish(req.params.provider, String(req.query.code || ""), String(req.query.state || ""));
    res.redirect("/?connected=" + encodeURIComponent(r.email || req.params.provider));
  } catch (e) { console.error("[mail] connect failed", e.message); res.redirect("/?mailerror=" + encodeURIComponent(e.message.slice(0, 200))); }
});
app.post("/api/mail/:id/sync", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id FROM mailboxes WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  mail.syncMailbox(rows[0].id).catch(() => {}); res.json({ started: true });
}));
app.delete("/api/mail/:id", requireAuth, wrap(async (req, res) => {
  await q("DELETE FROM mailboxes WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]);
  await audit(req, "mailbox_disconnected", { id: +req.params.id }); res.json({ ok: true });
}));

// ---------- re:SearchTX alert emails (Postmark inbound webhook) ----------
app.post("/api/inbound/postmark", wrap(async (req, res) => {
  const key = (process.env.INBOUND_KEY || "").trim(), given = String(req.query.key || "").trim();
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return res.status(403).json({ error: "Forbidden" });
  try { res.json(await inbound.handle(req.body || {})); }
  catch (e) { console.error("[inbound] failed", e.message); res.json({ ok: false }); } // 200 so Postmark doesn't retry forever
}));
app.get("/api/email-alerts", requireAuth, wrap(async (req, res) => {
  const token = await inbound.tokenFor(req.user.id);
  const { rows } = await q("SELECT id, from_addr, subject, kind, causes, matched_case_ids, confirm_code, received_at FROM inbound_emails WHERE user_id=$1 ORDER BY received_at DESC LIMIT 30", [req.user.id]);
  const confirm = rows.find(r => r.kind === "forward_confirm" && r.confirm_code);
  const known = rows.length ? (await q("SELECT upper(cause_no) c FROM cases WHERE firm_id=$1", [req.user.firm_id])).rows.map(r => r.c) : [];
  res.json({ address: inbound.addressFor(token), configured: !!inbound.addressFor(token), confirm: confirm ? { code: confirm.confirm_code, at: confirm.received_at } : null,
    emails: rows.filter(r => r.kind !== "forward_confirm").map(r => ({ ...r, unmatched: (r.causes || []).filter(c => !known.includes(c)) })) });
}));
app.get("/api/email-alerts/:id", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id, from_addr, subject, body, html, kind, causes, received_at FROM inbound_emails WHERE id=$1 AND user_id=$2", [+req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  await q("UPDATE inbound_emails SET read_at=now() WHERE id=$1 AND read_at IS NULL", [rows[0].id]);
  const cm = await caseMap(req.user.firm_id, rows[0].causes || []);
  res.json({ email: rows[0], summary: inbound.summarize(rows[0], cm) });
}));
async function caseMap(firmId, causes) {
  if (!causes.length) return {};
  const { rows } = await q("SELECT id, upper(cause_no) c, style, county FROM cases WHERE firm_id=$1 AND upper(cause_no) = ANY($2)", [firmId, causes]);
  return Object.fromEntries(rows.map(r => [r.c, { id: r.id, style: r.style, county: r.county }]));
}
// Inbox: every email received for this attorney, newest first, each with a short summary.
app.get("/api/inbox", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id, from_addr, subject, body, kind, causes, read_at, received_at FROM inbound_emails WHERE user_id=$1 ORDER BY received_at DESC LIMIT 200", [req.user.id]);
  const cm = await caseMap(req.user.firm_id, [...new Set(rows.flatMap(r => r.causes || []))]);
  res.json({ unread: rows.filter(r => !r.read_at).length, emails: rows.map(r => {
    const sm = inbound.summarize(r, cm);
    return { id: r.id, from_addr: r.from_addr, subject: r.subject, received_at: r.received_at, read: !!r.read_at, type: sm.type, dates: sm.dates, cases: sm.cases, preview: (sm.lines[0] || String(r.body || "").replace(/\s+/g, " ").slice(0, 140)) };
  }) });
}));
app.post("/api/inbox/read-all", requireAuth, wrap(async (req, res) => { await q("UPDATE inbound_emails SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [req.user.id]); res.json({ ok: true }); }));
app.post("/api/cases/:id/filing-ack", requireAuth, wrap(async (req, res) => {
  await q("UPDATE cases SET filing_alert=NULL WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true });
}));

// ---------- case law ----------
const lawLimiter = rateLimit({ windowMs: 60e3, max: 30, message: { error: "Slow down a little." } });
app.get("/api/law/search", requireAuth, lawLimiter, wrap(async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "Enter search words." });
  if (await lawdb.available()) {
    const f = { after: req.query.after || undefined, county: req.query.county || undefined };
    if (["tex", "texapp", "texcrimapp"].includes(req.query.court)) f.court = req.query.court;
    if (/^\d{1,2}$/.test(req.query.coa || "")) { f.court = "texapp"; f.coa = +req.query.coa; }
    return res.json(await lawdb.search({ text: query.replace(/\bAND\b/g, " ") }, f, 30));
  }
  res.json(await cl.search({ query, court: req.query.court, after: req.query.after, before: req.query.before, page: req.query.page }));
}));
app.get("/api/law/opinion/:cid", requireAuth, lawLimiter, wrap(async (req, res) => {
  const cid = +req.params.cid; if (!cid) return res.status(400).json({ error: "Bad id" });
  const op = (await lawdb.available() && await lawdb.opinion(cid)) || await cl.opinion(cid);
  await audit(req, "opinion_viewed", { cluster_id: cid });
  res.json({ opinion: op });
}));
app.get("/api/law/citator/:oid", requireAuth, lawLimiter, wrap(async (req, res) => {
  const oid = +req.params.oid; if (!oid) return res.status(400).json({ error: "Bad id" });
  if (req.query.cluster && await lawdb.available()) { const r = await lawdb.citator(+req.query.cluster); if (r.cited_by || (await lawdb.opinion(+req.query.cluster))) return res.json(r); }
  res.json(await cl.citator(oid));
}));
app.get("/api/law/stats", requireAuth, wrap(async (req, res) => res.json({ available: await lawdb.available(), rows: await lawdb.stats() })));

// ---------- bulk case-law loader (GitHub Actions job → here). Token-protected. ----------
function ingestAuth(req, res, next) {
  const tok = (process.env.SYNC_TOKEN || "").trim(), given = String(req.get("X-Cron-Token") || "").trim();
  if (!tok || given.length !== tok.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok))) return res.status(403).json({ error: "Forbidden" });
  next();
}
app.post("/api/ingest/log", ingestAuth, (req, res) => { console.log("[loader]", String(req.body?.msg || "").slice(0, 2000)); res.json({ ok: true }); });
app.post("/api/ingest/opinions", ingestAuth, wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const cols = ["opinion_id", "cluster_id", "court_id", "coa", "origin_county", "docket_number", "case_name", "date_filed", "citations", "judges", "cite_count", "precedential", "op_type", "text"];
  let n = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50), params = [];
    const values = chunk.map(r => "(" + cols.map(c => { params.push(r[c] === "" || r[c] === undefined ? null : r[c]); return "$" + params.length; }).join(",") + ")").join(",");
    await q(`INSERT INTO tx_opinions(${cols.join(",")}) VALUES ${values}
      ON CONFLICT(opinion_id) DO UPDATE SET ${cols.slice(1).map(c => `${c}=EXCLUDED.${c}`).join(",")}`, params);
    n += chunk.length;
  }
  res.json({ ok: true, n });
}));
app.post("/api/ingest/cites", ingestAuth, wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    await q(`INSERT INTO tx_cites(citing, cited, depth) SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[]) ON CONFLICT DO NOTHING`,
      [chunk.map(r => r[0]), chunk.map(r => r[1]), chunk.map(r => r[2] || 1)]);
  }
  res.json({ ok: true, n: rows.length });
}));
app.post("/api/ingest/done", ingestAuth, wrap(async (req, res) => {
  await q("ANALYZE tx_opinions"); await q("ANALYZE tx_cites");
  console.log("[loader] done", JSON.stringify(req.body || {}), "rows now:", (await q("SELECT count(*)::int n FROM tx_opinions")).rows[0].n);
  res.json({ ok: true });
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
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", setHeaders: r => r.setHeader("Cache-Control", "no-cache") }));
app.use((req, res) => req.path.startsWith("/api") ? res.status(404).json({ error: "Not found" }) : res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  if (err instanceof cl.CLError) return res.status(err.status || 502).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 3000;
migrate().then(() => app.listen(PORT, () => { console.log("TX Case Desk on :" + PORT); sync.startScheduler();
  if (process.env.NODE_ENV === "production") setTimeout(() => sync.MODULES.odyssey.probe(CONNECTORS.Hidalgo.url).catch(() => {}), 5000); })).catch(e => { console.error("DB migrate failed", e); process.exit(1); });
