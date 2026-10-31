// re:SearchTX alert emails → case updates.
// Each attorney forwards their re:SearchTX alert emails to their own private address
// (<inbound>+<token>@inbound.postmarkapp.com). Postmark posts each email here as JSON.
const crypto = require("crypto");
const { q } = require("./db");
const { COUNTIES } = require("./counties");

// Texas cause-number shapes seen across counties, e.g. C-0412-26-E, 2026-DCL-04411, 2026-CI-18833, DC-26-14002, CL-26-1188-B, 13-24-00123-CV
const CAUSE_RES = [
  /\b[A-Z]{1,4}-\d{2,5}-\d{2}-[A-Z0-9]{1,3}\b/g,
  /\b(?:19|20)\d{2}-[A-Z]{2,5}-\d{3,7}(?:-[A-Z0-9]{1,3})?\b/g,
  /\b[A-Z]{1,4}-\d{2}-\d{3,7}(?:-[A-Z0-9]{1,3})?\b/g,
  /\b\d{2}-\d{2}-\d{4,5}-(?:CV|CR)\b/g,
  /\b(?:19|20)\d{2}-\d{4,7}\b/g
];
function causesIn(text) {
  const found = new Set();
  for (const re of CAUSE_RES) for (const m of String(text).toUpperCase().matchAll(re)) found.add(m[0]);
  return [...found].slice(0, 50);
}
function countyIn(text) { const m = String(text).match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) County\b/); return m && COUNTIES.includes(m[1]) ? m[1] : null; }
const strip = h => String(h || "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

async function tokenFor(userId) {
  const { rows } = await q("SELECT inbox_token FROM users WHERE id=$1", [userId]);
  if (rows[0]?.inbox_token) return rows[0].inbox_token;
  const t = crypto.randomBytes(9).toString("hex");
  await q("UPDATE users SET inbox_token=$2 WHERE id=$1 AND inbox_token IS NULL", [userId, t]);
  return (await q("SELECT inbox_token FROM users WHERE id=$1", [userId])).rows[0].inbox_token;
}
function addressFor(token) {
  const base = (process.env.POSTMARK_INBOUND || "").trim();
  if (!base.includes("@")) return null;
  const [local, domain] = base.split("@");
  return `${local.split("+")[0]}+${token}@${domain}`;
}

async function handle(msg) {
  const hash = (msg.MailboxHash || (msg.ToFull || []).map(t => t.MailboxHash).find(Boolean) || "").trim();
  if (!hash) { console.log(`[inbound] received email with no address tag (subject "${String(msg.Subject || "").slice(0, 60)}")`); return { ignored: "no address tag" }; }
  if (hash === "selftest") { console.log(`[inbound] SELFTEST OK — Postmark → app webhook works (subject "${String(msg.Subject || "").slice(0, 60)}")`); return { ok: true, selftest: true }; }
  const { rows } = await q("SELECT id, firm_id, counties FROM users WHERE inbox_token=$1 AND active", [hash]);
  const u = rows[0];
  if (!u) return { ignored: "unknown tag" };
  const from = msg.FromFull?.Email || msg.From || "";
  const subject = String(msg.Subject || "").slice(0, 300);
  const body = (msg.TextBody && msg.TextBody.trim() ? msg.TextBody : strip(msg.HtmlBody)).slice(0, 50000);
  let kind = "other", confirm = null;
  if (/forwarding-noreply@google\.com/i.test(from) || /forwarding confirmation/i.test(subject)) {
    kind = "forward_confirm";
    confirm = (body.match(/Confirmation code:\s*(\d{6,12})/i) || [])[1] || (body.match(/https:\/\/mail[^\s]*google\.com\/mail\/[^\s]+/) || [])[0] || null;
  } else if (/research|txcourts|tylertech|tylerhost|efiletexas/i.test(from + " " + subject + " " + body.slice(0, 2000))) kind = "research_alert";
  const causes = kind === "forward_confirm" ? [] : causesIn(subject + "\n" + body);
  let matched = [];
  if (causes.length) {
    const m = await q("SELECT id, cause_no FROM cases WHERE firm_id=$1 AND upper(cause_no) = ANY($2)", [u.firm_id, causes]);
    matched = m.rows.map(r => r.id);
    const line = `${subject}`.slice(0, 200) || "re:SearchTX update";
    for (const r of m.rows) {
      // a short excerpt around the cause number for context
      const i = body.toUpperCase().indexOf(r.cause_no.toUpperCase());
      const excerpt = i >= 0 ? body.slice(Math.max(0, i - 80), i + 220).replace(/\s+/g, " ").trim() : "";
      await q("UPDATE cases SET filing_alert=$2, filing_alert_at=now(), updated_at=now() WHERE id=$1", [r.id, `${line}${excerpt ? " — " + excerpt : ""}`.slice(0, 600)]);
    }
  }
  await q(`INSERT INTO inbound_emails(user_id, firm_id, from_addr, subject, body, kind, causes, matched_case_ids, confirm_code)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [u.id, u.firm_id, from.slice(0, 200), subject, body, kind, causes, matched, confirm]);
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail) VALUES($1,$2,'email_alert',$3)", [u.id, u.firm_id, { kind, subject, causes: causes.length, matched: matched.length }]);
  console.log(`[inbound] user ${u.id} kind=${kind} causes=${causes.length} matched=${matched.length} subject="${subject.slice(0, 80)}"`);
  return { ok: true, kind, causes, matched };
}

module.exports = { handle, tokenFor, addressFor, causesIn, countyIn };
