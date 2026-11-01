// Texas deadline calculator (rule-based, no AI). Every result names its rule; the attorney confirms each date.
// Counting follows TRCP 4: skip the trigger day, count every day, and if the last day is a Saturday, Sunday or
// legal holiday, the period runs to the next day that isn't. Backward-counted "at least N days before" periods
// move EARLIER to the last business day (the safe direction).

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = s => { const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return isNaN(d) ? null : d; };
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const addYears = (d, n) => { const x = new Date(d.getTime()); x.setUTCFullYear(x.getUTCFullYear() + n); if (x.getUTCDate() !== d.getUTCDate()) x.setUTCDate(0); return x; };
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// nth weekday of a month (n = -1 → last)
function nthDow(y, m, dow, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, m, 1)); return new Date(Date.UTC(y, m, 1 + ((dow - first.getUTCDay() + 7) % 7) + 7 * (n - 1))); }
  const last = new Date(Date.UTC(y, m + 1, 0)); return new Date(Date.UTC(y, m, last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7)));
}
// National holidays (Tex. Gov't Code 662.003(a)) — treated as legal holidays.
function nationalHolidays(y) {
  const t = nthDow(y, 10, 4, 4);
  return [
    [`${y}-01-01`, "New Year's Day"], [iso(nthDow(y, 0, 1, 3)), "Martin Luther King Jr. Day"], [iso(nthDow(y, 1, 1, 3)), "Presidents' Day"],
    [iso(nthDow(y, 4, 1, -1)), "Memorial Day"], [`${y}-07-04`, "Independence Day"], [iso(nthDow(y, 8, 1, 1)), "Labor Day"],
    [`${y}-11-11`, "Veterans Day"], [iso(t), "Thanksgiving Day"], [`${y}-12-25`, "Christmas Day"]
  ];
}
// Texas state holidays (662.003(b)) — many clerk offices close on some of these; we FLAG them rather than skip them.
function stateHolidays(y) {
  return [
    [`${y}-01-19`, "Confederate Heroes Day"], [`${y}-03-02`, "Texas Independence Day"], [`${y}-04-21`, "San Jacinto Day"],
    [`${y}-06-19`, "Emancipation Day"], [`${y}-08-27`, "Lyndon Baines Johnson Day"], [iso(addDays(nthDow(y, 10, 4, 4), 1)), "Day after Thanksgiving"],
    [`${y}-12-24`, "Christmas Eve"], [`${y}-12-26`, "December 26"]
  ];
}
function holidayMaps(years, extraClosed = []) {
  const legal = new Map(), state = new Map();
  for (const y of years) { nationalHolidays(y).forEach(([d, n]) => legal.set(d, n)); stateHolidays(y).forEach(([d, n]) => state.set(d, n)); }
  for (const x of extraClosed) if (x && x.date) legal.set(x.date, x.name || "Court closed");
  return { legal, state };
}
function closedReason(d, H) {
  const k = iso(d), w = d.getUTCDay();
  if (w === 0 || w === 6) return DOW[w];
  if (H.legal.has(k)) return H.legal.get(k);
  return null;
}
// TRCP 4 / CPRC 16.072: roll forward past weekends and legal holidays
function rollForward(d, H, moved) { let x = d; let r; while ((r = closedReason(x, H))) { moved.push(`${iso(x)} is ${r}`); x = addDays(x, 1); } return x; }
function rollBack(d, H, moved) { let x = d; let r; while ((r = closedReason(x, H))) { moved.push(`${iso(x)} is ${r}`); x = addDays(x, -1); } return x; }

const RULES = {
  answer_district: { label: "Answer due — district / county court", trigger: "Date served", cite: "TRCP 99(b)", group: "Pleadings",
    calc(t, o, H, mv) { const end = addDays(t, 20); let d = addDays(end, 1); while (d.getUTCDay() !== 1) d = addDays(d, 1); return { date: rollForward(d, H, mv), time: "10:00 AM", how: "10:00 a.m. on the Monday next after 20 days from service" }; } },
  answer_justice: { label: "Answer due — justice court", trigger: "Date served", cite: "TRCP 502.5(a)", group: "Pleadings",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 14), H, mv), how: "14 days after service" }; } },
  initial_disclosures: { label: "Initial disclosures due", trigger: "Date first answer was filed", cite: "TRCP 194.2(a)", group: "Discovery",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 30), H, mv), how: "30 days after the first answer (unless exempt or the court orders otherwise)" }; } },
  discovery_response: { label: "Discovery responses due", trigger: "Date the requests were served", cite: "TRCP 196.2, 197.2, 198.2; 21a(c)", group: "Discovery", mail: true,
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 30 + (o.mail ? 3 : 0)), H, mv), how: `30 days after service${o.mail ? " + 3 days for service by mail" : ""}` }; } },
  hearing_notice: { label: "Last day to serve notice of hearing", trigger: "Hearing date", cite: "TRCP 21(b)", group: "Motions",
    calc(t, o, H, mv) { return { date: rollBack(addDays(t, -3), H, mv), how: "at least 3 days before the hearing (counted back; moved earlier if closed)" }; } },
  msj_serve: { label: "Serve motion for summary judgment", trigger: "Hearing date", cite: "TRCP 166a(c)", group: "Motions",
    calc(t, o, H, mv) { return { date: rollBack(addDays(t, -21), H, mv), how: "at least 21 days before the hearing (counted back; moved earlier if closed)" }; } },
  msj_response: { label: "Summary judgment response due", trigger: "Hearing date", cite: "TRCP 166a(c)", group: "Motions",
    calc(t, o, H, mv) { return { date: rollBack(addDays(t, -7), H, mv), how: "no later than 7 days before the hearing, unless the court allows otherwise" }; } },
  findings_request: { label: "Request findings of fact", trigger: "Date judgment was signed", cite: "TRCP 296", group: "Post-judgment",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 20), H, mv), how: "20 days after the judgment is signed" }; } },
  new_trial: { label: "Motion for new trial due", trigger: "Date judgment was signed", cite: "TRCP 329b(a)", group: "Post-judgment",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 30), H, mv), how: "30 days after the judgment is signed" }; } },
  notice_appeal: { label: "Notice of appeal due", trigger: "Date judgment was signed", cite: "TRAP 26.1", group: "Appeal", extended: true,
    calc(t, o, H, mv) { const n = o.extended ? 90 : 30; return { date: rollForward(addDays(t, n), H, mv), how: o.extended ? "90 days after judgment — a timely motion for new trial, to modify, to reinstate, or request for findings was filed" : "30 days after the judgment is signed" }; } },
  notice_appeal_accel: { label: "Notice of appeal due — accelerated appeal", trigger: "Date judgment or order was signed", cite: "TRAP 26.1(b), 28.1", group: "Appeal",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 20), H, mv), how: "20 days after the judgment or order is signed" }; } },
  coa_rehearing: { label: "Motion for rehearing — court of appeals", trigger: "Date of court of appeals judgment", cite: "TRAP 49.1", group: "Appeal",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 15), H, mv), how: "15 days after the court of appeals' judgment" }; } },
  petition_review: { label: "Petition for review — Supreme Court of Texas", trigger: "Date of court of appeals judgment (or last ruling on a timely rehearing motion)", cite: "TRAP 53.7(a)", group: "Appeal",
    calc(t, o, H, mv) { return { date: rollForward(addDays(t, 45), H, mv), how: "45 days after the court of appeals' judgment or the last timely rehearing ruling" }; } },
  limitations_pi: { label: "Limitations — personal injury", trigger: "Date of injury", cite: "CPRC 16.003; 16.072", group: "Limitations",
    calc(t, o, H, mv) { return { date: rollForward(addYears(t, 2), H, mv), how: "2 years from the date of injury (discovery rule and tolling not applied)" }; } },
  limitations_contract: { label: "Limitations — contract / debt", trigger: "Date of breach", cite: "CPRC 16.004, 16.051; 16.072", group: "Limitations",
    calc(t, o, H, mv) { return { date: rollForward(addYears(t, 4), H, mv), how: "4 years from the breach (tolling not applied)" }; } }
};

function compute(ruleKey, triggerDate, opts = {}) {
  const r = RULES[ruleKey]; if (!r) throw new Error("Unknown rule");
  const t = parse(triggerDate); if (!t) throw new Error("Enter the date as YYYY-MM-DD");
  const y = t.getUTCFullYear();
  const H = holidayMaps([y - 1, y, y + 1, y + 2, y + 3, y + 4, y + 5], opts.closed || []);
  const moved = [];
  const out = r.calc(t, opts, H, moved);
  const k = iso(out.date);
  const flags = [];
  if (H.state.has(k)) flags.push(`${k} is ${H.state.get(k)} (a Texas state holiday) — check whether the clerk's office is open that day.`);
  return { rule: ruleKey, label: r.label, cite: r.cite, trigger: iso(t), date: k, day: DOW[out.date.getUTCDay()], time: out.time || null, how: out.how,
    moved: moved.length ? `Moved past ${moved.join("; ")}` : null, flags };
}
const list = () => Object.entries(RULES).map(([k, r]) => ({ key: k, label: r.label, trigger: r.trigger, cite: r.cite, group: r.group, mail: !!r.mail, extended: !!r.extended }));

module.exports = { compute, list, nationalHolidays, stateHolidays, iso, parse };
