// Local Texas case-law engine (Postgres full-text search over tx_opinions loaded from bulk files).
// Used instead of the CourtListener API once the database is loaded — no daily limits.
const { q } = require("./db");

const COURT_NAMES = { tex: "Supreme Court of Texas", texcrimapp: "Texas Court of Criminal Appeals", texapp: "Texas Court of Appeals" };
const ORD = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th", "10th", "11th", "12th", "13th", "14th", "15th"];
function courtLabel(r) { return r.court_id === "texapp" && r.coa ? `${ORD[r.coa]} Court of Appeals` : COURT_NAMES[r.court_id] || r.court_id; }

let cache = { n: 0, at: 0 };
async function size() {
  if (Date.now() - cache.at < 10 * 60e3) return cache.n;
  const { rows } = await q("SELECT count(*)::int n FROM tx_opinions");
  cache = { n: rows[0].n, at: Date.now() };
  return cache.n;
}
async function available() { try { return (await size()) >= +(process.env.LAWDB_MIN || 1000); } catch (e) { return false; } }

// spec: { all: ["slip and fall", ...], any: [["we affirm","is affirmed"], ...], text: "free websearch text" }
function tsquerySql(spec, params) {
  const parts = [];
  for (const p of spec.all || []) { params.push(p); parts.push(`phraseto_tsquery('english', $${params.length})`); }
  for (const group of spec.any || []) {
    const ors = group.map(p => { params.push(p); return `phraseto_tsquery('english', $${params.length})`; });
    parts.push(`(${ors.join(" || ")})`);
  }
  for (const group of spec.none || []) {
    const ors = group.map(p => { params.push(p); return `phraseto_tsquery('english', $${params.length})`; });
    parts.push(`!!(${ors.join(" || ")})`);
  }
  if (spec.text) { params.push(spec.text); parts.push(`websearch_to_tsquery('english', $${params.length})`); }
  return parts.length ? parts.join(" && ") : null;
}
// filters: { court: 'tex'|'texapp'|'texcrimapp', coa: 13, binding: {coa}, county, after }
function whereSql(f, params) {
  const w = [];
  if (f.binding) { params.push(f.binding.coas || []); w.push(`(court_id='tex' OR (court_id='texapp' AND coa = ANY($${params.length}::int[])))`); }
  if (f.court) { params.push(f.court); w.push(`court_id=$${params.length}`); }
  if (f.coa) { params.push(+f.coa); w.push(`coa=$${params.length}`); }
  if (f.county) { params.push(f.county); w.push(`origin_county=$${params.length}`); }
  if (f.after) { params.push(f.after); w.push(`date_filed >= $${params.length}`); }
  return w;
}

async function search(spec, f = {}, limit = 20) {
  const params = []; const tq = tsquerySql(spec, params);
  if (!tq) return { count: 0, results: [] };
  const w = whereSql(f, params);
  const where = `tsv @@ (${tq})` + (w.length ? " AND " + w.join(" AND ") : "");
  const cnt = await q(`SELECT count(DISTINCT cluster_id)::int n FROM tx_opinions WHERE ${where}`, params);
  params.push(limit);
  const { rows } = await q(`
    WITH hits AS (
      SELECT cluster_id, max(ts_rank_cd(tsv, ${tq})) AS rank FROM tx_opinions WHERE ${where}
      GROUP BY cluster_id ORDER BY rank DESC LIMIT $${params.length}
    )
    SELECT DISTINCT ON (o.cluster_id) o.cluster_id, o.opinion_id, o.case_name, o.citations, o.court_id, o.coa, o.origin_county,
      o.docket_number, o.date_filed, o.cite_count, h.rank,
      ts_headline('english', left(o.text, 20000), ${tq}, 'MaxWords=40, MinWords=15, MaxFragments=1, StartSel="", StopSel=""') AS snippet
    FROM hits h JOIN tx_opinions o ON o.cluster_id=h.cluster_id
    ORDER BY o.cluster_id, o.op_type`, params);
  const results = rows.map(r => ({
    cluster_id: +r.cluster_id, opinion_id: +r.opinion_id, case_name: r.case_name, citation: r.citations || r.docket_number || "",
    court: courtLabel(r), court_id: r.court_id, coa: r.coa, origin_county: r.origin_county,
    date_filed: r.date_filed ? r.date_filed.toISOString().slice(0, 10) : null, cite_count: r.cite_count || 0,
    snippet: (r.snippet || "").replace(/\s+/g, " ").trim(), rank: +r.rank, url: `https://www.courtlistener.com/opinion/${r.cluster_id}/x/`
  })).sort((a, b) => b.rank - a.rank);
  return { count: cnt.rows[0].n, results, source: "local" };
}

async function count(spec, f = {}) {
  const params = []; const tq = tsquerySql(spec, params);
  if (!tq) return 0;
  const w = whereSql(f, params);
  const { rows } = await q(`SELECT count(DISTINCT cluster_id)::int n FROM tx_opinions WHERE tsv @@ (${tq})${w.length ? " AND " + w.join(" AND ") : ""}`, params);
  return rows[0].n;
}

async function opinion(clusterId) {
  const { rows } = await q("SELECT * FROM tx_opinions WHERE cluster_id=$1 ORDER BY op_type, opinion_id", [clusterId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    cluster_id: +r.cluster_id, opinion_id: +r.opinion_id, case_name: r.case_name, citations: r.citations || r.docket_number,
    court: courtLabel(r), court_id: r.court_id, coa: r.coa, origin_county: r.origin_county, docket_number: r.docket_number,
    date_filed: r.date_filed ? r.date_filed.toISOString().slice(0, 10) : null, judges: r.judges,
    text: rows.map(x => x.text).filter(Boolean).join("\n\n———\n\n"),
    absolute_url: `https://www.courtlistener.com/opinion/${r.cluster_id}/x/`, opinion_ids: rows.map(x => +x.opinion_id)
  };
}

// Citator from the bulk citation map: who cites this decision, and whether citing opinions use negative-treatment language.
async function citator(clusterId) {
  const { rows } = await q(`
    SELECT DISTINCT ON (c.cluster_id) c.cluster_id, c.opinion_id, c.case_name, c.citations, c.docket_number, c.court_id, c.coa, c.date_filed,
      (c.tsv @@ to_tsquery('english', 'overrul:* | disapprov:* | abrogat:* | supersed:*')) AS negative
    FROM tx_opinions o JOIN tx_cites x ON x.cited=o.opinion_id JOIN tx_opinions c ON c.opinion_id=x.citing
    WHERE o.cluster_id=$1 ORDER BY c.cluster_id, c.date_filed DESC`, [clusterId]);
  const citing = rows.map(r => ({ cluster_id: +r.cluster_id, case_name: r.case_name, citation: r.citations || r.docket_number || "", court: courtLabel(r),
    date_filed: r.date_filed ? r.date_filed.toISOString().slice(0, 10) : null, negative: r.negative })).sort((a, b) => String(b.date_filed).localeCompare(String(a.date_filed)));
  const neg = citing.filter(c => c.negative).length;
  return { cited_by: citing.length, negative_count: neg, flag: neg ? "caution" : citing.length ? "cited" : "none", citing: citing.slice(0, 30), source: "local" };
}

async function stats() {
  const { rows } = await q(`SELECT court_id, coa, count(DISTINCT cluster_id)::int n, min(date_filed) first, max(date_filed) last FROM tx_opinions GROUP BY 1,2 ORDER BY 1,2`);
  return rows;
}

module.exports = { available, size, search, count, opinion, citator, stats, courtLabel, ORD };
