// Activity log: one timeline of everything on a case — conversations, court emails, documents, tasks, dates,
// time and invoices (attorneys only), discovery, team and case changes (stage, court status, court, attorney…).
// Read-only: it's built from the records themselves, so it can't drift from them.
const { q } = require("./db");
const access = require("./access");
const rt = require("./richtext");

const LAWYER = u => u.role !== "paralegal";
const FIELD = { stage: "Stage", status: "Court status", court: "Court", case_type: "Case type", style: "Case name", cause_no: "Cause #", attorney: "Lead attorney", next_setting: "Next setting" };
const KIND = { call: "Call", meeting: "Meeting", voicemail: "Voicemail", email: "Email", text: "Text", court: "Court / clerk", note: "Note to file" };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const d10 = d => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : "";
const mdy = d => { const s = d10(d); return /^\d{4}-\d\d-\d\d$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : s; };
const AUD = ["case_team_added", "case_team_removed", "convo_edit", "convo_delete", "document_shared", "document_deleted", "event_deleted", "task_deleted", "discovery_set_deleted"];
const SRC = "Court email or sync";   // a change no person made
const hrs = m => (Math.round((+m || 0) / 6) / 10).toFixed(1) + " h";
const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function build(user, caseId) {
  const pr = [+caseId || 0, user.firm_id]; const cond = access.caseCond(user, "c", pr);
  const c = (await q(`SELECT c.* FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0];
  if (!c) return null;
  const F = user.firm_id, id = c.id, law = LAWYER(user);
  const none = { rows: [] }, safe = p => p.catch(e => { console.warn("[activity]", e.message); return none; });
  const [users, convos, emails, docs, tasks, events, time, invoices, disc, changes, audits] = await Promise.all([
    safe(q("SELECT id, name FROM users WHERE firm_id=$1", [F])),
    safe(q("SELECT id, at, kind, with_name, direction, minutes, body, user_id FROM case_convos WHERE case_id=$1 AND firm_id=$2 ORDER BY at DESC LIMIT 1000", [id, F])),
    safe(q(`SELECT id, subject, from_addr, received_at FROM inbound_emails WHERE firm_id=$2 AND dismissed_at IS NULL
        AND ($3 = ANY(matched_case_ids) OR ($1 = ANY(causes) AND (lower(parsed->>'county') = lower($4) OR user_id=$5))) ORDER BY received_at DESC LIMIT 500`,
      [String(c.cause_no).toUpperCase(), F, id, c.county || "", user.id])),
    safe(q("SELECT id, name, shared, uploaded_by, created_at FROM documents WHERE case_id=$1 AND firm_id=$2 ORDER BY id DESC LIMIT 500", [id, F])),
    safe(q("SELECT id, title, due_date, done, done_at, done_by, assignee, created_by, created_at FROM tasks WHERE case_id=$1 AND firm_id=$2 ORDER BY id DESC LIMIT 500", [id, F])),
    safe(q("SELECT id, kind, title, on_date, at_time, created_by, created_at FROM events WHERE case_id=$1 AND firm_id=$2 ORDER BY id DESC LIMIT 500", [id, F])),
    law ? safe(q("SELECT id, minutes, amount, description, user_id, created_at, invoice_id FROM time_entries WHERE case_id=$1 AND firm_id=$2 ORDER BY id DESC LIMIT 500", [id, F])) : none,
    law ? safe(q("SELECT id, number, total, status, created_at FROM invoices WHERE case_id=$1 AND firm_id=$2 ORDER BY id DESC LIMIT 200", [id, F])) : none,
    safe(q("SELECT id, title, response_title, created_by, created_at, sent_at, sent_to, sent_by FROM discovery_sets WHERE case_id=$1 AND firm_id=$2", [id, F])),
    safe(q("SELECT field, old_value, new_value, user_id, at FROM case_changes WHERE case_id=$1 ORDER BY at DESC LIMIT 500", [id])),
    // written to match the indexes on audit_log (db.js LATE_INDEXES)
    safe(q(`(SELECT action, detail, user_id, at FROM audit_log WHERE firm_id=$1 AND action IN (${AUD.map(a => `'${a}'`).join(",")}) AND COALESCE(detail->>'case', detail->>'case_id') = $2 ORDER BY at DESC LIMIT 500)
        UNION ALL (SELECT action, detail, user_id, at FROM audit_log WHERE firm_id=$1 AND action='case_added' AND detail->>'id' = $2 LIMIT 1)`, [F, String(id)])),
  ]);
  const nm = Object.fromEntries(users.rows.map(u => [u.id, u.name])), by = uid => uid ? nm[uid] || "Former user" : null;
  // the full wording of an edited or deleted conversation: firm leaders and the lead attorney only (it may have been on the wrong matter)
  const seeOld = access.firmDash(user) || c.user_id === user.id;
  const out = [], add = (cat, at, title, detail, who, go) => { if (at) out.push({ cat, at: new Date(at).toISOString(), title, detail: detail || "", by: who || null, go: go || null }); };

  for (const v of convos.rows) add("conversations", v.at, `${KIND[v.kind] || "Conversation"}${v.direction === "in" ? " (incoming)" : v.direction === "out" ? " (outgoing)" : ""}${v.with_name ? " with " + v.with_name : ""}${v.minutes ? " · " + v.minutes + " min" : ""}`,
    clip(rt.toText(v.body || ""), 220), by(v.user_id), { sec: "talk" });
  for (const e of emails.rows) add("court", e.received_at, clip(e.subject || "(no subject)", 200), e.from_addr ? "From " + clip(e.from_addr, 120) : "", SRC, { email: e.id });
  for (const d of docs.rows) add("documents", d.created_at, "Document added: " + clip(d.name, 160), "", by(d.uploaded_by), { doc: d.id });
  for (const t of tasks.rows) {
    add("tasks", t.created_at, "Task added: " + clip(t.title, 160), [t.due_date ? "Due " + mdy(t.due_date) : "", t.assignee ? "For " + by(t.assignee) : ""].filter(Boolean).join(" · "), by(t.created_by), { sec: "tasks" });
    if (t.done && t.done_at) add("tasks", t.done_at, "Task done: " + clip(t.title, 160), t.done_by ? "" : t.assignee ? "For " + by(t.assignee) : "", t.done_by ? by(t.done_by) : null, { sec: "tasks" });
  }
  for (const e of events.rows) add("dates", e.created_at, `${e.kind === "hearing" ? "Hearing" : e.kind === "deadline" ? "Deadline" : e.kind === "meeting" ? "Meeting" : "Date"} added: ${clip(e.title, 160)}`,
    "On " + mdy(e.on_date) + (e.at_time ? " " + e.at_time : ""), e.created_by ? by(e.created_by) : SRC, { sec: "dates" });
  for (const t of time.rows) add("billing", t.created_at, t.amount != null && !t.minutes ? `Expense / flat fee: ${usd(t.amount)}` : `Time: ${hrs(t.minutes)}`, clip(t.description, 200) + (t.invoice_id ? " · invoiced" : ""), by(t.user_id), { sec: "billing" });
  for (const i of invoices.rows) add("billing", i.created_at, `Invoice ${i.number}: ${usd(i.total)}`, "Status: " + i.status, null, { sec: "billing" });
  for (const s of disc.rows) {
    add("discovery", s.created_at, "Discovery requests added: " + clip(s.title, 160), "", by(s.created_by), { sec: "discovery" });
    if (s.sent_at) add("discovery", s.sent_at, "Responses served: " + clip(s.response_title || s.title, 160), s.sent_to ? "To " + clip(s.sent_to, 160) : "", by(s.sent_by), { sec: "discovery" });
  }
  for (const ch of changes.rows) {
    const v = x => ch.field === "attorney" ? (x ? by(+x) : "") : x;
    add("changes", ch.at, `${FIELD[ch.field] || ch.field}: ${clip(v(ch.new_value), 140) || "cleared"}`, ch.old_value ? "Was " + clip(v(ch.old_value), 140) : "", ch.user_id ? by(ch.user_id) : SRC, null);
  }
  for (const a of audits.rows) {
    const d = a.detail || {};
    if (a.action === "case_added") add("changes", a.at, "Case added", "", by(a.user_id), null);
    else if (a.action === "case_team_added") add("changes", a.at, "Added to the case team: " + (by(+d.user) || ""), "", by(a.user_id), { sec: "people" });
    else if (a.action === "case_team_removed") add("changes", a.at, "Removed from the case team: " + (by(+d.user) || ""), "", by(a.user_id), { sec: "people" });
    else if (a.action === "convo_edit" || a.action === "convo_delete") {
      const b = d.before || {}, head = `${KIND[b.kind] || "Conversation"}${b.with_name ? " with " + b.with_name : ""}${b.at ? " on " + mdy(b.at) : ""}`;
      add("conversations", a.at, a.action === "convo_edit" ? "Conversation edited" : "Conversation deleted", (a.action === "convo_edit" ? "Was: " : "") + head + (seeOld && b.body ? " — " + clip(rt.toText(b.body), 160) : ""), by(a.user_id), a.action === "convo_edit" ? { sec: "talk" } : null);
    }
    else if (a.action === "document_shared") add("documents", a.at, `${d.shared ? "Shared with the client" : "No longer shared with the client"}: ${clip(d.name, 160)}`, "", by(a.user_id), null);
    else if (a.action === "document_deleted") add("documents", a.at, "Document deleted: " + clip(d.name || "", 160), "", by(a.user_id), null);
    else if (a.action === "event_deleted") add("dates", a.at, `${d.kind === "hearing" ? "Hearing" : d.kind === "deadline" ? "Deadline" : "Date"} removed: ${clip(d.title, 160)}`, d.on ? "Was on " + mdy(d.on) : "", by(a.user_id), null);
    else if (a.action === "task_deleted") add("tasks", a.at, "Task deleted: " + clip(d.title, 160), "", by(a.user_id), null);
    else if (a.action === "discovery_set_deleted") add("discovery", a.at, "Discovery draft deleted" + (d.title ? ": " + clip(d.title, 160) : ""), "", by(a.user_id), null);
  }
  if (!audits.rows.some(a => a.action === "case_added") && c.created_at) add("changes", c.created_at, "Case added", "", SRC, null);
  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, 2000);
}

function mount(app, { requireAuth, wrap }) {
  app.get("/api/cases/:id/activity", requireAuth, wrap(async (req, res) => {
    const items = await build(req.user, req.params.id);
    if (!items) return res.status(404).json({ error: "Case not found" });
    res.json({ items, billing: LAWYER(req.user) });
  }));
}
module.exports = { mount, _test: { build } };
