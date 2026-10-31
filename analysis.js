// Rule-based case-law analysis (no AI).
// 1) Builds a search from the attorney's issues for the case.
// 2) Ranks the most relevant Texas authorities (binding court, recency, how often cited).
// 3) For each common procedural path, counts how recent Texas appeals on these issues came out
//    (upheld vs reversed) and ranks the paths. Counts come straight from CourtListener result totals.
const cl = require("./courtlistener");

const PATHS = [
  { key: "msj", label: "Summary judgment", terms: '"summary judgment"' },
  { key: "91a", label: "Rule 91a dismissal (baseless claim)", terms: '"91a"' },
  { key: "plea", label: "Plea to the jurisdiction", terms: '"plea to the jurisdiction"' },
  { key: "arb", label: "Motion to compel arbitration", terms: '"compel arbitration"' },
  { key: "jury", label: "Jury trial", terms: '("jury verdict" OR "jury found")' },
  { key: "bench", label: "Bench trial", terms: '"bench trial"' }
];
const UPHELD = '("we affirm" OR "is affirmed" OR "are affirmed")';
const REVERSED = '("we reverse" OR "is reversed" OR "reverse and remand" OR "reverse and render" OR "reversed and remanded" OR "reversed and rendered")';

function yearsAgo(n) { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); }

// "slip and fall, constructive notice; grocery" -> ("slip and fall") AND ("constructive notice") AND (grocery)
function buildQuery(issues, joiner = "AND") {
  const parts = String(issues || "").split(/[,;\n]+/).map(s => s.trim().replace(/["()]/g, "")).filter(s => s.length > 1).slice(0, 6);
  if (!parts.length) return "";
  return parts.map(p => (/\s/.test(p) ? `("${p}")` : `(${p})`)).join(` ${joiner} `);
}

async function count(query, after, court) {
  const r = await cl.search({ query, after, court });
  return r.count || 0;
}

async function analyze({ issues, county, appeals }) {
  let q = buildQuery(issues, "AND"), mode = "all issues";
  if (!q) throw Object.assign(new Error("Add the case's issues first (e.g. slip and fall, constructive notice, grocery store)."), { status: 400 });
  const since10 = yearsAgo(10), since5 = yearsAgo(5), since3 = yearsAgo(3);

  // Main search — fall back to "any issue" if the all-issues search is too narrow.
  let main = await cl.search({ query: q, after: since10 });
  if ((main.count || 0) < 5) {
    const qOr = buildQuery(issues, "OR");
    const alt = await cl.search({ query: qOr, after: since10 });
    if ((alt.count || 0) > (main.count || 0)) { main = alt; q = qOr; mode = "any issue (all-issues search was too narrow)"; }
  }

  // Rank authorities: Texas Supreme Court > courts of appeals; newer > older; more-cited > less-cited.
  const now = Date.now();
  const authorities = (main.results || []).map(o => {
    const ageYrs = o.date_filed ? (now - new Date(o.date_filed)) / 3.156e10 : 10;
    const court = o.court_id === "tex" ? 3 : o.court_id === "texcrimapp" ? 1 : 1.5;
    const score = court + Math.max(0, 3 - ageYrs / 3) + Math.log10(1 + (o.cite_count || 0));
    return { ...o, score: Math.round(score * 10) / 10, binding: o.court_id === "tex" ? "Binding statewide (Tex. Sup. Ct.)" : `Court of appeals${appeals ? " — check if " + appeals : ""}` };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  // Ways forward: upheld vs reversed counts per path (last 10 years, all Texas courts).
  const paths = [];
  for (const p of PATHS) {
    const base = `(${q}) AND ${p.terms}`;
    const upheld = await count(`${base} AND ${UPHELD}`, since10);
    const reversed = await count(`${base} AND ${REVERSED}`, since10);
    const n = upheld + reversed;
    const rate = n ? upheld / n : 0;
    const confidence = Math.min(1, n / 10);
    paths.push({ ...p, upheld, reversed, n, rate: Math.round(rate * 100), score: Math.round(rate * confidence * 100), enough: n >= 3 });
  }
  paths.sort((a, b) => (b.enough - a.enough) || (b.score - a.score) || (b.n - a.n));

  // Trend for the top path: last 3 years vs the 7 years before.
  let trend = null;
  const top = paths.find(p => p.enough);
  if (top) {
    const base = `(${q}) AND ${top.terms}`;
    const rU = await count(`${base} AND ${UPHELD}`, since3), rR = await count(`${base} AND ${REVERSED}`, since3);
    const recentN = rU + rR, recentRate = recentN ? Math.round((rU / recentN) * 100) : null;
    const olderU = top.upheld - rU, olderR = top.reversed - rR, olderN = olderU + olderR;
    const olderRate = olderN ? Math.round((olderU / olderN) * 100) : null;
    trend = { path: top.label, recentN, recentRate, olderN, olderRate,
      direction: recentRate == null || olderRate == null ? "not enough data" : recentRate > olderRate + 10 ? "more often upheld lately" : recentRate < olderRate - 10 ? "more often reversed lately" : "steady" };
  }

  // Supporting cases for each of the top 3 paths (1 search each, already cached when repeated).
  for (const p of paths.slice(0, 3)) {
    if (!p.n) { p.examples = []; continue; }
    const r = await cl.search({ query: `(${q}) AND ${p.terms}`, after: since5 });
    p.examples = (r.results || []).slice(0, 3).map(o => ({ cluster_id: o.cluster_id, case_name: o.case_name, citation: o.citation, court: o.court, date_filed: o.date_filed }));
  }

  return {
    ran_at: new Date().toISOString(), county, query: q, mode,
    total_opinions: main.count || 0, authorities, paths, trend,
    method: "Counts are Texas opinions from the last 10 years that match your issues and the path, split by whether the appeals court said it affirmed or reversed. This is a statistical starting point from public opinions — read the cases and use your judgment before relying on it."
  };
}

// For the case-law watch: how many new Texas opinions on these issues since a date (1 request).
async function newSince(issues, sinceIso) {
  const q = buildQuery(issues, "AND");
  if (!q) return { count: 0, results: [] };
  const r = await cl.search({ query: q, after: sinceIso.slice(0, 10) });
  return { count: r.count || 0, results: (r.results || []).filter(o => o.date_filed && o.date_filed >= sinceIso.slice(0, 10)).slice(0, 5) };
}

module.exports = { analyze, newSince, buildQuery, PATHS };
