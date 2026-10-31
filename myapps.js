// Subscriptions are managed in Steve's My Apps console (same as Karaoke and Band Tips).
// This file is TX Case Desk's side: start a firm's trial, redeem free-time codes, refresh the plan,
// and answer My Apps' platform calls (list firms, set plan, turn a firm off/on).
const crypto = require("crypto");
const { q } = require("./db");

const SLUG = "txcasedesk";
const BASE = () => (process.env.MYAPPS_URL || "").trim().replace(/\/$/, "");
const SECRET = () => (process.env.MYAPPS_SECRET || "").trim();
const enabled = () => !!(BASE() && SECRET());
const tenantKey = firmId => `firm:${firmId}`;

async function call(path, body) {
  const r = await fetch(BASE() + path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: SLUG, secret: SECRET(), ...body }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `My Apps said ${r.status}`), { status: r.status });
  return j;
}
async function save(firmId, p) {
  await q("UPDATE firms SET plan=$2, plan_expires=$3, plan_source=$4, plan_checked=now() WHERE id=$1",
    [firmId, p.plan || "free", p.expires_on ? String(p.expires_on).slice(0, 10) : null, p.source || null]);
}

// New firm: start its free trial (14 days, set in My Apps). Optional code adds free time on top.
async function onSignup(firmId, firmName, code) {
  if (!enabled()) return { plan: "pro", note: "subscriptions not connected" };
  const t = await call("/api/v1/trial", { tenant: tenantKey(firmId), tenantName: firmName });
  await save(firmId, t);
  if (code) { try { const r = await call("/api/v1/redeem-tenant", { tenant: tenantKey(firmId), tenantName: firmName, code }); await save(firmId, r); } catch (e) { return { ...t, codeError: e.message }; } }
  return t;
}
async function redeem(firmId, firmName, code) {
  const r = await call("/api/v1/redeem-tenant", { tenant: tenantKey(firmId), tenantName: firmName, code: String(code || "").trim() });
  await save(firmId, r);
  return r;
}
// Refresh from My Apps at most once an hour (also catches expired trials).
async function refresh(firm, force = false) {
  if (!enabled()) return firm;
  if (!force && firm.plan_checked && Date.now() - new Date(firm.plan_checked) < 3600e3) return firm;
  try { const p = await call("/api/v1/plan", { tenant: tenantKey(firm.id) }); await save(firm.id, p); return { ...firm, plan: p.plan, plan_expires: p.expires_on, plan_source: p.source, trial_over: p.trial_over }; }
  catch (e) { console.error("[myapps] plan refresh failed", e.message); return firm; }
}
function active(firm) {
  if (firm.disabled) return { ok: false, code: "FIRM_OFF", reason: "This firm's account has been turned off. Contact support." };
  if (!enabled()) return { ok: true };
  if (firm.plan === "pro") return { ok: true };
  return { ok: false, code: "PLAN_EXPIRED", reason: firm.plan_source === "trial" ? "Your free trial has ended." : "Your subscription isn't active." };
}

// ---- My Apps → TX Case Desk (signed with the shared secret) ----
function platformAuth(req, res, next) {
  const key = String(req.get("x-platform-key") || ""), s = SECRET();
  if (!s || key.length !== s.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(s))) return res.status(403).json({ error: "Forbidden" });
  next();
}
async function listFirms(appUrl) {
  const { rows } = await q(`SELECT f.*,
      (SELECT count(*)::int FROM users u WHERE u.firm_id=f.id AND u.active) AS users,
      (SELECT count(*)::int FROM cases c WHERE c.firm_id=f.id) AS cases,
      (SELECT u.email FROM users u WHERE u.firm_id=f.id AND u.role='admin' ORDER BY u.id LIMIT 1) AS admin_email,
      (SELECT u.name FROM users u WHERE u.firm_id=f.id AND u.role='admin' ORDER BY u.id LIMIT 1) AS admin_name,
      (SELECT max(u.last_login) FROM users u WHERE u.firm_id=f.id) AS last_login,
      (SELECT count(*)::int FROM mailboxes m JOIN users u ON u.id=m.user_id WHERE u.firm_id=f.id) AS mailboxes,
      (SELECT provider FROM firm_mail fm WHERE fm.firm_id=f.id) AS firm_mail
    FROM firms f ORDER BY f.created_at DESC`);
  return rows.map(f => ({
    key: tenantKey(f.id), slug: String(f.id), name: f.name, created: f.created_at, users: f.users, cases: f.cases,
    email: f.admin_email, admin: f.admin_name, last_login: f.last_login, disabled: f.disabled,
    email_connected: f.firm_mail ? `firm-wide (${f.firm_mail})` : f.mailboxes ? `${f.mailboxes} mailbox(es)` : "no",
    plan: { active: f.plan === "pro", expires_on: f.plan_expires, source: f.plan_source, paid: f.plan === "pro" && !f.plan_expires },
    url: appUrl
  }));
}
async function platformAction(firmId, b) {
  const { rows } = await q("SELECT id FROM firms WHERE id=$1", [firmId]);
  if (!rows[0]) throw Object.assign(new Error("No such firm"), { status: 404 });
  if (b.action === "plan") await save(firmId, { plan: b.plan, expires_on: b.expires_on, source: b.source || "manual" });
  else if (b.action === "disable") await q("UPDATE firms SET disabled=true WHERE id=$1", [firmId]);
  else if (b.action === "enable") await q("UPDATE firms SET disabled=false WHERE id=$1", [firmId]);
  else throw Object.assign(new Error("Unknown action"), { status: 400 });
  await q("INSERT INTO audit_log(firm_id, action, detail) VALUES($1,'myapps_action',$2)", [firmId, b]);
  return { ok: true };
}

module.exports = { enabled, onSignup, redeem, refresh, active, platformAuth, listFirms, platformAction, tenantKey };
