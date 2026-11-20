// Close-out checks (Steve, Nov 20, 2026): only a firm admin closes a case. Before closing, the app lists what's still open
// on it: money in trust (for the case, or still held for one of its clients), unpaid invoices, unbilled time or expenses (not
// logged hours on a contingency case; $0 entries never count), open dates (deadlines not marked done, anything still ahead on
// the calendar, a court setting still ahead) and open to-dos. Amounts only for trust access / non-paralegals. The admin can still close over open items, but only
// with a typed reason; that's recorded (closed_why, audit "case_close_override", Activity log).
const { q } = require("./db");
const access = require("./access");
const { parseSetting } = require("./practice");

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });   // Texas (Central) date
const d10 = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10);
const mdy = s => /^\d{4}-\d\d-\d\d$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : s;
const usd = n => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const few = (arr, n = 3, sep = "; ") => arr.slice(0, n).join(sep) + (arr.length > n ? `${sep}and ${arr.length - n} more` : "");
const MIN_REASON = 10;

// items: [{ key, label, detail, count?, amount?, info?, clear, fix }] — label is the status ("Dates: 2 open"); fix = the case
// section where it's put right. db: the caller's own connection (closing runs inside its transaction); queries run one at a time.
async function check(user, c, db) {
  const run = db ? (t, p) => db.query(t, p) : q;
  const F = c.firm_id, id = c.id, t = today();
  const seeTrust = access.trustOk(user), seeMoney = user.role !== "paralegal";   // paralegals never get billing data
  // trust: money held for this case, and each client on the case who still has money in trust overall
  const bal = Number((await run("SELECT coalesce(sum(amount),0)::numeric AS bal FROM trust_tx WHERE case_id=$1 AND firm_id=$2", [id, F])).rows[0].bal);
  const clients = (await run(`SELECT ct.name, coalesce((SELECT sum(t.amount) FROM trust_tx t WHERE t.contact_id=ct.id AND t.firm_id=$2),0)::numeric AS bal
    FROM case_contacts cc JOIN contacts ct ON ct.id=cc.contact_id WHERE cc.case_id=$1 AND cc.role='client' ORDER BY ct.name`, [id, F])).rows.filter(x => Number(x.bal) > 0.005);
  const inv = (await run("SELECT number, coalesce(total,0) - coalesce(paid,0) AS owed FROM invoices WHERE case_id=$1 AND firm_id=$2 AND coalesce(status,'') <> 'void' AND coalesce(paid,0) < coalesce(total,0) ORDER BY id", [id, F])).rows;
  // unbilled: billable, not invoiced, worth more than $0; on a contingency case logged hours aren't billed, so only expenses count
  const unb = (await run(`SELECT (amount IS NULL) AS hourly, minutes, coalesce(amount, minutes/60.0*rate) AS v FROM time_entries
    WHERE case_id=$1 AND firm_id=$2 AND billable AND invoice_id IS NULL AND coalesce(amount, minutes/60.0*rate) > 0`, [id, F])).rows;
  // open dates: a deadline not marked done (past or future: a past, unconfirmed deadline is open), or anything still ahead
  const ev = (await run("SELECT kind, title, on_date::text AS d FROM events WHERE case_id=$1 AND firm_id=$2 AND NOT coalesce(done,false) AND (kind='deadline' OR on_date >= $3::date) ORDER BY on_date", [id, F, t])).rows;
  const tk = (await run("SELECT title, due_date::text AS d FROM tasks WHERE case_id=$1 AND firm_id=$2 AND NOT coalesce(done,false) ORDER BY due_date NULLS LAST, id", [id, F])).rows;

  const contingency = c.billing === "contingency";
  const unbOpen = contingency ? unb.filter(x => !x.hourly) : unb, contHours = contingency ? unb.filter(x => x.hourly).reduce((s, x) => s + Number(x.minutes || 0), 0) / 60 : 0;
  const owed = inv.reduce((s, x) => s + Number(x.owed), 0), unbV = unbOpen.reduce((s, x) => s + Number(x.v), 0);
  const trustOpen = bal > 0.005 || clients.length > 0, held = Math.max(bal, clients.reduce((s, x) => s + Number(x.bal), 0));
  const dates = ev.map(e => `${e.kind === "deadline" ? "Deadline" : e.kind === "hearing" ? "Hearing" : e.kind === "meeting" ? "Meeting" : "Date"}: ${e.title} (${mdy(e.d)}${e.kind === "deadline" && e.d < t ? ", past and not marked done" : ""})`);
  const s = parseSetting(c.next_setting); if (s && s.date >= t) dates.push(`Court setting: ${s.title} (${mdy(s.date)})`);
  const n2 = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const items = [
    { key: "trust", clear: !trustOpen, fix: "trust",
      label: !trustOpen ? "Trust: $0" : seeTrust ? `Trust: ${usd(held)} held` : "Trust: money still held",
      detail: !trustOpen ? "Nothing held in trust for this case or its clients." : [
        bal > 0.005 ? (seeTrust ? `${usd(bal)} held for this case.` : "Money is held in trust for this case.") : "",
        ...clients.map(x => `Client ${x.name} still has ${seeTrust ? usd(x.bal) : "money"} in trust.`),
        seeTrust ? "Refund or disburse it first." : "Ask someone with trust access."].filter(Boolean).join(" "),
      ...(seeTrust ? { amount: Math.round(held * 100) / 100 } : {}) },
    seeMoney ? { key: "invoices", clear: !inv.length, fix: "billing", count: inv.length, amount: Math.round(owed * 100) / 100,
      label: !inv.length ? "Invoices: all paid" : `Invoices: ${inv.length} unpaid (${usd(owed)})`,
      detail: !inv.length ? "No unpaid invoices." : `Not fully paid: ${few(inv.map(x => "#" + x.number), 3, ", ")}.` }
      : { key: "invoices", clear: !inv.length, fix: "billing", label: !inv.length ? "Invoices: all paid" : "Invoices: not all paid", detail: !inv.length ? "" : "Ask an attorney." },
    seeMoney ? { key: "unbilled", clear: !unbOpen.length, fix: "billing", count: unbOpen.length, amount: Math.round(unbV * 100) / 100,
      label: !unbOpen.length ? "Unbilled time: none" : `Unbilled time: ${n2(unbOpen.length, "entry", "entries")}`,
      detail: !unbOpen.length ? "Everything billable has been invoiced." : `${usd(unbV)} not invoiced${contingency ? " (expenses)" : ""}. Invoice it, or mark it not billable.`,
      ...(contHours > 0 ? { info: `${Math.round(contHours * 10) / 10} contingency hours logged (not billed on a contingency case).` } : {}) }
      : { key: "unbilled", clear: !unbOpen.length, fix: "billing", label: !unbOpen.length ? "Unbilled time: none" : "Unbilled time: some not invoiced", detail: !unbOpen.length ? "" : "Ask an attorney." },
    { key: "dates", clear: !dates.length, fix: "dates", count: dates.length,
      label: !dates.length ? "Dates: none open" : `Dates: ${dates.length} open`,
      detail: !dates.length ? "No deadline left open and nothing ahead on the calendar." : few(dates) + ". Mark deadlines done or remove dates that no longer apply." },
    { key: "tasks", clear: !tk.length, fix: "tasks", count: tk.length,
      label: !tk.length ? "To-dos: none open" : `To-dos: ${tk.length} open`,
      detail: !tk.length ? "Every to-do is done." : few(tk.map(x => x.title + (x.d ? ` (due ${mdy(x.d)})` : ""))) + "." },
  ];
  return { ok: items.every(i => i.clear), items };
}

function mount(app, { requireAuth, wrap }) {
  app.get("/api/cases/:id/closeout", requireAuth, wrap(async (req, res) => {
    const pr = [+req.params.id || 0, req.user.firm_id]; const cond = access.caseCond(req.user, "c", pr);
    const c = (await q(`SELECT c.* FROM cases c WHERE c.id=$1 AND c.firm_id=$2 AND ${cond}`, pr)).rows[0];
    if (!c) return res.status(404).json({ error: "Case not found" });
    res.json({ ...(await check(req.user, c)), can_close: req.user.role === "admin", closed: c.stage === "Closed", ready: c.close_ready_at ? { at: c.close_ready_at, why: c.close_ready_why } : null, min_reason: MIN_REASON });
  }));
}
module.exports = { mount, check, MIN_REASON };
