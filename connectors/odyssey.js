// Tyler Odyssey "Public Access" (classic default.aspx / Search.aspx portal) connector.
// Signs in with the attorney's OWN portal login (if given), searches by the attorney's bar number,
// and returns the cases where they appear as attorney. Pages are parsed by labels/headers, not
// fixed positions, because each county skins the portal a little differently.
const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (compatible; TX-Case-Desk/1.0; attorney case sync)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Session {
  constructor(base) { this.base = base.replace(/\/+$/, "") + "/"; this.jar = new Map(); this.log = []; }
  url(p) { return new URL(p, this.base).toString(); }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const c of set) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); }
  }
  async req(path, { method = "GET", form, referer } = {}) {
    let url = this.url(path), body, hops = 0;
    if (form) body = new URLSearchParams(form).toString();
    while (true) {
      const headers = { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", Cookie: this.cookieHeader() };
      if (referer) headers.Referer = referer;
      if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
      let res;
      try { res = await fetch(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(30000) }); }
      catch (e) { throw new Error(`Can't reach ${new URL(url).host} (${e.cause?.code || e.message})`); }
      this.store(res);
      if ([301, 302, 303, 307, 308].includes(res.status) && hops++ < 8) {
        url = new URL(res.headers.get("location"), url).toString();
        if (res.status !== 307 && res.status !== 308) { method = "GET"; body = undefined; }
        continue;
      }
      const html = await res.text();
      this.log.push(`${method} ${new URL(url).pathname}${new URL(url).search} → ${res.status} "${(cheerio.load(html)("title").text() || "").trim()}"`);
      if (res.status >= 400) throw new Error(`Portal returned ${res.status} on ${new URL(url).pathname}`);
      await sleep(800); // be polite to the county server
      return { url, html, $: cheerio.load(html) };
    }
  }
}

// Collect every form field the way a browser would submit it.
function formFields($, form) {
  const f = {};
  $(form).find("input").each((_, el) => {
    const t = ($(el).attr("type") || "text").toLowerCase(), n = $(el).attr("name");
    if (!n || ["submit", "button", "image", "reset", "file"].includes(t)) return;
    if ((t === "radio" || t === "checkbox") && !$(el).is("[checked]")) return;
    f[n] = $(el).attr("value") ?? (t === "checkbox" ? "on" : "");
  });
  $(form).find("select").each((_, el) => {
    const n = $(el).attr("name"); if (!n) return;
    const sel = $(el).find("option[selected]").first();
    f[n] = (sel.length ? sel : $(el).find("option").first()).attr("value") ?? "";
  });
  return f;
}
function findForm($) { return $("form").first(); }
function captchaPresent($) { return /captcha|recaptcha|hcaptcha|are you a human/i.test($.html()); }

async function login(s, username, password) {
  const home = await s.req("default.aspx");
  if (!username) return home;
  let page = home;
  const link = home.$("a").filter((_, a) => /sign\s*on|log\s*in|login/i.test(home.$(a).text())).first().attr("href");
  page = await s.req(link || "Login.aspx", { referer: home.url });
  const $ = page.$, form = findForm($);
  if (captchaPresent($)) throw new Error("Portal login shows a CAPTCHA — automatic sign-in isn't possible for this county.");
  const f = formFields($, form);
  const userField = $(form).find("input[type=text],input[type=email],input:not([type])").filter((_, el) => /user|login|email|name/i.test($(el).attr("name") || "")).first().attr("name");
  const passField = $(form).find("input[type=password]").first().attr("name");
  if (!userField || !passField) throw new Error("Couldn't find the portal's sign-in fields.");
  f[userField] = username; f[passField] = password;
  const btn = $(form).find("input[type=submit],button[type=submit]").filter((_, el) => /sign|log/i.test($(el).attr("value") || $(el).text())).first();
  if (btn.attr("name")) f[btn.attr("name")] = btn.attr("value") || "Sign On";
  const after = await s.req(new URL($(form).attr("action") || page.url, page.url).toString(), { method: "POST", form: f, referer: page.url });
  if (after.$("input[type=password]").length && /invalid|incorrect|failed|not valid/i.test(after.$.text()))
    throw new Error("The portal rejected this attorney's username or password.");
  return after;
}

// Pick the search page for district/county civil & family cases from the portal home.
function searchLinks(page) {
  const out = [];
  page.$("a").each((_, a) => {
    const href = page.$(a).attr("href") || "", txt = page.$(a).text().trim();
    if (/Search\.aspx\?ID=\d+/i.test(href) && !/jail|calendar|court calendar|judgment|financial/i.test(txt)) out.push({ href, txt });
  });
  return out;
}

async function searchByBar(s, entry, bar, attorneyName) {
  const page = await s.req(entry.href, { referer: s.base });
  const $ = page.$, form = findForm($);
  if (captchaPresent($)) throw new Error("Search page shows a CAPTCHA.");
  const f = formFields($, form);
  // 1) choose "Attorney" search mode
  const sel = $(form).find("select").filter((_, el) => /searchby/i.test($(el).attr("name") || $(el).attr("id") || "")).first();
  let modeText = "";
  if (sel.length) {
    const opt = sel.find("option").filter((_, o) => /attorney/i.test($(o).text())).first();
    if (!opt.length) throw new Error(`"${entry.txt}" has no attorney search.`);
    f[sel.attr("name")] = opt.attr("value"); modeText = opt.text();
  }
  // Odyssey sets hidden SearchType/SearchMode with JavaScript — mimic it.
  if ("SearchType" in f) f.SearchType = "ATTORNEY";
  if ("SearchMode" in f) f.SearchMode = "BARNUMBER";
  // 2) fill bar number (fallback: attorney last/first name)
  const barInput = $(form).find("input").filter((_, el) => /bar/i.test(($(el).attr("name") || "") + ($(el).attr("id") || ""))).first().attr("name");
  if (barInput) f[barInput] = bar;
  else {
    const [first, ...rest] = String(attorneyName || "").trim().split(/\s+/); const last = rest.pop() || first;
    const ln = $(form).find("input").filter((_, el) => /last\s*name|LastName/i.test($(el).attr("name") || "")).first().attr("name");
    const fn = $(form).find("input").filter((_, el) => /first\s*name|FirstName/i.test($(el).attr("name") || "")).first().attr("name");
    if (!ln) throw new Error("Couldn't find a bar-number or attorney-name field on the search page.");
    f[ln] = last; if (fn) f[fn] = first;
    if ("SearchMode" in f) f.SearchMode = "NAME";
  }
  // 3) open cases only, if the portal offers it
  const openRadio = $(form).find("input[type=radio]").filter((_, el) => {
    const id = $(el).attr("id"), lbl = id ? $(`label[for='${id}']`).text() : "";
    const after = String(el.next?.data || "") + lbl;
    return /^\s*open/i.test(after) || /open/i.test($(el).attr("value") || "");
  }).first();
  if (openRadio.attr("name")) f[openRadio.attr("name")] = openRadio.attr("value");
  const submit = $(form).find("input[type=submit]").filter((_, el) => /search/i.test($(el).attr("value") || "")).first();
  if (submit.attr("name")) f[submit.attr("name")] = submit.attr("value");
  const res = await s.req(new URL($(form).attr("action") || page.url, page.url).toString(), { method: "POST", form: f, referer: page.url });
  return { res, modeText, fields: Object.keys(f) };
}

// Parse the results grid by its header labels.
function parseResults(res) {
  const $ = res.$, rows = [];
  $("table").each((_, t) => {
    const hdr = $(t).find("tr").filter((_, tr) => /case\s*number/i.test($(tr).text())).first();
    if (!hdr.length) return;
    const cols = hdr.find("th,td").map((_, c) => $(c).text().replace(/\s+/g, " ").trim().toLowerCase()).get();
    hdr.nextAll("tr").each((_, tr) => {
      const link = $(tr).find("a[href*='CaseDetail']").first();
      if (!link.length) return;
      const tds = $(tr).children("td");
      const cells = tds.map((_, c) => $(c).text().replace(/\s+/g, " ").trim()).get();
      const idx = re => cols.findIndex(c => re.test(c));
      const by = (...res) => { for (const re of res) { const i = idx(re); if (i >= 0 && cells[i]) return cells[i]; } return ""; };
      // Type/Status cell holds two lines (divs or <br>) — keep them apart.
      const tsI = idx(/type|status/);
      let parts = [];
      if (tsI >= 0) {
        const cell = tds.eq(tsI);
        parts = cell.find("div").length ? cell.find("div").map((_, d) => $(d).text().trim()).get()
          : cell.html().split(/<br\s*\/?>/i).map(h => cheerio.load(h).text().trim());
        if (parts.length < 2) parts = cell.text().trim().split(/\s{2,}|\n/).map(x => x.trim());
      }
      rows.push({
        cause_no: link.text().trim(),
        detail: new URL(link.attr("href"), res.url).toString(),
        style: by(/style|caption/, /defendant|party/, /citation/),
        filed_location: by(/filed|location/),
        case_type: parts[0] || null,
        status: parts[1] || null
      });
    });
  });
  return rows;
}

function splitFiled(s) {
  const m = String(s).match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*(.*)/);
  if (!m) return { filed_date: null, court: s || null };
  const [mm, dd, yy] = m[1].split("/");
  return { filed_date: `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`, court: m[2].trim() || null };
}

// Case detail page: court, status, and next upcoming event.
async function caseDetail(s, url, referer) {
  const d = await s.req(url, { referer });
  const $ = d.$, text = $("body").text().replace(/\s+/g, " ");
  const grab = re => (text.match(re) || [])[1]?.trim();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let next = null;
  $("tr").each((_, tr) => {
    const t = $(tr).text().replace(/\s+/g, " ").trim();
    const m = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(.*?(hearing|trial|conference|docket|setting|mediation|status|motion).*)$/i);
    if (!m) return;
    const dt = new Date(m[1]);
    if (dt >= today && (!next || dt < next.dt)) next = { dt, txt: `${m[1]} – ${m[2].slice(0, 120)}` };
  });
  return {
    case_type: grab(/Case Type:\s*(.+?)\s+(Date Filed|Location|Case Status)/i),
    status: grab(/Case Status:\s*(.+?)\s+(Location|Date Filed|Judicial|Case Type|$)/i) || null,
    court: grab(/Location:\s*(.+?)\s+(Judicial|Case Type|Date Filed|Case Status|$)/i),
    next_setting: next ? next.txt : null
  };
}

async function sync({ baseUrl, username, password, barNumber, attorneyName, maxCases = 200, watchUrls = [], watchOnly = false }) {
  const s = new Session(baseUrl);
  const home = await login(s, username, password);
  if (watchOnly) { // hourly light check: only re-read watched cases' pages, no bar search
    const notes = [], out = [];
    for (const w of watchUrls.slice(0, 100)) {
      try { out.push({ cause_no: w.cause_no, external_url: w.url, ...(await caseDetail(s, w.url, s.base)) }); }
      catch (e) { notes.push(`${w.cause_no}: ${e.message}`); }
    }
    notes.push(`Hourly check: ${out.length} watched case(s)`);
    return { cases: out, notes, diag: s.log };
  }
  const entries = searchLinks(home.url.includes("default") ? home : await s.req("default.aspx"));
  if (!entries.length) throw Object.assign(new Error("No case-search pages found on the portal home page."), { diag: s.log });
  const found = new Map(), notes = [];
  for (const e of entries) {
    try {
      const { res } = await searchByBar(s, e, barNumber, attorneyName);
      const rows = parseResults(res);
      if (!rows.length && /no cases matched|no records/i.test(res.$.text())) notes.push(`${e.txt}: 0 cases`);
      else notes.push(`${e.txt}: ${rows.length} cases`);
      for (const r of rows) if (!found.has(r.cause_no)) found.set(r.cause_no, r);
    } catch (err) { notes.push(`${e.txt}: ${err.message}`); }
  }
  const cases = [];
  for (const r of [...found.values()].slice(0, maxCases)) {
    const base = { cause_no: r.cause_no, style: r.style || null, external_url: r.detail, ...splitFiled(r.filed_location) };
    base.case_type = r.case_type; base.status = r.status;
    try { Object.assign(base, Object.fromEntries(Object.entries(await caseDetail(s, r.detail, s.base)).filter(([, v]) => v))); } catch (e) { notes.push(`${r.cause_no} detail: ${e.message}`); }
    cases.push(base);
  }
  // Watched cases that didn't come back in the bar search (closed, transferred, other counsel): re-read their detail page.
  const seen = new Set(cases.map(c => c.external_url));
  const watched = [];
  for (const w of watchUrls.filter(w => w.url && !seen.has(w.url)).slice(0, 100)) {
    try { watched.push({ cause_no: w.cause_no, external_url: w.url, ...(await caseDetail(s, w.url, s.base)) }); }
    catch (e) { notes.push(`${w.cause_no} watch check: ${e.message}`); }
  }
  if (watched.length) notes.push(`Re-checked ${watched.length} watched case(s) outside the bar search`);
  return { cases: cases.concat(watched), notes, diag: s.log };
}

// Fetch the portal pages and report their structure (used to tune a county's settings from server logs).
async function inspect({ baseUrl }) {
  const s = new Session(baseUrl);
  const home = await s.req("default.aspx");
  const entries = searchLinks(home);
  const report = { home_title: home.$("title").text().trim(), captcha: captchaPresent(home.$), login_link: home.$("a").filter((_, a) => /sign\s*on|log\s*in/i.test(home.$(a).text())).map((_, a) => home.$(a).attr("href")).get(), search_pages: entries, first_search: null };
  if (entries[0]) {
    const p = await s.req(entries[0].href);
    const $ = p.$;
    report.first_search = {
      title: $("title").text().trim(), captcha: captchaPresent($),
      selects: $("select").map((_, el) => ({ name: $(el).attr("name"), options: $(el).find("option").map((_, o) => `${$(o).attr("value")}=${$(o).text().trim()}`).get().slice(0, 25) })).get(),
      inputs: $("input").map((_, el) => `${$(el).attr("type") || "text"}:${$(el).attr("name")}${$(el).attr("type") === "hidden" ? "" : ""}`).get().filter(x => !/__VIEWSTATE|__EVENTVALIDATION/.test(x))
    };
  }
  report.log = s.log;
  return report;
}

module.exports = { sync, inspect };
