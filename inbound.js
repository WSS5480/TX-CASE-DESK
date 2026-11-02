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
  // the firm's shared court inbox forwarding here (court-<token>)
  if (hash.startsWith("court-")) {
    const f = (await q("SELECT id FROM firms WHERE court_token=$1", [hash])).rows[0];
    if (!f) return { ignored: "unknown firm tag" };
    return processEmail({ id: null, firm_id: f.id, shared: true }, { from: msg.FromFull?.Email || msg.From || "", subject: msg.Subject, text: msg.TextBody, html: msg.HtmlBody, ext_id: msg.MessageID ? "pm:" + msg.MessageID : null, source: "forward-shared" });
  }
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
  // County: the court line first, else the county named most often anywhere in the notice (eFileTexas puts it far down)
  // any capitalization ("HIDALGO COUNTY", "Hidalgo County"); "Location: Hidalgo - County Court at Law" also names it
  const CK = Object.fromEntries(COUNTIES.map(c => [c.toLowerCase(), c]));
  const countyOf = t => { const n = {}; for (const m of String(t).matchAll(/\b([A-Za-z]+(?: [A-Za-z]+)?) county\b/gi)) { const w = m[1].toLowerCase(), k = CK[w] || CK[w.split(" ").pop()]; if (k) n[k] = (n[k] || 0) + 1; }
    return (Object.entries(n).sort((a, b) => b[1] - a[1])[0] || [])[0] || null; };
  const loc = lines.find(l => /^(location|court location|county)\s*:/i.test(l));
  const locC = loc && (countyOf(loc) || (CK[(loc.split(":")[1] || "").trim().split(/[\s,-]+/)[0].toLowerCase()] || null));
  out.county = countyOf(out.court || "") || locC || countyOf(lines.slice(0, 400).filter(l => !/\bTX\s*7\d{4}\b|\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/i.test(l)).join("\n")) || undefined;
  const crt = blob.match(/\b(\d{1,3}(?:st|nd|rd|th) (?:Judicial )?District Court|County Court at Law(?: No\.?)? ?#?\d*|Probate Court(?: No\.? ?\d+)?|Justice of the Peace[^,;]*)/i);
  if (crt) out.court_name = crt[1];
  const hl = lines.find(l => /(hearing|set for|setting|trial|docket call|mediation)/i.test(l) && /\d{1,2}\/\d{1,2}\/\d{4}/.test(l) && !/(filed|submitted)/i.test(l));
  if (hl) { const hm = hl.match(/(\d{1,2}\/\d{1,2}\/\d{4})(?:\s*(?:at\s*)?(\d{1,2}:\d{2}\s*[AP]\.?M\.?))?/i); out.next_setting = `${hm[1]}${hm[2] ? " " + hm[2].toUpperCase() : ""} – ${hl.slice(0, 140)}`; }
  return out;
}

// Which firm attorney a court notice is about: their bar number or full name in the email. Exactly one match or nobody.
async function attorneyIn(firmId, text) {
  const { rows } = await q("SELECT id, name, bar_number FROM users WHERE firm_id=$1 AND active AND role IN ('admin','partner','manager','attorney')", [firmId]);
  const T = " " + String(text).toUpperCase().replace(/[^A-Z0-9,' -]+/g, " ").replace(/\s+/g, " ").replace(/ ,/g, ",") + " ";
  const hits = rows.filter(r => {
    const bar = String(r.bar_number || "").replace(/\D/g, "");
    if (bar.length >= 6 && new RegExp(`(^|\\D)0*${bar}(\\D|$)`).test(String(text))) return true;
    const parts = String(r.name || "").toUpperCase().replace(/[^A-Z' -]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return false;
    const first = parts[0], last = parts[parts.length - 1];
    return [parts.join(" "), `${first} ${last}`, `${last}, ${first}`].some(v => T.includes(" " + v + " ") || T.includes(" " + v + ","));
  });
  return hits.length === 1 ? hits[0].id : null;
}

// Shared pipeline for forwarded and connected-mailbox emails: store, match/create cases, raise alerts.
// u = the attorney whose mailbox it came from, or { id: null, firm_id, shared: true } for the firm's shared court inbox.
async function processEmail(u, { from = "", subject = "", text, html, ext_id = null, source = "forward", received = null }) {
  const shared = !!u.shared;
  // "Each attorney's own email" chosen: the shared court inbox is switched off, whatever still feeds it
  if (shared && ((await q("SELECT court_mode FROM firms WHERE id=$1", [u.firm_id])).rows[0] || {}).court_mode === "each") return { ignored: "court inbox off" };
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
  if (kind !== "forward_confirm") {
    if (!parsed.cause_no) { const sm = String(subject).match(/for Case:\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{3,})/i); if (sm) parsed.cause_no = sm[1].toUpperCase(); }   // "Notification of Service for Case: CL-26-4816-G, ..."
    if (!parsed.county && u.counties && u.counties.length === 1 && parsed.cause_no) parsed.county = u.counties[0];   // no county named: only when the attorney works one county
  }
  const causes = kind === "forward_confirm" ? [] : [...new Set([parsed.cause_no, ...causesIn(subject + "\n" + body)].filter(Boolean))].slice(0, 50);
  // de-dupe the same message (mailbox re-reads). Shared-inbox copies are tagged so they never collide with the attorney's own copy.
  const extKey = ext_id && shared ? "shared:" + ext_id : ext_id;
  if (ext_id) {
    const dup = shared ? await q("SELECT 1 FROM inbound_emails WHERE firm_id=$1 AND shared AND ext_id=$2", [u.firm_id, extKey])
      : await q("SELECT 1 FROM inbound_emails WHERE user_id=$1 AND (ext_id=$2 OR ext_id=$3)", [u.id, ext_id, "shared:" + ext_id]);
    if (dup.rowCount) return { duplicate: true };
  }

  let matched = [], created = [], owner = shared ? null : u.id, routed = shared ? null : undefined;
  if (causes.length) {
    const m = await q(`SELECT c.id, c.user_id, upper(c.cause_no) c, c.county, c.next_setting, c.watch_dates,
      coalesce(u.active, false) AND u.role IN ('admin','partner','manager','attorney') AS owner_active   -- notices only go to active attorneys
      FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.firm_id=$1 AND upper(c.cause_no) = ANY($2)`, [u.firm_id, causes]);
    // The same cause number can exist in two counties. Only then does the county matter: keep the case in the county the
    // notice names (when one matches); if it's still unclear, a personal mailbox keeps only its own cases and the shared
    // inbox leaves it for someone to assign. A county read from the body is never used to drop the only match.
    const existing = m.rows.slice();
    const lc = x => String(x || "").toLowerCase(), nCounties = rows => new Set(rows.map(r => lc(r.county))).size;
    const onTeam = shared ? new Set() : new Set((await q("SELECT case_id FROM case_team WHERE user_id=$1 AND case_id = ANY($2)", [u.id, m.rows.map(r => r.id)]).catch(() => ({ rows: [] }))).rows.map(x => x.case_id));
    const keep = [];
    for (const no of new Set(m.rows.map(r => r.c))) {          // one cause number at a time (a notice can name several cases)
      let g = m.rows.filter(r => r.c === no);
      if (nCounties(g) > 1 && parsed.county) { const f = g.filter(r => lc(r.county) === lc(parsed.county)); if (f.length) g = f; }
      if (nCounties(g) > 1) g = shared ? [] : g.filter(r => r.user_id === u.id || onTeam.has(r.id));
      keep.push(...g);
    }
    m.rows = keep;
    // shared inbox: the notice belongs to whoever has the case (if they still work here — otherwise it waits to be assigned)
    if (shared && m.rows.length) { const main = m.rows.find(r => r.c === parsed.cause_no && r.owner_active) || m.rows.find(r => r.owner_active); if (main) { owner = main.user_id; routed = "case"; } }
    // New case from a court notice: create it (tracked, so it shows even outside the attorney's county list).
    // From the shared inbox, only when the notice names exactly one of the firm's attorneys — otherwise it waits to be assigned.
    if (parsed.cause_no && kind === "research_alert" && !existing.some(r => r.c === parsed.cause_no) && parsed.county) {   // never a second case with the same cause #
      let who = u.id;
      if (shared) { who = await attorneyIn(u.firm_id, subject + "\n" + body); if (who && !owner) { owner = who; routed = "attorney"; } }
      if (who) {
        const ins = await q(`INSERT INTO cases(firm_id,user_id,county,cause_no,court,style,status,next_setting,source,tracked,watch_dates)
          VALUES($1,$2,$3,$4,$5,$6,'Active',$7,'email',true,true) ON CONFLICT DO NOTHING RETURNING id, user_id, upper(cause_no) c, next_setting, watch_dates`,
          [u.firm_id, who, parsed.county, parsed.cause_no, parsed.court_name || parsed.court || null, parsed.style || null, parsed.next_setting || null]);
        if (ins.rows[0]) { created.push(ins.rows[0].id); m.rows.push({ ...ins.rows[0], fresh: true }); require("./practice").onCaseCreated({ ...ins.rows[0], firm_id: u.firm_id, user_id: who }, who).catch(() => {}); }
      }
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
  // the attorney already got this exact email in their own connected mailbox — the case is updated, don't list it twice
  // "Both" mode: one court email can reach the shared inbox AND the attorney's own mailbox. The case is already updated;
  // list it once. Outlook and Gmail give each copy its own id, so a copy also counts as the same email when the sender
  // and subject match within 10 minutes. The second copy is kept as a hidden marker so later syncs skip it.
  const fromAddr = String(from).slice(0, 200);
  let dupe = false;
  if (shared && owner && ext_id && (await q("SELECT 1 FROM inbound_emails WHERE user_id=$1 AND ext_id=$2", [owner, ext_id])).rowCount) dupe = true;
  // Only when it names the same cause numbers too — generic subjects like "Hearing Notice" must never hide a different notice.
  if (!dupe && kind !== "forward_confirm" && subject.trim() && causes.length) {
    const sorted = [...causes].sort();
    const near = `firm_id=$1 AND dismissed_at IS NULL AND lower(subject)=lower($2) AND lower(from_addr)=lower($3) AND abs(extract(epoch FROM received_at - COALESCE($4::timestamptz, now()))) < 600
      AND (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(causes) x) = $5::text[]`;
    if (shared) {
      // the shared copy is redundant when the attorney (or, before routing, anyone at the firm) already has their own copy
      // (only an attorney's own copy counts — a paralegal's copy never takes a notice away from the attorneys)
      const t = await q(`SELECT user_id FROM inbound_emails WHERE ${near} AND NOT shared ${owner ? "AND user_id=$6" : ""}
        AND user_id IN (SELECT id FROM users WHERE firm_id=$1 AND active AND role IN ('admin','partner','manager','attorney')) LIMIT 1`,
        owner ? [u.firm_id, subject, fromAddr, received, sorted, owner] : [u.firm_id, subject, fromAddr, received, sorted]);
      if (t.rows[0]) { dupe = true; if (!owner) { owner = t.rows[0].user_id; routed = "duplicate"; } }
    } else {
      const t = await q(`SELECT id, user_id FROM inbound_emails WHERE ${near} AND shared AND (user_id=$6 OR user_id IS NULL) LIMIT 1`, [u.firm_id, subject, fromAddr, received, sorted, u.id]);
      if (t.rows[0] && t.rows[0].user_id === u.id) dupe = true;
      else if (t.rows[0] && (await q("SELECT 1 FROM users WHERE id=$1 AND active AND role IN ('admin','partner','manager','attorney')", [u.id])).rowCount)
        await q("UPDATE inbound_emails SET dismissed_at=now(), routed='duplicate', user_id=$2 WHERE id=$1 AND user_id IS NULL", [t.rows[0].id, u.id]);  // it was waiting to be assigned — this attorney already has it
    }
  }
  await q(`INSERT INTO inbound_emails(user_id, firm_id, from_addr, subject, body, kind, causes, matched_case_ids, confirm_code, html, ext_id, source, parsed, received_at, shared, routed, dismissed_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,now()),$15,$16,$17) ON CONFLICT DO NOTHING`,
    [owner, u.firm_id, fromAddr, subject, body, kind, causes, matched, confirm, String(html || "").slice(0, 400000) || null, extKey, source, parsed, received, shared, dupe ? "duplicate" : (routed || null), dupe ? new Date() : null]);
  if (dupe) { console.log(`[inbound] ${shared ? "shared" : "user " + u.id} copy already listed — kept hidden: "${subject.slice(0, 80)}"`); return { duplicate: true, matched, created }; }
  await q("INSERT INTO audit_log(user_id, firm_id, action, detail) VALUES($1,$2,'email_alert',$3)", [owner, u.firm_id, { source, kind, subject, causes: causes.length, matched: matched.length, created: created.length, ...(shared ? { shared: true, routed: routed || "unassigned" } : {}) }]);
  if (kind === "research_alert" && causes.length && !matched.length && !created.length) console.log(`[inbound] no case filed: cause ${parsed.cause_no || "?"} county ${parsed.county || "?"} court ${(parsed.court_name || parsed.court || "?").slice(0, 60)} (counties picked ${(u.counties || []).length})`);
  console.log(`[inbound] ${shared ? `firm ${u.firm_id} shared inbox → ${owner ? "user " + owner + " (" + routed + ")" : "needs assigning"}` : "user " + u.id} ${source} kind=${kind} causes=${causes.length} matched=${matched.length} created=${created.length} subject="${subject.slice(0, 80)}"`);
  return { ok: true, kind, causes, matched, created, owner, routed };
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

module.exports = { processEmail, parseNotice, summarize, handle, tokenFor, addressFor, causesIn, countyIn, attorneyIn };
