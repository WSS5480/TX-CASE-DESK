// Practice management: calendar + Texas deadlines, clients + conflicts, documents + templates, tasks,
// dashboard, time + invoices + payments, trust ledger, client portal, import/export.
// Everything is scoped to the signed-in user's firm.
const express = require("express");
const crypto = require("crypto");
const { q } = require("./db");
const box = require("./crypto-box");
const deadlines = require("./deadlines");
const access = require("./access");

const APP = () => (process.env.APP_URL || "https://tx-case-desk.onrender.com").replace(/\/$/, "");
const tok = () => crypto.randomBytes(18).toString("base64url");
const money = n => Math.round(Number(n || 0) * 100) / 100;
const usd = n => "$" + money(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD in Texas (Central) time, daylight time included
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const p2 = n => String(n).padStart(2, "0");
const ds = v => v instanceof Date ? `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}` : v ? String(v).slice(0, 10) : "";
const clean = (v, n = 500) => typeof v === "string" ? v.trim().slice(0, n) : v;

// ---- court settings already on cases ("12/02/2026 1:30 PM – Hearing on …" or "2026-11-18 – …") → calendar items
function parseSetting(s) {
  const t = String(s || "");
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/), date = null;
  if (m) date = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/))) date = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (!date || isNaN(Date.parse(date))) return null;
  const tm = t.match(/(\d{1,2}):(\d{2})\s*([AP])\.?M\.?/i);
  const title = (t.split(/\s[–—-]\s/).slice(1).join(" – ").trim() || "Court setting").slice(0, 200);
  return { date, time: tm ? `${+tm[1]}:${tm[2]} ${tm[3].toUpperCase()}M` : null, title };
}

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
const csvCell = v => { const s = v == null ? "" : v instanceof Date ? (v.getHours() || v.getMinutes() ? v.toISOString() : ds(v)) : String(v); const safe = /^[=+\-@\t]/.test(s) && isNaN(Number(s)) ? "'" + s : s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
const toCsv = rows => { if (!rows.length) return ""; const keys = Object.keys(rows[0]); return [keys.join(","), ...rows.map(r => keys.map(k => csvCell(r[k])).join(","))].join("\r\n"); };

// ---- default checklists by case type (firm admins can change them)
const DEFAULT_TEMPLATES = [
  ["*", "Run a conflict check on every party", 0], ["*", "Add the client's contact details", 1], ["*", "Send engagement letter", 2],
  ["Civil – Personal Injury", "Calendar the limitations date (CPRC 16.003)", 0], ["Civil – Personal Injury", "Send preservation letter", 3], ["Civil – Personal Injury", "Request medical records and bills", 7],
  ["Civil – Contract", "Collect the contract and all correspondence", 3],
  ["Civil – DTPA / Consumer", "Check the DTPA pre-suit notice requirement", 1],
  ["Family", "Calendar the temporary orders hearing", 0], ["Family", "Gather financial information for the inventory", 14],
  ["Eviction", "Confirm the notice to vacate was given", 0],
  ["Probate", "Get the death certificate and original will", 3],
  ["Criminal – Felony", "Request discovery from the State (CCP art. 39.14)", 3], ["Criminal – Misdemeanor", "Request discovery from the State (CCP art. 39.14)", 3]
];
async function seedTemplates(firmId) {
  const n = (await q("SELECT count(*)::int n FROM task_templates WHERE firm_id=$1", [firmId])).rows[0].n;
  if (n) return;
  let i = 0; for (const [t, title, d] of DEFAULT_TEMPLATES) await q("INSERT INTO task_templates(firm_id, case_type, title, due_days, sort) VALUES($1,$2,$3,$4,$5)", [firmId, t, title, d, i++]);
}
// Called when a case is created (by hand, CSV import, or a court email)
async function onCaseCreated(c, byUserId) {
  try {
    await seedTemplates(c.firm_id);
    const { rows } = await q("SELECT * FROM task_templates WHERE firm_id=$1 AND (case_type='*' OR case_type=$2) ORDER BY sort, id", [c.firm_id, c.case_type || ""]);
    for (const t of rows) await q("INSERT INTO tasks(firm_id, case_id, assignee, title, due_date, created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [c.firm_id, c.id, c.user_id || byUserId || null, t.title, t.due_days == null ? null : addDays(today(), t.due_days), byUserId || null]);
  } catch (e) { console.error("[practice] checklist", e.message); }
}

function mount(app, { requireAuth, requireAdmin, wrap, audit }) {
  const R = express.Router();
  // cases and contacts this person may see (access.js): admins/managers the whole firm, others their own + added cases
  const caseOf = async (req, id) => { const pr = [+id, req.user.firm_id]; const cond = access.caseCond(req.user, "c", pr); return (await q(`SELECT c.* FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0]; };
  // Contacts follow the cases: on a case you can see, or added by you (or, with team access, by the attorneys you work with).
  // Contacts from before this rule (no "added by") and on no case stay visible to everyone, as they were.
  const contactCond = (u, alias, pr) => {
    if (access.seesFirm(u)) return "TRUE";
    pr.push(u.id); const meIx = pr.length;
    // contacts on no case: also those added by the people this person works with (team access, either direction)
    let team = `${alias}.created_by IN (SELECT w.id FROM users w WHERE w.firm_id=${alias}.firm_id AND w.access='team' AND $${meIx} = ANY(w.works_with))`;
    const ww = u.access === "team" ? (u.works_with || []).map(Number).filter(Boolean) : [];
    if (ww.length) { pr.push(ww); team += ` OR ${alias}.created_by = ANY($${pr.length}::int[])`; }
    const noCase = `NOT EXISTS (SELECT 1 FROM case_contacts x WHERE x.contact_id=${alias}.id)`;
    return `(${alias}.created_by=$${meIx} OR (${noCase} AND (${alias}.created_by IS NULL OR ${team})) OR EXISTS (SELECT 1 FROM case_contacts x JOIN cases c ON c.id=x.case_id WHERE x.contact_id=${alias}.id AND ${access.caseCond(u, "c", pr)}))`;
  };
  const contactOf = async (req, id) => { const pr = [+id, req.user.firm_id]; const cond = contactCond(req.user, "ct", pr); return (await q(`SELECT ct.* FROM contacts ct WHERE ct.id=$1 AND ct.firm_id=$2 AND ${cond}`, pr)).rows[0]; };
  const visibleCaseIds = (u, pr) => `(SELECT c.id FROM cases c WHERE c.firm_id=$1 AND ${access.caseCond(u, "c", pr)})`;
  const trustOnly = (req, res, next) => access.trustOk(req.user) ? next() : res.status(403).json({ error: "Ask your firm admin for trust access." });
  const notPara = (req, res, next) => req.user.role === "paralegal" ? res.status(403).json({ error: "Attorneys and admins only" }) : next();
  const closedDays = async firmId => (await q("SELECT closed_days FROM firms WHERE id=$1", [firmId])).rows[0]?.closed_days || [];

  R.get("/firm/people", requireAuth, wrap(async (req, res) => res.json({ people: (await q("SELECT id, name, role, rate FROM users WHERE firm_id=$1 AND active ORDER BY name", [req.user.firm_id])).rows })));

  // ===================== Calendar =====================
  async function calendarItems(firmId, { from, to, userId, caseId, county, viewer }) {
    const lim = viewer && !access.seesFirm(viewer);
    const p = [firmId, from, to]; let w = "e.firm_id=$1 AND e.on_date BETWEEN $2 AND $3";
    if (lim) { p.push(viewer.id); const me = p.length; w += ` AND (e.user_id=$${me} OR (e.case_id IS NOT NULL AND ${access.caseCond(viewer, "c", p)}))`; }
    else if (userId) { p.push(userId); w += ` AND (e.user_id=$${p.length} OR c.user_id=$${p.length})`; }
    if (caseId) { p.push(caseId); w += ` AND e.case_id=$${p.length}`; }
    if (county) { p.push(county); w += ` AND c.county=$${p.length}`; }
    const ev = (await q(`SELECT e.*, c.cause_no, c.style, c.county, c.court, u.name AS who FROM events e LEFT JOIN cases c ON c.id=e.case_id LEFT JOIN users u ON u.id=COALESCE(e.user_id, c.user_id) WHERE ${w} ORDER BY e.on_date, e.at_time NULLS FIRST`, p)).rows
      .map(e => ({ id: e.id, src: "event", kind: e.kind, title: e.title, date: ds(e.on_date), time: e.at_time, done: e.done, cite: e.cite, rule: e.rule, confirmed: !!e.confirmed_at, notes: e.notes, location: e.location, who: e.who,
        case: e.case_id ? { id: e.case_id, cause_no: e.cause_no, style: e.style, county: e.county } : null }));
    const cp = [firmId]; let cw = "c.firm_id=$1 AND c.next_setting IS NOT NULL AND c.next_setting <> ''";
    if (lim) cw += " AND " + access.caseCond(viewer, "c", cp);
    else if (userId) { cp.push(userId); cw += ` AND c.user_id=$${cp.length}`; }
    if (caseId) { cp.push(caseId); cw += ` AND c.id=$${cp.length}`; }
    if (county) { cp.push(county); cw += ` AND c.county=$${cp.length}`; }
    const settings = (await q(`SELECT c.id, c.cause_no, c.style, c.county, c.court, c.next_setting, u.name AS who FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE ${cw}`, cp)).rows
      .map(c => { const s = parseSetting(c.next_setting); return s && s.date >= from && s.date <= to ? { id: "c" + c.id, src: "court", kind: "hearing", title: s.title, date: s.date, time: s.time, who: c.who, location: c.court, case: { id: c.id, cause_no: c.cause_no, style: c.style, county: c.county } } : null; })
      .filter(Boolean);
    const tm = t => { const m = String(t || "").match(/(\d+):(\d+)\s*([AP])M/i); return m ? (+m[1] % 12 + (m[3].toUpperCase() === "P" ? 12 : 0)) * 60 + +m[2] : -1; };
    return [...ev, ...settings].sort((a, b) => a.date.localeCompare(b.date) || tm(a.time) - tm(b.time));
  }
  // counties for the shared filter (Today, Calendar, Tasks): every county that has a case this person can see, plus their own counties
  R.get("/case-counties", requireAuth, wrap(async (req, res) => {
    const pr = [req.user.firm_id]; const cond = access.caseCond(req.user, "c", pr);
    const { rows } = await q(`SELECT DISTINCT c.county FROM cases c WHERE c.firm_id=$1 AND c.county IS NOT NULL AND ${cond}`, pr);
    res.json({ counties: [...new Set([...rows.map(r => r.county), ...(req.user.counties || [])])].sort() });
  }));
  R.get("/calendar", requireAuth, wrap(async (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : addDays(today(), -7), to = isDate(req.query.to) ? req.query.to : addDays(today(), 60);
    const userId = req.query.who === "firm" ? (+req.query.attorney || null) : req.user.id;
    res.json({ items: await calendarItems(req.user.firm_id, { from, to, userId, caseId: +req.query.case_id || null, county: req.query.county || null, viewer: req.user }), from, to });
  }));
  const cleanEvent = b => ({ kind: ["hearing", "deadline", "meeting", "event"].includes(b.kind) ? b.kind : "event", title: clean(b.title, 200), on_date: isDate(b.on_date) ? b.on_date : null,
    at_time: clean(b.at_time, 20) || null, location: clean(b.location, 200) || null, notes: clean(b.notes, 2000) || null });
  R.post("/events", requireAuth, wrap(async (req, res) => {
    const e = cleanEvent(req.body || {});
    if (!e.title || !e.on_date) return res.status(400).json({ error: "Title and date are required." });
    if (req.body.case_id && !(await caseOf(req, req.body.case_id))) return res.status(404).json({ error: "Case not found" });
    // someone else's calendar only for whole-firm roles, the attorneys you work with, or a person on this case
    let owner = req.user.id; const want = +req.body.user_id;
    if (want && want !== req.user.id) {
      const inFirm = (await q("SELECT 1 FROM users WHERE id=$1 AND firm_id=$2 AND active", [want, req.user.firm_id])).rowCount > 0;
      const ok = inFirm && (access.FIRM_ROLES.includes(req.user.role) || (req.user.access === "team" && (req.user.works_with || []).map(Number).includes(want)) ||
        (+req.body.case_id && (await q("SELECT 1 FROM cases c WHERE c.id=$1 AND c.firm_id=$3 AND (c.user_id=$2 OR c.id IN (SELECT case_id FROM case_team WHERE user_id=$2))", [+req.body.case_id, want, req.user.firm_id])).rowCount > 0));
      if (!ok) return res.status(403).json({ error: "You can put this on your own calendar, or on the calendar of someone on this case." });
      owner = want;
    }
    const { rows } = await q(`INSERT INTO events(firm_id, case_id, user_id, kind, title, on_date, at_time, location, notes, created_by, confirmed_at, confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$10) RETURNING *`,
      [req.user.firm_id, +req.body.case_id || null, owner, e.kind, e.title, e.on_date, e.at_time, e.location, e.notes, req.user.id]);
    res.json({ event: rows[0] });
  }));
  const eventOk = async (req, id) => { const pr = [+id, req.user.firm_id, req.user.id]; const cond = access.caseCond(req.user, "c", pr);
    return (await q(`SELECT e.id FROM events e LEFT JOIN cases c ON c.id=e.case_id WHERE e.id=$1 AND e.firm_id=$2 AND (e.user_id=$3 OR e.created_by=$3 OR (e.case_id IS NOT NULL AND ${cond}))`, pr)).rowCount > 0; };
  R.patch("/events/:id", requireAuth, wrap(async (req, res) => {
    if (!(await eventOk(req, req.params.id))) return res.status(404).json({ error: "Not found" });
    const b = req.body || {}, sets = [], p = [+req.params.id, req.user.firm_id];
    const e = cleanEvent({ kind: b.kind || "event", ...b });
    for (const k of ["title", "on_date", "at_time", "location", "notes"]) if (b[k] !== undefined && (k !== "on_date" || e.on_date) && (k !== "title" || e.title)) { p.push(e[k]); sets.push(`${k}=$${p.length}`); }
    if (b.done !== undefined) { p.push(!!b.done); sets.push(`done=$${p.length}`); }
    if (b.confirm !== undefined) { if (b.confirm) { p.push(req.user.id); sets.push(`confirmed_at=now(), confirmed_by=$${p.length}`); } else sets.push("confirmed_at=NULL, confirmed_by=NULL"); }
    if (!sets.length) return res.json({ ok: true });
    const { rowCount } = await q(`UPDATE events SET ${sets.join(",")} WHERE id=$1 AND firm_id=$2`, p);
    if (b.confirm && rowCount) await audit(req, "deadline_confirmed", { event: +req.params.id });
    res.json({ ok: rowCount > 0 });
  }));
  R.delete("/events/:id", requireAuth, wrap(async (req, res) => { if (!(await eventOk(req, req.params.id))) return res.status(404).json({ error: "Not found" }); await q("DELETE FROM events WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true }); }));

  // ---- Texas deadline calculator
  R.get("/deadlines/rules", requireAuth, (req, res) => res.json({ rules: deadlines.list() }));
  R.post("/deadlines/calc", requireAuth, wrap(async (req, res) => {
    try { res.json({ result: deadlines.compute(req.body.rule, req.body.trigger, { mail: !!req.body.mail, extended: !!req.body.extended, closed: await closedDays(req.user.firm_id) }) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }));
  R.post("/deadlines/add", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.body.case_id); if (!c) return res.status(404).json({ error: "Pick a case first." });
    let r; try { r = deadlines.compute(req.body.rule, req.body.trigger, { mail: !!req.body.mail, extended: !!req.body.extended, closed: await closedDays(req.user.firm_id) }); } catch (e) { return res.status(400).json({ error: e.message }); }
    const notes = [r.how, `Trigger: ${r.trigger}`, r.moved, ...r.flags, "Calculated by TX Case Desk — confirm against the rules and any court order."].filter(Boolean).join("\n");
    const { rows } = await q(`INSERT INTO events(firm_id, case_id, user_id, kind, title, on_date, at_time, notes, rule, cite, created_by) VALUES($1,$2,$3,'deadline',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.firm_id, c.id, c.user_id || req.user.id, r.label, r.date, r.time, notes, r.rule, r.cite, req.user.id]);
    await audit(req, "deadline_added", { case: c.id, rule: r.rule, date: r.date });
    res.json({ event: rows[0], result: r });
  }));
  R.get("/firm/closed-days", requireAuth, wrap(async (req, res) => res.json({ days: await closedDays(req.user.firm_id), national: deadlines.nationalHolidays(new Date().getFullYear()), state: deadlines.stateHolidays(new Date().getFullYear()) })));
  R.put("/firm/closed-days", requireAuth, requireAdmin, wrap(async (req, res) => {
    const days = (Array.isArray(req.body.days) ? req.body.days : []).filter(d => isDate(d.date)).slice(0, 100).map(d => ({ date: d.date, name: clean(d.name, 80) || "Court closed" }));
    await q("UPDATE firms SET closed_days=$2 WHERE id=$1", [req.user.firm_id, JSON.stringify(days)]); res.json({ days });
  }));

  // ---- calendar feed (subscribe in Outlook / Google / iPhone)
  R.get("/calendar/feed", requireAuth, wrap(async (req, res) => {
    if (req.devView) return res.status(403).json({ error: "Developer view is read-only — nothing was changed.", code: "DEV_READONLY" });   // second lock, whatever the URL spelling
    let t = (await q("SELECT cal_token FROM users WHERE id=$1", [req.user.id])).rows[0]?.cal_token;
    if (!t || req.query.reset) { t = tok(); await q("UPDATE users SET cal_token=$2 WHERE id=$1", [req.user.id, t]); }
    res.json({ url: `${APP()}/cal/${t}.ics`, webcal: `${APP().replace(/^https?:/, "webcal:")}/cal/${t}.ics` });
  }));
  app.get("/cal/:token.ics", wrap(async (req, res) => {
    const u = (await q("SELECT id, firm_id, name FROM users WHERE cal_token=$1 AND active", [String(req.params.token)])).rows[0];
    if (!u) return res.status(404).send("Not found");
    const items = await calendarItems(u.firm_id, { from: addDays(today(), -30), to: addDays(today(), 400), userId: u.id });
    const icsEsc = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TX Case Desk//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:TX Case Desk – ${icsEsc(u.name)}`, "X-WR-TIMEZONE:America/Chicago"];
    for (const it of items) {
      const d = it.date.replace(/-/g, ""); const m = String(it.time || "").match(/(\d+):(\d+)\s*([AP])M/i);
      const summary = `${it.kind === "deadline" ? "DEADLINE: " : it.kind === "hearing" ? "Hearing: " : ""}${it.title}${it.case ? ` (${it.case.cause_no})` : ""}`;
      lines.push("BEGIN:VEVENT", `UID:${it.src}-${it.id}@txcasedesk`, `DTSTAMP:${stamp}`);
      if (m) { const h = (+m[1] % 12) + (m[3].toUpperCase() === "P" ? 12 : 0); lines.push(`DTSTART;TZID=America/Chicago:${d}T${String(h).padStart(2, "0")}${m[2]}00`, "DURATION:PT1H"); }
      else lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(it.date, 1).replace(/-/g, "")}`);
      lines.push(`SUMMARY:${icsEsc(summary)}`);
      if (it.case) lines.push(`DESCRIPTION:${icsEsc([it.case.style, `${it.case.county} County · Cause ${it.case.cause_no}`, it.cite ? `Rule: ${it.cite}` : "", it.notes || ""].filter(Boolean).join("\n"))}`);
      if (it.location) lines.push(`LOCATION:${icsEsc(it.location)}`);
      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    res.set({ "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" }).send(lines.join("\r\n"));
  }));

  // ===================== Clients & conflicts =====================
  const KINDS = ["client", "opposing", "witness", "other"];
  const cleanContact = b => ({ kind: KINDS.includes(b.kind) ? b.kind : "client", name: clean(b.name, 200), company: clean(b.company, 200) || null, email: clean(b.email, 200) || null,
    phone: clean(b.phone, 40) || null, address: clean(b.address, 400) || null, notes: clean(b.notes, 4000) || null });
  async function conflicts(firmId, name, excludeId, viewer) {
    const words = String(name || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2 && !["llc", "inc", "the", "and", "corp", "company"].includes(w));
    if (!words.length) return [];
    const like = words.map(w => `%${w}%`);
    const people = (await q(`SELECT ct.id, ct.name, ct.company, ct.kind, coalesce(json_agg(DISTINCT jsonb_build_object('id', c.id, 'label', c.cause_no || ' · ' || coalesce(c.style,'') || ' (' || cc.role || ')', 'role', cc.role, 'atty', u.name)) FILTER (WHERE c.id IS NOT NULL), '[]') AS cases
      FROM contacts ct LEFT JOIN case_contacts cc ON cc.contact_id=ct.id LEFT JOIN cases c ON c.id=cc.case_id LEFT JOIN users u ON u.id=c.user_id
      WHERE ct.firm_id=$1 AND ($3::int IS NULL OR ct.id<>$3) AND (lower(ct.name) LIKE ANY($2) OR lower(coalesce(ct.company,'')) LIKE ANY($2)) GROUP BY ct.id LIMIT 25`, [firmId, like, excludeId || null])).rows;
    const cases = (await q(`SELECT c.id, c.cause_no, c.style, c.county, u.name AS atty FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.firm_id=$1 AND lower(coalesce(c.style,'')) LIKE ANY($2) LIMIT 25`, [firmId, like])).rows;
    let seen = null;
    if (viewer && !access.seesFirm(viewer)) { const pr = [firmId]; seen = new Set((await q(`SELECT c.id FROM cases c WHERE c.firm_id=$1 AND ${access.caseCond(viewer, "c", pr)}`, pr)).rows.map(r => r.id)); }
    const ok = id => !seen || seen.has(id), other = a => `A case of ${a || "another attorney"} — ask them`;
    return [...people.map(p => ({ type: "contact", id: p.id, name: p.name, company: p.company, kind: p.kind, cases: p.cases.map(c => ok(c.id) ? c.label : `${other(c.atty)} (${c.role})`) })),
      ...cases.map(c => ok(c.id) ? { type: "case", id: c.id, name: c.style, cause_no: c.cause_no, county: c.county } : { type: "case", id: null, name: c.style, cause_no: other(c.atty), county: c.county })];
  }
  R.get("/conflicts", requireAuth, wrap(async (req, res) => res.json({ matches: await conflicts(req.user.firm_id, req.query.name, null, req.user) })));
  R.get("/contacts", requireAuth, wrap(async (req, res) => {
    const p = [req.user.firm_id]; let w = "ct.firm_id=$1";
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w += ` AND (lower(ct.name) LIKE $${p.length} OR lower(coalesce(ct.company,'')) LIKE $${p.length} OR lower(coalesce(ct.email,'')) LIKE $${p.length} OR coalesce(ct.phone,'') LIKE $${p.length})`; }
    if (KINDS.includes(req.query.kind)) { p.push(req.query.kind); w += ` AND ct.kind=$${p.length}`; }
    w += " AND " + contactCond(req.user, "ct", p);
    const { rows } = await q(`SELECT ct.id, ct.kind, ct.name, ct.company, ct.email, ct.phone, count(cc.case_id)::int AS cases,
      coalesce((SELECT sum(amount) FROM trust_tx t WHERE t.contact_id=ct.id),0) AS trust
      FROM contacts ct LEFT JOIN case_contacts cc ON cc.contact_id=ct.id WHERE ${w} GROUP BY ct.id ORDER BY lower(ct.name) LIMIT 500`, p);
    res.json({ contacts: rows });
  }));
  R.post("/contacts", requireAuth, wrap(async (req, res) => {
    const c = cleanContact(req.body || {}); if (!c.name) return res.status(400).json({ error: "Name is required." });
    const { rows } = await q(`INSERT INTO contacts(firm_id, kind, name, company, email, phone, address, notes, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [req.user.firm_id, c.kind, c.name, c.company, c.email, c.phone, c.address, c.notes, req.user.id]);
    if (req.body.case_id && await caseOf(req, req.body.case_id)) await q("INSERT INTO case_contacts(case_id, contact_id, role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [+req.body.case_id, rows[0].id, clean(req.body.role, 40) || c.kind]);
    res.json({ contact: rows[0], conflicts: await conflicts(req.user.firm_id, c.name + " " + (c.company || ""), rows[0].id, req.user) });
  }));
  R.get("/contacts/:id", requireAuth, wrap(async (req, res) => {
    const c = await contactOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    const cpr = [c.id]; const ccond = access.caseCond(req.user, "c", cpr);
    const cases = (await q(`SELECT c.id, c.cause_no, c.style, c.county, c.status, c.next_setting, cc.role FROM case_contacts cc JOIN cases c ON c.id=cc.case_id WHERE cc.contact_id=$1 AND ${ccond} ORDER BY c.id DESC`, cpr)).rows;
    const invoices = (await q("SELECT id, number, issued, due, status, total, paid FROM invoices WHERE contact_id=$1 AND firm_id=$2 ORDER BY id DESC", [c.id, req.user.firm_id])).rows;
    const trust = (await q("SELECT coalesce(sum(amount),0) AS bal FROM trust_tx WHERE contact_id=$1", [c.id])).rows[0].bal;
    res.json({ contact: { ...c, portal_url: c.portal_token ? `${APP()}/portal/${c.portal_token}` : null }, cases, invoices, trust });
  }));
  R.patch("/contacts/:id", requireAuth, wrap(async (req, res) => {
    const c = await contactOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    const n = cleanContact({ ...c, ...req.body }); if (!n.name) return res.status(400).json({ error: "Name is required." });
    await q("UPDATE contacts SET kind=$2, name=$3, company=$4, email=$5, phone=$6, address=$7, notes=$8 WHERE id=$1", [c.id, n.kind, n.name, n.company, n.email, n.phone, n.address, n.notes]);
    res.json({ ok: true });
  }));
  R.delete("/contacts/:id", requireAuth, wrap(async (req, res) => {
    const c = await contactOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    if ((await q("SELECT 1 FROM trust_tx WHERE contact_id=$1 LIMIT 1", [c.id])).rowCount) return res.status(400).json({ error: "This client has trust history, so they can't be deleted." });
    await q("DELETE FROM contacts WHERE id=$1", [c.id]); await audit(req, "contact_deleted", { id: c.id }); res.json({ ok: true });
  }));
  R.post("/cases/:id/contacts", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    const ct = await contactOf(req, req.body.contact_id); if (!ct) return res.status(404).json({ error: "Contact not found" });
    await q("INSERT INTO case_contacts(case_id, contact_id, role) VALUES($1,$2,$3) ON CONFLICT(case_id, contact_id) DO UPDATE SET role=$3", [c.id, ct.id, clean(req.body.role, 40) || ct.kind]);
    res.json({ ok: true, conflicts: await conflicts(req.user.firm_id, ct.name + " " + (ct.company || ""), ct.id, req.user) });
  }));
  R.delete("/cases/:id/contacts/:cid", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    await q("DELETE FROM case_contacts WHERE case_id=$1 AND contact_id=$2", [c.id, +req.params.cid]); res.json({ ok: true });
  }));

  // ===================== Case hub (everything about one case) =====================
  R.get("/cases/:id/hub", requireAuth, wrap(async (req, res) => {
    const c = (await q("SELECT c.*, u.name AS attorney FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.firm_id=$2", [+req.params.id, req.user.firm_id])).rows[0];
    if (!c) return res.status(404).json({ error: "Case not found" });
    const [contacts, tasks, docs, time, invoices, team, emails] = await Promise.all([
      q("SELECT ct.*, cc.role, coalesce((SELECT sum(amount) FROM trust_tx t WHERE t.contact_id=ct.id),0) AS trust FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1 ORDER BY cc.role, ct.name", [c.id]),
      q("SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee WHERE t.case_id=$1 ORDER BY t.done, t.due_date NULLS LAST, t.id", [c.id]),
      q("SELECT id, name, mime, size, shared, created_at FROM documents WHERE case_id=$1 ORDER BY id DESC", [c.id]),
      q("SELECT te.*, u.name AS who FROM time_entries te LEFT JOIN users u ON u.id=te.user_id WHERE te.case_id=$1 ORDER BY te.on_date DESC, te.id DESC LIMIT 200", [c.id]),
      q("SELECT id, number, issued, due, status, total, paid FROM invoices WHERE case_id=$1 ORDER BY id DESC", [c.id]),
      q("SELECT u.id, u.name, u.role FROM case_team t JOIN users u ON u.id=t.user_id WHERE t.case_id=$1 ORDER BY u.name", [c.id]),
      q(`SELECT id, subject, from_addr, received_at FROM inbound_emails WHERE firm_id=$2 AND dismissed_at IS NULL
          AND ($3 = ANY(matched_case_ids) OR ($1 = ANY(causes) AND (lower(parsed->>'county') = lower($4) OR user_id=$5)))
          ORDER BY received_at DESC LIMIT 50`, [String(c.cause_no).toUpperCase(), req.user.firm_id, c.id, c.county || "", req.user.id]).catch(() => ({ rows: [] }))
    ]);
    const events = await calendarItems(req.user.firm_id, { from: addDays(today(), -365), to: addDays(today(), 1500), caseId: c.id });
    res.json({ case: c, contacts: contacts.rows, tasks: tasks.rows, documents: docs.rows, time: time.rows, invoices: invoices.rows, emails: emails.rows, events,
      team: team.rows, can_team: access.seesFirm(req.user) || c.user_id === req.user.id });
  }));
  // case team: people added to a case beyond its lead attorney (they can then see it)
  R.post("/cases/:id/team", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    if (!access.seesFirm(req.user) && c.user_id !== req.user.id) return res.status(403).json({ error: "Only the lead attorney, a manager or an admin can change the team." });
    const u = (await q("SELECT id, name FROM users WHERE id=$1 AND firm_id=$2 AND active", [+req.body.user_id, req.user.firm_id])).rows[0]; if (!u) return res.status(404).json({ error: "Person not found" });
    await q("INSERT INTO case_team(case_id, user_id, added_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [c.id, u.id, req.user.id]);
    await audit(req, "case_team_added", { case: c.id, user: u.id }); res.json({ ok: true });
  }));
  R.delete("/cases/:id/team/:uid", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    if (!access.seesFirm(req.user) && c.user_id !== req.user.id) return res.status(403).json({ error: "Only the lead attorney, a manager or an admin can change the team." });
    await q("DELETE FROM case_team WHERE case_id=$1 AND user_id=$2", [c.id, +req.params.uid]); await audit(req, "case_team_removed", { case: c.id, user: +req.params.uid }); res.json({ ok: true });
  }));

  // file names with any characters (–, curly quotes, accents) download safely: ASCII fallback + UTF-8 name
  const dispo = (kind, name) => { const n = String(name || "file"); return `${kind}; filename="${n.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(n)}`; };
  // ===================== Documents =====================
  R.post("/cases/:id/documents", requireAuth, express.raw({ type: () => true, limit: "15mb" }), wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    const name = clean(decodeURIComponent(req.get("X-File-Name") || "document"), 200).replace(/[\\/]/g, "_");
    if (!req.body || !req.body.length) return res.status(400).json({ error: "Empty file" });
    const { rows } = await q("INSERT INTO documents(firm_id, case_id, name, mime, size, data, uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, size",
      [req.user.firm_id, c.id, name, clean(req.get("Content-Type"), 100) || "application/octet-stream", req.body.length, req.body, req.user.id]);
    await audit(req, "document_uploaded", { case: c.id, name }); res.json({ document: rows[0] });
  }));
  const docOk = async (req, id) => { const pr = [+id, req.user.firm_id]; const cond = access.caseCond(req.user, "c", pr); return (await q(`SELECT d.* FROM documents d JOIN cases c ON c.id=d.case_id WHERE d.id=$1 AND d.firm_id=$2 AND ${cond}`, pr)).rows[0]; };
  R.get("/documents/:id", requireAuth, wrap(async (req, res) => {
    const d = await docOk(req, req.params.id); if (!d) return res.status(404).send("Not found");
    res.set({ "Content-Type": d.mime || "application/octet-stream", "Content-Disposition": dispo("attachment", d.name) }).send(d.data);
  }));
  R.patch("/documents/:id", requireAuth, wrap(async (req, res) => { if (!(await docOk(req, req.params.id))) return res.status(404).json({ error: "Not found" }); await q("UPDATE documents SET shared=$3 WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id, !!req.body.shared]); res.json({ ok: true }); }));
  R.delete("/documents/:id", requireAuth, wrap(async (req, res) => { if (!(await docOk(req, req.params.id))) return res.status(404).json({ error: "Not found" }); await q("DELETE FROM documents WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); await audit(req, "document_deleted", { id: +req.params.id }); res.json({ ok: true }); }));

  // ---- Word templates (drafts — the attorney reviews before filing)
  const templates = require("./templates");
  R.get("/templates", requireAuth, (req, res) => res.json({ templates: templates.list() }));
  R.get("/cases/:id/templates/:key", requireAuth, wrap(async (req, res) => {
    const c = (await q("SELECT c.*, u.name AS attorney, u.bar_number, u.email AS attorney_email FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=$1 AND c.firm_id=$2", [+req.params.id, req.user.firm_id])).rows[0];
    if (!c) return res.status(404).send("Case not found");
    const contacts = (await q("SELECT ct.*, cc.role FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1", [c.id])).rows;
    const events = await calendarItems(req.user.firm_id, { from: today(), to: addDays(today(), 1500), caseId: c.id });
    const f = (await q("SELECT name, address, phone, fax, website, logo, logo_mime, logo_w, logo_h FROM firms WHERE id=$1", [req.user.firm_id])).rows[0] || {};
    const signer = { name: req.user.name, bar: req.user.bar_number, email: req.user.doc_email || req.user.email, firm: f.name || req.user.firm_name, title: req.user.title, phone: req.user.phone,
      address: f.address, firmPhone: f.phone, fax: f.fax, website: f.website, logo: f.logo ? { data: f.logo, type: f.logo_mime === "image/png" ? "png" : "jpg", w: f.logo_w, h: f.logo_h } : null };
    let out; try { out = await templates.render(req.params.key, { c, contacts, events, signer, opts: req.query }); } catch (e) { return res.status(400).send(e.message); }
    res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": dispo("attachment", out.filename) }).send(out.buffer);
  }));

  // ===================== Tasks =====================
  R.get("/tasks", requireAuth, wrap(async (req, res) => {
    const p = [req.user.firm_id]; let w = "t.firm_id=$1";
    if (!access.seesFirm(req.user)) { p.push(req.user.id); const me = p.length; w += ` AND (t.assignee=$${me} OR t.created_by=$${me} OR t.case_id IN ${visibleCaseIds(req.user, p)})`; }
    else if (req.query.who !== "firm") { p.push(req.user.id); w += ` AND t.assignee=$${p.length}`; } else if (+req.query.attorney) { p.push(+req.query.attorney); w += ` AND t.assignee=$${p.length}`; }
    if (req.query.status === "done") w += " AND t.done"; else if (req.query.status !== "all") w += " AND NOT t.done";
    if (+req.query.case_id) { p.push(+req.query.case_id); w += ` AND t.case_id=$${p.length}`; }
    if (req.query.county) { p.push(String(req.query.county)); w += ` AND c.county=$${p.length}`; }
    const { rows } = await q(`SELECT t.*, c.cause_no, c.style, u.name AS assignee_name FROM tasks t LEFT JOIN cases c ON c.id=t.case_id LEFT JOIN users u ON u.id=t.assignee WHERE ${w} ORDER BY t.done, t.due_date NULLS LAST, t.id LIMIT 500`, p);
    res.json({ tasks: rows });
  }));
  R.post("/tasks", requireAuth, wrap(async (req, res) => {
    const b = req.body || {}; const title = clean(b.title, 300); if (!title) return res.status(400).json({ error: "What needs doing?" });
    if (b.case_id && !(await caseOf(req, b.case_id))) return res.status(404).json({ error: "Case not found" });
    const assignee = +b.assignee && (await q("SELECT 1 FROM users WHERE id=$1 AND firm_id=$2", [+b.assignee, req.user.firm_id])).rowCount ? +b.assignee : req.user.id;
    const { rows } = await q("INSERT INTO tasks(firm_id, case_id, assignee, title, due_date, created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", [req.user.firm_id, +b.case_id || null, assignee, title, isDate(b.due_date) ? b.due_date : null, req.user.id]);
    res.json({ task: rows[0] });
  }));
  const taskOk = async (req, id) => { const pr = [+id, req.user.firm_id, req.user.id]; return (await q(`SELECT 1 FROM tasks t WHERE t.id=$1 AND t.firm_id=$2 AND (t.assignee=$3 OR t.created_by=$3 OR t.case_id IN ${visibleCaseIds(req.user, pr)})`, pr)).rowCount > 0; };
  R.patch("/tasks/:id", requireAuth, wrap(async (req, res) => {
    if (!(await taskOk(req, req.params.id))) return res.status(404).json({ error: "Not found" });
    const b = req.body || {}, sets = [], p = [+req.params.id, req.user.firm_id];
    if (b.done !== undefined) { p.push(!!b.done); sets.push(`done=$${p.length}, done_at=CASE WHEN $${p.length} THEN now() ELSE NULL END`); }
    if (b.title) { p.push(clean(b.title, 300)); sets.push(`title=$${p.length}`); }
    if (b.due_date !== undefined) { p.push(isDate(b.due_date) ? b.due_date : null); sets.push(`due_date=$${p.length}`); }
    if (+b.assignee) { p.push(+b.assignee); sets.push(`assignee=$${p.length}`); }
    if (sets.length) await q(`UPDATE tasks SET ${sets.join(",")} WHERE id=$1 AND firm_id=$2`, p);
    res.json({ ok: true });
  }));
  R.delete("/tasks/:id", requireAuth, wrap(async (req, res) => { if (!(await taskOk(req, req.params.id))) return res.status(404).json({ error: "Not found" }); await q("DELETE FROM tasks WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true }); }));
  R.get("/firm/task-templates", requireAuth, wrap(async (req, res) => { if (!req.devView) await seedTemplates(req.user.firm_id); /* developer view only reads */ res.json({ templates: (await q("SELECT * FROM task_templates WHERE firm_id=$1 ORDER BY case_type, sort, id", [req.user.firm_id])).rows }); }));
  R.post("/firm/task-templates", requireAuth, requireAdmin, wrap(async (req, res) => {
    const title = clean(req.body.title, 300); if (!title) return res.status(400).json({ error: "Task is required." });
    const { rows } = await q("INSERT INTO task_templates(firm_id, case_type, title, due_days, sort) VALUES($1,$2,$3,$4,999) RETURNING *", [req.user.firm_id, clean(req.body.case_type, 80) || "*", title, Number.isFinite(+req.body.due_days) && req.body.due_days !== "" ? +req.body.due_days : null]);
    res.json({ template: rows[0] });
  }));
  R.delete("/firm/task-templates/:id", requireAuth, requireAdmin, wrap(async (req, res) => { await q("DELETE FROM task_templates WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id]); res.json({ ok: true }); }));

  // ===================== Today dashboard (one set of filters for every number) =====================
  R.get("/dashboard", requireAuth, wrap(async (req, res) => {
    const firm = req.user.firm_id, t = today(), lim = !access.seesFirm(req.user);
    const userId = lim ? req.user.id : req.query.who === "firm" ? (+req.query.attorney || null) : req.user.id;
    const county = req.query.county || null;
    const cp = [firm]; let cw = "c.firm_id=$1";
    if (lim) cw += " AND " + access.caseCond(req.user, "c", cp);
    else if (userId) { cp.push(userId); cw += ` AND c.user_id=$${cp.length}`; }
    if (county) { cp.push(county); cw += ` AND c.county=$${cp.length}`; }
    const caseIds = `SELECT c.id FROM cases c WHERE ${cw}`;
    // tasks: this person's (or the picked attorney's), and only tasks on that county's cases when a county is picked
    const taskP = [userId, county].filter(Boolean);
    const taskW = n => `${userId ? `AND t.assignee=$${n++}` : ""} ${county ? `AND c.county=$${n}` : ""}`;
    const [byCounty, byCourt, open, tasksDue, overdue, hours, unbilled, outstanding, collected, trust, alerts] = await Promise.all([
      q(`SELECT c.county AS k, count(*)::int n FROM cases c WHERE ${cw} AND coalesce(c.status,'') !~* 'closed|dismissed|disposed' GROUP BY 1 ORDER BY 2 DESC`, cp),
      q(`SELECT coalesce(nullif(c.court,''),'Court not set') AS k, count(*)::int n FROM cases c WHERE ${cw} AND coalesce(c.status,'') !~* 'closed|dismissed|disposed' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, cp),
      q(`SELECT count(*)::int n FROM cases c WHERE ${cw} AND coalesce(c.status,'') !~* 'closed|dismissed|disposed'`, cp),
      q(`SELECT t.id, t.title, t.due_date, c.cause_no, c.style, t.case_id FROM tasks t LEFT JOIN cases c ON c.id=t.case_id WHERE t.firm_id=$1 AND NOT t.done AND t.due_date <= $2 ${taskW(3)} ORDER BY t.due_date LIMIT 20`, [firm, addDays(t, 7), ...taskP]),
      q(`SELECT count(*)::int n FROM tasks t LEFT JOIN cases c ON c.id=t.case_id WHERE t.firm_id=$1 AND NOT t.done AND t.due_date < $2 ${taskW(3)}`, [firm, t, ...taskP]),
      q(`SELECT coalesce(sum(minutes),0)::int m FROM time_entries te WHERE te.firm_id=$1 AND te.on_date >= date_trunc('month', $2::date) ${userId ? "AND te.user_id=$3" : ""}`, userId ? [firm, t, userId] : [firm, t]),
      q(`SELECT coalesce(sum(coalesce(te.amount, te.minutes/60.0*te.rate)),0) AS v FROM time_entries te WHERE te.firm_id=$1 AND te.billable AND te.invoice_id IS NULL AND (${lim ? `te.user_id=${req.user.id | 0}` : "te.case_id IS NULL"} OR te.case_id IN (${caseIds}))`, cp),
      q(`SELECT coalesce(sum(total-paid),0) AS v, count(*)::int n FROM invoices i WHERE i.firm_id=$1 AND i.status IN ('sent','draft') AND total>paid AND (${lim ? "FALSE" : "i.case_id IS NULL"} OR i.case_id IN (${caseIds}))`, cp),
      lim ? q(`SELECT coalesce(sum(p.amount),0) AS v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.firm_id=$1 AND p.on_date >= date_trunc('month', current_date) AND i.case_id IN (${caseIds})`, cp)
        : q(`SELECT coalesce(sum(p.amount),0) AS v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.firm_id=$1 AND p.on_date >= date_trunc('month', $2::date)`, [firm, t]),
      q(`SELECT coalesce(sum(amount),0) AS v FROM trust_tx WHERE firm_id=$1`, [firm]),
      q(`SELECT count(*)::int n FROM cases c WHERE ${cw} AND (c.date_alert IS NOT NULL OR c.filing_alert IS NOT NULL OR c.law_alert IS NOT NULL)`, cp)
    ]);
    const upcoming = (await calendarItems(firm, { from: t, to: addDays(t, 14), userId, county, viewer: req.user })).filter(i => !i.done);
    const overdueDl = (await calendarItems(firm, { from: addDays(t, -60), to: addDays(t, -1), userId, county, viewer: req.user })).filter(i => !i.done && i.kind === "deadline" && i.src === "event");
    const hoursToday = (await q("SELECT coalesce(sum(minutes),0)::int m FROM time_entries WHERE firm_id=$1 AND user_id=$2 AND on_date=$3", [firm, req.user.id, t])).rows[0].m;
    // court notices from the firm's shared inbox waiting for someone to assign them (admin + the people they picked)
    const courtQueue = req.user.role === "admin" || req.user.court_handler
      ? (await q("SELECT count(*)::int n FROM inbound_emails WHERE firm_id=$1 AND shared AND user_id IS NULL AND dismissed_at IS NULL", [firm])).rows[0].n : null;
    res.json({ today: t, open: open.rows[0].n, alerts: alerts.rows[0].n, byCounty: byCounty.rows, byCourt: byCourt.rows, upcoming, overdueDl, hoursToday: Math.round(hoursToday / 6) / 10,
      tasksDue: tasksDue.rows, overdue: overdue.rows[0].n, hours: Math.round(hours.rows[0].m / 6) / 10, unbilled: money(unbilled.rows[0].v),
      outstanding: money(outstanding.rows[0].v), outstandingCount: outstanding.rows[0].n, collected: money(collected.rows[0].v), trust: access.trustOk(req.user) ? money(trust.rows[0].v) : null, sees_firm: !lim, court_queue: courtQueue });
  }));

  // ===================== Dashboards =====================
  // Firm view: admins, partners, managers (and a solo attorney) — every attorney's numbers, or one attorney's.
  // My view: the cases this person works (lead, added to, or their attorneys' cases) and their own time.
  R.get("/reports", requireAuth, wrap(async (req, res) => {
    const firm = req.user.firm_id, t = today(), u = req.user;
    const firmScope = req.query.scope === "firm" && access.firmDash(u);
    const att = firmScope && +req.query.attorney ? +req.query.attorney : null;
    const cp = [firm]; let cw = "c.firm_id=$1";
    if (firmScope) { if (att) { cp.push(att); cw += ` AND c.user_id=$${cp.length}`; } }
    else cw += " AND " + (access.seesFirm(u) ? access.ownCond(u, "c", cp) : access.caseCond(u, "c", cp));
    const OPEN = "coalesce(c.status,'') !~* 'closed|dismissed|disposed'";
    const caseIds = `SELECT c.id FROM cases c WHERE ${cw}`;
    const tp = firmScope ? (att ? [firm, att] : [firm]) : [firm, u.id];
    const tw = firmScope && !att ? "te.firm_id=$1" : "te.firm_id=$1 AND te.user_id=$2";
    const invW = firmScope && !att ? "i.firm_id=$1" : `i.firm_id=$1 AND i.case_id IN (${caseIds})`;
    const tkP = firmScope ? (att ? [firm, t, att] : [firm, t]) : [firm, t, u.id];
    const tkW = `t.firm_id=$1 AND NOT t.done AND t.due_date < $2${tkP.length > 2 ? " AND t.assignee=$3" : ""}`;
    const monthStart = t.slice(0, 8) + "01", prevStart = (() => { const d = new Date(monthStart + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
    const wk = s => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(wk(t), -7 * (7 - i)));
    const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(monthStart + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() - (5 - i)); return d.toISOString().slice(0, 10); });
    const [open, newM, hrsM, hrsP, unbilled, outstanding, collM, collP, trust, overdueTasks, byType, byCounty, wkRows, moRows, taskList] = await Promise.all([
      q(`SELECT count(*)::int n FROM cases c WHERE ${cw} AND ${OPEN}`, cp),
      q(`SELECT count(*)::int n FROM cases c WHERE ${cw} AND c.created_at >= $${cp.length + 1}::date`, [...cp, monthStart]),
      q(`SELECT coalesce(sum(minutes),0)::int m FROM time_entries te WHERE ${tw} AND te.on_date >= $${tp.length + 1}`, [...tp, monthStart]),
      q(`SELECT coalesce(sum(minutes),0)::int m FROM time_entries te WHERE ${tw} AND te.on_date >= $${tp.length + 1} AND te.on_date < $${tp.length + 2}`, [...tp, prevStart, monthStart]),
      q(`SELECT coalesce(sum(coalesce(te.amount, te.minutes/60.0*te.rate)),0) v FROM time_entries te WHERE ${tw} AND te.billable AND te.invoice_id IS NULL`, tp),
      q(`SELECT coalesce(sum(total-paid),0) v, count(*)::int n FROM invoices i WHERE ${invW} AND i.status IN ('sent','draft') AND total>paid`, cp),
      q(`SELECT coalesce(sum(p.amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE ${invW} AND p.on_date >= $${cp.length + 1}`, [...cp, monthStart]),
      q(`SELECT coalesce(sum(p.amount),0) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE ${invW} AND p.on_date >= $${cp.length + 1} AND p.on_date < $${cp.length + 2}`, [...cp, prevStart, monthStart]),
      access.trustOk(u) && (firmScope && !att || u.firm_kind === "solo") ? q("SELECT coalesce(sum(amount),0) v FROM trust_tx WHERE firm_id=$1", [firm]) : Promise.resolve(null),
      q(`SELECT count(*)::int n FROM tasks t WHERE ${tkW}`, tkP),
      q(`SELECT coalesce(nullif(c.case_type,''),'Type not set') k, count(*)::int n FROM cases c WHERE ${cw} AND ${OPEN} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, cp),
      q(`SELECT c.county k, count(*)::int n FROM cases c WHERE ${cw} AND ${OPEN} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 8`, cp),
      q(`SELECT to_char(date_trunc('week', te.on_date), 'YYYY-MM-DD') wk, sum(minutes)::int m FROM time_entries te WHERE ${tw} AND te.on_date >= $${tp.length + 1} GROUP BY 1`, [...tp, weeks[0]]),
      q(`SELECT to_char(date_trunc('month', p.on_date), 'YYYY-MM-DD') mo, sum(p.amount) v FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE ${invW} AND p.on_date >= $${cp.length + 1} GROUP BY 1`, [...cp, months[0]]),
      q(`SELECT t.id, t.title, t.due_date, c.cause_no, c.style, u.name AS who FROM tasks t LEFT JOIN cases c ON c.id=t.case_id LEFT JOIN users u ON u.id=t.assignee WHERE ${tkW} ORDER BY t.due_date LIMIT 6`, tkP)
    ]);
    const calOpts = firmScope ? { userId: att } : access.seesFirm(u) ? { userId: u.id } : { viewer: u };
    const overdueDl = (await calendarItems(firm, { from: addDays(t, -60), to: addDays(t, -1), ...calOpts })).filter(i => !i.done && i.kind === "deadline" && i.src === "event");
    const next7 = (await calendarItems(firm, { from: t, to: addDays(t, 7), ...calOpts })).filter(i => !i.done && i.kind === "hearing");
    const wm = Object.fromEntries(wkRows.rows.map(r => [r.wk, r.m])), mm = Object.fromEntries(moRows.rows.map(r => [r.mo, Number(r.v)]));
    let byAttorney = null;
    if (firmScope && !att) {
      const [ppl, oc, hr, ub, os, cl, od, ot] = await Promise.all([
        q("SELECT id, name, role FROM users WHERE firm_id=$1 AND active AND role <> 'paralegal' ORDER BY name", [firm]),
        q(`SELECT c.user_id k, count(*)::int n FROM cases c WHERE c.firm_id=$1 AND ${OPEN} GROUP BY 1`, [firm]),
        q("SELECT user_id k, sum(minutes)::int n FROM time_entries WHERE firm_id=$1 AND on_date >= $2 GROUP BY 1", [firm, monthStart]),
        q("SELECT user_id k, sum(coalesce(amount, minutes/60.0*rate)) n FROM time_entries WHERE firm_id=$1 AND billable AND invoice_id IS NULL GROUP BY 1", [firm]),
        q("SELECT c.user_id k, sum(i.total-i.paid) n FROM invoices i JOIN cases c ON c.id=i.case_id WHERE i.firm_id=$1 AND i.status IN ('sent','draft') AND i.total>i.paid GROUP BY 1", [firm]),
        q("SELECT c.user_id k, sum(p.amount) n FROM payments p JOIN invoices i ON i.id=p.invoice_id JOIN cases c ON c.id=i.case_id WHERE p.firm_id=$1 AND p.on_date >= $2 GROUP BY 1", [firm, monthStart]),
        q("SELECT coalesce(e.user_id, c.user_id) k, count(*)::int n FROM events e LEFT JOIN cases c ON c.id=e.case_id WHERE e.firm_id=$1 AND e.kind='deadline' AND NOT e.done AND e.on_date < $2 AND e.on_date >= $3 GROUP BY 1", [firm, t, addDays(t, -60)]),
        q("SELECT assignee k, count(*)::int n FROM tasks WHERE firm_id=$1 AND NOT done AND due_date < $2 GROUP BY 1", [firm, t])
      ]);
      const m = r => Object.fromEntries(r.rows.map(x => [x.k, Number(x.n)]));
      const [O, H, U, S, C, D, T] = [oc, hr, ub, os, cl, od, ot].map(m);
      byAttorney = ppl.rows.map(x => ({ id: x.id, name: x.name, role: x.role, open: O[x.id] || 0, hours: Math.round((H[x.id] || 0) / 6) / 10, unbilled: money(U[x.id]), outstanding: money(S[x.id]), collected: money(C[x.id]), overdueDl: D[x.id] || 0, overdueTasks: T[x.id] || 0 }));
    }
    res.json({ scope: firmScope ? "firm" : "mine", attorney: att, today: t,
      tiles: { open: open.rows[0].n, newThisMonth: newM.rows[0].n, hours: Math.round(hrsM.rows[0].m / 6) / 10, hoursPrev: Math.round(hrsP.rows[0].m / 6) / 10,
        unbilled: money(unbilled.rows[0].v), outstanding: money(outstanding.rows[0].v), outstandingCount: outstanding.rows[0].n, collected: money(collM.rows[0].v), collectedPrev: money(collP.rows[0].v),
        trust: trust ? money(trust.rows[0].v) : null, overdueDeadlines: overdueDl.length, overdueTasks: overdueTasks.rows[0].n, court7: next7.length },
      hoursByWeek: weeks.map(w => ({ wk: w, h: Math.round((wm[w] || 0) / 6) / 10 })), collectedByMonth: months.map(mo => ({ mo, v: money(mm[mo]) })),
      byType: byType.rows, byCounty: byCounty.rows, byAttorney,
      attention: { deadlines: overdueDl.slice(0, 6), tasks: taskList.rows }, next7: next7.slice(0, 6) });
  }));

  // ===================== Time & billing =====================
  async function rateFor(firmId, caseId, userId) {
    const c = caseId ? (await q("SELECT rate FROM cases WHERE id=$1 AND firm_id=$2", [caseId, firmId])).rows[0] : null;
    if (c && c.rate != null) return Number(c.rate);
    const u = (await q("SELECT rate FROM users WHERE id=$1", [userId])).rows[0]; return Number(u?.rate || 0);
  }
  R.get("/time", requireAuth, wrap(async (req, res) => {
    const p = [req.user.firm_id]; let w = "te.firm_id=$1";
    if (+req.query.case_id) { p.push(+req.query.case_id); w += ` AND te.case_id=$${p.length}`; }
    if (req.query.who !== "firm" || !access.seesFirm(req.user)) { p.push(req.user.id); w += ` AND te.user_id=$${p.length}`; }
    if (req.query.unbilled) w += " AND te.invoice_id IS NULL AND te.billable";
    const { rows } = await q(`SELECT te.*, c.cause_no, c.style, u.name AS who, coalesce(te.amount, round(te.minutes/60.0*te.rate, 2)) AS value FROM time_entries te LEFT JOIN cases c ON c.id=te.case_id LEFT JOIN users u ON u.id=te.user_id WHERE ${w} ORDER BY te.on_date DESC, te.id DESC LIMIT 300`, p);
    res.json({ entries: rows, rate: await rateFor(req.user.firm_id, null, req.user.id) });
  }));
  R.post("/time", requireAuth, wrap(async (req, res) => {
    const b = req.body || {};
    if (b.case_id && !(await caseOf(req, b.case_id))) return res.status(404).json({ error: "Case not found" });
    const minutes = Math.max(0, Math.round(+b.minutes || 0)), amount = b.amount !== undefined && b.amount !== "" && b.amount !== null ? money(b.amount) : null;
    if (!minutes && amount == null) return res.status(400).json({ error: "Enter the time (minutes) or an amount." });
    const rate = b.rate !== undefined && b.rate !== "" && b.rate !== null ? money(b.rate) : await rateFor(req.user.firm_id, +b.case_id || null, req.user.id);
    const { rows } = await q(`INSERT INTO time_entries(firm_id, case_id, user_id, on_date, minutes, rate, amount, description, billable) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.firm_id, +b.case_id || null, req.user.id, isDate(b.on_date) ? b.on_date : today(), minutes, rate, amount, clean(b.description, 1000) || null, b.billable !== false]);
    res.json({ entry: rows[0] });
  }));
  R.delete("/time/:id", requireAuth, wrap(async (req, res) => {
    // your own entries; admins, partners and managers (whole-firm roles) can remove anyone's
    const p = [+req.params.id, req.user.firm_id]; let w = "id=$1 AND firm_id=$2";
    if (!access.FIRM_ROLES.includes(req.user.role)) { p.push(req.user.id); w += " AND user_id=$3"; }   // the role, not "whole firm" viewing access
    const e = (await q(`SELECT invoice_id FROM time_entries WHERE ${w}`, p)).rows[0];
    if (!e) return res.status(404).json({ error: "Not found" });
    if (e.invoice_id) return res.status(400).json({ error: "Already on an invoice — void the invoice first." });
    await q("DELETE FROM time_entries WHERE id=$1 AND firm_id=$2 AND invoice_id IS NULL", [+req.params.id, req.user.firm_id]); res.json({ ok: true });
  }));
  R.put("/me/rate", requireAuth, wrap(async (req, res) => { await q("UPDATE users SET rate=$2 WHERE id=$1", [req.user.id, req.body.rate === "" ? null : money(req.body.rate)]); res.json({ ok: true }); }));
  R.put("/firm/users/:id/rate", requireAuth, requireAdmin, wrap(async (req, res) => { await q("UPDATE users SET rate=$3 WHERE id=$1 AND firm_id=$2", [+req.params.id, req.user.firm_id, req.body.rate === "" ? null : money(req.body.rate)]); res.json({ ok: true }); }));
  R.put("/cases/:id/billing", requireAuth, wrap(async (req, res) => {
    const c = await caseOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Case not found" });
    await q("UPDATE cases SET rate=$2, billing=$3 WHERE id=$1", [c.id, req.body.rate === "" || req.body.rate == null ? null : money(req.body.rate), ["hourly", "flat", "contingency"].includes(req.body.billing) ? req.body.billing : "hourly"]);
    res.json({ ok: true });
  }));

  // ---- invoices
  async function recalc(invId) {
    await q(`UPDATE invoices i SET total=coalesce((SELECT sum(amount) FROM invoice_lines WHERE invoice_id=i.id),0), paid=coalesce((SELECT sum(amount) FROM payments WHERE invoice_id=i.id),0) WHERE id=$1`, [invId]);
    await q(`UPDATE invoices SET status='paid' WHERE id=$1 AND status<>'void' AND total>0 AND paid>=total`, [invId]);
  }
  R.get("/invoices", requireAuth, notPara, wrap(async (req, res) => {
    const p = [req.user.firm_id]; let w = "i.firm_id=$1";
    if (["draft", "sent", "paid", "void"].includes(req.query.status)) { p.push(req.query.status); w += ` AND i.status=$${p.length}`; }
    if (!access.seesFirm(req.user)) w += ` AND i.case_id IN ${visibleCaseIds(req.user, p)}`;
    const { rows } = await q(`SELECT i.*, c.cause_no, c.style, ct.name AS client FROM invoices i LEFT JOIN cases c ON c.id=i.case_id LEFT JOIN contacts ct ON ct.id=i.contact_id WHERE ${w} ORDER BY i.id DESC LIMIT 300`, p);
    res.json({ invoices: rows });
  }));
  R.post("/invoices", requireAuth, notPara, wrap(async (req, res) => {
    const c = await caseOf(req, req.body.case_id); if (!c) return res.status(404).json({ error: "Pick a case." });
    const entries = (await q("SELECT te.*, u.name AS who FROM time_entries te LEFT JOIN users u ON u.id=te.user_id WHERE te.case_id=$1 AND te.firm_id=$2 AND te.billable AND te.invoice_id IS NULL ORDER BY te.on_date, te.id", [c.id, req.user.firm_id])).rows;
    if (!entries.length) return res.status(400).json({ error: "No unbilled time or charges on this case yet." });
    let contactId = +req.body.contact_id || null;
    if (!contactId) contactId = (await q("SELECT contact_id FROM case_contacts WHERE case_id=$1 AND role='client' LIMIT 1", [c.id])).rows[0]?.contact_id || null;
    const seq = (await q("UPDATE firms SET invoice_seq=invoice_seq+1 WHERE id=$1 RETURNING invoice_seq", [req.user.firm_id])).rows[0].invoice_seq;
    const due = addDays(today(), Number.isFinite(+req.body.due_days) ? +req.body.due_days : 30);
    const inv = (await q("INSERT INTO invoices(firm_id, case_id, contact_id, number, due, pay_token, notes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *", [req.user.firm_id, c.id, contactId, String(seq), due, tok(), clean(req.body.notes, 1000) || null])).rows[0];
    for (const e of entries) {
      const amt = e.amount != null ? money(e.amount) : money(e.minutes / 60 * e.rate);
      const desc = `${ds(e.on_date)} · ${e.description || "Legal services"}${e.who ? " · " + e.who : ""}`;
      await q("INSERT INTO invoice_lines(invoice_id, time_id, description, qty, rate, amount) VALUES($1,$2,$3,$4,$5,$6)", [inv.id, e.id, desc, e.amount != null ? null : money(e.minutes / 60), e.amount != null ? null : e.rate, amt]);
      await q("UPDATE time_entries SET invoice_id=$2 WHERE id=$1", [e.id, inv.id]);
    }
    await recalc(inv.id); await audit(req, "invoice_created", { id: inv.id, case: c.id });
    res.json({ invoice: (await q("SELECT * FROM invoices WHERE id=$1", [inv.id])).rows[0] });
  }));
  async function invoiceFull(firmId, id) {
    const inv = (await q(`SELECT i.*, c.cause_no, c.style, c.county, c.court, ct.name AS client, ct.email AS client_email, ct.address AS client_address, f.name AS firm_name, f.address AS firm_address, f.phone AS firm_phone, f.firm_email, f.website AS firm_website, f.logo_token, f.card_fee_pct, f.card_fee_fixed, (f.stripe_enc IS NOT NULL) AS card_on
      FROM invoices i JOIN firms f ON f.id=i.firm_id LEFT JOIN cases c ON c.id=i.case_id LEFT JOIN contacts ct ON ct.id=i.contact_id WHERE i.id=$1 AND i.firm_id=$2`, [id, firmId])).rows[0];
    if (!inv) return null;
    inv.lines = (await q("SELECT * FROM invoice_lines WHERE invoice_id=$1 ORDER BY id", [id])).rows;
    inv.payments = (await q("SELECT * FROM payments WHERE invoice_id=$1 ORDER BY on_date, id", [id])).rows;
    inv.balance = money(inv.total - inv.paid);
    inv.pay_url = `${APP()}/pay/${inv.pay_token}`;
    inv.card_fee = inv.card_fee_pct != null ? money(inv.balance * inv.card_fee_pct / 100 + Number(inv.card_fee_fixed || 0)) : null;
    return inv;
  }
  // one invoice, only if its case is visible to this person
  async function invFor(req, id) { const inv = await invoiceFull(req.user.firm_id, id); if (!inv) return null; if (access.seesFirm(req.user)) return inv; return inv.case_id && await caseOf(req, inv.case_id) ? inv : null; }
  R.get("/invoices/:id", requireAuth, notPara, wrap(async (req, res) => { const inv = await invFor(req, +req.params.id); if (!inv) return res.status(404).json({ error: "Not found" }); res.json({ invoice: inv }); }));
  R.patch("/invoices/:id", requireAuth, notPara, wrap(async (req, res) => {
    const inv = await invFor(req, +req.params.id); if (!inv) return res.status(404).json({ error: "Not found" });
    const st = req.body.status;
    if (st === "void") { if (inv.payments.length) return res.status(400).json({ error: "This invoice has payments — it can't be voided." }); await q("UPDATE time_entries SET invoice_id=NULL WHERE invoice_id=$1", [inv.id]); await q("UPDATE invoices SET status='void' WHERE id=$1", [inv.id]); }
    else if (st === "sent" || st === "draft") await q("UPDATE invoices SET status=$2 WHERE id=$1 AND status NOT IN ('paid','void')", [inv.id, st]);
    await audit(req, "invoice_status", { id: inv.id, status: st }); res.json({ ok: true });
  }));
  R.post("/invoices/:id/payments", requireAuth, notPara, wrap(async (req, res) => {
    const inv = await invFor(req, +req.params.id); if (!inv) return res.status(404).json({ error: "Not found" });
    if (inv.status === "void") return res.status(400).json({ error: "Invoice is void." });
    const amount = money(req.body.amount); if (!(amount > 0)) return res.status(400).json({ error: "Enter the amount paid." });
    if (amount > inv.balance + 0.001) return res.status(400).json({ error: `That's more than the balance (${usd(inv.balance)}).` });
    const method = ["card", "bank", "check", "cash", "trust", "other"].includes(req.body.method) ? req.body.method : "other";
    if (method === "trust") {
      if (!inv.contact_id) return res.status(400).json({ error: "Link a client to this invoice to pay from trust." });
      const bal = Number((await q("SELECT coalesce(sum(amount),0) b FROM trust_tx WHERE contact_id=$1", [inv.contact_id])).rows[0].b);
      if (bal + 0.001 < amount) return res.status(400).json({ error: `Not enough in this client's trust balance (${usd(bal)}).` });
      await q("INSERT INTO trust_tx(firm_id, contact_id, case_id, on_date, amount, memo, ref, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [req.user.firm_id, inv.contact_id, inv.case_id, isDate(req.body.on_date) ? req.body.on_date : today(), -amount, `Earned fees applied to invoice #${inv.number}`, `INV-${inv.number}`, req.user.id]);
    }
    await q("INSERT INTO payments(firm_id, invoice_id, amount, method, ref, on_date) VALUES($1,$2,$3,$4,$5,$6)", [req.user.firm_id, inv.id, amount, method, clean(req.body.ref, 100) || `manual-${Date.now()}`, isDate(req.body.on_date) ? req.body.on_date : today()]);
    await recalc(inv.id); await audit(req, "payment_recorded", { invoice: inv.id, amount, method }); res.json({ ok: true });
  }));
  // Printable invoice (save as PDF from the browser)
  app.get("/invoice/:id/print", requireAuth, wrap(async (req, res) => {
    const inv = await invFor(req, +req.params.id); if (!inv) return res.status(404).send("Not found");
    res.set("Content-Type", "text/html; charset=utf-8").send(invoiceHtml(inv, { print: true }));
  }));

  // ---- Stripe (the firm's own account; card/bank payments go straight to the firm)
  R.get("/firm/stripe", requireAuth, requireAdmin, wrap(async (req, res) => {
    const f = (await q("SELECT stripe_hint, card_fee_pct, card_fee_fixed FROM firms WHERE id=$1", [req.user.firm_id])).rows[0];
    res.json({ on: !!f.stripe_hint, hint: f.stripe_hint, fee_pct: f.card_fee_pct, fee_fixed: f.card_fee_fixed });
  }));
  R.post("/firm/stripe", requireAuth, requireAdmin, wrap(async (req, res) => {
    const key = String(req.body.secret || "").trim();
    const pct = req.body.fee_pct === "" || req.body.fee_pct == null ? null : Number(req.body.fee_pct), fixed = req.body.fee_fixed === "" || req.body.fee_fixed == null ? null : Number(req.body.fee_fixed);
    if (key) {
      if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(key)) return res.status(400).json({ error: "That doesn't look like a Stripe secret key (it starts with sk_live_ or sk_test_)." });
      const r = await fetch("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (!r || r.status === 401) return res.status(400).json({ error: "Stripe didn't accept that key." });
      await q("UPDATE firms SET stripe_enc=$2, stripe_hint=$3 WHERE id=$1", [req.user.firm_id, box.seal(key), key.slice(0, 8) + "…" + key.slice(-4)]);
    }
    await q("UPDATE firms SET card_fee_pct=$2, card_fee_fixed=$3 WHERE id=$1", [req.user.firm_id, Number.isFinite(pct) ? pct : null, Number.isFinite(fixed) ? fixed : null]);
    await audit(req, "stripe_saved", { key: !!key }); res.json({ ok: true });
  }));
  R.delete("/firm/stripe", requireAuth, requireAdmin, wrap(async (req, res) => { await q("UPDATE firms SET stripe_enc=NULL, stripe_hint=NULL WHERE id=$1", [req.user.firm_id]); res.json({ ok: true }); }));
  async function stripeCall(key, path, params, method = "POST") {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" }, body: method === "POST" ? new URLSearchParams(params) : undefined, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Stripe error ${r.status}`); return j;
  }
  // Public pay page
  app.get("/pay/:token", wrap(async (req, res) => {
    const row = (await q("SELECT id, firm_id FROM invoices WHERE pay_token=$1", [String(req.params.token)])).rows[0]; if (!row) return res.status(404).send("Invoice not found");
    let note = "";
    if (req.query.session_id) {
      const f = (await q("SELECT stripe_enc FROM firms WHERE id=$1", [row.firm_id])).rows[0];
      try {
        const s = await stripeCall(box.open(f.stripe_enc), `checkout/sessions/${encodeURIComponent(String(req.query.session_id))}`, null, "GET");
        if (s.payment_status === "paid" && s.metadata?.invoice_id === String(row.id)) {
          await q("INSERT INTO payments(firm_id, invoice_id, amount, method, ref) VALUES($1,$2,$3,'card',$4) ON CONFLICT (invoice_id, ref) DO NOTHING", [row.firm_id, row.id, money(s.amount_total / 100), s.id]);
          await recalc(row.id); note = "Thank you — your payment was received.";
        }
      } catch (e) { note = "We couldn't confirm the payment yet. If you were charged, the firm will see it shortly."; }
    }
    const inv = await invoiceFull(row.firm_id, row.id);
    res.set({ "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" }).send(invoiceHtml(inv, { pay: true, note }));
  }));
  app.get("/pay/:token/checkout", wrap(async (req, res) => {
    const row = (await q("SELECT i.id, i.firm_id, f.stripe_enc FROM invoices i JOIN firms f ON f.id=i.firm_id WHERE i.pay_token=$1", [String(req.params.token)])).rows[0];
    if (!row || !row.stripe_enc) return res.status(404).send("Online payment isn't available for this invoice.");
    const inv = await invoiceFull(row.firm_id, row.id);
    if (!(inv.balance > 0) || inv.status === "void") return res.redirect(`/pay/${req.params.token}`);
    try {
      const s = await stripeCall(box.open(row.stripe_enc), "checkout/sessions", {
        mode: "payment", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": String(Math.round(inv.balance * 100)),
        "line_items[0][price_data][product_data][name]": `${inv.firm_name} — Invoice #${inv.number}`, "metadata[invoice_id]": String(inv.id),
        success_url: `${APP()}/pay/${req.params.token}?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${APP()}/pay/${req.params.token}` });
      res.redirect(303, s.url);
    } catch (e) { res.status(502).send("The payment page couldn't be opened: " + esc(e.message)); }
  }));

  // ===================== Trust (IOLTA) ledger — beta =====================
  R.get("/trust", requireAuth, trustOnly, wrap(async (req, res) => {
    const clients = (await q(`SELECT ct.id, ct.name, sum(t.amount) AS balance, max(t.on_date) AS last FROM trust_tx t JOIN contacts ct ON ct.id=t.contact_id WHERE t.firm_id=$1 GROUP BY ct.id ORDER BY ct.name`, [req.user.firm_id])).rows;
    const recent = (await q(`SELECT t.*, ct.name, c.cause_no FROM trust_tx t JOIN contacts ct ON ct.id=t.contact_id LEFT JOIN cases c ON c.id=t.case_id WHERE t.firm_id=$1 ORDER BY t.on_date DESC, t.id DESC LIMIT 100`, [req.user.firm_id])).rows;
    const recons = (await q("SELECT * FROM trust_recon WHERE firm_id=$1 ORDER BY as_of DESC, id DESC LIMIT 12", [req.user.firm_id])).rows;
    res.json({ clients, recent, recons, total: money(clients.reduce((s, c) => s + Number(c.balance), 0)) });
  }));
  R.post("/trust", requireAuth, trustOnly, wrap(async (req, res) => {
    const b = req.body || {}; const ct = await contactOf(req, b.contact_id); if (!ct) return res.status(404).json({ error: "Pick the client." });
    const amount = money(b.amount); if (!amount) return res.status(400).json({ error: "Enter an amount (+ deposit, − payment out)." });
    if (b.case_id && !(await caseOf(req, b.case_id))) return res.status(404).json({ error: "Case not found" });
    const bal = Number((await q("SELECT coalesce(sum(amount),0) b FROM trust_tx WHERE contact_id=$1", [ct.id])).rows[0].b);
    if (bal + amount < -0.001) return res.status(400).json({ error: `That would overdraw ${ct.name}'s trust balance (${usd(bal)}). Client money can't go below zero.` });
    if (!clean(b.memo, 300)) return res.status(400).json({ error: "Add a memo (what the money is for)." });
    await q("INSERT INTO trust_tx(firm_id, contact_id, case_id, on_date, amount, memo, ref, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [req.user.firm_id, ct.id, +b.case_id || null, isDate(b.on_date) ? b.on_date : today(), amount, clean(b.memo, 300), clean(b.ref, 100) || null, req.user.id]);
    await audit(req, "trust_entry", { contact: ct.id, amount }); res.json({ ok: true, balance: money(bal + amount) });
  }));
  R.post("/trust/reconcile", requireAuth, trustOnly, wrap(async (req, res) => {
    const asOf = isDate(req.body.as_of) ? req.body.as_of : today(), bank = money(req.body.bank_balance);
    if (req.body.bank_balance === "" || req.body.bank_balance == null) return res.status(400).json({ error: "Enter the bank statement balance." });
    const book = money((await q("SELECT coalesce(sum(amount),0) v FROM trust_tx WHERE firm_id=$1 AND on_date<=$2", [req.user.firm_id, asOf])).rows[0].v);
    const ledgers = money((await q("SELECT coalesce(sum(b),0) v FROM (SELECT sum(amount) b FROM trust_tx WHERE firm_id=$1 AND on_date<=$2 GROUP BY contact_id) x", [req.user.firm_id, asOf])).rows[0].v);
    const ok = Math.abs(bank - book) < 0.005 && Math.abs(book - ledgers) < 0.005;
    await q("INSERT INTO trust_recon(firm_id, as_of, bank_balance, book_balance, ledgers_total, ok, created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [req.user.firm_id, asOf, bank, book, ledgers, ok, req.user.id]);
    await audit(req, "trust_reconciled", { asOf, ok }); res.json({ as_of: asOf, bank, book, ledgers, ok, difference: money(bank - book) });
  }));

  // ===================== Client portal (link per client, no password; revocable) =====================
  R.post("/contacts/:id/portal", requireAuth, wrap(async (req, res) => {
    const c = await contactOf(req, req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
    const t = req.body.revoke ? null : tok();
    await q("UPDATE contacts SET portal_token=$2 WHERE id=$1", [c.id, t]); await audit(req, t ? "portal_link_made" : "portal_link_revoked", { contact: c.id });
    res.json({ url: t ? `${APP()}/portal/${t}` : null });
  }));
  app.get("/portal/:token", wrap(async (req, res) => {
    const ct = (await q("SELECT ct.*, f.name AS firm_name, f.address AS firm_address, f.phone AS firm_phone, f.firm_email, f.website AS firm_website, f.logo_token FROM contacts ct JOIN firms f ON f.id=ct.firm_id WHERE ct.portal_token=$1", [String(req.params.token)])).rows[0];
    if (!ct) return res.status(404).send("This link is no longer active. Contact your attorney for a new one.");
    const cases = (await q("SELECT c.* FROM case_contacts cc JOIN cases c ON c.id=cc.case_id WHERE cc.contact_id=$1 AND cc.role='client' ORDER BY c.id DESC", [ct.id])).rows;
    const blocks = [];
    for (const c of cases) {
      const ev = (await calendarItems(ct.firm_id, { from: today(), to: addDays(today(), 365), caseId: c.id })).filter(i => i.kind === "hearing" || i.kind === "meeting");
      const docs = (await q("SELECT id, name FROM documents WHERE case_id=$1 AND shared ORDER BY id DESC", [c.id])).rows;
      blocks.push(`<div class="card"><div class="mute">${esc(c.county)} County${c.court ? " · " + esc(c.court) : ""} · Cause ${esc(c.cause_no)}</div><h2>${esc(c.style || c.cause_no)}</h2>
        ${c.status ? `<p><b>Status:</b> ${esc(c.status)}</p>` : ""}
        <p><b>Next court date:</b> ${ev[0] ? `${esc(ev[0].date)}${ev[0].time ? " at " + esc(ev[0].time) : ""} — ${esc(ev[0].title)}` : "None scheduled yet"}</p>
        ${ev.length > 1 ? `<p class="mute">Also: ${ev.slice(1, 5).map(e => esc(e.date + " " + e.title)).join(" · ")}</p>` : ""}
        ${docs.length ? `<p><b>Documents:</b><br>${docs.map(d => `<a href="/portal/${esc(req.params.token)}/doc/${d.id}">${esc(d.name)}</a>`).join("<br>")}</p>` : ""}</div>`);
    }
    const invs = (await q("SELECT number, total, paid, pay_token, due, status FROM invoices WHERE contact_id=$1 AND status IN ('sent','paid') ORDER BY id DESC LIMIT 20", [ct.id])).rows;
    const inv = invs.length ? `<div class="card"><h2>Invoices</h2>${invs.map(i => `<p>#${esc(i.number)} — ${usd(i.total)} · ${Number(i.total) - Number(i.paid) > 0 ? `balance ${usd(Number(i.total) - Number(i.paid))} · <a href="/pay/${esc(i.pay_token)}">View and pay</a>` : "Paid"}</p>`).join("")}</div>` : "";
    res.set({ "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" }).send(page(`${ct.firm_name} — client page`,
      `${brandHead({ name: ct.firm_name, address: ct.firm_address, phone: ct.firm_phone, email: ct.firm_email, website: ct.firm_website, logo_token: ct.logo_token })}<h1>Hello, ${esc(ct.name.split(" ")[0])}</h1><p class="mute">Your case updates from ${esc(ct.firm_name)}. Questions? Contact your attorney directly.</p>${blocks.join("") || `<div class="card">No active cases to show yet.</div>`}${inv}`));
  }));
  app.get("/portal/:token/doc/:id", wrap(async (req, res) => {
    const d = (await q(`SELECT d.* FROM documents d JOIN case_contacts cc ON cc.case_id=d.case_id AND cc.role='client' JOIN contacts ct ON ct.id=cc.contact_id WHERE ct.portal_token=$1 AND d.id=$2 AND d.shared`, [String(req.params.token), +req.params.id])).rows[0];
    if (!d) return res.status(404).send("Not found");
    res.set({ "Content-Type": d.mime || "application/octet-stream", "Content-Disposition": dispo("attachment", d.name) }).send(d.data);
  }));

  // ===================== Export / import =====================
  const EXPORTS = {
    cases: f => q("SELECT c.county, c.cause_no, c.style, c.court, c.case_type, c.filed_date, c.status, c.next_setting, c.notes, c.issues, u.name AS attorney, c.source, c.created_at FROM cases c LEFT JOIN users u ON u.id=c.user_id WHERE c.firm_id=$1 ORDER BY c.id", [f]),
    contacts: f => q("SELECT kind, name, company, email, phone, address, notes FROM contacts WHERE firm_id=$1 ORDER BY name", [f]),
    calendar: f => q("SELECT e.on_date, e.at_time, e.kind, e.title, e.cite, e.done, c.cause_no, c.style, e.notes FROM events e LEFT JOIN cases c ON c.id=e.case_id WHERE e.firm_id=$1 ORDER BY e.on_date", [f]),
    tasks: f => q("SELECT t.title, t.due_date, t.done, u.name AS assignee, c.cause_no FROM tasks t LEFT JOIN users u ON u.id=t.assignee LEFT JOIN cases c ON c.id=t.case_id WHERE t.firm_id=$1 ORDER BY t.id", [f]),
    time: f => q("SELECT te.on_date, u.name AS who, c.cause_no, te.minutes, te.rate, te.amount, te.description, te.billable, i.number AS invoice FROM time_entries te LEFT JOIN users u ON u.id=te.user_id LEFT JOIN cases c ON c.id=te.case_id LEFT JOIN invoices i ON i.id=te.invoice_id WHERE te.firm_id=$1 ORDER BY te.on_date", [f]),
    invoices: f => q("SELECT i.number, i.issued, i.due, i.status, i.total, i.paid, c.cause_no, ct.name AS client FROM invoices i LEFT JOIN cases c ON c.id=i.case_id LEFT JOIN contacts ct ON ct.id=i.contact_id WHERE i.firm_id=$1 ORDER BY i.id", [f]),
    trust: f => q("SELECT t.on_date, ct.name AS client, c.cause_no, t.amount, t.memo, t.ref FROM trust_tx t JOIN contacts ct ON ct.id=t.contact_id LEFT JOIN cases c ON c.id=t.case_id WHERE t.firm_id=$1 ORDER BY t.on_date, t.id", [f])
  };
  app.get("/export/:what.csv", requireAuth, requireAdmin, wrap(async (req, res) => {
    if (req.devView) return res.status(403).json({ error: "Developer view is read-only — nothing was changed.", code: "DEV_READONLY" });   // second lock, whatever the URL spelling
    const fn = EXPORTS[req.params.what]; if (!fn) return res.status(404).send("Not found");
    const { rows } = await fn(req.user.firm_id); await audit(req, "export", { what: req.params.what, rows: rows.length });
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="tx-case-desk-${req.params.what}-${today()}.csv"` }).send("\ufeff" + toCsv(rows));
  }));
  // Import contacts or matters exported from Clio / MyCase / PracticePanther (header names are matched loosely)
  const pick = (h, names) => { for (const n of names) { const i = h.findIndex(x => x === n); if (i >= 0) return i; } for (const n of names) { const i = h.findIndex(x => x.includes(n)); if (i >= 0) return i; } return -1; };
  R.post("/import/contacts", requireAuth, wrap(async (req, res) => {
    const rows = parseCsv(String(req.body.csv || "")); if (rows.length < 2) return res.status(400).json({ error: "Paste or upload a CSV with a header row." });
    const h = rows[0].map(x => x.trim().toLowerCase());
    const ix = { name: pick(h, ["name", "full name", "contact name", "display name"]), first: pick(h, ["first name", "first"]), last: pick(h, ["last name", "last"]), company: pick(h, ["company", "organization", "business"]),
      email: pick(h, ["email", "email address", "primary email"]), phone: pick(h, ["phone", "phone number", "mobile", "primary phone", "cell"]), address: pick(h, ["address", "street", "mailing address"]) };
    if (ix.name < 0 && ix.first < 0 && ix.last < 0 && ix.company < 0) return res.status(400).json({ error: "Couldn't find a name column (Name, First Name / Last Name, or Company)." });
    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      const g = i => i >= 0 ? (r[i] || "").trim() : "";
      const name = g(ix.name) || [g(ix.first), g(ix.last)].filter(Boolean).join(" ") || g(ix.company);
      if (!name) { skipped++; continue; }
      if ((await q("SELECT 1 FROM contacts WHERE firm_id=$1 AND lower(name)=lower($2) AND coalesce(lower(email),'')=coalesce(lower($3),'')", [req.user.firm_id, name, g(ix.email) || null])).rowCount) { skipped++; continue; }
      await q("INSERT INTO contacts(firm_id, kind, name, company, email, phone, address, created_by) VALUES($1,'client',$2,$3,$4,$5,$6,$7)", [req.user.firm_id, name.slice(0, 200), g(ix.company) || null, g(ix.email) || null, g(ix.phone) || null, g(ix.address) || null, req.user.id]);
      added++;
    }
    await audit(req, "import_contacts", { added, skipped }); res.json({ added, skipped });
  }));
  R.post("/import/matters", requireAuth, wrap(async (req, res) => {
    const county = String(req.body.county || ""); if (!(req.user.counties || []).includes(county)) return res.status(400).json({ error: "Pick one of your counties for these cases." });
    const rows = parseCsv(String(req.body.csv || "")); if (rows.length < 2) return res.status(400).json({ error: "Paste or upload a CSV with a header row." });
    const h = rows[0].map(x => x.trim().toLowerCase());
    const ix = { cause: pick(h, ["cause number", "cause no", "cause #", "case number", "court case number", "docket number", "display number", "matter number"]),
      style: pick(h, ["case style", "style", "case name", "matter name", "description", "matter description", "name"]), client: pick(h, ["client", "client name", "contact", "primary client"]),
      status: pick(h, ["status", "matter status"]), court: pick(h, ["court"]), area: pick(h, ["practice area", "case type", "matter type"]) };
    if (ix.cause < 0) return res.status(400).json({ error: "Couldn't find a case/cause number column (Cause Number, Case Number, Display Number or Matter Number)." });
    let added = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      const g = i => i >= 0 ? (r[i] || "").trim() : "";
      const cause = g(ix.cause).toUpperCase().slice(0, 60); if (!cause) { skipped++; continue; }
      const area = g(ix.area).toLowerCase();
      const type = /probate|estate|guardian/.test(area) ? "Probate" : /family|divorce|custody/.test(area) ? "Family" : /injury|accident/.test(area) ? "Civil – Personal Injury" : /contract|collection|debt/.test(area) ? "Civil – Contract"
        : /dtpa|consumer/.test(area) ? "Civil – DTPA / Consumer" : /real (estate|property)/.test(area) ? "Civil – Real Property" : /evict|landlord/.test(area) ? "Eviction" : /felony/.test(area) ? "Criminal – Felony" : /misdemeanor|dwi|criminal/.test(area) ? "Criminal – Misdemeanor" : null;
      const ins = await q(`INSERT INTO cases(firm_id, user_id, county, cause_no, style, status, court, case_type, notes, source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'import') ON CONFLICT(firm_id,county,cause_no) DO NOTHING RETURNING *`,
        [req.user.firm_id, req.user.id, county, cause, g(ix.style) || null, g(ix.status) || null, g(ix.court) || null, type, g(ix.area) ? `Practice area: ${g(ix.area)}` : null]);
      if (!ins.rows[0]) { skipped++; continue; }
      added++; await onCaseCreated(ins.rows[0], req.user.id);
      const client = g(ix.client);
      if (client) {
        let ct = (await q("SELECT id FROM contacts WHERE firm_id=$1 AND lower(name)=lower($2) LIMIT 1", [req.user.firm_id, client])).rows[0];
        if (!ct) ct = (await q("INSERT INTO contacts(firm_id, kind, name, created_by) VALUES($1,'client',$2,$3) RETURNING id", [req.user.firm_id, client.slice(0, 200), req.user.id])).rows[0];
        await q("INSERT INTO case_contacts(case_id, contact_id, role) VALUES($1,$2,'client') ON CONFLICT DO NOTHING", [ins.rows[0].id, ct.id]);
      }
    }
    await audit(req, "import_matters", { added, skipped }); res.json({ added, skipped });
  }));

  app.use("/api", R);
}

// ---------- small standalone pages (invoice / pay / portal) ----------
function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f4f0;color:#1d2433}main{max-width:760px;margin:0 auto;padding:16px}
h1{font-family:Georgia,serif;font-size:22px}h2{font-size:17px;margin:4px 0 8px}.card{background:#fff;border:1px solid #e4e2db;border-radius:12px;padding:14px;margin:0 0 12px}.mute{color:#667085;font-size:13px}
.line{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #eee;padding:8px 0}.line span:last-child{white-space:nowrap}.tot{font-weight:700;font-size:17px}
.brand{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:8px 0 14px;margin-bottom:12px;border-bottom:1px solid #e4e2db}.brand img{max-height:56px;max-width:220px;object-fit:contain}.brand .bn{font-family:Georgia,serif;font-size:19px;font-weight:600}
.btn{display:inline-block;border:0;background:#7a2e2e;color:#fff;padding:12px 18px;border-radius:8px;font-size:15px;text-decoration:none;cursor:pointer}a{color:#7a2e2e}.ok{background:#e3f4ea;border-color:#bfe3cd}
@media print{.noprint{display:none}body{background:#fff}.card{border:0}}</style></head><body><main>${body}</main></body></html>`;
}
// firm header for invoices and the client page (logo + name + contact line)
function brandHead(f) {
  const contact = [String(f.address || "").split(/\n+/).map(s => s.trim()).filter(Boolean).join(", "), f.phone, f.email, f.website].filter(Boolean);
  return `<header class="brand">${f.logo_token ? `<img src="/brand/${esc(f.logo_token)}" alt="${esc(f.name)}">` : ""}<div><div class="bn">${esc(f.name)}</div>${contact.length ? `<div class="mute">${contact.map(esc).join(" · ")}</div>` : ""}</div></header>`;
}
function invoiceHtml(inv, { pay, print, note } = {}) {
  const d = ds;
  return page(`Invoice #${inv.number} — ${inv.firm_name}`, `${note ? `<div class="card ok">${esc(note)}</div>` : ""}
  ${brandHead({ name: inv.firm_name, address: inv.firm_address, phone: inv.firm_phone, email: inv.firm_email, website: inv.firm_website, logo_token: inv.logo_token })}
  <div class="card"><h1 style="margin:0 0 4px">Invoice #${esc(inv.number)}</h1>
   <div class="mute">Issued ${d(inv.issued)}${inv.due ? ` · Due ${d(inv.due)}` : ""} · ${esc(inv.status)}</div>
   ${inv.client ? `<p><b>Bill to:</b> ${esc(inv.client)}${inv.client_address ? `<br><span class="mute">${esc(inv.client_address)}</span>` : ""}</p>` : ""}
   ${inv.cause_no ? `<p class="mute">Matter: ${esc(inv.style || "")} · ${esc(inv.county || "")} County · Cause ${esc(inv.cause_no)}</p>` : ""}</div>
  <div class="card">${inv.lines.map(l => `<div class="line"><span>${esc(l.description)}${Number(l.qty) && l.time_id ? ` <span class="mute">(${Number(l.qty)} h × ${usd(l.rate)})</span>` : ""}</span><span>${usd(l.amount)}</span></div>`).join("")}
   <div class="line tot"><span>Total</span><span>${usd(inv.total)}</span></div>
   ${Number(inv.paid) ? `<div class="line"><span>Paid</span><span>− ${usd(inv.paid)}</span></div><div class="line tot"><span>Balance due</span><span>${usd(inv.balance)}</span></div>` : ""}</div>
  ${pay && inv.balance > 0 && inv.status !== "void" ? (inv.card_on ? `<p class="noprint"><a class="btn" href="/pay/${esc(inv.pay_token)}/checkout">Pay ${usd(inv.balance)} by card or bank</a></p><p class="mute noprint">Secure payment by Stripe. The firm receives your payment directly.</p>`
    : `<div class="card noprint">To pay, contact ${esc(inv.firm_name)}.</div>`) : ""}
  ${print ? `<p class="noprint mute">To save a PDF: use your browser's Print, then choose Save as PDF.</p>` : ""}`);
}

module.exports = { mount, onCaseCreated, parseSetting };
