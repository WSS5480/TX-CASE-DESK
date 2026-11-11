// Conversations: a dated log on each case — calls, meetings, voicemails, emails, texts, court — who it was with and
// what was said (Word-style notes, dictation works). Anyone who can see the case can read and add; the person who
// logged an entry, or an attorney, can edit or delete it. Every change is audited.
const { q } = require("./db");
const access = require("./access");
const rt = require("./richtext");

const KINDS = ["call", "meeting", "voicemail", "email", "text", "court", "note"];
const fail = (status, error) => Object.assign(new Error(error), { status });
const LAWYER = u => u.role !== "paralegal";

async function caseFor(user, id) {
  const pr = [+id || 0, user.firm_id]; const cond = access.caseCond(user, "c", pr);
  const c = (await q(`SELECT c.id, c.firm_id FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0];
  if (!c) throw fail(404, "Case not found.");
  return c;
}
async function entryFor(user, id) {
  const e = (await q("SELECT * FROM case_convos WHERE id=$1 AND firm_id=$2", [+id || 0, user.firm_id])).rows[0];
  if (!e) throw fail(404, "Not found.");
  await caseFor(user, e.case_id);
  if (e.user_id !== user.id && !LAWYER(user)) throw fail(403, "Only the person who logged this, or an attorney, can change it.");
  return e;
}
async function clean(user, caseId, b, old) {
  const o = {};
  if (b.kind !== undefined || !old) { const k = String(b.kind || "call").toLowerCase(); if (!KINDS.includes(k)) throw fail(400, "Pick a type."); o.kind = k; }
  if (b.at !== undefined || !old) {
    const d = b.at ? new Date(b.at) : new Date();
    if (isNaN(d) || d.getFullYear() < 1990 || d > new Date(Date.now() + 366 * 864e5)) throw fail(400, "Check the date and time.");
    o.at = d.toISOString();
  }
  if (b.contact_id !== undefined) {
    if (b.contact_id) {
      const ct = (await q("SELECT ct.id, ct.name FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1 AND ct.id=$2", [caseId, +b.contact_id])).rows[0];
      if (!ct) throw fail(400, "That person isn't on this case.");
      o.contact_id = ct.id; o.with_name = ct.name;
    } else o.contact_id = null;
  }
  if (b.with_name !== undefined && !o.contact_id) o.with_name = String(b.with_name || "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || null;
  if (b.direction !== undefined) o.direction = ["in", "out"].includes(b.direction) ? b.direction : null;
  if (b.minutes !== undefined) { const m = b.minutes === "" || b.minutes == null ? null : Math.round(+b.minutes); if (m != null && !(m >= 0 && m <= 24 * 60)) throw fail(400, "Check the minutes."); o.minutes = m; }
  // links to the time entry / follow-up task made for this entry: only this firm's, on this case
  if (b.time_id !== undefined) o.time_id = b.time_id && (await q("SELECT 1 FROM time_entries WHERE id=$1 AND firm_id=$2 AND case_id=$3 AND user_id=$4", [+b.time_id, user.firm_id, caseId, user.id])).rowCount ? +b.time_id : null;
  if (b.task_id !== undefined) o.task_id = b.task_id && (await q("SELECT 1 FROM tasks WHERE id=$1 AND firm_id=$2 AND case_id=$3", [+b.task_id, user.firm_id, caseId])).rowCount ? +b.task_id : null;
  if (b.body !== undefined || !old) {
    const body = String(b.body || ""); if (body.length > 100000) throw fail(400, "That's too long (100,000 characters at most).");
    o.body = rt.cleanNotes(body) || null;
  }
  const empty = !(o.body !== undefined ? o.body && rt.toText(o.body).trim() : old && old.body);
  if (empty) throw fail(400, "Write what was said.");
  return o;
}
const SEL = `SELECT v.*, u.name AS logged_by, ub.name AS edited_by, te.minutes AS billed_minutes, te.invoice_id AS billed_invoice, tk.due_date AS follow_due, tk.done AS follow_done, tk.title AS follow_title
  FROM case_convos v LEFT JOIN users u ON u.id=v.user_id LEFT JOIN users ub ON ub.id=v.updated_by LEFT JOIN time_entries te ON te.id=v.time_id LEFT JOIN tasks tk ON tk.id=v.task_id`;

function mount(app, { requireAuth, wrap, audit }) {
  app.get("/api/cases/:id/convos", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id);
    const rows = (await q(`${SEL} WHERE v.case_id=$1 AND v.firm_id=$2 ORDER BY v.at DESC, v.id DESC LIMIT 500`, [c.id, req.user.firm_id])).rows;
    res.json({ convos: rows.map(r => ({ ...r, can_edit: r.user_id === req.user.id || LAWYER(req.user) })), kinds: KINDS });
  }));
  app.post("/api/cases/:id/convos", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id);
    const o = await clean(req.user, c.id, req.body || {});
    const r = (await q(`INSERT INTO case_convos (firm_id, case_id, at, kind, contact_id, with_name, body, user_id, direction, minutes, time_id, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.firm_id, c.id, o.at, o.kind, o.contact_id || null, o.with_name || null, o.body, req.user.id, o.direction || null, o.minutes ?? null, o.time_id || null, o.task_id || null])).rows[0];
    await audit(req, "convo_add", { case_id: c.id, convo_id: r.id, kind: o.kind });
    res.json({ convo: { ...(await q(`${SEL} WHERE v.id=$1`, [r.id])).rows[0], can_edit: true } });
  }));
  app.patch("/api/convos/:id", requireAuth, wrap(async (req, res) => {
    const e = await entryFor(req.user, req.params.id);
    const o = await clean(req.user, e.case_id, req.body || {}, e);
    const keys = Object.keys(o); if (!keys.length) return res.json({ ok: true });
    if (keys.every(k => k === "time_id" || k === "task_id")) {   // linking the time entry / follow-up made with this entry isn't an edit
      await q(`UPDATE case_convos SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(", ")} WHERE id=$1`, [e.id, ...keys.map(k => o[k])]);
      await audit(req, "convo_link", { case_id: e.case_id, convo_id: e.id, ...o });
      return res.json({ convo: { ...(await q(`${SEL} WHERE v.id=$1`, [e.id])).rows[0], can_edit: true } });
    }
    await q(`UPDATE case_convos SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(", ")}, updated_at=now(), updated_by=$${keys.length + 2} WHERE id=$1`, [e.id, ...keys.map(k => o[k]), req.user.id]);
    await audit(req, "convo_edit", { case_id: e.case_id, convo_id: e.id, before: { at: e.at, kind: e.kind, with_name: e.with_name, direction: e.direction, minutes: e.minutes, body: e.body } });   // the old wording is kept in the firm's record
    res.json({ convo: { ...(await q(`${SEL} WHERE v.id=$1`, [e.id])).rows[0], can_edit: true } });
  }));
  app.delete("/api/convos/:id", requireAuth, wrap(async (req, res) => {
    const e = await entryFor(req.user, req.params.id);
    await q("DELETE FROM case_convos WHERE id=$1", [e.id]);
    await audit(req, "convo_delete", { case_id: e.case_id, convo_id: e.id, before: { at: e.at, kind: e.kind, with_name: e.with_name, direction: e.direction, minutes: e.minutes, body: e.body, logged_by: e.user_id, created_at: e.created_at } });
    res.json({ ok: true });
  }));
}
module.exports = { mount, KINDS, _test: { entryFor, caseFor } };
