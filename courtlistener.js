// Texas case law from public court opinions via CourtListener (Free Law Project).
// Opinions are public domain. Every response is cached in Postgres because free
// CourtListener accounts have tight daily request limits.
const { q } = require("./db");

const BASE = "https://www.courtlistener.com/api/rest/v4";
const TX_COURTS = { tex: "Supreme Court of Texas", texapp: "Texas Courts of Appeals", texcrimapp: "Texas Court of Criminal Appeals" };
const SEARCH_TTL_HOURS = 24;

class CLError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function clFetch(path, { auth = false } = {}) {
  const headers = { Accept: "application/json", "User-Agent": "TX-Case-Desk/1.0" };
  const token = process.env.COURTLISTENER_TOKEN;
  if (token) headers.Authorization = "Token " + token;
  else if (auth) throw new CLError("Opening full opinions needs a CourtListener API token (set COURTLISTENER_TOKEN on the server).", 503);
  let res;
  try { res = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw new CLError("Can't reach the case-law source right now. Try again shortly.", 503); }
  if (res.status === 429) throw new CLError("Case-law source is rate-limited right now. Cached results still work — try again in a few minutes.", 429);
  if (res.status === 401 || res.status === 403) throw new CLError("Case-law source rejected the API token.", 502);
  if (!res.ok) throw new CLError("Case-law source error (" + res.status + ").", 502);
  return res.json();
}

async function cached(key, ttlHours, loader) {
  const { rows } = await q("SELECT body, at FROM api_cache WHERE key=$1", [key]);
  if (rows[0] && (ttlHours == null || Date.now() - new Date(rows[0].at) < ttlHours * 3600e3)) return rows[0].body;
  try {
    const body = await loader();
    await q("INSERT INTO api_cache(key, body, at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET body=$2, at=now()", [key, body]);
    return body;
  } catch (e) {
    if (rows[0]) return { ...rows[0].body, stale: true }; // serve stale cache on outage / rate limit
    throw e;
  }
}

function normResult(r) {
  const op = (r.opinions && r.opinions[0]) || {};
  return {
    cluster_id: r.cluster_id,
    opinion_id: op.id || null,
    case_name: r.caseName || r.caseNameFull || "Untitled",
    citation: Array.isArray(r.citation) ? r.citation.join(", ") : (r.citation || ""),
    court: TX_COURTS[r.court_id] || r.court || r.court_id,
    court_id: r.court_id,
    date_filed: r.dateFiled ? String(r.dateFiled).slice(0, 10) : null,
    cite_count: r.citeCount || 0,
    snippet: stripTags(op.snippet || r.snippet || "").slice(0, 400),
    url: r.absolute_url ? "https://www.courtlistener.com" + r.absolute_url : null
  };
}

async function search({ query, court, after, before, page }) {
  const courts = court && TX_COURTS[court] ? court : Object.keys(TX_COURTS).join(" ");
  const p = new URLSearchParams({ type: "o", q: query, court: courts, order_by: "score desc" });
  if (after) p.set("filed_after", after);
  if (before) p.set("filed_before", before);
  if (page) p.set("cursor", page);
  const key = "search:" + p.toString();
  const body = await cached(key, SEARCH_TTL_HOURS, async () => {
    const d = await clFetch("/search/?" + p.toString());
    return { count: d.count, next: d.next ? new URL(d.next).searchParams.get("cursor") : null, results: (d.results || []).map(normResult) };
  });
  return body;
}

async function opinion(clusterId) {
  const { rows } = await q("SELECT * FROM opinions WHERE cluster_id=$1", [clusterId]);
  if (rows[0] && rows[0].text) return rows[0];
  const c = await clFetch(`/clusters/${clusterId}/`, { auth: true });
  const subs = c.sub_opinions || [];
  let text = "", opinionId = null;
  for (const s of subs) {
    const id = String(s).match(/opinions\/(\d+)/);
    if (!id) continue;
    const o = await clFetch(`/opinions/${id[1]}/`, { auth: true });
    opinionId = opinionId || o.id;
    const t = o.plain_text || stripTags(o.html_with_citations || o.html || o.html_lawbox || o.html_columbia || o.xml_harvard || "");
    if (t) text += (text ? "\n\n———\n\n" : "") + t.trim();
  }
  const cites = (c.citations || []).map(x => `${x.volume} ${x.reporter} ${x.page}`).join(", ");
  const courtId = (String(c.docket || "").match(/courts\/(\w+)/) || [])[1] || null;
  const rec = {
    cluster_id: clusterId, opinion_id: opinionId, case_name: c.case_name || c.case_name_full,
    citations: cites, court: TX_COURTS[courtId] || null, court_id: courtId, date_filed: c.date_filed || null,
    judges: c.judges || null, text, absolute_url: c.absolute_url ? "https://www.courtlistener.com" + c.absolute_url : null
  };
  await q(`INSERT INTO opinions(cluster_id,opinion_id,case_name,citations,court,court_id,date_filed,judges,text,absolute_url)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT(cluster_id) DO UPDATE SET opinion_id=$2,case_name=$3,citations=$4,court=COALESCE($5,opinions.court),
           court_id=COALESCE($6,opinions.court_id),date_filed=$7,judges=$8,text=$9,absolute_url=$10,fetched_at=now()`,
    [rec.cluster_id, rec.opinion_id, rec.case_name, rec.citations, rec.court, rec.court_id, rec.date_filed, rec.judges, rec.text, rec.absolute_url]);
  return rec;
}

// Our own citator: who cites this opinion, and a flag when citing opinions use negative-treatment language.
async function citator(opinionId) {
  return cached("citator:" + opinionId, 72, async () => {
    const base = `cites:(${opinionId})`;
    const all = await clFetch("/search/?" + new URLSearchParams({ type: "o", q: base, order_by: "dateFiled desc" }));
    const neg = await clFetch("/search/?" + new URLSearchParams({ type: "o", q: `${base} AND (overruled OR overrule OR disapproved OR abrogated OR "superseded by statute")`, order_by: "dateFiled desc" }));
    const negIds = new Set((neg.results || []).map(r => r.cluster_id));
    return {
      cited_by: all.count || 0,
      negative_count: neg.count || 0,
      flag: neg.count ? "caution" : (all.count ? "cited" : "none"),
      citing: (all.results || []).slice(0, 20).map(r => ({ ...normResult(r), negative: negIds.has(r.cluster_id) }))
    };
  });
}

function stripTags(h) {
  return String(h).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n");
}

module.exports = { search, opinion, citator, TX_COURTS, CLError };
