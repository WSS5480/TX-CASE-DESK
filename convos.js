// Conversations: a dated log on each case — calls, meetings, voicemails, emails, texts, court — who it was with and
// what was said (Word-style notes, dictation works). Anyone who can see the case can read and add. The person who
// logged an entry, or an attorney, can edit it; every edit keeps the wording it replaced (case_convo_versions) and the
// entry shows "Edited by … · See earlier versions" to everyone on the case. Only a firm admin can delete an entry, and a
// delete only hides it: admins still see it (greyed, "Deleted by …") and can restore it. The log can't be used to cover
// a mistake (Steve, Nov 20, 2026). Every change is audited.
const { q, pool } = require("./db");
const access = require("./access");
const rt = require("./richtext");

const KINDS = ["call", "meeting", "voicemail", "email", "text", "court", "note"];
const fail = (status, error) => Object.assign(new Error(error), { status });
const LAWYER = u => u.role !== "paralegal";
const ADMIN = u => u.role === "admin";
const MSG = { del: "Only a firm admin can delete a logged conversation.", restore: "Only a firm admin can restore a logged conversation.", deleted: "This entry was deleted. Restore it first to edit it.", link: "This entry was added through a co-counsel link. It can't be edited." };
const ID = v => /^\d{1,9}$/.test(String(v)) ? +v : 0;   // anything else (or past the id range) is simply not found

async function caseFor(user, id) {
  const pr = [ID(id), user.firm_id]; const cond = access.caseCond(user, "c", pr);
  const c = (await q(`SELECT c.id, c.firm_id FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0];
  if (!c) throw fail(404, "Case not found.");
  return c;
}
// the entry, if this person may see it (deleted entries: firm admins only); edit = they may also change it
async function entryFor(user, id, { edit = true } = {}) {
  const e = (await q("SELECT * FROM case_convos WHERE id=$1 AND firm_id=$2", [ID(id), user.firm_id])).rows[0];
  if (!e || (e.deleted_at && !ADMIN(user))) throw fail(404, "Not found.");
  await caseFor(user, e.case_id);
  if (edit) {
    if (e.link_id) throw fail(403, MSG.link);
    if (e.user_id !== user.id && !LAWYER(user)) throw fail(403, "Only the person who logged this, or an attorney, can change it.");
    if (e.deleted_at) throw fail(400, MSG.deleted);
  }
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
const same = (k, a, b) => k === "at" ? new Date(a).getTime() === new Date(b).getTime() : (a == null ? null : String(a)) === (b == null ? null : String(b));
const SEL = `SELECT v.*, u.name AS logged_by, ub.name AS edited_by, ud.name AS deleted_by_name, te.minutes AS billed_minutes, te.invoice_id AS billed_invoice, tk.due_date AS follow_due, tk.done AS follow_done, tk.title AS follow_title,
  (SELECT count(*)::int FROM case_convo_versions x WHERE x.convo_id=v.id) AS versions, lk.name AS link_name, lk.role_label AS link_role
  FROM case_convos v LEFT JOIN case_links lk ON lk.id=v.link_id LEFT JOIN users u ON u.id=v.user_id LEFT JOIN users ub ON ub.id=v.updated_by LEFT JOIN users ud ON ud.id=v.deleted_by LEFT JOIN time_entries te ON te.id=v.time_id LEFT JOIN tasks tk ON tk.id=v.task_id`;
// an entry added through a co-counsel link (links.js) is that person's own record: nobody edits it (a firm admin can still delete / restore)
const shape = (r, user) => ({ ...r, via_link: !!r.link_id, deleted: !!r.deleted_at, can_edit: !r.deleted_at && !r.link_id && (r.user_id === user.id || LAWYER(user)), can_delete: !r.deleted_at && ADMIN(user), can_restore: !!r.deleted_at && ADMIN(user) });
const one = async (id, user) => shape((await q(`${SEL} WHERE v.id=$1`, [id])).rows[0], user);

function mount(app, { requireAuth, wrap, audit }) {
  app.get("/api/cases/:id/convos", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id);
    const rows = (await q(`${SEL} WHERE v.case_id=$1 AND v.firm_id=$2 ${ADMIN(req.user) ? "" : "AND v.deleted_at IS NULL"} ORDER BY v.at DESC, v.id DESC LIMIT 500`, [c.id, req.user.firm_id])).rows;
    res.json({ convos: rows.map(r => shape(r, req.user)), kinds: KINDS, admin: ADMIN(req.user) });
  }));
  app.post("/api/cases/:id/convos", requireAuth, wrap(async (req, res) => {
    const c = await caseFor(req.user, req.params.id);
    const o = await clean(req.user, c.id, req.body || {});
    const r = (await q(`INSERT INTO case_convos (firm_id, case_id, at, kind, contact_id, with_name, body, user_id, direction, minutes, time_id, task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.firm_id, c.id, o.at, o.kind, o.contact_id || null, o.with_name || null, o.body, req.user.id, o.direction || null, o.minutes ?? null, o.time_id || null, o.task_id || null])).rows[0];
    await audit(req, "convo_add", { case_id: c.id, convo_id: r.id, kind: o.kind });
    res.json({ convo: await one(r.id, req.user) });
  }));
  // earlier versions of an entry, newest first: anyone who can see the case (and the entry)
  app.get("/api/convos/:id/versions", requireAuth, wrap(async (req, res) => {
    const e = await entryFor(req.user, req.params.id, { edit: false });
    const rows = (await q(`SELECT x.id, x.at, x.kind, x.with_name, x.direction, x.minutes, x.body, x.written_at, x.saved_at, ul.name AS logged_by, uw.name AS written_by, ue.name AS edited_by
      FROM case_convo_versions x LEFT JOIN users ul ON ul.id=x.logged_by LEFT JOIN users uw ON uw.id=x.written_by LEFT JOIN users ue ON ue.id=x.edited_by
      WHERE x.convo_id=$1 AND x.firm_id=$2 ORDER BY x.id DESC LIMIT 200`, [e.id, req.user.firm_id])).rows;
    res.json({ versions: rows });
  }));
  app.patch("/api/convos/:id", requireAuth, wrap(async (req, res) => {
    const e = await entryFor(req.user, req.params.id);
    const o = await clean(req.user, e.case_id, req.body || {}, e);
    const keys = Object.keys(o); if (!keys.length) return res.json({ ok: true });
    // The entry is read again, locked, inside the transaction: the no-change test, the saved version and the audit's "before"
    // all use what's really there now. Linking the time entry / follow-up made with it isn't an edit; nor is saving unchanged text.
    const cl = await pool.connect(); let rbErr, cur, edit, link;
    try {
      await cl.query("BEGIN");
      cur = (await cl.query("SELECT * FROM case_convos WHERE id=$1 FOR UPDATE", [e.id])).rows[0];
      if (!cur || cur.deleted_at) throw fail(400, MSG.deleted);
      edit = keys.filter(k => k !== "time_id" && k !== "task_id" && !same(k, o[k], cur[k]));
      link = keys.filter(k => (k === "time_id" || k === "task_id") && !same(k, o[k], cur[k]));
      const sets = [...edit, ...link];
      if (sets.length) {
        if (edit.length) await cl.query(`INSERT INTO case_convo_versions (convo_id, firm_id, at, kind, with_name, contact_id, direction, minutes, body, logged_by, written_by, written_at, edited_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [cur.id, cur.firm_id, cur.at, cur.kind, cur.with_name, cur.contact_id, cur.direction, cur.minutes, cur.body, cur.user_id, cur.updated_by || cur.user_id, cur.updated_at || cur.created_at, req.user.id]);
        await cl.query(`UPDATE case_convos SET ${sets.map((k, i) => `${k}=$${i + 2}`).join(", ")}${edit.length ? `, updated_at=now(), updated_by=$${sets.length + 2}` : ""} WHERE id=$1`,
          [e.id, ...sets.map(k => o[k]), ...(edit.length ? [req.user.id] : [])]);
      }
      await cl.query("COMMIT");
    } catch (x) { await cl.query("ROLLBACK").catch(y => { rbErr = y; }); throw x; } finally { cl.release(rbErr); }
    if (link.length) await audit(req, "convo_link", { case_id: e.case_id, convo_id: e.id, ...Object.fromEntries(link.map(k => [k, o[k]])) });
    if (edit.length) await audit(req, "convo_edit", { case_id: e.case_id, convo_id: e.id, before: { at: cur.at, kind: cur.kind, with_name: cur.with_name, direction: cur.direction, minutes: cur.minutes, body: cur.body } });   // the old wording is kept in the firm's record
    res.json({ convo: await one(e.id, req.user) });
  }));
  // delete = hide: firm admins only; the entry stays in the record (admins see it greyed and can restore it)
  app.delete("/api/convos/:id", requireAuth, wrap(async (req, res) => {
    if (!ADMIN(req.user)) throw fail(403, MSG.del);
    const e = await entryFor(req.user, req.params.id, { edit: false });
    if (e.deleted_at) return res.json({ ok: true, convo: await one(e.id, req.user) });
    await q("UPDATE case_convos SET deleted_at=now(), deleted_by=$2 WHERE id=$1 AND deleted_at IS NULL", [e.id, req.user.id]);
    await audit(req, "convo_delete", { case_id: e.case_id, convo_id: e.id, before: { at: e.at, kind: e.kind, with_name: e.with_name, direction: e.direction, minutes: e.minutes, body: e.body, logged_by: e.user_id, created_at: e.created_at } });
    res.json({ ok: true, convo: await one(e.id, req.user) });
  }));
  app.post("/api/convos/:id/restore", requireAuth, wrap(async (req, res) => {
    if (!ADMIN(req.user)) throw fail(403, MSG.restore);
    const e = await entryFor(req.user, req.params.id, { edit: false });
    if (e.deleted_at) {
      await q("UPDATE case_convos SET deleted_at=NULL, deleted_by=NULL WHERE id=$1", [e.id]);
      await audit(req, "convo_restore", { case_id: e.case_id, convo_id: e.id, deleted_at: e.deleted_at, deleted_by: e.deleted_by, before: { at: e.at, kind: e.kind, with_name: e.with_name } });
    }
    res.json({ ok: true, convo: await one(e.id, req.user) });
  }));
}
module.exports = { mount, KINDS, MSG, _test: { entryFor, caseFor } };
