// Rule-based case-law analysis (no AI).
// Uses the local Texas database when it's loaded (no limits, can separate the 13th COA and county of origin);
// otherwise falls back to the CourtListener API.
// 1) Builds a search from the attorney's issues.  2) Ranks authorities (binding court first, recent, cited).
// 3) For each procedural path, counts upheld vs reversed appeals on these issues and ranks the paths.
const cl = require("./courtlistener");
const lawdb = require("./lawdb");

const AFFIRM = ["we affirm", "is affirmed", "are affirmed", "affirm the trial court"];
const REVERSE = ["we reverse", "is reversed", "reverse and remand", "reverse and render", "reversed and remanded", "reversed and rendered"];
const PATHS = [
  { key: "msj", label: "Summary judgment", spec: { all: ["summary judgment"] } },
  { key: "91a", label: "Rule 91a dismissal (baseless claim)", spec: { any: [["rule 91a", "91a motion"]] } },
  { key: "plea", label: "Plea to the jurisdiction", spec: { all: ["plea to the jurisdiction"] } },
  { key: "arb", label: "Motion to compel arbitration", spec: { all: ["compel arbitration"] } },
  { key: "jury", label: "Jury trial", spec: { any: [["jury verdict", "jury found", "the jury returned"]] } },
  { key: "bench", label: "Bench trial", spec: { any: [["bench trial", "nonjury trial"]] } }
];

function yearsAgo(n) { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); }
function phrases(issues) { return String(issues || "").split(/[,;\n]+/).map(s => s.trim().replace(/["()]/g, "")).filter(s => s.length > 1).slice(0, 6); }
function coasFor(appealsLabel) { return [...String(appealsLabel || "").matchAll(/(\d+)(st|nd|rd|th)/g)].map(m => +m[1]); }

// ----- CourtListener string form of a spec -----
const qp = p => (/\s/.test(p) ? `"${p}"` : p);
function clQuery(spec) {
  const parts = [];
  for (const p of spec.all || []) parts.push(qp(p));
  for (const g of spec.any || []) parts.push(`(${g.map(qp).join(" OR ")})`);
  let s = parts.join(" AND ");
  for (const g of spec.none || []) s += ` AND NOT (${g.map(qp).join(" OR ")})`;
  return s;
}
const merge = (...specs) => ({ all: specs.flatMap(s => s.all || []), any: specs.flatMap(s => s.any || []), none: specs.flatMap(s => s.none || []) });

// ----- backend adapters -----
function backend(local) {
  if (local) return {
    name: "Texas case-law database (loaded from CourtListener bulk files)",
    search: (spec, f) => lawdb.search(spec, f, 20),
    count: (spec, f) => lawdb.count(spec, f)
  };
  return {
    name: "CourtListener live search (limited daily lookups)",
    search: async (spec, f) => cl.search({ query: clQuery(spec), after: f.after }),
    count: async (spec, f) => (await cl.search({ query: clQuery(spec), after: f.after })).count || 0
  };
}

async function analyze({ issues, county, appeals }) {
  const ph = phrases(issues);
  if (!ph.length) throw Object.assign(new Error("Add the case's issues first (e.g. slip and fall, constructive notice, grocery store)."), { status: 400 });
  const local = await lawdb.available();
  const B = backend(local);
  const coas = coasFor(appeals);
  const binding = local && coas.length ? { coas } : null;
  const since10 = yearsAgo(10), since5 = yearsAgo(5), since3 = yearsAgo(3);

  let issueSpec = { all: ph }, mode = "all issues";
  let main = await B.search(issueSpec, { after: since10 });
  if ((main.count || 0) < 5 && ph.length > 1) {
    const alt = { any: [ph] };
    const r = await B.search(alt, { after: since10 });
    if ((r.count || 0) > (main.count || 0)) { main = r; issueSpec = alt; mode = "any issue (all-issues search was too narrow)"; }
  }

  // Authorities: binding court first (Tex. Sup. Ct., then this county's court of appeals), recent, cited, same county.
  let pool = main.results || [];
  if (binding) {
    const b = await B.search(issueSpec, { after: since10, binding });
    const seen = new Set(pool.map(o => o.cluster_id));
    pool = pool.concat((b.results || []).filter(o => !seen.has(o.cluster_id)));
  }
  const now = Date.now();
  const authorities = pool.map(o => {
    const ageYrs = o.date_filed ? (now - new Date(o.date_filed)) / 3.156e10 : 10;
    const isBindingCoa = o.court_id === "texapp" && coas.includes(o.coa);
    const court = o.court_id === "tex" ? 3 : isBindingCoa ? 2.5 : o.court_id === "texcrimapp" ? 1 : 1.2;
    const sameCounty = county && o.origin_county === county ? 1 : 0;
    const score = court + sameCounty + Math.max(0, 3 - ageYrs / 3) + Math.log10(1 + (o.cite_count || 0));
    const why = o.court_id === "tex" ? "Binding statewide (Tex. Sup. Ct.)" : isBindingCoa ? `Binding here — ${o.court}` : o.court_id === "texapp" ? `Persuasive — ${o.court}` : o.court;
    return { ...o, score: Math.round(score * 10) / 10, binding: why + (sameCounty ? ` · appeal from ${county} County` : "") };
  }).sort((a, b) => b.score - a.score).slice(0, 10);

  // Ways forward: upheld (affirmed, not reversed) vs reversed, statewide and in the courts that bind this county.
  const paths = [];
  for (const p of PATHS) {
    const base = merge(issueSpec, p.spec);
    const up = merge(base, { any: [AFFIRM], none: [REVERSE] }), rv = merge(base, { any: [REVERSE] });
    const upheld = await B.count(up, { after: since10 }), reversed = await B.count(rv, { after: since10 });
    let bUp = null, bRv = null;
    if (binding) { bUp = await B.count(up, { after: since10, binding }); bRv = await B.count(rv, { after: since10, binding }); }
    const n = upheld + reversed, bn = binding ? bUp + bRv : 0;
    const useBinding = binding && bn >= 3;
    const rate = useBinding ? bUp / bn : (n ? upheld / n : 0);
    const nn = useBinding ? bn : n;
    paths.push({ key: p.key, label: p.label, spec: base, upheld, reversed, n, rate: Math.round(rate * 100),
      binding: binding ? { upheld: bUp, reversed: bRv, n: bn, rate: bn ? Math.round((bUp / bn) * 100) : null } : null,
      basis: useBinding ? "binding courts" : "all Texas courts",
      score: Math.round(rate * Math.min(1, nn / 10) * 100), enough: nn >= 3 });
  }
  paths.sort((a, b) => (b.enough - a.enough) || (b.score - a.score) || (b.n - a.n));

  // Trend for the top path: last 3 years vs the 7 before (statewide).
  let trend = null;
  const top = paths.find(p => p.enough);
  if (top) {
    const up = merge(top.spec, { any: [AFFIRM], none: [REVERSE] }), rv = merge(top.spec, { any: [REVERSE] });
    const rU = await B.count(up, { after: since3 }), rR = await B.count(rv, { after: since3 });
    const recentN = rU + rR, recentRate = recentN ? Math.round((rU / recentN) * 100) : null;
    const olderN = (top.upheld - rU) + (top.reversed - rR), olderRate = olderN > 0 ? Math.round(((top.upheld - rU) / olderN) * 100) : null;
    trend = { path: top.label, recentN, recentRate, olderN, olderRate,
      direction: recentRate == null || olderRate == null ? "not enough data" : recentRate > olderRate + 10 ? "more often upheld lately" : recentRate < olderRate - 10 ? "more often reversed lately" : "steady" };
  }

  // Example cases for the top 3 paths (binding courts first when available).
  for (const p of paths.slice(0, 3)) {
    if (!p.n) { p.examples = []; continue; }
    let r = binding ? await B.search(p.spec, { after: since5, binding }) : null;
    if (!r || !(r.results || []).length) r = await B.search(p.spec, { after: since5 });
    p.examples = (r.results || []).slice(0, 3).map(o => ({ cluster_id: o.cluster_id, case_name: o.case_name, citation: o.citation, court: o.court, date_filed: o.date_filed }));
  }
  paths.forEach(p => delete p.spec);

  return {
    ran_at: new Date().toISOString(), county, appeals: appeals || null, source: B.name,
    query: clQuery(issueSpec), mode, total_opinions: main.count || 0, authorities, paths, trend,
    method: `Counts are Texas opinions from the last 10 years matching your issues and each path: "upheld" = the court affirmed (and didn't reverse); "reversed" = it reversed.${binding ? ` Ranking uses the courts that bind ${county} County (Texas Supreme Court + ${appeals}) when they have at least 3 cases.` : ""} It can't tell which side won — read the cases and use your judgment.`
  };
}

// Case-law watch: new opinions on these issues since a date (1 live lookup per watched case per day).
async function newSince(issues, sinceIso) {
  const ph = phrases(issues);
  if (!ph.length) return { count: 0, results: [] };
  // Live source first (catches brand-new opinions before the monthly database refresh); local DB if the live lookup fails.
  let r;
  try { r = await cl.search({ query: clQuery({ all: ph }), after: sinceIso.slice(0, 10) }); }
  catch (e) { if (!(await lawdb.available())) throw e; r = await lawdb.search({ all: ph }, { after: sinceIso.slice(0, 10) }, 10); }
  return { count: r.count || 0, results: (r.results || []).filter(o => o.date_filed && o.date_filed >= sinceIso.slice(0, 10)).slice(0, 5) };
}

module.exports = { analyze, newSince, PATHS, phrases, clQuery };
