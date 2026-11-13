// Demo firm: "Try the demo" on the sign-in page gives each visitor their own copy of a sample personal-injury firm.
// Everything works on screen; nothing leaves the app (no email, no court portals, no AI calls, no logins for staff).
// Each copy is deleted after HOURS hours (Decision Log 2026-11-13-demo-firm: reset after 24 hours). Demo firms never touch My Apps subscriptions.
// AI stays off in the demo until the assistant ships with Steve's key and per-visitor / monthly caps (assistant plan, Phase 2).
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { q, pool } = require("./db");

const HOURS = 24, MAX_ACTIVE = 300;
const MSG = {
  send: "Demo firm: nothing is sent. In your own firm this goes out from your own email address.",
  connect: "Demo firm: email can't be connected. In your own firm you connect Outlook, Gmail or your email provider here.",
  ai: "Demo firm: AI drafting is off. In your own firm, AI writes the first draft and an attorney approves every item.",
  court: "Demo firm: court portals, case-law research and case-law watching are off.",
  share: "Demo firm: client portal links and calendar subscriptions are off (nothing in a demo is published).",
  files: "Demo firm: imports, logos and bar cards are off. Documents up to 1 MB, 10 per demo.",
  staff: "Demo firm: staff logins can't be added. In your own firm, add attorneys and staff here.",
  account: "Demo firm: there's no password or subscription to change.",
};
// [method (or * for any), path regex, message]
// Paths are normalized first (decoded, lowercased, no doubled or trailing slashes); ids match any segment ("5", "5.0", "0x5").
const BLOCK = [
  ["*", /^\/api\/mail\//, "connect"], ["*", /^\/api\/firm\/(mail|court-inbox|ms-keys|setup-help|stripe)(\/|$)/, "connect"],
  ["W", /^\/api\/mailx(\/|$)/, "send"], ["*", /^\/api\/discovery\/[^/]+\/send$/, "send"],
  ["*", /^\/api\/discovery\/[^/]+\/draft$/, "ai"], ["*", /^\/api\/dictation(\/|$)/, "ai"],
  ["*", /^\/api\/law(\/|$)/, "court"], ["*", /^\/api\/admin(\/|$)/, "court"], ["*", /^\/api\/cases\/[^/]+\/(analyze|law-ack)$/, "court"], ["*", /^\/api\/court-logins(\/|$)/, "court"], ["*", /^\/api\/cases\/watch-all$/, "court"],
  ["*", /^\/api\/contacts\/[^/]+\/portal$/, "share"], ["*", /^\/api\/calendar\/feed$/, "share"],
  ["*", /^\/api\/(import\/|cases\/import$|firm\/logo$|firm\/users\/[^/]+\/bar-card$|users\/[^/]+\/bar-card$|me\/bar-card$)/, "files"],
  ["W", /^\/api\/firm\/users$/, "staff"], ["*", /^\/api\/(password|subscription|2fa|totp)(\/|$)/, "account"],
];
const norm = req => { let p = req.originalUrl; try { p = new URL(p, "http://x").pathname; } catch (e) {} try { p = decodeURIComponent(p); } catch (e) {}
  return p.toLowerCase().replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1"); };
// returns a response if a demo user tries something that would leave the app
// writes per demo firm: 300 an hour, 200 KB each (the free database is shared with real firms)
const writes = new Map();
function guard(req, res) {
  const rawPath = String(req.originalUrl || "").split("?")[0];
  if (/(^|\/)(\.|%2e){1,2}(\/|$)|%2f|%5c|\\/i.test(rawPath)) return res.status(400).json({ error: "Bad address.", code: "DEMO" });   // dot segments, encoded slashes
  const path = norm(req), m = req.method === "HEAD" ? "GET" : req.method, w = m !== "GET";
  if (w) {
    if (+(req.get("content-length") || 0) > 200 * 1024 && !/^\/api\/cases\/[^/]+\/documents$/.test(path)) return res.status(413).json({ error: "Demo firm: that's too large for the demo.", code: "DEMO" });
    const k = req.user.firm_id, now = Date.now(), e = writes.get(k) || { n: 0, at: now };
    if (now - e.at > 3600e3) { e.n = 0; e.at = now; }
    if (++e.n > 300) return res.status(429).json({ error: "Demo firm: that's a lot of changes for one hour. Sign up to keep going.", code: "DEMO" });
    writes.set(k, e); if (writes.size > 5000) writes.clear();
  }
  for (const [meth, re, k] of BLOCK) {
    if (!re.test(path) || !(meth === "*" || meth === m || (meth === "W" && w))) continue;
    if (m === "GET" && /text\/html/.test(req.get("accept") || "")) return res.redirect(303, "/?demo=" + k);
    return res.status(k === "ai" && /^\/api\/dictation/.test(path) ? 503 : 403).json({ error: MSG[k], code: "DEMO" });
  }
  // the court-date and case-law watchers would reach outside sites: keep them off on demo cases
  if (w && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    if (/^\/api\/cases(\/[^/]+)?$/.test(path)) { delete req.body.watch_dates; delete req.body.law_watch; delete req.body.tracked; }
    if (/^\/api\/cases\/[^/]+\/discovery$/.test(path)) req.body.draft = false;   // no AI drafting
    if (/^\/api\/firm\/users\/[^/]+$/.test(path)) { delete req.body.reset; delete req.body.email; }   // no passwords, no real addresses
  }
  return null;
}

// documents in a demo: 1 MB each, 10 per firm (the free database is shared with real firms)
async function uploadOk(req, res) {
  if (!req.user || !req.user.demo_until) return true;
  const n = (await q("SELECT count(*)::int n FROM documents WHERE firm_id=$1", [req.user.firm_id])).rows[0].n;
  if ((req.body && req.body.length > 1024 * 1024) || n >= 10) { res.status(403).json({ error: MSG.files, code: "DEMO" }); return false; }
  return true;
}
// after the insert: two uploads at once can't get past 10 (the newest extra is removed)
async function uploadAfter(req, res, docId) {
  if (!req.user || !req.user.demo_until) return true;
  const ids = (await q("SELECT id FROM documents WHERE firm_id=$1 ORDER BY id", [req.user.firm_id])).rows.map(r => r.id);
  if (ids.indexOf(docId) < 10) return true;
  await q("DELETE FROM documents WHERE id=$1", [docId]); res.status(403).json({ error: MSG.files, code: "DEMO" }); return false;
}

// ---------- the sample firm ----------
const iso = d => d.toISOString().slice(0, 10);
const day = n => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d; };
const workday = n => { const d = day(n); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d; };
const mdy = d => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const ago = (days, h = 10) => { const d = day(-days); d.setUTCHours(h + 6, 15, 0, 0); return d.toISOString(); };

async function seed(c, termsVersion) {
  const tag = crypto.randomBytes(5).toString("hex");
  const f = (await c.query(`INSERT INTO firms(name, kind, plan, plan_source, demo_until, phone, address, firm_email)
    VALUES('Little Joe Demo Attorney at Law', 'firm', 'pro', 'demo', now() + interval '${HOURS} hours', '(956) 555-0100', '1200 N 10th St, McAllen, TX 78501', 'office@example.com') RETURNING id`)).rows[0].id;
  const nopw = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 8);   // no one can sign in to these with a password
  const U = async (name, role, bar, extra = {}) => (await c.query(`INSERT INTO users(firm_id, email, name, bar_number, role, pw_hash, terms_version, terms_at, counties, rate, access, title, trust_access)
    VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8,$9,$10,$11,$12) RETURNING id`, [f, `demo-${tag}-${role}-${Math.random().toString(36).slice(2, 7)}@demo.invalid`, name, bar, role, nopw, termsVersion,
    ["Hidalgo", "Cameron"], extra.rate || null, extra.access || (role === "admin" ? "firm" : "own"), extra.title || null, !!extra.trust])).rows[0].id;
  const me = await U("Little Joe", "admin", "24000000", { rate: 300, title: "Managing Attorney", trust: true });
  const maria = await U("Maria Treviño", "attorney", "24000001", { rate: 275, title: "Associate Attorney" });
  const jordan = await U("Jordan Lee", "paralegal", null, { access: "firm", title: "Paralegal" });

  const K = async (kind, name, o = {}) => (await c.query("INSERT INTO contacts(firm_id, kind, name, company, email, phone, address, notes, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
    [f, kind, name, o.company || null, o.email || null, o.phone || null, o.address || null, o.notes || null, me])).rows[0].id;
  const ct = {
    garza: await K("client", "Elena Garza", { phone: "(956) 555-0141", email: "elena.garza@example.com", address: "409 Ash Ave, Edinburg, TX" }),
    morales: await K("client", "Ricardo Morales", { phone: "(956) 555-0172", email: "rmorales@example.com", address: "88 Palm Blvd, Brownsville, TX" }),
    hernandez: await K("client", "Ana Hernández", { phone: "(956) 555-0198", email: "ana.h@example.com" }),
    castillo: await K("client", "Luis Castillo", { phone: "(956) 555-0110" }),
    pena: await K("client", "Sofia Peña", { phone: "(956) 555-0133", email: "sofia.pena@example.com" }),
    ortiz: await K("client", "Daniel Ortiz", { phone: "(956) 555-0187" }),
    rvt: await K("opposing", "Rio Valley Transport, LLC", { address: "5500 Expressway 83, Pharr, TX" }),
    santos: await K("opposing", "Martin Santos"),
    hebmart: await K("opposing", "ValleyMart Stores, Inc."),
    defcounsel: await K("opposing", "Robert Klein", { company: "Klein & Watts, PLLC", email: "rklein@example.com", phone: "(956) 555-0300" }),
    defcounsel2: await K("opposing", "Patricia Gómez", { company: "Gómez Defense Group", email: "pgomez@example.com", phone: "(956) 555-0311" }),
    adjuster: await K("other", "Karen Whitfield", { company: "Lone Star Mutual Insurance (adjuster)", email: "kwhitfield@example.com", phone: "(800) 555-0144" }),
    adjuster2: await K("other", "Tom Brandt", { company: "Gulf Coast Casualty (adjuster)", email: "tbrandt@example.com", phone: "(800) 555-0177" }),
    dhr: await K("other", "Valley Orthopedic Clinic", { company: "Medical provider", phone: "(956) 555-0400", email: "records@example.com" }),
    pt: await K("other", "McAllen Physical Therapy", { company: "Medical provider", phone: "(956) 555-0420" }),
    witness: await K("witness", "James Whitaker", { phone: "(956) 555-0155", notes: "Saw the collision from the gas station on 10th St." }),
  };

  const C = async (o) => (await c.query(`INSERT INTO cases(firm_id, user_id, county, cause_no, court, style, case_type, filed_date, status, next_setting, notes, stage, source, created_at, updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13,$13) RETURNING id`,
    [f, o.atty || me, o.county, o.cause, o.court || null, o.style, o.type || "Civil – Personal Injury", o.filed || null, o.status || "Open", o.next || null, o.notes || null, o.stage, o.created || ago(60)])).rows[0].id;
  const h1 = workday(9), h2 = workday(16), med = workday(23);
  const cs = {
    garza: await C({ county: "Hidalgo", cause: "C-4512-26-F", court: "332nd District Court", style: "Elena Garza v. Rio Valley Transport, LLC", filed: iso(day(-180)), stage: "Discovery",
      next: `${mdy(h1)} 9:00 AM – Status conference`, created: ago(190), notes: "<p>Rear-end collision with an 18-wheeler on Expressway 83. Client treated at Valley Orthopedic (lumbar strain, two injections). Liability strong: dash-cam footage requested.</p><ul><li>Policy limits: $1,000,000</li><li>Medicals to date: $48,250</li></ul>" }),
    morales: await C({ county: "Cameron", cause: "2026-DCL-02211", court: "107th District Court", style: "Ricardo Morales v. Martin Santos", filed: iso(day(-95)), stage: "Mediation",
      next: `${mdy(med)} 10:00 AM – Mediation`, created: ago(120), notes: "<p>Intersection collision; defendant ran a red light (witness James Whitaker). Mediation set with Hon. (ret.) R. Salinas.</p>" }),
    hernandez: await C({ county: "Hidalgo", cause: "PRE-2611-A1D4E2", style: "Ana Hernández – slip and fall (pre-suit)", stage: "Demand / negotiation", created: ago(45),
      notes: "<p>Fall on wet floor at ValleyMart, no warning sign. Demand sent; adjuster Tom Brandt reviewing. Limitations runs in about 20 months.</p>" }),
    castillo: await C({ county: "Hidalgo", cause: "PRE-2611-B7C9F0", style: "Luis Castillo – auto accident (pre-suit)", stage: "Intake", created: ago(6), atty: maria,
      notes: "<p>New intake: T-bone collision on Nolana Ave. Still treating. Need police report and health insurance card.</p>" }),
    pena: await C({ county: "Hidalgo", cause: "C-2207-25-I", court: "398th District Court", style: "Sofia Peña v. ValleyMart Stores, Inc.", filed: iso(day(-400)), stage: "Trial preparation",
      next: `${mdy(h2)} 1:30 PM – Pretrial conference`, created: ago(420), atty: maria, notes: "<p>Premises liability. Trial setting in 6 weeks; expert designations served.</p>" }),
    ortiz: await C({ county: "Cameron", cause: "2025-DCL-07788", court: "357th District Court", style: "Daniel Ortiz v. Coastal Freight Co.", filed: iso(day(-300)), stage: "Discovery",
      status: "Answer filed", created: ago(310), notes: "<p>Delivery truck backed into client's parked car while he was loading it. Disputed liability.</p>" }),
    estate: await C({ county: "Hidalgo", cause: "P-1102-26", court: "Probate Court No. 1", style: "In re Estate of Rosa Villarreal", type: "Probate", filed: iso(day(-30)), stage: "Filed – pleadings", created: ago(32), atty: maria,
      notes: "<p>Application to probate will as muniment of title.</p>" }),
    closed: await C({ county: "Hidalgo", cause: "C-0915-24-E", court: "275th District Court", style: "Mark Delgado v. Harlingen Rentals, LLC", filed: iso(day(-700)), stage: "Settled", status: "Open", created: ago(720),
      notes: "<p>Settled at mediation; release signed, funds disbursed.</p>" }),
  };
  await c.query("UPDATE cases SET stage='Closed', status='Dismissed', closed_at=now() - interval '20 days', closed_why='Settled and dismissed', stage_before_close='Settled' WHERE id=$1", [cs.closed]);

  const link = async (cid, kid, role) => c.query("INSERT INTO case_contacts(case_id, contact_id, role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [cid, kid, role]);
  await link(cs.garza, ct.garza, "client"); await link(cs.garza, ct.rvt, "opposing party"); await link(cs.garza, ct.defcounsel, "opposing counsel"); await link(cs.garza, ct.adjuster, "other"); await link(cs.garza, ct.dhr, "other"); await link(cs.garza, ct.pt, "other");
  await link(cs.morales, ct.morales, "client"); await link(cs.morales, ct.santos, "opposing party"); await link(cs.morales, ct.defcounsel2, "opposing counsel"); await link(cs.morales, ct.witness, "witness"); await link(cs.morales, ct.adjuster, "other");
  await link(cs.hernandez, ct.hernandez, "client"); await link(cs.hernandez, ct.hebmart, "opposing party"); await link(cs.hernandez, ct.adjuster2, "other");
  await link(cs.castillo, ct.castillo, "client"); await link(cs.pena, ct.pena, "client"); await link(cs.pena, ct.hebmart, "opposing party"); await link(cs.pena, ct.defcounsel, "opposing counsel");
  await link(cs.ortiz, ct.ortiz, "client");

  const T = (cid, title, due, who, done) => c.query("INSERT INTO tasks(firm_id, case_id, title, due_date, assignee, created_by, done, done_at, done_by, created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [f, cid, title, iso(due), who, me, !!done, done ? ago(2) : null, done ? who : null, ago(12)]);
  await T(cs.garza, "Send records request to Valley Orthopedic", day(-2), jordan);
  await T(cs.garza, "Review dash-cam footage from defense production", day(3), me);
  await T(cs.garza, "Calendar defendant's deposition", day(-5), jordan, true);
  await T(cs.morales, "Prepare mediation statement", workday(18), me);
  await T(cs.hernandez, "Follow up with adjuster on demand", day(1), me);
  await T(cs.castillo, "Get police crash report (CR-3)", day(4), jordan);
  await T(cs.castillo, "Send signed contingency fee agreement to client", day(0), maria);
  await T(cs.pena, "Finalize exhibit list", workday(12), maria);

  const E = (cid, kind, title, d, time, who, loc) => c.query("INSERT INTO events(firm_id, case_id, user_id, kind, title, on_date, at_time, location, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [f, cid, who, kind, title, iso(d), time || null, loc || null, who]);
  await E(cs.garza, "hearing", "Status conference", h1, "9:00 AM", me, "332nd District Court, Edinburg");
  await E(cs.garza, "deadline", "Discovery responses due (TRCP 196)", workday(5), null, me);
  await E(cs.morales, "meeting", "Mediation", med, "10:00 AM", me, "Salinas Mediation, Brownsville");
  await E(cs.pena, "hearing", "Pretrial conference", h2, "1:30 PM", maria, "398th District Court, Edinburg");
  await E(cs.pena, "deadline", "Expert designation deadline (defendant)", workday(7), null, maria);
  await E(cs.ortiz, "deadline", "Respond to motion to compel", workday(4), null, me);
  await E(null, "meeting", "Firm case review", workday(2), "8:30 AM", me, "Conference room");

  const V = (cid, kind, who, body, o = {}) => c.query("INSERT INTO case_convos(firm_id, case_id, at, kind, contact_id, with_name, body, user_id, direction, minutes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [f, cid, o.at || ago(3), kind, o.contact || null, o.with || null, body, who, o.dir || null, o.min || null]);
  await V(cs.garza, "call", me, "<p>Client says her back pain is better after the second injection. Doctor wants 6 more weeks of PT. Told her to keep all receipts.</p>", { contact: ct.garza, with: "Elena Garza", dir: "in", min: 12, at: ago(2, 9) });
  await V(cs.garza, "email", jordan, "<p>Sent HIPAA authorization and records request to Valley Orthopedic.</p>", { contact: ct.dhr, with: "Valley Orthopedic Clinic", dir: "out", at: ago(6, 14) });
  await V(cs.garza, "call", me, "<p>Adjuster says they're still reviewing the dash-cam. No offer yet; will call back next week.</p>", { contact: ct.adjuster, with: "Karen Whitfield", dir: "out", min: 8, at: ago(4, 11) });
  await V(cs.morales, "meeting", me, "<p>Prepared client for mediation: walked through the process, our numbers and the range we expect.</p>", { contact: ct.morales, with: "Ricardo Morales", min: 45, at: ago(1, 15) });
  await V(cs.hernandez, "voicemail", me, "<p>Left voicemail for adjuster asking for a response to the demand.</p>", { contact: ct.adjuster2, with: "Tom Brandt", dir: "out", at: ago(0, 9) });
  await V(cs.castillo, "meeting", maria, "<p>Intake meeting. Collision on Nolana Ave; client treated at the ER, now seeing a chiropractor. Signed fee agreement.</p>", { contact: ct.castillo, with: "Luis Castillo", min: 60, at: ago(6, 10) });

  const TE = (cid, who, mins, rate, desc, ago_) => c.query("INSERT INTO time_entries(firm_id, case_id, user_id, on_date, minutes, rate, description, billable) VALUES($1,$2,$3,$4,$5,$6,$7,true)",
    [f, cid, who, iso(day(-ago_)), mins, rate, desc]);
  await TE(cs.estate, maria, 90, 275, "Draft application to probate will as muniment of title", 28);
  await TE(cs.estate, maria, 30, 275, "Telephone conference with applicant", 25);
  await TE(cs.ortiz, me, 120, 300, "Draft responses to requests for production", 10);
  await TE(cs.ortiz, me, 24, 300, "Telephone conference with client", 3);
  await c.query("UPDATE cases SET billing='contingency' WHERE id = ANY($1)", [[cs.garza, cs.morales, cs.hernandez, cs.castillo, cs.pena, cs.closed]]);

  // court emails (Court notices), already matched to their cases
  const N = (cid, cause, county, subject, body, d) => c.query(`INSERT INTO inbound_emails(user_id, firm_id, from_addr, subject, body, kind, causes, matched_case_ids, received_at, source, parsed, routed)
    VALUES($1,$2,$3,$4,$5,'other',$6,$7,$8,'demo',$9,'case')`, [me, f, "no-reply@efilingmail.tylertech.cloud", subject, body, [cause], [cid], d, { county, causes: [cause] }]);
  await N(cs.garza, "C-4512-26-F", "Hidalgo", "Notification of Service for Case: C-4512-26-F, Elena Garza v. Rio Valley Transport, LLC for Filing Defendant's First Amended Answer",
    "Defendant's First Amended Answer has been served on you in case C-4512-26-F (332nd District Court, Hidalgo County).", ago(3, 16));
  await N(cs.pena, "C-2207-25-I", "Hidalgo", "Notification of Service for Case: C-2207-25-I, Sofia Peña v. ValleyMart Stores, Inc. for Filing Defendant's Designation of Expert Witnesses",
    "Defendant's Designation of Expert Witnesses has been served on you in case C-2207-25-I.", ago(1, 13));
  await N(cs.morales, "2026-DCL-02211", "Cameron", "Order Referring Case to Mediation – 2026-DCL-02211", "The court has signed an order referring this case to mediation.", ago(9, 10));
  return { firm: f, user: me };
}

async function start(termsVersion) {
  const n = (await q("SELECT count(*)::int n FROM firms WHERE demo_until > now()")).rows[0].n;
  if (n >= MAX_ACTIVE) throw Object.assign(new Error("The demo is busy right now. Please try again later."), { status: 503 });
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await seed(c, termsVersion); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
// delete demo firms past their date (everything on them cascades), and their audit rows
async function cleanup() {
  const c = await pool.connect(); let n = 0;
  try { await c.query("BEGIN");
    const { rows } = await c.query("DELETE FROM firms WHERE demo_until IS NOT NULL AND demo_until < now() RETURNING id");
    if (rows.length) await c.query("DELETE FROM audit_log WHERE firm_id = ANY($1)", [rows.map(r => r.id)]);
    await c.query("COMMIT"); n = rows.length; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  if (n) console.log(`[demo] removed ${n} expired demo firm(s)`);
  return n;
}

function mount(app, { wrap, audit, terms }) {
  const ipaddr = require("ipaddr.js");
  const ipKey = req => { const ip = String(req.ip || "");   // IPv6 grouped by /64 (one home or phone network), compressed forms expanded first
    try { const a = ipaddr.process(ip); return a.kind() === "ipv6" ? a.toNormalizedString().split(":").slice(0, 4).join(":") + "::/64" : a.toString(); } catch (e) { return ip; } };
  const limiter = rateLimit({ windowMs: 60 * 60e3, max: 6, keyGenerator: ipKey, standardHeaders: true, legacyHeaders: false, message: { error: "Too many demos from here. Try again in an hour." } });
  const total = rateLimit({ windowMs: 60 * 60e3, max: 60, keyGenerator: () => "all", standardHeaders: false, legacyHeaders: false, message: { error: "The demo is busy right now. Please try again later." } });
  app.post("/api/demo/start", limiter, total, wrap(async (req, res) => {   // per-address limit first, so one address can't use up everyone's hour
    if (!req.body || req.body.agree !== true) return res.status(400).json({ error: "Please agree to the User Agreement to try the demo." });
    const r = await start(terms.VERSION);
    await new Promise((ok, no) => req.session.regenerate(e => e ? no(e) : ok()));
    req.session.uid = r.user; req.session.mfa = true;
    req.user = { id: r.user, firm_id: r.firm }; await audit(req, "demo_started", { firm: r.firm });
    res.json({ ok: true });
  }));
  setTimeout(() => cleanup().catch(e => console.warn("[demo] cleanup:", e.message)), 30e3);
  setInterval(() => cleanup().catch(e => console.warn("[demo] cleanup:", e.message)), 3600e3);
}

module.exports = { mount, guard, cleanup, uploadOk, uploadAfter, HOURS, _test: { seed, start, BLOCK, MSG } };
