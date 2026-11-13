// One helper for every AI (Claude) call in the app: dictation cleanup, discovery drafting, the Case Desk Assistant, the daily brief, Test key.
// - Picks the key: a real firm uses ONLY its own key from Firm Settings (encrypted with crypto-box.js / CRED_KEY). The Render key
//   (ANTHROPIC_API_KEY) is used ONLY by demo firms (firms.demo_until IS NOT NULL). A real firm with no key never falls back to it.
// - Records every call (firm, person, feature, model, tokens, cost in USD) in ai_usage.
// - Turns every failure into the same plain messages, and never puts a key in a response, log, error or audit row.
// - Uses prompt caching (cache_control) on tools, system prompt and the latest message, so repeat questions reuse the case file cheaply.
// - Strips anything shaped like a social security number from what is sent.
const { q } = require("./db");
const box = require("./crypto-box");

const MODELS = { fast: "claude-haiku-5-5", main: "claude-sonnet-5-5", top: "claude-opus-5-5" };
// US dollars per million tokens, in / out (Anthropic API prices, Nov 2026). Cache writes (5-minute) cost 1.25x input, cache reads 0.1x input.
const PRICES = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10], "claude-opus-5-5": [4, 20] };
const CACHE_WRITE = 1.25, CACHE_READ = 0.10;
const priceOf = model => PRICES[model] || PRICES[MODELS.top];   // an unknown model is priced as the dearest, so caps never under-count
function costOf(model, u = {}) {
  const [pin, pout] = priceOf(model);
  const n = k => Math.max(0, +u[k] || 0);
  return (n("input_tokens") * pin + n("output_tokens") * pout + n("cache_creation_input_tokens") * pin * CACHE_WRITE + n("cache_read_input_tokens") * pin * CACHE_READ) / 1e6;
}

// the plain messages, the same everywhere AI is used
const MSG = {
  noKey: "Add your firm's Claude key in Firm Settings.",
  noDemoKey: "The demo's AI isn't switched on yet. Sign up to use AI with your own firm's key.",
  demoKeyDown: "The demo's AI isn't available right now. Sign up to use AI with your own firm's key.",
  badKey: "Key not valid. A firm admin can replace it in Firm Settings → AI (Claude).",
  credit: "Out of credit (add credit in the Anthropic Console).",
  rate: "Too many requests, try again shortly.",
  busy: "The AI service is busy, try again shortly.",
  down: "The AI service didn't answer.",
  slow: "The AI service took too long.",
  devView: "AI is off in developer view.",
};
// Test key answers (Firm Settings → AI (Claude) → Test key)
const TEST = { ok: "Working", badKey: "Key not valid", credit: "Out of credit (add credit in the Anthropic Console)", rate: "Too many requests, try again shortly", busy: "The AI service is busy, try again shortly", down: "The AI service didn't answer" };

const fail = (status, error, code) => Object.assign(new Error(error), { status, code, plain: true });
// SSN filter. A separator is a space, dot, hyphen or any dash (U+2010 to U+2015), or a JSON escape (\n \r \t) for text that
// was turned into JSON before it got here. Text is NFKC-normalized first, so full-width digits are plain digits.
// - 3-2-4 digits with 1 to 3 separators between the groups, or 9 digits run together; a letter right before is fine
//   ("ssn123-45-6789"). Separators must be on both sides or neither, so ZIP+4 (78501-1234) isn't taken for an SSN.
// - After SSN / social / soc sec (within 25 characters): any 9 digits with up to 3 separators between each
//   ("SSN 123 456 789", "1 2 3-4 5-6 7 8 9").
// Phone numbers ((956) 555-0100, 956-555-0100), cause numbers (C-4512-26-F, 2026-DCL-02211, DC-24-12345), ISO dates and
// money don't have these shapes, so they come through untouched (tests check them).
// separators: spaces of any kind, dots, any dash or minus, underscores, soft hyphens and zero-width characters
// (pasted from Word or PDFs), and JSON escapes (\n, \t, \u000b…) when text was already stringified
const SEP = String.raw`(?:[\s.\-_\u00ad\u2010-\u2015\u2212\u200b-\u200d\u2060\ufeff]|\\[nrtbf]|\\u00[01][0-9a-fA-F])`;
const SSN_RE = new RegExp(String.raw`(?<!\d)\d{3}(?:${SEP}{1,3}\d{2}${SEP}{1,3}|\d{2})\d{4}(?!\d)`, "g");
const SSN_NEAR = new RegExp(String.raw`(\bssns?\b|\bs\.?\s?s\.?\s?n\b\.?|\bss\s?#|\bs\.\s?s\.\s?#|\bsocial\b|soc\.?\s*sec)([^0-9]{0,25})((?:\d${SEP}{0,3}){8}\d)(?!\d)`, "gi");
// 9 digits run together right after "cause", "case", "docket", "file", "No." or "#" are a cause or file number
// (Harris County writes 2026 + 5 digits), so they're kept. Next to an SSN keyword they were already removed above.
const CAUSE_BEFORE = /(cause|case|docket|file|matter|no\.?|number|#)[^0-9a-z]{0,15}$/i;
const scrub = s => String(s).normalize("NFKC").replace(SSN_NEAR, "$1$2[SSN removed]")
  .replace(SSN_RE, (m, at, all) => /^\d{9}$/.test(m) && CAUSE_BEFORE.test(all.slice(Math.max(0, at - 25), at)) ? m : "[SSN removed]");
// Every string inside an object or array. Call it on data BEFORE it is JSON.stringify'd into a prompt (tool results, page
// context, brief data, discovery case file): once stringified, a line break is the two characters \n. ai.call also runs it
// over the whole request. Tool ids are left alone: a random id can hold 9 digits in a row, and changing it would break the tool round.
const KEEP = new Set(["id", "tool_use_id", "type", "model"]);   // names (contacts, parties, documents) ARE scrubbed
const scrubDeep = o => typeof o === "string" ? scrub(o) : Array.isArray(o) ? o.map(scrubDeep) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, KEEP.has(k) && typeof v === "string" ? v : scrubDeep(v)])) : o;
const money = n => "$" + (Math.round(n * 100) / 100).toFixed(2);

// ---------- the key ----------
const KEY_RE = /^sk-ant-[A-Za-z0-9_\-]{16,300}$/;
const last4 = k => String(k).slice(-4);
async function firmOf(firmId) { return (await q("SELECT id, demo_until, ai_key_enc, ai_key_last4, ai_key_at, ai_key_by FROM firms WHERE id=$1", [firmId])).rows[0] || {}; }
const isDemo = f => !!(f && f.demo_until);
const demoKey = () => (process.env.ANTHROPIC_API_KEY || "").trim();
// returns { key, demo } or throws the plain "add your key" message. Never returns the Render key for a real firm.
async function keyFor(user) {
  const f = await firmOf(user.firm_id);
  if (isDemo(f)) { const k = demoKey(); if (!k) throw fail(503, MSG.noDemoKey, "NO_KEY"); return { key: k, demo: true }; }
  if (!f.ai_key_enc) throw fail(503, MSG.noKey, "NO_KEY");
  let k; try { k = box.open(f.ai_key_enc); } catch (e) { console.warn("[ai] firm key couldn't be unlocked (CRED_KEY changed?)"); throw fail(503, MSG.noKey, "NO_KEY"); }
  return { key: k, demo: false };
}
// is AI usable for this person right now (a key is there)? Doesn't call anyone.
async function available(user) {
  if (!user) return false;
  const f = await firmOf(user.firm_id);
  return isDemo(f) ? !!demoKey() : !!f.ai_key_enc;
}

// ---------- caps ----------
const num = (v, d) => Number.isFinite(+v) && +v > 0 ? +v : d;   // a blank or bad Render value falls back to the default, never to "no cap"
const CAPS = () => ({ month: num(process.env.DEMO_AI_MONTH_USD, 50), day: num(process.env.DEMO_AI_DAY_USD, 2),
  rate: num(process.env.DEMO_AI_RATE, 20), rateWin: 10 * 60e3, allRate: num(process.env.DEMO_AI_RATE_ALL, 400), allWin: 60 * 60e3 });
const pending = new Map();   // cost of calls in flight, so a burst of calls at once can't run past a cap: key -> USD
const addPending = (k, v) => pending.set(k, Math.max(0, (pending.get(k) || 0) + v));
const hits = new Map();      // demo rate limit: firm -> [times]
function rateOk(k, max, win) {
  const now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < win);
  if (a.length >= max) { hits.set(k, a); return false; }
  a.push(now); hits.set(k, a);
  if (hits.size > 5000) for (const x of [...hits.keys()]) if (x !== "all") hits.delete(x);   // evict per-firm entries only; the all-demo counter stays
  return true;
}
const DEMO_CAP = "The demo has used its AI allowance for now. Sign up to keep using the assistant with your own firm's key.";
// The caller has already added this call's estimate to `pending` (before any await), so pending includes it:
// two calls at once can't both slip under a cap.
async function checkCaps(user, demo) {
  if (demo) {
    const c = CAPS();
    const month = +(await q("SELECT coalesce(sum(cost_usd),0) v FROM ai_usage WHERE demo AND at >= date_trunc('month', now())")).rows[0].v;
    if (month + (pending.get("demo") || 0) > c.month) throw fail(429, DEMO_CAP, "DEMO_CAP");
    const day = +(await q("SELECT coalesce(sum(cost_usd),0) v FROM ai_usage WHERE demo AND firm_id=$1 AND at >= now() - interval '1 day'", [user.firm_id])).rows[0].v;
    if (day + (pending.get("f" + user.firm_id) || 0) > c.day) throw fail(429, "This demo has used its AI allowance for today. Sign up to keep using the assistant with your own firm's key.", "DEMO_CAP");
    if (!rateOk("all", c.allRate, c.allWin)) throw fail(429, DEMO_CAP, "DEMO_CAP");
    if (!rateOk("f" + user.firm_id, c.rate, c.rateWin)) throw fail(429, "That's a lot of AI requests in a few minutes for the demo. Wait a little, or sign up to use your own firm's key.", "DEMO_CAP");
    return;
  }
  const lim = (await q("SELECT ai_limit_usd FROM users WHERE id=$1", [user.id])).rows[0];
  if (lim && lim.ai_limit_usd != null) {
    const spent = +(await q("SELECT coalesce(sum(cost_usd),0) v FROM ai_usage WHERE user_id=$1 AND firm_id=$2 AND at >= date_trunc('month', now())", [user.id, user.firm_id])).rows[0].v;
    if (spent + (pending.get("u" + user.id) || 0) > +lim.ai_limit_usd) throw fail(429, `You've reached your monthly AI limit (${money(+lim.ai_limit_usd)}). Your firm admin can raise it in Firm Settings → AI (Claude).`, "AI_LIMIT");
  }
}

// ---------- the call ----------
// error from Anthropic -> one of the plain messages (status codes the app answers with)
function plainError(status, j) {
  const type = (j && j.error && j.error.type) || "", m = String((j && j.error && j.error.message) || "");
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") return fail(502, MSG.badKey, "BAD_KEY");
  if (status === 402 || /credit balance|billing|insufficient.*(credit|fund)/i.test(m)) return fail(502, MSG.credit, "NO_CREDIT");
  if (status === 429 || type === "rate_limit_error") return fail(429, MSG.rate, "RATE");
  if (status === 529 || type === "overloaded_error") return fail(503, MSG.busy, "BUSY");
  return fail(502, MSG.down, "DOWN");
}
// adds cache_control to the last tool, the last system block and the last block of the last message (up to 3 cache breakpoints)
function withCache(body, cacheLast = true) {
  const cc = { type: "ephemeral" };
  if (Array.isArray(body.tools) && body.tools.length) body.tools[body.tools.length - 1] = { ...body.tools[body.tools.length - 1], cache_control: cc };
  if (typeof body.system === "string") body.system = [{ type: "text", text: body.system, cache_control: cc }];
  else if (Array.isArray(body.system) && body.system.length) body.system[body.system.length - 1] = { ...body.system[body.system.length - 1], cache_control: cc };
  const last = body.messages[body.messages.length - 1];
  if (last && cacheLast) {
    if (typeof last.content === "string") last.content = [{ type: "text", text: last.content, cache_control: cc }];
    else if (Array.isArray(last.content) && last.content.length) { const i = last.content.length - 1; last.content[i] = { ...last.content[i], cache_control: cc }; }
  }
  return body;
}
async function record(user, demo, feature, model, usage, ok, err) {
  const u = usage || {};
  await q(`INSERT INTO ai_usage(firm_id, user_id, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, demo, ok, error)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [user.firm_id, user.id || null, feature, model, +u.input_tokens || 0, +u.output_tokens || 0, +u.cache_read_input_tokens || 0, +u.cache_creation_input_tokens || 0,
    costOf(model, u), !!demo, !!ok, err || null]).catch(e => console.warn("[ai] usage not recorded:", e.message));
}

// call({ user, feature, model, system, messages, tools, max_tokens, timeoutMs, cacheLast })
// cacheLast:false when the last message is one-off text (dictation, one discovery batch): the system prompt and tools are still cached -> the API reply (content, stop_reason, usage)
async function call(opts) {
  const { user, feature, devView } = opts;
  if (devView) throw fail(403, MSG.devView, "DEV_VIEW");
  const model = opts.model || MODELS.main, max_tokens = opts.max_tokens || 2000;
  const { key, demo } = await keyFor(user);
  const body = withCache({ model, max_tokens, system: opts.system, messages: JSON.parse(JSON.stringify(opts.messages)), ...(opts.tools ? { tools: JSON.parse(JSON.stringify(opts.tools)) } : {}) }, opts.cacheLast !== false);
  const payload = JSON.stringify(scrubDeep(body));   // no SSNs ever go to AI
  const [pin, pout] = priceOf(model);
  const estimate = ((payload.length / 2.5) * pin * CACHE_WRITE + max_tokens * pout) / 1e6;   // worst case for this call, held against the caps while it runs
  const keys = demo ? ["demo", "f" + user.firm_id] : ["u" + user.id];
  keys.forEach(k => addPending(k, estimate));   // reserved before the first await, so parallel calls see each other
  const release = () => keys.forEach(k => addPending(k, -estimate));
  try { await checkCaps(user, demo); } catch (e) { release(); throw e; }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), num(process.env.AI_TIMEOUT_MS, opts.timeoutMs || 120e3));   // AI_TIMEOUT_MS: tests only
  try {
    let r, j;
    try {
      for (let attempt = 0; ; attempt++) {   // one retry on 429 / 529, honoring retry-after (at most 5 seconds)
        r = await fetch(process.env.AI_URL || "https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal,
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: payload });
        j = await r.json().catch(() => ({}));
        if (ctl.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });   // timed out while reading the answer: a timeout, not a $0 success
        if (attempt || (r.status !== 429 && r.status !== 529)) break;
        const ra = +r.headers.get("retry-after"); const wait = Math.min(5000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000);
        console.warn(`[ai] ${feature}: AI service ${r.status}, retrying once in ${wait} ms`);
        await new Promise(ok => setTimeout(ok, wait));
      }
    } catch (e) {
      const slow = e.name === "AbortError"; console.warn(`[ai] ${feature}: ${slow ? "timed out" : "no answer"}`);
      await record(user, demo, feature, model, null, false, slow ? "timeout" : "network");
      throw fail(slow ? 504 : 502, slow ? MSG.slow : MSG.down, slow ? "SLOW" : "DOWN");
    }
    if (!r.ok) {
      let pe = plainError(r.status, j);
      console.warn(`[ai] ${feature}: AI service ${r.status} ${pe.code}${demo ? " (demo key)" : ""}`);   // status and kind only: never the key, never the text
      await record(user, demo, feature, model, j && j.usage, false, pe.code);
      // demo visitors never see firm-admin advice about a key they don't own
      if (demo && (pe.code === "BAD_KEY" || pe.code === "NO_CREDIT")) pe = fail(503, MSG.demoKeyDown, "DEMO_KEY");
      throw pe;
    }
    await record(user, demo, feature, model, j.usage, true, null);
    return j;
  } finally { clearTimeout(timer); release(); }
}
// hourly: AI usage rows older than 13 months go
async function prune() {
  const n = (await q("DELETE FROM ai_usage WHERE at < now() - interval '13 months'")).rowCount;
  if (n) console.log(`[ai] removed ${n} usage row(s) older than 13 months`);
  return n;
}
const textOf = j => ((j && j.content) || []).filter(x => x.type === "text").map(x => x.text).join("");

// Test key: one tiny call with the cheapest model. Returns { result, ok }.
async function testKey(user, key) {
  const model = MODELS.fast;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30e3);
  try {
    const r = await fetch(process.env.AI_URL || "https://api.anthropic.com/v1/messages", { method: "POST", signal: ctl.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "Reply with OK." }] }) });
    const j = await r.json().catch(() => ({}));
    await record(user, false, "key_test", model, r.ok ? j.usage : null, r.ok, r.ok ? null : plainError(r.status, j).code);
    if (r.ok) return { ok: true, result: TEST.ok };
    const code = plainError(r.status, j).code; console.warn(`[ai] key test: AI service ${r.status} ${code}`);
    return { ok: false, result: code === "BAD_KEY" ? TEST.badKey : code === "NO_CREDIT" ? TEST.credit : code === "RATE" ? TEST.rate : code === "BUSY" ? TEST.busy : TEST.down };
  } catch (e) { console.warn("[ai] key test: no answer"); return { ok: false, result: TEST.down }; }
  finally { clearTimeout(timer); }
}

// ---------- Firm Settings → AI (Claude) ----------
function mount(app, { requireAuth, requireAdmin, wrap, audit }) {
  const notDemo = (req, res, next) => req.user.demo_until ? res.status(403).json({ error: "Demo firm: the demo uses the demo key, so there's nothing to change here. In your own firm, an admin adds the firm's Claude key here.", code: "DEMO" }) : next();
  const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10); };
  const monthOf = s => /^\d{4}-\d{2}$/.test(s || "") ? s + "-01" : monthStart();

  // everyone sees the status; only admins see who saved it
  app.get("/api/ai/settings", requireAuth, wrap(async (req, res) => {
    const f = await firmOf(req.user.firm_id), admin = req.user.role === "admin";
    const mine = (await q("SELECT coalesce(sum(cost_usd),0) v FROM ai_usage WHERE user_id=$1 AND firm_id=$2 AND at >= date_trunc('month', now())", [req.user.id, req.user.firm_id])).rows[0].v;
    const lim = (await q("SELECT ai_limit_usd FROM users WHERE id=$1", [req.user.id])).rows[0];
    res.json({ demo: isDemo(f), has_key: isDemo(f) ? !!demoKey() : !!f.ai_key_enc, last4: isDemo(f) ? null : f.ai_key_last4 || null,
      saved_at: admin && !isDemo(f) ? f.ai_key_at : null, saved_by: admin && !isDemo(f) ? f.ai_key_by : null,
      can_change: admin && !isDemo(f) && !req.devView, admin, my_month_usd: +(+mine).toFixed(4), my_limit_usd: lim && lim.ai_limit_usd != null ? +lim.ai_limit_usd : null,
      models: { fast: MODELS.fast, main: MODELS.main }, prices: PRICES });
  }));
  app.put("/api/ai/key", requireAuth, requireAdmin, notDemo, wrap(async (req, res) => {
    const k = String((req.body && req.body.key) || "").trim();
    if (!KEY_RE.test(k)) return res.status(400).json({ error: "That doesn't look like a Claude API key. It starts with sk-ant- (copy it from the Anthropic Console → API keys)." });
    const old = (await firmOf(req.user.firm_id)).ai_key_last4 || null;
    await q("UPDATE firms SET ai_key_enc=$2, ai_key_last4=$3, ai_key_at=now(), ai_key_by=$4 WHERE id=$1", [req.user.firm_id, box.seal(k), last4(k), req.user.name]);
    await audit(req, old ? "ai_key_replaced" : "ai_key_saved", { last4: last4(k), ...(old ? { old_last4: old } : {}) });
    res.json({ ok: true, last4: last4(k) });
  }));
  app.delete("/api/ai/key", requireAuth, requireAdmin, notDemo, wrap(async (req, res) => {
    const old = (await firmOf(req.user.firm_id)).ai_key_last4 || null;
    await q("UPDATE firms SET ai_key_enc=NULL, ai_key_last4=NULL, ai_key_at=NULL, ai_key_by=NULL WHERE id=$1", [req.user.firm_id]);
    if (old) await audit(req, "ai_key_removed", { last4: old });
    res.json({ ok: true });
  }));
  app.post("/api/ai/key/test", requireAuth, requireAdmin, notDemo, wrap(async (req, res) => {
    let key; try { ({ key } = await keyFor(req.user)); } catch (e) { return res.json({ ok: false, result: "No key saved yet" }); }
    const r = await testKey(req.user, key);
    await audit(req, "ai_key_tested", { last4: last4(key), result: r.result });
    res.json(r);
  }));

  // usage per person this month (admins); the tile opens the calls behind it
  app.get("/api/ai/usage", requireAuth, requireAdmin, wrap(async (req, res) => {
    const from = monthOf(req.query.month);
    const rows = (await q(`SELECT u.id, u.name, u.role, u.active, u.ai_limit_usd, coalesce(sum(a.cost_usd),0) AS usd, count(a.id)::int AS calls
      FROM users u LEFT JOIN ai_usage a ON a.user_id=u.id AND a.firm_id=u.firm_id AND a.at >= $2::date AND a.at < ($2::date + interval '1 month')
      WHERE u.firm_id=$1 GROUP BY u.id ORDER BY usd DESC, u.name`, [req.user.firm_id, from])).rows;
    res.json({ month: from.slice(0, 7), people: rows.filter(r => r.active || r.calls).map(r => ({ id: r.id, name: r.name, role: r.role, usd: +(+r.usd).toFixed(4), calls: r.calls, limit_usd: r.ai_limit_usd != null ? +r.ai_limit_usd : null })),
      total_usd: +rows.reduce((s, r) => s + +r.usd, 0).toFixed(4) });
  }));
  app.get("/api/ai/usage/:userId", requireAuth, requireAdmin, wrap(async (req, res) => {
    const from = monthOf(req.query.month);
    const u = (await q("SELECT id, name FROM users WHERE id=$1 AND firm_id=$2", [+req.params.userId || 0, req.user.firm_id])).rows[0];
    if (!u) return res.status(404).json({ error: "Not found" });
    const calls = (await q(`SELECT at, feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, ok, error FROM ai_usage
      WHERE user_id=$1 AND firm_id=$2 AND at >= $3::date AND at < ($3::date + interval '1 month') ORDER BY at DESC LIMIT 500`, [u.id, req.user.firm_id, from])).rows;
    res.json({ person: u, month: from.slice(0, 7), calls: calls.map(c => ({ ...c, cost_usd: +(+c.cost_usd).toFixed(6) })) });
  }));
  app.put("/api/ai/limits/:userId", requireAuth, requireAdmin, notDemo, wrap(async (req, res) => {
    const v = req.body && req.body.limit_usd, lim = v === null || v === "" || v === undefined ? null : Math.round(+v * 100) / 100;
    if (lim !== null && !(lim >= 0 && lim <= 100000)) return res.status(400).json({ error: "Enter a dollar amount, or leave it blank for no limit." });
    const r = await q("UPDATE users SET ai_limit_usd=$3 WHERE id=$1 AND firm_id=$2 RETURNING name", [+req.params.userId || 0, req.user.firm_id, lim]);
    if (!r.rowCount) return res.status(404).json({ error: "Not found" });
    await audit(req, "ai_limit_set", { user: +req.params.userId, limit_usd: lim });
    res.json({ ok: true, limit_usd: lim });
  }));
}

module.exports = { mount, call, prune, textOf, scrubDeep, available, keyFor, testKey, costOf, scrub, MODELS, PRICES, MSG, TEST, fail, _test: { withCache, plainError, CAPS, pending, hits, rateOk, SSN_RE } };
