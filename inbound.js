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
  return processEmail(u, { from: msg.FromFull?.Email || msg.From || "", subject: msg.Subject, text: msg.TextBody, html: msg.HtmlBody, ext_id: msg.MessageID ? "pm:" + msg.MessageID : null, source: "forward" });
}

// ---- eFileTexas / clerk notice parser: "Label: value" lines (and "Label<TAB>value" tables) ----
const LABELS = {
  cause_no: ["case number", "cause number", "case #", "case no"],
  style: ["case style", "case title", "style", "case name"],
  court: ["court", "location", "court location", "court name"],
  filing_type: ["filing type"],
  filing_desc: ["filing description", "document description", "description", "document type", "filing code"],
  filed_by: ["filed by", "filer"],
  envelope: ["envelope number", "envelope #", "envelope id"],
  submitted: ["date/time submitted", "submitted date", "date submitted", "filed date"],
  hearing: ["hearing date", "hearing", "setting date", "date of hearing"]
};
function parseNotice(text) {
  const out = {};
  const lines = String(text).split(/\n+/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    for (const [key, labels] of Object.entries(LABELS)) {
      if (out[key]) continue;
      for (const lab of labels) {
        const re = new RegExp("^" + lab.replace(/[.*+?^${}()|[\]\\#\/]/g, "\\$&") + "\\s*[:\\-–]?\\s*(.*)$", "i");
        const m = l.match(re);
        if (m) { const v = (m[1] || "").trim() || (lines[i + 1] && !/:\s*$/.test(lines[i + 1]) ? lines[i + 1] : ""); if (v && v.length < 300) { out[key] = v; break; } }
      }
    }
  }
  if (out.cause_no) out.cause_no = out.cause_no.split(/\s/)[0].toUpperCase();
  const blob = (out.court || "") + " " + lines.slice(0, 40).join(" ");
  const cm = blob.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) County\b/);
  if (cm && COUNTIES.includes(cm[1])) out.county = cm[1];
  const crt = blob.match(/\b(\d{1,3}(?:st|nd|rd|th) (?:Judicial )?District Court|County Court at Law(?: No\.?)? ?#?\d*|Probate Court(?: No\.? ?\d+)?|Justice of the Peace[^,;]*)/i);
  if (crt) out.court_name = crt[1];
  const hl = lines.find(l => /(hearing|set for|setting|trial|docket call|mediation)/i.test(l) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(l) && !/(filed|submitted)/i.test(l));
  if (hl) { const hm = hl.match(/(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]\.?M\.?))?/i); out.next_setting = `${hm[1]}${hm[2] ? " " + hm[2].toUpperCase() : ""} – ${hl.slice(0, 140)}`; }
  return out;
}

// Shared pipeline for forwarded and connected-mailbox emails: store, match/create cases, raise alerts.
async function processEmail(u, { from = "", subject = "", text, html, ext_id = null, source = "forward", received = null }) {
  subject = String(subject || "").slice(0, 300);
  let body = (text && String(text).trim() ? String(text) : strip(html)).slice(0, 50000);
  const hrefs = [...new Set([...String(html || "").matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, "&")).filter(x => /^https?:\/\//i.test(x)))].slice(0, 30);
  if (hrefs.length) body += "\n\nLinks in this email:\n" + hrefs.join("\n");
  let kind = "other", confirm = null;
  if (/forwarding-noreply@google\.com/i.test(from) || /forwarding confirmation/i.test(subject)) {
    kind = "forward_confirm";
    confirm = (body.match(/Confirmation code:\s*(\d{6,12})/i) || [])[1] || (body.match(/https:\/\/mail[^\s]*google\.com\/mail\/[^\s]+/) || [])[0] || null;
  } else if (/re:?search|txcourts|tylertech|tylerhost|efiletexas|\.tx\.us|clerk/i.test(from + " " + subject + " " + body.slice(0, 2000))) kind = "research_alert";
  const parsed = kind === "forward_confirm" ? {} : parseNotice(body);
  const causes = kind === "forward_confirm" ? [] : [...new Set([parsed.cause_no, ...causesIn(subject + "\n" + body)].filter(Boolean))].slice(0, 50);
  // de-dupe the same message (mailbox re-reads)
  if (ext_id && (await q("SELECT 1 FROM inbound_emails WHERE user_id=$1 AND ext_id=$2", [u.id, ext_id])).rowCount) return { duplicate: true };

  let matched = [], created = [];
  if (causes.length) {
    const m = await q("SELECT id, upper(cause_no) c, next_setting, watch_dates FROM cases WHERE firm_id=$1 AND upper(cause_no) = ANY($2)", [u.firm_id, causes]);
    // New case from a court notice: create it (tracked, so it shows even outside the attorney's county list)
    if (parsed.cause_no && kind === "research_alert" && !m.rows.some(r => r.c === parsed.cause_no) && parsed.county) {
      const ins = await q(`INSERT INTO cases(firm_id,user_id,county,cause_no,court,style,status,next_setting,source,tracked,watch_dates)
        VALUES($1,$2,$3,$4,$5,$6,'Active',$7,'email',true,true) ON CONFLICT DO NOTHING RETURNING id, upper(cause_no) c, next_setting, watch_dates`,
        [u.firm_id, u.id, parsed.county, parsed.cause_no, parsed.court_name || parsed.court || null, parsed.style || null, parsed.next_setting || null]);
      if (ins.rows[0]) { created.push(ins.rows[0].id); m.rows.push({ ...ins.rows[0], fresh: true }); require("./practice").onCaseCreated({ ...ins.rows[0], firm_id: u.firm_id, user_id: u.id }, u.id).catch(() => {}); }
    }
    const line = [parsed.filing_desc, parsed.filing_type && !parsed.filing_desc ? parsed.filing_type : null].filter(Boolean).join(" · ") || subject || "Court update";
    for (const r of m.rows) {
      matched.push(r.id);
      if (r.fresh) { await q("UPDATE cases SET filing_alert=$2, filing_alert_at=now() WHERE id=$1", [r.id, `New case added from court email: ${line}`.slice(0, 600)]); continue; }
      const i = body.toUpperCase().indexOf(r.c);
      const excerpt = i >= 0 ? body.slice(Math.max(0, i - 60), i + 200).replace(/\s+/g, " ").trim() : "";
      await q("UPDATE cases SET filing_alert=$2, filing_alert_at=now(), updated_at=now(), style=COALESCE(style,$3), court=COALESCE(court,$4) WHERE id=$1",
        [r.id, `${line}${excerpt && !parsed.filing_desc ? " — " + excerpt : ""}`.slice(0, 600), parsed.style || null, parsed.court_name || null]);
      if (parsed.next_setting && r.c === parsed.cause_no && parsed.next_setting !== r.next_setting) {
        await q("INSERT INTO case_changes(case_id, field, old_value, new_value) VALUES($1,'next_setting',$2,$3)", [r.id, r.next_setting, parsed.next_setting]);
        await q("UPDATE cases SET next_setting=$2, date_alert=$3, date_alert_at=now() WHERE id=$1", [r.id, parsed.next_setting, `${r.next_setting || "No setting"} → ${parsed.next_setting}`]);
      }
    }
  }
  await q(`INSERT INTO inbound_emails(user_id, firm_id, from_addr, subject, body, kind, causes, matched_case_ids, confirm_code, html, ext_id, source, parsed, received_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,now())) ON CONFLICT DO NOTHING`,
    [u.id, u.firm_id, String(from).slice(0, 200), subject, body, kind, causes, matched, confirm, String(html || "").slice(0, 400000) || null, ext_id, source, parsed, received]);
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail) VALUES($1,$2,'email_alert',$3)", [u.id, u.firm_id, { source, kind, subject, causes: causes.length, matched: matched.length, created: created.length }]);
  console.log(`[inbound] user ${u.id} ${source} kind=${kind} causes=${causes.length} matched=${matched.length} created=${created.length} subject="${subject.slice(0, 80)}"`);
  return { ok: true, kind, causes, matched, created };
}

// Rule-based summary (no AI): what kind of email, which cases, dates/times, the key lines, and links.
const KEY = /(hearing|trial|set for|setting|docket|filed|filing|order|notice|motion|judgment|citation|served|service|answer|petition|continuance|cancel|reset|document|activate|verify|password)/i;
function summarize(e, caseMap = {}) {
  const text = String(e.body || ""), subj = String(e.subject || "");
  const all = subj + "\n" + text;
  let type = "Email";
  if (/activate|verify|confirm your/i.test(subj)) type = "Account activation";
  else if (/hearing|setting|trial|docket/i.test(all.slice(0, 3000))) type = "Hearing / setting";
  else if (/order|judgment/i.test(subj)) type = "Order / judgment";
  else if (/filed|filing|document|envelope/i.test(all.slice(0, 3000))) type = "New filing";
  else if (/alert|notice/i.test(subj)) type = "Case notice";
  const dates = [...new Set([...all.matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]\.?M\.?))?/gi)].map(m => m[2] ? `${m[1]} ${m[2].toUpperCase()}` : m[1]))].slice(0, 5);
  const lines = text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 12 && l.length < 300 && KEY.test(l) && !/^https?:/i.test(l)).slice(0, 5);
  const links = [...new Set((text.match(/https?:\/\/[^\s<>"]+/g) || []))].slice(0, 5);
  const cases = (e.causes || []).map(c => ({ cause_no: c, case: caseMap[c] || null }));
  // the hearing date = a date on a line that talks about a hearing/setting/trial (not the filing date)
  const hl = all.split(/\n+/).find(l => /(hearing|set for|setting|trial|docket call|mediation)/i.test(l) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(l) && !/filed/i.test(l));
  const hm = hl && hl.match(/(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]\.?M\.?))?/i);
  const when = hm ? (hm[2] ? `${hm[1]} ${hm[2].toUpperCase()}` : hm[1]) : null;
  const action = type === "Account activation" ? "Open the activation link below to finish setup." : when ? `Calendar: ${when} — ${hl.replace(/\s+/g, " ").trim().slice(0, 120)}` : null;
  return { type, dates, lines, links, cases, action };
}

module.exports = { processEmail, parseNotice, summarize, handle, tokenFor, addressFor, causesIn, countyIn };
