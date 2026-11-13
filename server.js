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
const { pool, q, migrate, lateIndexes } = require("./db");
const analysis = require("./analysis");
const lawdb = require("./lawdb");
const inbound = require("./inbound");
const mail = require("./mail");
const practice = require("./practice");
const access = require("./access");
const myapps = require("./myapps");
const demo = require("./demo");
const cl = require("./courtlistener");
const { COUNTIES, APPEALS, CONNECTORS } = require("./counties");
const sync = require("./sync");
const box = require("./crypto-box");

authenticator.options = { window: 1 };
// 2FA secrets are stored encrypted (older plain ones still work and get encrypted the next time they're used).
const SEALED = /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;
const totpOpen = s => !s ? null : SEALED.test(s) ? box.open(s) : s;
const totpSeal = s => { try { return box.seal(s); } catch (e) { return s; } };   // no CRED_KEY (local tests): stays as is
// A code works once: the 30-second step it belongs to is recorded, and only later codes are accepted after it.
async function useTotp(userId, stored, code) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code) || !stored) return false;
  let secret; try { secret = totpOpen(stored); } catch (e) { return false; }
  const now = Date.now(), delta = authenticator.clone({ epoch: now }).checkDelta(code, secret); if (delta === null || delta === undefined) return false;   // one clock reading for both
  const step = Math.floor(now / 30000) + delta;
  const r = await q("UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id", [userId, step]);
  if (r.rowCount && !SEALED.test(stored)) { const sealed = totpSeal(secret); if (sealed !== secret) await q("UPDATE users SET totp_secret=$2 WHERE id=$1 AND totp_secret=$3", [userId, sealed, stored]); }   // only if nobody reset it meanwhile
  return r.rowCount > 0;
}
// Wrong 2FA codes per account (from any address): 10 an hour, then that account waits. Counted before the code is checked.
async function codeTry(userId) {
  const r = await q(`UPDATE users SET totp_fails = CASE WHEN totp_fail_at IS NULL OR totp_fail_at < now() - interval '1 hour' THEN 1 ELSE totp_fails + 1 END,
      totp_fail_at = CASE WHEN totp_fail_at IS NULL OR totp_fail_at < now() - interval '1 hour' THEN now() ELSE totp_fail_at END WHERE id=$1 RETURNING totp_fails`, [userId]);
  return (r.rows[0] || {}).totp_fails <= 10;
}
const TOO_MANY_CODES = { error: "Too many codes tried for this account. Wait an hour, or ask your firm's admin to reset your sign-in.", code: "CODES" };
const signOutAll = (uid, keepSid) => q(`DELETE FROM session WHERE (sess->>'uid' = $1 OR sess->>'pendingUid' = $1 OR sess->>'resetUid' = $1)${keepSid ? " AND sid <> $2" : ""}`, keepSid ? [String(uid), keepSid] : [String(uid)]);
if (process.env.NODE_ENV === "production" && !(process.env.CRED_KEY || "").trim()) console.error("[security] CRED_KEY is not set: 2FA secrets and mailbox passwords can't be encrypted. Set it in Render and never change it.");
const PROD = process.env.NODE_ENV === "production";
const app = express();
app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:"] } } }));
app.use("/api/ingest", express.json({ limit: "80mb" }));
app.use("/api/inbound", express.json({ limit: "30mb" })); // Postmark inbound email webhook // bulk case-law loader (gzip JSON batches)
app.use("/api/mailx/send", express.json({ limit: "12mb" }));   // an email body can be larger than other requests
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

const TERMS = require("./terms");
const rt = require("./richtext");
// ---- Developer view: the developer (PIN in Render: DEVELOPER_PIN) sees what any person sees, read-only, for one hour ----
const DEV_PIN = String(process.env.DEVELOPER_PIN || process.env.DELVELOPER_PIN || "").trim();
const DEV_HASH = DEV_PIN.length >= 4 ? crypto.createHash("sha256").update(DEV_PIN).digest() : null;   // this PIN opens every firm
const DEV_SHORT = DEV_PIN.length < 8;   // a short PIN (owner's choice) gets far stricter guessing limits: 5 wrong tries a day in total
const DEV_TTL = 3600e3;
const MFA_OFF = new Set(String(process.env.MFA_OFF_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const devOk = req => !!(req.session && req.session.dev && Date.now() - req.session.dev.at < DEV_TTL);
// GET pages that would change something (connect a mailbox, make a calendar link, bulk export) are blocked in developer view too
const DEV_BLOCKED_GET = /^\/(api\/calendar\/feed|api\/export|export)\b/;
// The one thing the developer may change: email setup (a person's mailboxes, the firm's Microsoft/Google mail, the court inbox).
// Everything else stays read-only. Each of these is logged with dev:true.
const DEV_EMAIL = [
  ["GET", /^\/api\/mail\/connect\/[a-z]+$/], ["POST", /^\/api\/mail\/imap$/], ["POST", /^\/api\/mail\/\d+\/sync$/], ["DELETE", /^\/api\/mail\/\d+$/],
  ["GET", /^\/api\/firm\/mail\/microsoft$/], ["POST", /^\/api\/firm\/mail\/(google|sync)$/], ["DELETE", /^\/api\/firm\/mail$/],
  ["PUT", /^\/api\/firm\/court-inbox$/], ["GET", /^\/api\/firm\/court-inbox\/connect\/microsoft$/], ["POST", /^\/api\/firm\/court-inbox\/(imap|sync)$/], ["DELETE", /^\/api\/firm\/court-inbox\/mailbox$/],
];
const devEmailOk = (method, p) => DEV_EMAIL.some(([m, re]) => m === method && re.test(p));
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts. Wait 15 minutes." } });

// ---------- helpers ----------
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s || "");
const isBar = s => /^\d{8}$/.test(s || "");
const strongPw = s => typeof s === "string" && s.length >= 10 && /[A-Za-z]/.test(s) && /\d/.test(s);
const tempPw = () => crypto.randomBytes(9).toString("base64url");
async function audit(req, action, detail = {}) {
  const u = req.user || {};
  if (req.devView) detail = { ...detail, dev: true };   // anything done in developer view is marked as the developer's
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,$3,$4,$5)", [u.id || req.session?.pendingUid || null, u.firm_id || null, action, detail, req.ip]).catch(() => {});
}
// who works the firm's unassigned court notices (shared court inbox): the admin plus anyone the admin picks
const courtHandler = u => !!u && (u.role === "admin" || !!u.court_handler);
function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, bar_number: u.bar_number, role: u.role, firm_id: u.firm_id, firm_name: u.firm_name,
    counties: u.counties || [], totp_enabled: u.totp_enabled, must_change_pw: u.must_change_pw,
    phone: u.phone || "", title: u.title || "", doc_email: u.doc_email || "", firm_logo: u.logo_token ? `/brand/${u.logo_token}` : null,
    access: u.access || "own", works_with: u.works_with || [], sees_firm: access.seesFirm(u), trust_access: access.trustOk(u),
    firm_dash: access.firmDash(u), firm_kind: u.firm_kind || "firm", prefs: u.prefs || {},
    licensed_on: u.licensed_on ? new Date(u.licensed_on).toISOString().slice(0, 10) : "", has_bar_card: !!u.bar_card_at,
    court_handler: courtHandler(u), court_mode: u.court_mode || "each",
    terms_ok: u.terms_version === TERMS.VERSION, terms_version: TERMS.VERSION, ...(u.demo_until ? { demo: true, demo_until: u.demo_until } : {}) };
}
async function loadUser(id) {
  const { rows } = await q("SELECT u.*, f.name AS firm_name, f.logo_token, f.kind AS firm_kind, f.court_mode, f.plan, f.plan_expires, f.plan_source, f.plan_checked, f.disabled AS firm_disabled, f.demo_until FROM users u JOIN firms f ON f.id=u.firm_id WHERE u.id=$1 AND u.active", [id]);
  return rows[0];
}
const requireAuth = wrap(async (req, res, next) => {
  if (!req.session.uid || !req.session.mfa) return res.status(401).json({ error: "Sign in required" });
  const path = req.originalUrl.split("?")[0];
  if (req.session.devView) {   // developer view: read-only, one hour from the PIN
    if (!devOk(req)) { req.session.destroy(() => {}); return res.status(401).json({ error: "Developer view ended (1 hour). Enter the developer PIN again.", code: "DEV_ENDED" }); }
    let np = path; try { np = new URL(req.originalUrl, "http://x").pathname; } catch (e) {}   // absolute-form request lines too
    try { np = decodeURIComponent(np); } catch (e) {}
    np = np.toLowerCase().replace(/\/{2,}/g, "/");   // routes match regardless of case or doubled slashes, so the check must too
    req.devEmail = devEmailOk(req.method, np);
    if ((req.method !== "GET" && !["/api/dev/exit", "/api/logout"].includes(np) && !req.devEmail) || DEV_BLOCKED_GET.test(np)) {
      // a link the browser followed (connect email, export): back to the app with a plain message instead of raw text
      if (req.method === "GET" && /text\/html/.test(req.get("accept") || "")) return res.redirect(303, "/?devro=1");
      return res.status(403).json({ error: "Developer view is read-only — nothing was changed.", code: "DEV_READONLY" });
    }
    req.devView = true;
  }
  req.user = await loadUser(req.session.uid);
  if (!req.user) { req.session.destroy(() => {}); return res.status(401).json({ error: "Account disabled" }); }
  if (req.user.demo_until) {   // "Try the demo" copy: ends on its date; nothing may leave the app
    if (new Date(req.user.demo_until) < new Date()) { req.session.destroy(() => {}); return res.status(401).json({ error: "This demo has ended. Start a new one from the sign-in page." }); }
    if (demo.guard(req, res)) return;
  }
  if (req.devEmail) await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,'developer_email_setup',$3,$4)", [req.user.id, req.user.firm_id, { dev: true, method: req.method, path }, req.ip]);   // logged before it runs
  if (req.user.must_change_pw && !["/api/me", "/api/password", "/api/logout"].includes(path))
    return res.status(403).json({ error: "Change your temporary password first", code: "CHANGE_PW" });
  // Subscription (managed in My Apps). Account, logout and subscription pages stay open so they can fix it.
  const fs = { id: req.user.firm_id, plan: req.user.plan, plan_expires: req.user.plan_expires, plan_source: req.user.plan_source, plan_checked: req.user.plan_checked, disabled: req.user.firm_disabled };
  const firm = req.devView || req.user.demo_until ? fs : await myapps.refresh(fs);   // developer view and demo firms: no My Apps calls that could change a plan
  // User Agreement: required before using the app (developer view excepted — it can't accept for anyone)
  if (!req.devView && req.user.terms_version !== TERMS.VERSION && !["/api/me", "/api/logout", "/api/password", "/api/terms/accept", "/api/subscription", "/api/subscription/redeem"].includes(path))
    return res.status(403).json({ error: "Please accept the updated User Agreement first.", code: "TERMS" });
  req.subscription = { plan: firm.plan, expires_on: firm.plan_expires, source: firm.plan_source, ...myapps.active(firm) };
  if (!req.subscription.ok && !["/api/me", "/api/logout", "/api/password", "/api/subscription", "/api/subscription/redeem", "/api/terms/accept"].includes(path))
    return res.status(402).json({ error: req.subscription.reason, code: req.subscription.code });
  next();
});
const requireAdmin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Firm admins only" });

// ---------- reference ----------
const VERSION = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 7);
const STARTED = new Date().toISOString();
app.get("/api/version", wrap(async (req, res) => {
  res.set("Cache-Control", "no-store");
  let firmId = null; if (req.session?.uid) firmId = (await q("SELECT firm_id FROM users WHERE id=$1", [req.session.uid])).rows[0]?.firm_id || null;
  const c = await mail.configuredFor(firmId);
  res.json({ v: VERSION, updated: STARTED, outlook: c.microsoft, gmail: c.google });
}));
app.get("/api/meta", wrap(async (req, res) => res.json({ stages: STAGES, preFiling: PRE_FILING, counties: COUNTIES, appeals: APPEALS, connectors: CONNECTORS, courts: cl.TX_COURTS, localLaw: await lawdb.available(), lawCount: await lawdb.size().catch(() => 0), tokenSet: !!process.env.COURTLISTENER_TOKEN })));
app.get("/healthz", wrap(async (req, res) => {   // checks the database too, so Render can restart an app that lost it
  try { await q("SELECT 1"); res.set("Cache-Control", "no-store").send("ok"); } catch (e) { res.status(503).send("database unavailable"); }
}));

// ---------- signup / login / 2FA ----------
app.post("/api/signup", loginLimiter, wrap(async (req, res) => {
  const { name, email, bar, password, code } = req.body || {};
  if (![true, 1, "1", "on", "true", "yes"].includes(req.body?.agree)) return res.status(400).json({ error: "Please read and accept the User Agreement." });
  const kind = req.body?.kind === "solo" ? "solo" : "firm";
  const firm = String(req.body?.firm || "").trim() || (kind === "solo" && name ? `Law Office of ${String(name).trim()}` : "");
  const em = String(email || "").trim().toLowerCase();
  if (!firm || !name || !isEmail(em) || !isBar(bar)) return res.status(400).json({ error: "Firm, name, valid email and 8-digit Texas bar # are required." });
  if (!strongPw(password)) return res.status(400).json({ error: "Password must be 10+ characters with letters and numbers." });
  const exists = await q("SELECT 1 FROM users WHERE email=$1", [em]);
  if (exists.rowCount) return res.status(409).json({ error: "That email is already registered." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const f = await client.query("INSERT INTO firms(name, kind) VALUES($1, $2) RETURNING id", [String(firm).trim(), kind]);
    const u = await client.query("INSERT INTO users(firm_id,email,name,bar_number,role,pw_hash,terms_version,terms_at) VALUES($1,$2,$3,$4,'admin',$5,$6,now()) RETURNING id",
      [f.rows[0].id, em, String(name).trim(), bar, await bcrypt.hash(password, 12), TERMS.VERSION]);
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
  // Two-step sign-in turned off for this person by the developer (Render setting MFA_OFF_EMAILS): password only. Logged.
  if (MFA_OFF.has(em)) { req.session.pendingUid = u.id; return finishMfa(req, res, u.id, "login_password_only"); }
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
  let secret = rows[0].totp_secret ? totpOpen(rows[0].totp_secret) : null;
  if (!secret) { secret = authenticator.generateSecret(); await q("UPDATE users SET totp_secret=$1 WHERE id=$2", [totpSeal(secret), uid]); }
  const uri = authenticator.keyuri(rows[0].email, "TX Case Desk", secret);
  res.json({ qr: await QRCode.toDataURL(uri), secret });
}));

async function finishMfa(req, res, uid, action) {
  await q("UPDATE users SET last_login=now(), totp_fails=0, totp_fail_at=NULL WHERE id=$1", [uid]);
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
  if (!(await codeTry(uid))) return res.status(429).json(TOO_MANY_CODES);
  if (!rows[0]?.totp_secret || !(await useTotp(uid, rows[0].totp_secret, req.body?.code)))
    return res.status(400).json({ error: "Code didn't match. Check your authenticator app's time and try again." });
  await q("UPDATE users SET totp_enabled=true WHERE id=$1", [uid]);
  await finishMfa(req, res, uid, "2fa_enabled");
}));
app.post("/api/login/2fa", loginLimiter, wrap(async (req, res) => {
  const uid = req.session.pendingUid;
  if (!uid) return res.status(401).json({ error: "Sign in first" });
  const { rows } = await q("SELECT totp_secret, totp_enabled FROM users WHERE id=$1 AND active", [uid]);
  if (!(await codeTry(uid))) return res.status(429).json(TOO_MANY_CODES);
  if (!rows[0]?.totp_enabled || !(await useTotp(uid, rows[0].totp_secret, req.body?.code)))
    return res.status(401).json({ error: "Wrong code, or a code that was already used. Wait for the next one." });
  await finishMfa(req, res, uid, "login");
}));

// Forgot password: prove it's you with your email and the 6-digit code from your authenticator app, then choose a new one.
// (No email needed. Lost the phone too? The firm admin resets it: Firm settings → People → Reset password & 2FA.)
app.post("/api/password/forgot", loginLimiter, wrap(async (req, res) => {
  const em = String(req.body?.email || "").trim().toLowerCase().slice(0, 200), code = String(req.body?.code || "").replace(/\s/g, "");
  // 5 tries a day per email, from anywhere — counted before the code is checked, the same for every email (so it reveals nothing)
  await q("DELETE FROM reset_attempts WHERE day < CURRENT_DATE");
  const tries = (await q(`INSERT INTO reset_attempts(email, day, n) VALUES($1, CURRENT_DATE, 1)
    ON CONFLICT (email) DO UPDATE SET n = CASE WHEN reset_attempts.day = CURRENT_DATE THEN reset_attempts.n + 1 ELSE 1 END, day = CURRENT_DATE RETURNING n`, [em])).rows[0].n;
  if (tries > 5) return res.status(429).json({ error: "Too many tries today. Ask your firm's admin to reset your sign-in, or try again tomorrow." });
  const u = (await q("SELECT id, firm_id, totp_secret, totp_enabled FROM users WHERE email=$1 AND active", [em])).rows[0];
  if (!u || !u.totp_enabled || !u.totp_secret || !(await useTotp(u.id, u.totp_secret, code))) {
    await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,'password_reset_failed','{}'::jsonb,$3)", [u ? u.id : null, u ? u.firm_id : null, req.ip]).catch(() => {});
    return res.status(400).json({ error: "That email and code don't match. Use the 6-digit code your authenticator app shows for TX Case Desk right now." });   // same answer whether or not the email exists
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Try again." });
    req.session.resetUid = u.id; req.session.resetAt = Date.now();
    res.json({ ok: true });
  });
}));
app.post("/api/password/forgot/set", loginLimiter, wrap(async (req, res) => {
  const uid = req.session.resetUid;
  if (!uid || Date.now() - (req.session.resetAt || 0) > 10 * 60e3) return res.status(401).json({ error: "That took longer than 10 minutes. Start again." });
  const next = req.body?.next;
  if (!strongPw(next)) return res.status(400).json({ error: "New password must be 10+ characters with letters and numbers." });
  const hash = await bcrypt.hash(next, 12);
  const u = (await q("UPDATE users SET pw_hash=$1, must_change_pw=false WHERE id=$2 AND active RETURNING id, firm_id", [hash, uid])).rows[0];
  if (!u) return res.status(401).json({ error: "Start again." });
  await signOutAll(uid, req.sessionID);   // then sign out everywhere else: signed-in sessions, half-way sign-ins, other open resets
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,'password_reset_self','{}'::jsonb,$3)", [u.id, u.firm_id, req.ip]);
  req.session.destroy(() => res.json({ ok: true }));
}));
app.post("/api/logout", (req, res) => req.session.destroy(() => { res.clearCookie("tcd.sid"); res.json({ ok: true }); }));
app.get("/api/me", requireAuth, (req, res) => res.json({ user: { ...publicUser(req.user), ...(req.devView ? { dev_view: true, dev_until: req.session.dev.at + DEV_TTL } : {}) }, subscription: req.subscription }));
// User Agreement: public page; accepting records the version and time on the person
app.get(["/terms", "/privacy", "/user-agreement"], (req, res) => res.set("Cache-Control", "no-cache").type("html").send(TERMS.page()));
app.post("/api/terms/accept", requireAuth, wrap(async (req, res) => {
  await q("UPDATE users SET terms_version=$2, terms_at=now() WHERE id=$1", [req.user.id, TERMS.VERSION]);
  await audit(req, "terms_accepted", { version: TERMS.VERSION }); res.json({ ok: true, version: TERMS.VERSION });
}));

// Developer view (see DEV_PIN above). Every view is written to that firm's activity log.
// failed PINs in the last hour, across all addresses (loaded once from the activity log so a restart doesn't reset it)
const DEV_MAX_FAILS = DEV_SHORT ? 5 : 50, DEV_FAIL_WIN = DEV_SHORT ? 24 * 3600e3 : 3600e3; let devFails = null, devFailsLoad = null;
async function devFailList() {
  if (!devFails) {   // every request waits for the same single load
    devFailsLoad = devFailsLoad || q("SELECT (extract(epoch FROM at) * 1000)::bigint t FROM audit_log WHERE action='developer_pin_failed' AND at > now() - ($1 || ' seconds')::interval ORDER BY at", [String(DEV_FAIL_WIN / 1000)]).then(r => r.rows.map(x => +x.t));
    const loaded = await devFailsLoad; if (!devFails) devFails = loaded;
  }
  const now = Date.now(); while (devFails.length && now - devFails[0] > DEV_FAIL_WIN) devFails.shift();
  return devFails;
}
const devLimiter = rateLimit({ windowMs: 15 * 60e3, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many tries. Wait 15 minutes." } });
app.get("/api/dev/status", (req, res) => res.json({ pin_ok: devOk(req), until: devOk(req) ? req.session.dev.at + DEV_TTL : null }));
app.post("/api/dev/pin", devLimiter, wrap(async (req, res) => {
  if (!DEV_HASH) return res.status(503).json({ error: DEV_PIN ? "The developer PIN in Render is too short. Use at least 4 characters, then try again." : "Developer access is off: add DEVELOPER_PIN in Render's Environment settings." });
  const list = await devFailList(), now = Date.now();
  if (list.length >= DEV_MAX_FAILS) return res.status(429).json({ error: DEV_SHORT ? "Developer sign-in is locked for 24 hours after 5 wrong PINs." : "Developer sign-in is locked for an hour after too many wrong PINs." });
  list.push(now);                         // counted before checking, with no await in between, so parallel guesses can't slip past
  const got = crypto.createHash("sha256").update(String(req.body?.pin || "").trim()).digest();
  if (!crypto.timingSafeEqual(got, DEV_HASH)) {
    console.log(`[dev] wrong developer PIN from ${req.ip} (forwarded hops: ${String(req.get("x-forwarded-for") || "").split(",").filter(Boolean).length})`);
    await audit(req, "developer_pin_failed", {}); return res.status(401).json({ error: "Wrong developer PIN." }); }
  list.splice(list.indexOf(now), 1);      // the right PIN isn't a failure
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Try again." });
    req.session.dev = { at: Date.now() }; audit(req, "developer_signin", {});
    res.json({ ok: true, until: req.session.dev.at + DEV_TTL });
  });
}));
app.get("/api/dev/people", wrap(async (req, res) => {
  if (!devOk(req)) return res.status(401).json({ error: "Enter the developer PIN first.", code: "DEV_PIN" });
  const { rows } = await q(`SELECT u.id, u.name, u.email, u.role, u.active, f.id AS firm_id, f.name AS firm_name, f.kind AS firm_kind
    FROM users u JOIN firms f ON f.id=u.firm_id WHERE f.demo_until IS NULL ORDER BY lower(f.name), f.id, CASE u.role WHEN 'admin' THEN 0 WHEN 'partner' THEN 1 WHEN 'manager' THEN 2 WHEN 'attorney' THEN 3 ELSE 4 END, lower(u.name)`);
  res.json({ people: rows, until: req.session.dev.at + DEV_TTL });
}));
app.post("/api/dev/view", wrap(async (req, res) => {
  if (!devOk(req)) return res.status(401).json({ error: "Enter the developer PIN first.", code: "DEV_PIN" });
  const u = (await q("SELECT id, firm_id, name, active FROM users WHERE id=$1", [+req.body?.user_id || 0])).rows[0];
  if (!u) return res.status(404).json({ error: "Person not found" });
  if (!u.active) return res.status(400).json({ error: "That person's account is turned off." });
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) VALUES($1,$2,'developer_view',$3,$4)", [u.id, u.firm_id, { read_only: true, minutes: 60, dev: true }, req.ip]);   // logged first: no log, no view
  req.session.uid = u.id; req.session.mfa = true; req.session.devView = true;
  console.log(`[dev] developer view of user ${u.id} (firm ${u.firm_id})`);
  res.json({ ok: true });
}));
app.post("/api/dev/exit", wrap(async (req, res) => {
  if (req.session.devView && req.session.uid) await q("INSERT INTO audit_log(user_id, firm_id, action, detail, ip) SELECT id, firm_id, 'developer_view_ended', '{}'::jsonb, $2 FROM users WHERE id=$1", [req.session.uid, req.ip]).catch(() => {});
  delete req.session.uid; req.session.mfa = false; req.session.devView = false;
  res.json({ ok: true, pin_ok: devOk(req) });
}));
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
  microsoft: { tx_case_desk_app: mail.configured().microsoft, firms_may_use_own_keys: true }, google_connect: mail.configured().google,
  postmark: !!process.env.POSTMARK_INBOUND, courtlistener: !!process.env.COURTLISTENER_TOKEN, case_law_opinions: await lawdb.size().catch(() => 0)
})));

app.post("/api/password", requireAuth, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!await bcrypt.compare(String(current || ""), req.user.pw_hash)) return res.status(400).json({ error: "Current password is wrong." });
  if (!strongPw(next)) return res.status(400).json({ error: "New password must be 10+ characters with letters and numbers." });
  await q("UPDATE users SET pw_hash=$1, must_change_pw=false WHERE id=$2", [await bcrypt.hash(next, 12), req.user.id]);
  await signOutAll(req.user.id, req.sessionID);   // other devices sign in again
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
// every /api/cases/<id>/... route: the case must be one this person may see (role + access rules in access.js)
app.use("/api/cases/:id", wrap(async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id) || !req.session.uid || !req.session.mfa) return next();
  const u = await loadUser(req.session.uid); if (!u) return next();
  const p = [+req.params.id, u.firm_id], cond = access.caseCond(u, "c", p);
  if (!(await q(`SELECT 1 FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, p)).rowCount) return res.status(404).json({ error: "Case not found" });
  next();
}));
// ---------- firm profile + logo (admin) and each person's own profile ----------
const pclean = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, m => (m.includes("\n") ? "\n" : " ")).trim().slice(0, n);
const okEmail = e => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
function imageInfo(b) {               // PNG or JPEG only; returns type + pixel size, or null
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { mime: "image/jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
app.get("/brand/:token", wrap(async (req, res) => {
  const r = (await q("SELECT logo, logo_mime FROM firms WHERE logo_token=$1 AND logo IS NOT NULL", [String(req.params.token).slice(0, 64)])).rows[0];
  if (!r) return res.status(404).send("Not found");
  res.set({ "Content-Type": r.logo_mime, "Cache-Control": "public, max-age=31536000, immutable", "Content-Security-Policy": "default-src 'none'" }).send(r.logo);
}));
const firmProfile = async id => {
  const f = (await q("SELECT name, kind, address, phone, fax, website, firm_email, logo_token, logo_w, logo_h FROM firms WHERE id=$1", [id])).rows[0];
  return { name: f.name, kind: f.kind || "firm", address: f.address || "", phone: f.phone || "", fax: f.fax || "", website: f.website || "", email: f.firm_email || "", logo: f.logo_token ? `/brand/${f.logo_token}` : null, logo_w: f.logo_w, logo_h: f.logo_h };
};
app.get("/api/firm/profile", requireAuth, wrap(async (req, res) => res.json({ profile: await firmProfile(req.user.firm_id) })));
app.put("/api/firm/profile", requireAuth, requireAdmin, wrap(async (req, res) => {
  const b = req.body || {}, name = pclean(b.name, 120), email = pclean(b.email, 120), web = pclean(b.website, 160);
  if (!name) return res.status(400).json({ error: "Firm name is required." });
  if (!okEmail(email)) return res.status(400).json({ error: "Check the firm email address." });
  await q("UPDATE firms SET name=$2, address=$3, phone=$4, fax=$5, website=$6, firm_email=$7 WHERE id=$1",
    [req.user.firm_id, name, pclean(b.address, 300) || null, pclean(b.phone, 30) || null, pclean(b.fax, 30) || null, web || null, email || null]);
  await audit(req, "firm_profile_saved", {});
  res.json({ profile: await firmProfile(req.user.firm_id) });
}));
app.put("/api/firm/logo", requireAuth, requireAdmin, express.raw({ type: () => true, limit: "1mb" }), wrap(async (req, res) => {
  const info = imageInfo(req.body);
  if (!info || !info.w || !info.h) return res.status(400).json({ error: "Use a PNG or JPG image (1 MB or smaller)." });
  const token = crypto.randomBytes(16).toString("hex");
  await q("UPDATE firms SET logo=$2, logo_mime=$3, logo_w=$4, logo_h=$5, logo_token=$6 WHERE id=$1", [req.user.firm_id, req.body, info.mime, info.w, info.h, token]);
  await audit(req, "firm_logo_saved", { type: info.mime, w: info.w, h: info.h });
  res.json({ logo: `/brand/${token}` });
}));
app.delete("/api/firm/logo", requireAuth, requireAdmin, wrap(async (req, res) => {
  await q("UPDATE firms SET logo=NULL, logo_mime=NULL, logo_w=NULL, logo_h=NULL, logo_token=NULL WHERE id=$1", [req.user.firm_id]);
  await audit(req, "firm_logo_removed", {}); res.json({ ok: true });
}));
// bar card (photo or PDF): the admin can add it for anyone in the firm; each person can add their own
const cardType = b => { const i = imageInfo(b); if (i) return i.mime; return b && b.length > 4 && b.slice(0, 5).toString() === "%PDF-" ? "application/pdf" : null; };
async function saveCard(req, res, uid) {
  const mime = cardType(req.body); if (!mime) return res.status(400).json({ error: "Use a photo (PNG or JPG) or a PDF of the bar card, 5 MB or smaller." });
  await q("INSERT INTO bar_cards(user_id, data, mime, at) VALUES($1,$2,$3,now()) ON CONFLICT(user_id) DO UPDATE SET data=$2, mime=$3, at=now()", [uid, req.body, mime]);
  await q("UPDATE users SET bar_card_at=now() WHERE id=$1", [uid]);
  await audit(req, "bar_card_saved", { user: uid }); res.json({ ok: true });
}
const sameFirm = async (req, id) => (await q("SELECT id FROM users WHERE id=$1 AND firm_id=$2", [+id, req.user.firm_id])).rows[0];
app.put("/api/me/bar-card", requireAuth, express.raw({ type: () => true, limit: "5mb" }), wrap(async (req, res) => saveCard(req, res, req.user.id)));
app.put("/api/firm/users/:id/bar-card", requireAuth, requireAdmin, express.raw({ type: () => true, limit: "5mb" }), wrap(async (req, res) => {
  if (!(await sameFirm(req, req.params.id))) return res.status(404).json({ error: "Not found" }); return saveCard(req, res, +req.params.id);
}));
app.delete("/api/firm/users/:id/bar-card", requireAuth, requireAdmin, wrap(async (req, res) => {
  if (!(await sameFirm(req, req.params.id))) return res.status(404).json({ error: "Not found" });
  await q("DELETE FROM bar_cards WHERE user_id=$1", [+req.params.id]); await q("UPDATE users SET bar_card_at=NULL WHERE id=$1", [+req.params.id]); await audit(req, "bar_card_removed", { user: +req.params.id }); res.json({ ok: true });
}));
app.get("/api/users/:id/bar-card", requireAuth, wrap(async (req, res) => {
  const id = +req.params.id; if (id !== req.user.id && req.user.role !== "admin") return res.status(403).send("Only the firm admin or the attorney can view this.");
  const r = (await q("SELECT b.data AS bar_card, b.mime AS bar_card_mime, u.name FROM bar_cards b JOIN users u ON u.id=b.user_id WHERE u.id=$1 AND u.firm_id=$2", [id, req.user.firm_id])).rows[0];
  if (!r) return res.status(404).send("No bar card on file");
  res.set({ "Content-Type": r.bar_card_mime, "Content-Disposition": `inline; filename="bar-card-${String(r.name).replace(/[^\w]+/g, "-")}.${r.bar_card_mime === "application/pdf" ? "pdf" : r.bar_card_mime === "image/png" ? "png" : "jpg"}"`, "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'" }).send(r.bar_card);
}));
const TODAY_CARDS = ["court", "deadlines", "mail", "next", "timer", "tasks", "glance", "caseload"];
app.put("/api/me/prefs", requireAuth, wrap(async (req, res) => {
  const hidden = (Array.isArray(req.body?.today_hidden) ? req.body.today_hidden : []).filter(k => TODAY_CARDS.includes(k));
  const prefs = { ...(req.user.prefs || {}), today_hidden: [...new Set(hidden)] };
  await q("UPDATE users SET prefs=$2 WHERE id=$1", [req.user.id, prefs]); res.json({ prefs });
}));
app.put("/api/firm/kind", requireAuth, requireAdmin, wrap(async (req, res) => {
  const kind = req.body?.kind === "solo" ? "solo" : "firm";
  if (kind === "solo" && (await q("SELECT count(*)::int n FROM users WHERE firm_id=$1 AND active", [req.user.firm_id])).rows[0].n > 1)
    return res.status(400).json({ error: "Solo practice is for one person. Disable the other sign-ins first." });
  await q("UPDATE firms SET kind=$2 WHERE id=$1", [req.user.firm_id, kind]); await audit(req, "firm_kind", { kind }); res.json({ kind });
}));
app.put("/api/me/profile", requireAuth, wrap(async (req, res) => {
  const b = req.body || {}, name = pclean(b.name, 80), bar = pclean(b.bar_number, 8).replace(/\D/g, ""), docEmail = pclean(b.doc_email, 120);
  if (!name) return res.status(400).json({ error: "Your name is required." });
  if (req.user.role !== "paralegal" && bar && bar.length !== 8) return res.status(400).json({ error: "Texas bar numbers are 8 digits." });
  if (!okEmail(docEmail)) return res.status(400).json({ error: "Check the email for documents." });
  const lic = /^\d{4}-\d{2}-\d{2}$/.test(String(b.licensed_on || "")) ? b.licensed_on : null;
  await q("UPDATE users SET name=$2, bar_number=$3, phone=$4, title=$5, doc_email=$6, licensed_on=$7 WHERE id=$1",
    [req.user.id, name, bar || null, pclean(b.phone, 30) || null, pclean(b.title, 80) || null, docEmail || null, lic]);
  await audit(req, "profile_saved", {});
  res.json({ user: publicUser(await loadUser(req.user.id)) });
}));
app.get("/api/firm/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await q(`SELECT id,email,name,bar_number,role,counties,totp_enabled,active,last_login,access,works_with,trust_access,title,phone,must_change_pw,court_handler,
    to_char(licensed_on,'YYYY-MM-DD') AS licensed_on, bar_card_at, (SELECT count(*)::int FROM mailboxes m WHERE m.user_id=users.id AND m.shared_firm IS NULL) AS mailboxes FROM users WHERE firm_id=$1 ORDER BY name`, [req.user.firm_id]);
  res.json({ users: rows });
}));
const ROLES = ["admin", "partner", "manager", "attorney", "paralegal"], ACCESS = ["own", "team", "firm"];
async function cleanWorksWith(firmId, ids) {
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))].slice(0, 50);
  if (!want.length) return [];
  return (await q("SELECT id FROM users WHERE firm_id=$1 AND id = ANY($2::int[]) AND role IN ('admin','partner','manager','attorney')", [firmId, want])).rows.map(r => r.id);
}
app.post("/api/firm/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const { name, email, bar, role } = req.body || {};
  const em = String(email || "").trim().toLowerCase();
  if (!name || !isEmail(em) || !ROLES.includes(role)) return res.status(400).json({ error: "Name, email and role required." });
  if ((role === "attorney" || role === "partner" || role === "manager" && bar) && !isBar(bar)) return res.status(400).json({ error: "Attorneys and partners need an 8-digit Texas bar #." });
  if ((await q("SELECT kind FROM firms WHERE id=$1", [req.user.firm_id])).rows[0].kind === "solo") return res.status(400).json({ error: "This is set up as a solo practice. Switch to Law firm under Firm profile to add people." });
  if (role === "admin" && bar && !isBar(bar)) return res.status(400).json({ error: "Bar # must be 8 digits." });
  if ((await q("SELECT 1 FROM users WHERE email=$1", [em])).rowCount) return res.status(409).json({ error: "Email already registered." });
  const acc = access.FIRM_ROLES.includes(role) ? "firm" : ACCESS.includes(req.body.access) ? req.body.access : role === "paralegal" ? "team" : "own";
  const ww = await cleanWorksWith(req.user.firm_id, req.body.works_with);
  const trust = role === "admin" ? true : !!req.body.trust_access && role !== "paralegal";
  const pw = tempPw();
  const lic = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.licensed_on || "")) ? req.body.licensed_on : null;
  const { rows } = await q("INSERT INTO users(firm_id,email,name,bar_number,role,pw_hash,must_change_pw,access,works_with,trust_access,phone,title,licensed_on) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12) RETURNING id",
    [req.user.firm_id, em, String(name).trim(), bar ? String(bar).trim() : null, role, await bcrypt.hash(pw, 12), acc, ww, trust, pclean(req.body.phone, 30) || null, pclean(req.body.title, 80) || null, lic]);
  await audit(req, "seat_added", { id: rows[0].id, email: em, role, access: acc });
  res.json({ id: rows[0].id, temp_password: pw });
}));
app.patch("/api/firm/users/:id", requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id && req.body.active === false) return res.status(400).json({ error: "You can't disable yourself." });
  const { rows } = await q("SELECT id FROM users WHERE id=$1 AND firm_id=$2", [id, req.user.firm_id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  if (typeof req.body.active === "boolean") { await q("UPDATE users SET active=$1 WHERE id=$2", [req.body.active, id]); if (!req.body.active) await signOutAll(id); }
  const b = req.body || {};
  if (ROLES.includes(b.role)) {
    const cur = (await q("SELECT role FROM users WHERE id=$1", [id])).rows[0].role;
    if (cur === "admin" && b.role !== "admin" && !(await q("SELECT 1 FROM users WHERE firm_id=$1 AND role='admin' AND active AND id<>$2", [req.user.firm_id, id])).rowCount)
      return res.status(400).json({ error: "The firm needs at least one admin. Make someone else an admin first." });
    await q("UPDATE users SET role=$1 WHERE id=$2", [b.role, id]);
    if (access.FIRM_ROLES.includes(b.role)) await q("UPDATE users SET access='firm' WHERE id=$1", [id]);
    if (b.role === "paralegal") await q("UPDATE users SET trust_access=false WHERE id=$1", [id]);
  }
  if (ACCESS.includes(b.access)) await q("UPDATE users SET access=$1 WHERE id=$2 AND role IN ('attorney','paralegal')", [b.access, id]);
  if (Array.isArray(b.works_with)) await q("UPDATE users SET works_with=$1 WHERE id=$2", [await cleanWorksWith(req.user.firm_id, b.works_with.filter(x => +x !== id)), id]);
  if (typeof b.trust_access === "boolean") await q("UPDATE users SET trust_access=$1 WHERE id=$2 AND role <> 'paralegal'", [b.trust_access, id]);
  if (b.details) {   // name, bar card number, date licensed, phone, title
    const d = b.details, nm = pclean(d.name, 80), bn = pclean(d.bar_number, 8).replace(/\D/g, "");
    if (!nm) return res.status(400).json({ error: "Name is required." });
    if (bn && bn.length !== 8) return res.status(400).json({ error: "Texas bar numbers are 8 digits." });
    const lic = /^\d{4}-\d{2}-\d{2}$/.test(String(d.licensed_on || "")) ? d.licensed_on : null;
    await q("UPDATE users SET name=$2, bar_number=$3, licensed_on=$4, phone=$5, title=$6 WHERE id=$1", [id, nm, bn || null, lic, pclean(d.phone, 30) || null, pclean(d.title, 80) || null]);
  }
  let temp_password;
  if (req.body.reset) { temp_password = tempPw(); const h = await bcrypt.hash(temp_password, 12);
    await q("UPDATE users SET pw_hash=$1, must_change_pw=true, totp_enabled=false, totp_secret=NULL, totp_last_step=NULL, totp_fails=0, totp_fail_at=NULL WHERE id=$2", [h, id]); await signOutAll(id); }
  await audit(req, "seat_updated", { id, ...req.body });
  res.json({ ok: true, temp_password });
}));

// ---------- pending cases ----------
// Rule: attorneys only see/add cases in the counties they practice in — plus cases they explicitly track.
const CASE_COLS = ["county", "cause_no", "court", "style", "case_type", "filed_date", "status", "next_setting", "notes", "tracked", "watch_dates", "issues", "law_watch", "stage"];
// The firm's own case stages, in order (the Cases list sorts by this). "Status" stays what the court says.
const STAGES = ["Intake", "Pre-litigation", "Demand / negotiation", "Filed – pleadings", "Discovery", "Motions", "Mediation", "Trial preparation", "Trial", "Post-trial / appeal", "Settled", "Closed"];
const PRE_FILING = ["Intake", "Pre-litigation", "Demand / negotiation"];   // no cause # yet: the app holds a PRE- number until it's filed
const preCause = () => "PRE-" + new Date().toISOString().slice(2, 7).replace("-", "") + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
function cleanCase(b) {
  const o = {};
  for (const k of CASE_COLS) if (b[k] !== undefined) o[k] = typeof b[k] === "string" ? b[k].trim().slice(0, 500) : b[k];
  if (o.filed_date === "") o.filed_date = null;
  if (o.filed_date && !/^\d{4}-\d{2}-\d{2}$/.test(o.filed_date)) o.filed_date = null;
  if ("tracked" in o) o.tracked = !!o.tracked;
  if ("watch_dates" in o) o.watch_dates = !!o.watch_dates;
  if ("law_watch" in o) o.law_watch = !!o.law_watch;
  if (typeof b.issues === "string") o.issues = b.issues.trim().slice(0, 1000);
  if (typeof b.notes === "string") { if (b.notes.length > 100000) throw Object.assign(new Error("Notes are too long (100,000 characters at most)."), { status: 400 }); o.notes = rt.cleanNotes(b.notes) || null; }   // Word-style notes: formatting kept, anything else stripped
  if ("stage" in o) o.stage = STAGES.find(x => x.toLowerCase() === String(o.stage || "").trim().toLowerCase()) || null;
  return o;
}
app.get("/api/cases", requireAuth, wrap(async (req, res) => {
  const { view = "mine", county, type } = req.query;
  const params = [req.user.firm_id, req.user.counties || []];
  let where = "c.firm_id=$1 AND (c.county = ANY($2) OR c.tracked)";
  if (!access.seesFirm(req.user)) where += " AND " + access.caseCond(req.user, "c", params);
  else if (view === "mine") { params.push(req.user.id); where += ` AND c.user_id=$${params.length}`; }
  if (view === "tracked") where += " AND c.tracked";
  if (view === "alerts") where += " AND (c.date_alert IS NOT NULL OR c.law_alert IS NOT NULL OR c.filing_alert IS NOT NULL)";
  if (view === "watched") where += " AND c.watch_dates";
  // Closed cases live in their own view; every other view shows active cases (unless you filter by the Closed stage)
  if (view === "closed") where += " AND c.stage = 'Closed'";
  else if (req.query.active === "1" && req.query.stage !== "Closed") where += " AND c.stage IS DISTINCT FROM 'Closed'";   // only the Cases list hides closed cases; billing, trust, calendar and search still find them
  if (req.query.attorney) { params.push(+req.query.attorney); where += ` AND c.user_id=$${params.length}`; }
  if (county) { params.push(county); where += ` AND c.county=$${params.length}`; }
  if (type) { params.push(type); where += ` AND c.case_type=$${params.length}`; }
  if (req.query.stage === "none") where += " AND c.stage IS NULL";
  else if (STAGES.includes(req.query.stage)) { params.push(req.query.stage); where += ` AND c.stage=$${params.length}`; }
  const alertsFirst = "(c.date_alert IS NOT NULL OR c.law_alert IS NOT NULL OR c.filing_alert IS NOT NULL) DESC";
  const byStage = /^stage(_desc)?$/.test(req.query.sort || ""); if (byStage) params.push(STAGES);
  const stPos = `array_position($${params.length}::text[], c.stage)`;
  const order = byStage ? `${stPos} ${req.query.sort === "stage_desc" ? "DESC" : "ASC"} NULLS LAST, ${alertsFirst}, c.filed_date DESC NULLS LAST`
    : { style: "lower(COALESCE(NULLIF(c.style,''), c.cause_no)) ASC", updated: "c.updated_at DESC NULLS LAST" }[req.query.sort] || `${alertsFirst}, c.filed_date DESC NULLS LAST`;
  const { rows } = await q(`SELECT c.*, u.name AS attorney FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE ${where} ORDER BY ${order}, c.id DESC LIMIT 500`, params);
  const ap = [req.user.firm_id, req.user.counties || []];
  const al = await q(`SELECT count(*)::int n FROM cases c WHERE c.firm_id=$1 AND (c.county = ANY($2) OR c.tracked) AND c.stage IS DISTINCT FROM 'Closed' AND (c.date_alert IS NOT NULL OR c.law_alert IS NOT NULL OR c.filing_alert IS NOT NULL) AND ${access.seesFirm(req.user) && req.user.role !== "attorney" ? "TRUE" : access.seesFirm(req.user) ? (ap.push(req.user.id), "c.user_id=$3") : access.caseCond(req.user, "c", ap)}`, ap);
  res.json({ cases: rows, alerts: al.rows[0].n });
}));
app.post("/api/cases", requireAuth, wrap(async (req, res) => {
  const c = cleanCase(req.body || {});
  if (!c.cause_no && PRE_FILING.includes(c.stage)) c.cause_no = preCause();   // not filed yet
  if (!c.county || !COUNTIES.includes(c.county) || !c.cause_no) return res.status(400).json({ error: c.county ? "Add the cause #. Not filed yet? Set the stage to Intake, Pre-litigation or Demand / negotiation and leave the cause # blank." : "County is required." });
  if (!(req.user.counties || []).includes(c.county) && !c.tracked) return res.status(403).json({ error: `${c.county} isn't one of your counties. Add it under My Counties, or mark the case as Tracked.` });
  const cols = Object.keys(c);
  const { rows } = await q(`INSERT INTO cases(firm_id,user_id,source,${cols.join(",")}) VALUES($1,$2,'manual',${cols.map((_, i) => "$" + (i + 3)).join(",")})
    ON CONFLICT(firm_id,county,cause_no) DO NOTHING RETURNING *`, [req.user.firm_id, req.user.id, ...cols.map(k => c[k])]);
  if (!rows[0]) return res.status(409).json({ error: "That cause # is already in your firm's list for this county." });
  await audit(req, "case_added", { id: rows[0].id, county: c.county, cause_no: c.cause_no });
  await practice.onCaseCreated(rows[0], req.user.id);
  res.json({ case: rows[0] });
}));
app.patch("/api/cases/:id", requireAuth, wrap(async (req, res) => {
  const c = cleanCase(req.body || {}); delete c.county; delete c.cause_no;
  // A case added before filing holds a PRE- number: the real cause # can be filled in once (only then).
  const nc = String((req.body || {}).cause_no || "").trim().slice(0, 500);
  if (nc) { const cur = (await q("SELECT cause_no FROM cases WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id])).rows[0];
    if (cur && /^PRE-/.test(cur.cause_no) && nc !== cur.cause_no) {
      if (/^PRE-/i.test(nc)) return res.status(400).json({ error: "Enter the real cause # from the court." });
      c.cause_no = nc;
    } }
  const cols = Object.keys(c);
  if (!cols.length) return res.status(400).json({ error: "Nothing to update" });
  const was = cols.includes("next_setting") ? (await q("SELECT next_setting FROM cases WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id])).rows[0] : null;
  // the update runs in its own transaction that names the person, so the activity log records who changed what
  let rows, rbErr; const cl = await pool.connect();
  try { await cl.query("BEGIN"); await cl.query("SELECT set_config('tcd.uid', $1, true)", [String(req.user.id)]);
    ({ rows } = await cl.query(`UPDATE cases SET ${cols.map((k, i) => `${k}=$${i + 3}`).join(",")}, updated_at=now() WHERE id=$1 AND firm_id=$2 RETURNING *`,
      [+req.params.id, req.user.firm_id, ...cols.map(k => c[k])]));
    await cl.query("COMMIT"); }
  catch (e) { await cl.query("ROLLBACK").catch(x => { rbErr = x; }); if (e.code === "23505") return res.status(409).json({ error: "That cause # is already on another case in your firm for this county." }); throw e; }
  finally { cl.release(rbErr); }   // a connection that couldn't roll back is closed, not reused
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  // activity log: a next setting typed by a person (court emails and syncs record their own)
  if (was && (was.next_setting || null) !== (rows[0].next_setting || null)) await q("INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES($1,'next_setting',$2,$3,$4)", [rows[0].id, was.next_setting, rows[0].next_setting, req.user.id]).catch(() => {});
  await audit(req, "case_updated", { id: rows[0].id, fields: cols });   // fields only, never the note text
  res.json({ case: rows[0] });
}));
app.post("/api/cases/:id/ack", requireAuth, wrap(async (req, res) => {
  await q("UPDATE cases SET date_alert=NULL WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]);
  await audit(req, "date_change_ack", { id: +req.params.id });
  res.json({ ok: true });
}));
// Case-law analysis (rule-based, no AI)
// Case-law rankings run in the background: the free CourtListener source allows 5 lookups a minute, so a
// ranking can take a few minutes. The page polls /api/law/jobs/:id for progress and the result.
const lawJobs = new Map();   // id -> { userId, status, done, total, live, result, error, at, onDone }
function startLawJob(req, { issues, county, onDone }) {
  return (async () => {
    const plan = await analysis.plannedLookups(issues);
    if (!plan.total) throw Object.assign(new Error("Add the issues first (e.g. slip and fall, constructive notice, grocery store)."), { status: 400 });
    const b = await cl.budget();
    if (plan.live > b.day) throw Object.assign(new Error(`This ranking needs up to ${plan.live} lookups from the free case-law source and only ${Math.max(0, b.day)} are left today (125 a day). Try again tomorrow, or rank fewer issues.`), { status: 429 });
    if (plan.live > b.hour) throw Object.assign(new Error(`This ranking needs up to ${plan.live} lookups and only ${Math.max(0, b.hour)} are left this hour (50 an hour). Try again later this hour.`), { status: 429 });
    for (const [k, j] of lawJobs) if (Date.now() - j.at > 3600e3) lawJobs.delete(k);
    const id = crypto.randomBytes(8).toString("hex");
    const job = { userId: req.user.id, status: "running", done: 0, total: plan.total, live: plan.live, at: Date.now() };
    lawJobs.set(id, job);
    analysis.analyze({ issues, county, appeals: county ? APPEALS[county] : null, onProgress: n => { job.done = Math.min(n, job.total); } })
      .then(async result => { job.result = result; job.created_at = new Date().toISOString(); if (onDone) await onDone(result).catch(e => console.error("[law] save failed", e.message)); job.status = "done"; })
      .catch(e => { job.status = "error"; job.error = e.message; job.code = e.status || 502; });
    return { job: id, total: plan.total, live: plan.live, est_seconds: Math.max(5, Math.ceil(Math.max(0, plan.live - Math.max(0, b.minute)) / 5) * 60) };
  })();
}
app.get("/api/law/jobs/:id", requireAuth, wrap(async (req, res) => {
  const j = lawJobs.get(String(req.params.id));
  if (!j || j.userId !== req.user.id) return res.status(404).json({ error: "That ranking isn't running anymore — run it again." });
  res.json({ status: j.status, done: j.done, total: j.total, live: j.live, error: j.error || null, result: j.status === "done" ? j.result : undefined, created_at: j.created_at || null });
}));
app.post("/api/cases/:id/analyze", requireAuth, rateLimit({ windowMs: 60e3, max: 3, message: { error: "One analysis at a time — try again in a minute." } }), wrap(async (req, res) => {
  const { rows } = await q("SELECT * FROM cases WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]);
  const c = rows[0]; if (!c) return res.status(404).json({ error: "Not found" });
  const issues = typeof req.body?.issues === "string" ? req.body.issues.trim().slice(0, 1000) : c.issues;
  if (issues !== c.issues) await q("UPDATE cases SET issues=$2 WHERE id=$1", [c.id, issues]);
  try {
    const r = await startLawJob(req, { issues, county: c.county, onDone: async result => {
      await q("INSERT INTO analyses(case_id,user_id,issues,result) VALUES($1,$2,$3,$4)", [c.id, req.user.id, issues, result]);
      await q("UPDATE cases SET law_checked_at=now() WHERE id=$1", [c.id]);
    } });
    await audit(req, "case_analyzed", { case_id: c.id, lookups: r.live });
    res.json({ ...r, issues });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));
app.get("/api/cases/:id/analysis", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT a.id, a.issues, a.result, a.created_at FROM analyses a JOIN cases c ON c.id=a.case_id WHERE a.case_id=$1 AND c.firm_id=$2 ORDER BY a.created_at DESC LIMIT 1", [+req.params.id, req.user.firm_id]);
  res.json({ analysis: rows[0] || null });
}));
app.post("/api/cases/:id/law-ack", requireAuth, wrap(async (req, res) => {
  await q("UPDATE cases SET law_alert=NULL WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true });
}));
app.get("/api/cases/:id/changes", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT ch.* FROM case_changes ch JOIN cases c ON c.id=ch.case_id WHERE ch.case_id=$1 AND c.firm_id=$2 AND ch.field='next_setting' ORDER BY ch.at DESC LIMIT 50", [+req.params.id, req.user.firm_id]);
  res.json({ changes: rows });
}));
// Firm admins: tick "watch court dates" on all of one attorney's cases at once.
app.post("/api/cases/watch-all", requireAuth, wrap(async (req, res) => {
  const uid = access.seesFirm(req.user) && req.body?.user_id ? +req.body.user_id : req.user.id;
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
    if (!c.cause_no && PRE_FILING.includes(c.stage)) c.cause_no = preCause();   // not filed yet
    const county = COUNTIES.find(x => x.toLowerCase() === String(c.county || "").toLowerCase().replace(/\s*county$/, ""));
    if (!county || !c.cause_no) { skipped.push(`${c.cause_no || "?"}: missing county/cause #`); continue; }
    if (!(req.user.counties || []).includes(county)) { skipped.push(`${c.cause_no}: ${county} not in your counties`); continue; }
    c.county = county;
    const cols = Object.keys(c);
    const ins = await q(`INSERT INTO cases(firm_id,user_id,source,${cols.join(",")}) VALUES($1,$2,'csv',${cols.map((_, i) => "$" + (i + 3)).join(",")}) ON CONFLICT DO NOTHING RETURNING *`,
      [req.user.firm_id, req.user.id, ...cols.map(k => c[k])]);
    if (ins.rowCount) { added++; await practice.onCaseCreated(ins.rows[0], req.user.id); } else skipped.push(`${c.cause_no}: already in list`);
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
const cronOk = (given, tok) => { given = String(given || "").trim(); tok = String(tok || "").trim(); return !!tok && given.length === tok.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(tok)); };
// Free outside timer (cron-job.org): GET /api/cron/hourly?key=CRON_KEY every 10 minutes keeps the free server awake;
// the hourly work itself still runs at most once every 50 minutes.
app.get("/api/cron/hourly", wrap(async (req, res) => {
  if (!cronOk(req.query.key, process.env.CRON_KEY)) return res.status(403).json({ error: "Forbidden" });
  if (Date.now() - lastHourly < 50 * 60e3) return res.json({ awake: true, skipped: "ran recently" });
  lastHourly = Date.now(); console.log("[cron] outside timer started hourly check");
  sync.hourly().catch(e => console.error("[cron] hourly", e.message));
  res.json({ started: true });
}));
app.post("/api/cron/hourly", wrap(async (req, res) => {
  if (!cronOk(req.get("X-Cron-Token"), process.env.SYNC_TOKEN)) return res.status(403).json({ error: "Forbidden" });
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
  const { rows } = await q("SELECT id, provider, email, status, last_sync, last_error, stats FROM mailboxes WHERE user_id=$1 AND shared_firm IS NULL ORDER BY provider", [req.user.id]);
  for (const r of rows) if (mail.running.has(r.id)) r.status = "syncing";
  const g = await mail.imapGuess(req.user.email).catch(() => ({ label: null }));
  res.json({ configured: await mail.configuredFor(req.user.firm_id), names: mail.NAMES, other: { label: g.label, provider: g.det?.provider || null }, mailboxes: rows });
}));
app.get("/api/mail/detect", requireAuth, wrap(async (req, res) => res.json(await mail.detect(req.user.email))));
// Firm-wide (admin): status + start
app.get("/api/firm/mail", requireAuth, requireAdmin, wrap(async (req, res) => {
  const f = (await q("SELECT provider, domain, status, last_sync, last_error, stats FROM firm_mail WHERE firm_id=$1", [req.user.firm_id])).rows[0] || null;
  const det = await mail.detect(req.user.email);
  const covered = f ? (await q("SELECT name, email FROM users WHERE firm_id=$1 AND active AND lower(split_part(email,'@',2))=lower($2) ORDER BY name", [req.user.firm_id, f.domain])).rows : [];
  res.json({ firm: f, detect: det, covered, configured: await mail.configuredFor(req.user.firm_id), google_sa_client_id: mail.GSA().clientId || null });
}));
app.get("/api/firm/mail/microsoft", requireAuth, requireAdmin, wrap(async (req, res) => {
  const det = await mail.detect(req.user.email);
  if (!(await mail.configuredFor(req.user.firm_id)).microsoft) return res.redirect("/?mailerror=" + encodeURIComponent("Microsoft connection isn't switched on yet."));
  if (det.personal) return res.redirect("/?mailerror=" + encodeURIComponent("Firm-wide connect needs a firm email domain (not a personal Outlook/Gmail address)."));
  res.redirect(await mail.adminConsentUrl(req.user.firm_id, det.domain, { dev: !!req.devView }));
}));
app.get("/api/mail/admin-callback/microsoft", async (req, res) => {
  try { await mail.finishAdminConsent(req.query); res.redirect("/?connected=" + encodeURIComponent("whole firm (Microsoft 365)")); }
  catch (e) { console.error("[mail] admin consent failed", e.message); res.redirect("/?mailerror=" + encodeURIComponent(e.message.slice(0, 200))); }
});
app.post("/api/firm/mail/google", requireAuth, requireAdmin, wrap(async (req, res) => {
  const det = await mail.detect(req.user.email);
  if (det.personal || !det.domain) return res.status(400).json({ error: "Firm-wide connect needs a firm email domain." });
  try { await mail.connectGoogleFirm(req.user.firm_id, det.domain, req.user.email, { dev: !!req.devView }); await audit(req, "firm_mail_google"); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post("/api/firm/mail/sync", requireAuth, requireAdmin, wrap(async (req, res) => { mail.syncFirm(req.user.firm_id).catch(() => {}); res.json({ started: true }); }));
app.delete("/api/firm/mail", requireAuth, requireAdmin, wrap(async (req, res) => { await q("DELETE FROM firm_mail WHERE firm_id=$1", [req.user.firm_id]); await audit(req, "firm_mail_disconnected"); res.json({ ok: true }); }));
app.get("/api/mail/connect/:provider", requireAuth, wrap(async (req, res) => {
  const p = req.params.provider;
  if (!mail.PROVIDERS[p] || !(await mail.configuredFor(req.user.firm_id))[p]) return res.redirect("/?mailerror=" + encodeURIComponent("That email provider isn't switched on yet."));
  res.redirect(await mail.startUrl(p, req.user, { full: req.query.full === "1", dev: !!req.devView }));
}));
// Password sign-in (IMAP) for Titan / GoDaddy / Zoho and other hosts
app.post("/api/mail/imap", requireAuth, wrap(async (req, res) => {
  try { const r = await mail.connectImap(req.user, req.body || {}, { dev: !!req.devView }); await audit(req, "mailbox_connected_imap", { host: r.host }); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
// A firm's own Microsoft (Azure) keys — entered by the firm admin, stored encrypted, never shown again
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get("/api/firm/ms-keys", requireAuth, requireAdmin, wrap(async (req, res) => {
  const f = (await q("SELECT ms_client_id, ms_tenant, ms_secret_hint, ms_keys_at, ms_keys_by, setup_help_at, setup_help_done FROM firms WHERE id=$1", [req.user.firm_id])).rows[0] || {};
  const base = (process.env.APP_URL || "https://tx-case-desk.onrender.com").replace(/\/$/, "");
  res.json({ help: f.setup_help_at && !f.setup_help_done ? f.setup_help_at : null, own: !!f.ms_client_id, client_id: f.ms_client_id || null, tenant: f.ms_tenant || null, hint: f.ms_secret_hint || null, at: f.ms_keys_at, by: f.ms_keys_by,
    shared: mail.configured().microsoft, redirects: [`${base}/api/mail/callback/microsoft`, `${base}/api/mail/admin-callback/microsoft`] });
}));
app.post("/api/firm/ms-keys", requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = String(req.body?.client_id || "").trim(), tenant = String(req.body?.tenant || "").trim(), secret = String(req.body?.secret || "").trim();
  if (!GUID.test(id)) return res.status(400).json({ error: "Application (client) ID should look like 19a4bf2f-3116-4960-9f89-225d69d956bc." });
  if (!GUID.test(tenant)) return res.status(400).json({ error: "Directory (tenant) ID should look like 495c209c-9687-4bd6-b667-94280ce2ac83." });
  if (secret.length < 20 || GUID.test(secret)) return res.status(400).json({ error: "That isn't the secret Value. Copy the long code in the Value column (not the Secret ID)." });
  try { await mail.testFirmKeys({ id, secret, tenant }); } catch (e) { return res.status(400).json({ error: e.message }); }
  await q("UPDATE firms SET ms_client_id=$2, ms_tenant=$3, ms_secret_enc=$4, ms_secret_hint=$5, ms_keys_at=now(), ms_keys_by=$6 WHERE id=$1",
    [req.user.firm_id, id, tenant, box.seal(secret), secret.slice(0, 3) + "…" + secret.slice(-3), req.user.name]);
  await audit(req, "firm_ms_keys_saved", { client_id: id, tenant });
  await q("UPDATE firms SET setup_help_done=true WHERE id=$1 AND setup_help_at IS NOT NULL", [req.user.firm_id]);
  res.json({ ok: true });
}));
// Firm asks for developer-assisted Microsoft setup (one-time fee); shows up on the firm's card in My Apps
app.post("/api/firm/setup-help", requireAuth, requireAdmin, wrap(async (req, res) => {
  const phone = String(req.body?.phone || "").trim().slice(0, 40), note = String(req.body?.note || "").trim().slice(0, 500);
  if (!phone) return res.status(400).json({ error: "Add a phone number so we can reach you." });
  await q("UPDATE firms SET setup_help_at=now(), setup_help_done=false, setup_help_note=$2 WHERE id=$1", [req.user.firm_id, `${req.user.name} · ${phone}${note ? " · " + note : ""}`]);
  await audit(req, "setup_help_requested", { phone }); console.log(`[setup-help] firm ${req.user.firm_id} (${req.user.firm_name}) asked for Microsoft setup help`);
  res.json({ ok: true });
}));
app.delete("/api/firm/ms-keys", requireAuth, requireAdmin, wrap(async (req, res) => {
  await q("UPDATE firms SET ms_client_id=NULL, ms_tenant=NULL, ms_secret_enc=NULL, ms_secret_hint=NULL, ms_keys_at=NULL, ms_keys_by=NULL WHERE id=$1", [req.user.firm_id]);
  await audit(req, "firm_ms_keys_removed"); res.json({ ok: true });
}));
app.get("/api/mail/callback/:provider", async (req, res) => {
  try {
    if (req.query.error) throw new Error(req.query.error_description || "Access was not allowed.");
    const r = await mail.finish(req.params.provider, String(req.query.code || ""), String(req.query.state || ""));
    res.redirect("/?connected=" + encodeURIComponent(r.shared ? `firm court inbox ${r.email || ""}`.trim() : r.email || req.params.provider));
  } catch (e) { console.error("[mail] connect failed", e.message); res.redirect("/?mailerror=" + encodeURIComponent(e.message.slice(0, 200))); }
});
app.post("/api/mail/:id/sync", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id FROM mailboxes WHERE id=$1 AND user_id=$2 AND shared_firm IS NULL", [+req.params.id, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  mail.syncMailbox(rows[0].id).catch(() => {}); res.json({ started: true });
}));
app.delete("/api/mail/:id", requireAuth, wrap(async (req, res) => {
  await q("DELETE FROM mailboxes WHERE id=$1 AND user_id=$2 AND shared_firm IS NULL", [+req.params.id, req.user.id]);
  await audit(req, "mailbox_disconnected", { id: +req.params.id }); res.json({ ok: true });
}));

// ---------- shared court inbox (one firm address; admins or chosen staff assign what can't be matched) ----------
async function courtInboxInfo(firmId) {
  const f = (await q("SELECT court_mode, court_email, court_stats, court_token FROM firms WHERE id=$1", [firmId])).rows[0] || {};
  const mb = (await q("SELECT id, provider, email, status, last_sync, last_error, stats FROM mailboxes WHERE shared_firm=$1", [firmId])).rows[0] || null;
  if (mb && mail.running.has(mb.id)) mb.status = "syncing";
  const fm = (await q("SELECT provider, domain, status FROM firm_mail WHERE firm_id=$1", [firmId])).rows[0] || null;
  const queue = (await q("SELECT count(*)::int n FROM inbound_emails WHERE firm_id=$1 AND shared AND user_id IS NULL AND dismissed_at IS NULL", [firmId])).rows[0].n;
  const routed = (await q("SELECT count(*)::int n FROM inbound_emails WHERE firm_id=$1 AND shared AND user_id IS NOT NULL AND dismissed_at IS NULL AND received_at > now() - interval '30 days'", [firmId])).rows[0].n;
  const fwd = f.court_token ? inbound.addressFor(f.court_token) : null;
  return { mode: f.court_mode || "each", mailbox: mb, court_email: f.court_email || null, court_stats: f.court_stats || null, firm_mail: fm,
    forward: fwd, forward_on: !!inbound.addressFor("x"), queue, routed30: routed,
    connected: !!(mb || (f.court_email && fm) || f.court_token) };
}
app.get("/api/firm/court-inbox", requireAuth, requireAdmin, wrap(async (req, res) => {
  const info = await courtInboxInfo(req.user.firm_id);
  const people = (await q("SELECT id, name, role, court_handler FROM users WHERE firm_id=$1 AND active ORDER BY name", [req.user.firm_id])).rows;
  res.json({ ...info, people, configured: await mail.configuredFor(req.user.firm_id) });
}));
app.put("/api/firm/court-inbox", requireAuth, requireAdmin, wrap(async (req, res) => {
  const b = req.body || {}, fid = req.user.firm_id;
  if (req.devView && b.handlers !== undefined) return res.status(403).json({ error: "Developer view can set up the court inbox, but not change who handles it.", code: "DEV_READONLY" });
  if (b.mode !== undefined) {
    if (!["each", "shared", "both"].includes(b.mode)) return res.status(400).json({ error: "Pick how your firm gets court emails." });
    await q("UPDATE firms SET court_mode=$2 WHERE id=$1", [fid, b.mode]);
  }
  if (Array.isArray(b.handlers)) {
    const ids = b.handlers.map(Number).filter(Boolean);
    await q("UPDATE users SET court_handler = (id = ANY($2::int[])) WHERE firm_id=$1", [fid, ids]);
  }
  if (b.court_email !== undefined) {
    const e = String(b.court_email || "").trim().toLowerCase();
    if (!e) await q("UPDATE firms SET court_email=NULL, court_stats=NULL WHERE id=$1", [fid]);
    else {
      const fm = (await q("SELECT domain FROM firm_mail WHERE firm_id=$1", [fid])).rows[0];
      if (!fm) return res.status(400).json({ error: "Turn on the firm-wide Microsoft 365 or Google connection first, or sign in to the shared inbox instead." });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.split("@")[1] !== String(fm.domain).toLowerCase()) return res.status(400).json({ error: `Use an @${fm.domain} address — the firm-wide connection only reaches your firm's own mailboxes.` });
      await q("UPDATE firms SET court_email=$2, court_seen=NULL, court_stats=NULL WHERE id=$1", [fid, e]);
      mail.syncFirm(fid).catch(() => {});
    }
  }
  if (b.forward === true) await q("UPDATE firms SET court_token=COALESCE(court_token, $2) WHERE id=$1", [fid, "court-" + crypto.randomBytes(8).toString("hex")]);
  if (b.forward === false) await q("UPDATE firms SET court_token=NULL WHERE id=$1", [fid]);
  await audit(req, "court_inbox_settings", { mode: b.mode, handlers: Array.isArray(b.handlers) ? b.handlers.length : undefined, court_email: b.court_email !== undefined ? !!b.court_email : undefined, forward: b.forward });
  res.json(await courtInboxInfo(fid));
}));
app.get("/api/firm/court-inbox/connect/microsoft", requireAuth, requireAdmin, wrap(async (req, res) => {
  if (!(await mail.configuredFor(req.user.firm_id)).microsoft) return res.redirect("/?mailerror=" + encodeURIComponent("Outlook sign-in isn't switched on yet."));
  res.redirect(await mail.startUrl("microsoft", req.user, { shared: true, dev: !!req.devView }));
}));
app.post("/api/firm/court-inbox/imap", requireAuth, requireAdmin, wrap(async (req, res) => {
  try { const r = await mail.connectImap(req.user, req.body || {}, { shared: true, dev: !!req.devView }); await audit(req, "court_inbox_connected", { provider: "imap", host: r.host }); res.json(r); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post("/api/firm/court-inbox/sync", requireAuth, requireAdmin, wrap(async (req, res) => {
  const mb = (await q("SELECT id FROM mailboxes WHERE shared_firm=$1", [req.user.firm_id])).rows[0];
  if (mb) mail.syncMailbox(mb.id).catch(() => {});
  const f = (await q("SELECT court_email FROM firms WHERE id=$1", [req.user.firm_id])).rows[0];
  if (f?.court_email) mail.syncFirm(req.user.firm_id).catch(() => {});
  const mode = ((await q("SELECT court_mode FROM firms WHERE id=$1", [req.user.firm_id])).rows[0] || {}).court_mode;
  res.json({ started: mode !== "each" && !!(mb || f?.court_email) });
}));
app.delete("/api/firm/court-inbox/mailbox", requireAuth, requireAdmin, wrap(async (req, res) => {
  await q("DELETE FROM mailboxes WHERE shared_firm=$1", [req.user.firm_id]); await audit(req, "court_inbox_disconnected"); res.json({ ok: true });
}));

// Court notices that came to the shared inbox and couldn't be matched to a case or an attorney
const needHandler = (req, res, next) => courtHandler(req.user) ? next() : res.status(403).json({ error: "Only the firm admin and people they pick can assign court notices." });
app.get("/api/court-queue", requireAuth, needHandler, wrap(async (req, res) => {
  const { rows } = await q(`SELECT id, from_addr, subject, body, kind, causes, matched_case_ids, parsed, received_at FROM inbound_emails
    WHERE firm_id=$1 AND shared AND user_id IS NULL AND dismissed_at IS NULL ORDER BY received_at DESC LIMIT 100`, [req.user.firm_id]);
  const all = await caseRows(req.user.firm_id, [...new Set(rows.flatMap(r => r.causes || []))], req.user);
  const people = (await q("SELECT id, name, role FROM users WHERE firm_id=$1 AND active AND role IN ('admin','partner','manager','attorney') ORDER BY name", [req.user.firm_id])).rows;
  res.json({ people, emails: rows.map(r => { const sm = inbound.summarize(r, mapFor(all, r)); const p = r.parsed || {};
    return { id: r.id, from_addr: r.from_addr, subject: r.subject, received_at: r.received_at, type: sm.type, dates: sm.dates, cases: sm.cases,
      preview: sm.lines[0] || String(r.body || "").replace(/\s+/g, " ").slice(0, 160),
      notice: { cause_no: p.cause_no || (r.causes || [])[0] || "", county: p.county || inbound.countyIn(r.body || "") || "", style: p.style || "", court: p.court_name || p.court || "", next_setting: p.next_setting || "" } }; }) });
}));
app.post("/api/court-queue/:id/assign", requireAuth, needHandler, wrap(async (req, res) => {
  const fid = req.user.firm_id, b = req.body || {};
  // only notices still waiting can be assigned; one already delivered to an attorney is theirs
  const e = (await q("SELECT * FROM inbound_emails WHERE id=$1 AND firm_id=$2 AND shared AND user_id IS NULL AND dismissed_at IS NULL", [+req.params.id, fid])).rows[0];
  if (!e) { const was = (await q("SELECT 1 FROM inbound_emails WHERE id=$1 AND firm_id=$2 AND shared", [+req.params.id, fid])).rowCount;
    return res.status(was ? 409 : 404).json({ error: was ? "That notice was already assigned or removed." : "Not found" }); }
  let owner = null, caseId = null, created = false;
  if (b.case_id || b.link_cause) {
    const sel = "SELECT c.id, c.user_id, c.cause_no, c.county, u.name AS owner_name, coalesce(u.active, false) AS owner_active, u.role AS owner_role FROM cases c LEFT JOIN users u ON u.id=c.user_id";
    let c;
    if (b.case_id) c = (await q(`${sel} WHERE c.id=$1 AND c.firm_id=$2`, [+b.case_id, fid])).rows[0];
    else {
      // the same cause # can exist in two counties: use the county picked on the form; ask for it when it's needed
      const all = (await q(`${sel} WHERE c.firm_id=$1 AND upper(c.cause_no)=$2 ORDER BY c.id`, [fid, String(b.link_cause || "").trim().toUpperCase()])).rows;
      // county only matters when the cause # is in more than one county (then: the form's county, else the one on the notice)
      const co = new Set(all.map(x => String(x.county || "").toLowerCase())).size > 1 ? (b.county || (e.parsed || {}).county || "") : "";
      const inCo = co ? all.filter(x => String(x.county || "").toLowerCase() === String(co).toLowerCase()) : all;
      if (!all.length || (co && !inCo.length)) return res.status(404).json({ error: `No case with that cause #${co ? " in " + co + " County" : ""} in the app — pick "A new case — add it" instead.` });
      if (new Set(inCo.map(x => x.county)).size > 1) return res.status(400).json({ error: `That cause # is in more than one county (${[...new Set(inCo.map(x => x.county))].join(", ")}). Pick the county.` });
      c = inCo[0];
    }
    if (!c) return res.status(404).json({ error: "Case not found" });
    if (!c.owner_active) return res.status(400).json({ error: `That case's attorney${c.owner_name ? " (" + c.owner_name + ")" : ""} no longer has an active account. Send it to an attorney instead, and reassign the case in Cases.` });
    if (!["admin", "partner", "manager", "attorney"].includes(c.owner_role)) return res.status(400).json({ error: `That case is led by ${c.owner_name || "someone"}, who isn't an attorney. Send it to an attorney instead, or change the case's lead attorney in Cases.` });
    owner = c.user_id; caseId = c.id;
  } else {
    const a = (await q("SELECT id FROM users WHERE id=$1 AND firm_id=$2 AND active AND role IN ('admin','partner','manager','attorney')", [+b.attorney || 0, fid])).rows[0];
    if (!a) return res.status(400).json({ error: "Pick the attorney." });
    owner = a.id;
    if (b.create) {
      const cause = String(b.create.cause_no || "").trim().toUpperCase().slice(0, 60), county = String(b.create.county || "").trim();
      if (!cause || !COUNTIES.includes(county)) return res.status(400).json({ error: "A new case needs the cause # and the county." });
      const ins = await q(`INSERT INTO cases(firm_id,user_id,county,cause_no,court,style,status,next_setting,source,tracked,watch_dates)
        VALUES($1,$2,$3,$4,$5,$6,'Active',$7,'email',true,true) ON CONFLICT DO NOTHING RETURNING id, user_id, cause_no, county`,
        [fid, owner, county, cause, String(b.create.court || "").slice(0, 200) || null, String(b.create.style || "").slice(0, 300) || null, String(b.create.next_setting || "").slice(0, 300) || null]);
      if (ins.rows[0]) { caseId = ins.rows[0].id; created = true; practice.onCaseCreated({ ...ins.rows[0], firm_id: fid }, owner).catch(() => {}); }
      else { const ex = (await q("SELECT c.id, c.user_id, coalesce(u.active, false) AND u.role IN ('admin','partner','manager','attorney') AS owner_ok FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.firm_id=$1 AND c.county=$2 AND upper(c.cause_no)=$3", [fid, county, cause])).rows[0];
        if (ex) { caseId = ex.id; if (ex.owner_ok) owner = ex.user_id; } }   // the case already exists: it goes to that case's attorney (if an active attorney)
    }
  }
  if (caseId) await q("UPDATE cases SET filing_alert=$2, filing_alert_at=now(), updated_at=now() WHERE id=$1", [caseId, `${created ? "New case added from court email: " : ""}${e.subject || "Court update"}`.slice(0, 600)]);
  const done = await q(`UPDATE inbound_emails SET user_id=$2, routed='manual', assigned_by=$3, assigned_at=now(), read_at=NULL,
    matched_case_ids = CASE WHEN $4::int IS NULL THEN matched_case_ids ELSE array(SELECT DISTINCT unnest(coalesce(matched_case_ids,'{}') || ARRAY[$4::int])) END
    WHERE id=$1 AND user_id IS NULL AND dismissed_at IS NULL`, [e.id, owner, req.user.id, caseId]);
  if (!done.rowCount) return res.status(409).json({ error: "Someone else just assigned or removed that notice." });
  await audit(req, "court_notice_assigned", { email: e.id, to: owner, case: caseId, created });
  res.json({ ok: true, owner, case_id: caseId, created });
}));
app.post("/api/court-queue/:id/dismiss", requireAuth, needHandler, wrap(async (req, res) => {
  const r = await q("UPDATE inbound_emails SET dismissed_at=now(), assigned_by=$3 WHERE id=$1 AND firm_id=$2 AND shared AND user_id IS NULL", [+req.params.id, req.user.firm_id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found" });
  await audit(req, "court_notice_dismissed", { email: +req.params.id }); res.json({ ok: true });
}));

// ---------- re:SearchTX alert emails (Postmark inbound webhook) ----------
app.post("/api/inbound/postmark", wrap(async (req, res) => {
  const key = (process.env.INBOUND_KEY || "").trim(), given = String(req.query.key || "").trim();
  if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return res.status(403).json({ error: "Forbidden" });
  try { res.json(await inbound.handle(req.body || {})); }
  catch (e) { console.error("[inbound] failed", e.message); res.json({ ok: false }); } // 200 so Postmark doesn't retry forever
}));
app.get("/api/email-alerts", requireAuth, wrap(async (req, res) => {
  const token = req.devView || req.user.demo_until ? (await q("SELECT inbox_token FROM users WHERE id=$1", [req.user.id])).rows[0]?.inbox_token || null : await inbound.tokenFor(req.user.id);
  const { rows } = await q("SELECT id, from_addr, subject, kind, causes, matched_case_ids, confirm_code, received_at FROM inbound_emails WHERE user_id=$1 AND dismissed_at IS NULL ORDER BY received_at DESC LIMIT 30", [req.user.id]);
  const confirm = rows.find(r => r.kind === "forward_confirm" && r.confirm_code);
  const known = rows.length ? (await q("SELECT upper(cause_no) c FROM cases WHERE firm_id=$1", [req.user.firm_id])).rows.map(r => r.c) : [];
  res.json({ address: token ? inbound.addressFor(token) : null, configured: !!(token && inbound.addressFor(token)), confirm: confirm ? { code: confirm.confirm_code, at: confirm.received_at } : null,
    emails: rows.filter(r => r.kind !== "forward_confirm").map(r => ({ ...r, unmatched: (r.causes || []).filter(c => !known.includes(c)) })) });
}));
app.get("/api/email-alerts/:id", requireAuth, wrap(async (req, res) => {
  // the person it went to, an assigner (unassigned shared notices), or anyone who can see a case the email is about
  const p = [+req.params.id, req.user.id, req.user.firm_id, courtHandler(req.user)];
  // "about a case" = matched to it when it arrived, or same cause # in the same county (a cause # alone can repeat across counties)
  const onCase = `(dismissed_at IS NULL AND EXISTS (SELECT 1 FROM cases c WHERE c.firm_id=$3 AND (c.id = ANY(e.matched_case_ids) OR (upper(c.cause_no) = ANY(e.causes) AND lower(e.parsed->>'county') = lower(c.county))) AND ${access.caseCond(req.user, "c", p)}))`;
  const { rows } = await q(`SELECT id, from_addr, subject, body, html, kind, causes, matched_case_ids, parsed, received_at, user_id, shared FROM inbound_emails e WHERE id=$1 AND firm_id=$3 AND (user_id=$2 OR ($4 AND shared AND user_id IS NULL) OR ${onCase})`, p);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  if (rows[0].user_id === req.user.id && !req.devView) await q("UPDATE inbound_emails SET read_at=now() WHERE id=$1 AND read_at IS NULL", [rows[0].id]);
  const cm = await caseMap(req.user.firm_id, rows[0].causes || [], req.user, rows[0].matched_case_ids || [], (rows[0].parsed || {}).county);
  delete rows[0].matched_case_ids; delete rows[0].parsed;
  res.json({ email: rows[0], summary: inbound.summarize(rows[0], cm) });
}));
// cause # → case. The same cause # can exist in two counties: the case the email was matched to wins, then the county it names.
async function caseRows(firmId, causes, viewer) {
  if (!causes.length) return [];
  const p = [firmId, causes], only = viewer ? " AND " + access.caseCond(viewer, "cases", p) : "";   // only cases this person may see
  return (await q(`SELECT id, upper(cause_no) c, style, county FROM cases WHERE firm_id=$1 AND upper(cause_no) = ANY($2)${only} ORDER BY id`, p)).rows;
}
// one email's cause numbers → cases; when a cause # is in two counties, the case it was matched to wins, then the county it names
function pickCases(rows, causes, prefer = [], county = null) {
  const want = new Set(causes || []), lc = x => String(x || "").toLowerCase();
  const score = r => (prefer.includes(r.id) ? 2 : 0) + (county && lc(r.county) === lc(county) ? 1 : 0);
  const list = rows.filter(r => want.has(r.c)).sort((a, b) => score(a) - score(b) || a.id - b.id);   // best match last, so it is the one kept
  return Object.fromEntries(list.map(r => [r.c, { id: r.id, style: r.style, county: r.county }]));
}
async function caseMap(firmId, causes, viewer, prefer = [], county = null) { return pickCases(await caseRows(firmId, causes, viewer), causes, prefer, county); }
const mapFor = (all, r) => pickCases(all, r.causes, r.matched_case_ids || [], (r.parsed || {}).county);
// Inbox: every email received for this attorney, newest first, each with a short summary.
app.get("/api/inbox", requireAuth, wrap(async (req, res) => {
  const { rows } = await q("SELECT id, from_addr, subject, body, kind, causes, matched_case_ids, parsed, read_at, received_at FROM inbound_emails WHERE user_id=$1 AND dismissed_at IS NULL ORDER BY received_at DESC LIMIT 200", [req.user.id]);
  const all = await caseRows(req.user.firm_id, [...new Set(rows.flatMap(r => r.causes || []))], req.user);
  res.json({ unread: rows.filter(r => !r.read_at).length, emails: rows.map(r => {
    const sm = inbound.summarize(r, mapFor(all, r));
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
// Rank the ways forward and the authorities for an argument, without opening a case (same rule-based analysis as a case's Case law tab)
app.post("/api/law/analyze", requireAuth, rateLimit({ windowMs: 60e3, max: 3, message: { error: "One ranking at a time — try again in a minute." } }), wrap(async (req, res) => {
  const issues = String(req.body?.issues || "").trim().slice(0, 1000);
  const county = COUNTIES.includes(req.body?.county) ? req.body.county : null;
  try { const r = await startLawJob(req, { issues, county }); await audit(req, "law_ranked", { county, issues: issues.slice(0, 120), lookups: r.live }); res.json({ ...r, issues }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
}));
app.get("/api/law/budget", requireAuth, wrap(async (req, res) => res.json({ ...(await cl.budget()), local: await lawdb.available() })));
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

// ---------- practice management (calendar, clients, documents, tasks, billing, trust, portal) ----------
practice.mount(app, { requireAuth, requireAdmin, wrap, audit });
require("./mailbox").mount(app, { requireAuth, wrap, audit });   // full mail client (Outlook-style)
require("./discovery").mount(app, { requireAuth, wrap, audit });   // discovery responses: split, AI draft, attorney approves, serve
require("./dictate").mount(app, { requireAuth, wrap });   // dictation: AI fixes grammar, the person chooses to insert it
require("./convos").mount(app, { requireAuth, wrap, audit });   // conversation log on each case
require("./activity").mount(app, { requireAuth, wrap });   // activity log: everything on a case in one timeline
demo.mount(app, { wrap, audit, terms: TERMS });   // "Try the demo": a sample firm per visitor, nothing leaves the app

// ---------- static + errors ----------
app.use(express.static(path.join(__dirname, "public"), { index: "index.html", setHeaders: r => r.setHeader("Cache-Control", "no-cache") }));
app.use((req, res) => req.path.startsWith("/api") ? res.status(404).json({ error: "Not found" }) : res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => {
  if (err instanceof cl.CLError) return res.status(err.status || 502).json({ error: err.message });
  if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) { console.warn(`[http] ${err.type} on ${req.method} ${req.path}`); return res.status(err.status || 400).json({ error: "Bad request" }); }
  if (err && err.status >= 400 && err.status < 500 && err.message && !err.type) return res.status(err.status).json({ error: err.message });   // a plain-English refusal raised on purpose
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 3000;
migrate().then(() => app.listen(PORT, () => { setTimeout(() => lateIndexes(), 20000); console.log("TX Case Desk on :" + PORT); console.log(`Outlook connect: TX Case Desk app ${mail.configured().microsoft ? "ON" : "OFF"} (MS_CLIENT_ID ${process.env.MS_CLIENT_ID ? "set" : "missing"}, MS_CLIENT_SECRET ${process.env.MS_CLIENT_SECRET ? "set" : "missing"}); firms may use their own keys`); sync.startScheduler(); setTimeout(() => mail.rescanOld().then(n => n && console.log(`[mail] rescanned ${n} mailbox(es) back 30 days`)).catch(e => console.error("[mail] rescan", e.message)), 15000);
  if (process.env.NODE_ENV === "production") setTimeout(() => sync.MODULES.odyssey.probe(CONNECTORS.Hidalgo.url).catch(() => {}), 5000);
  // court settings emails saved before the settings reader existed
  setTimeout(() => inbound.backfillSettings().catch(e => console.warn("[inbound] settings backfill:", e.message)), 8000); })).catch(e => { console.error("DB migrate failed", e); process.exit(1); });
