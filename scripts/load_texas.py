#!/usr/bin/env python3
"""Texas case-law loader (runs on GitHub Actions).

Streams CourtListener bulk CSV files (bz2, PostgreSQL COPY format) from stdin, keeps only Texas
appellate opinions from the last N years, tags each with its Court of Appeals district (from the
docket number, e.g. 13-24-00123-CV -> 13th) and the trial county it came from, then sends them to
the TX Case Desk app in batches.

Steps (each reads one bulk file on stdin):
  dockets   -> tx_dockets.tsv           (Texas docket id, court, docket number)
  clusters  -> tx_clusters.jsonl        (decisions in the date range)   needs tx_dockets.tsv
  citations -> tx_clusters.jsonl        (adds reporter cites, e.g. 123 S.W.3d 456)
  opinions  -> app /api/ingest/opinions + tx_opinion_ids.txt
  citemap   -> app /api/ingest/cites    (who-cites-whom among Texas opinions)
"""
import csv, gzip, html, io, json, os, re, sys, time, urllib.request
from datetime import date

TX_COURTS = {"tex", "texapp", "texcrimapp"}
APP = os.environ.get("APP_URL", "https://tx-case-desk.onrender.com").rstrip("/")
TOKEN = os.environ.get("SYNC_TOKEN", "").strip()
YEARS = int(os.environ.get("YEARS", "15"))
CUTOFF = os.environ.get("CUTOFF") or date(date.today().year - YEARS, date.today().month, 1).isoformat()
HERE = os.path.dirname(os.path.abspath(__file__))

csv.field_size_limit(sys.maxsize)


def counties():
    src = open(os.path.join(HERE, "..", "counties.js"), encoding="utf-8").read()
    arr = re.search(r"const COUNTIES = (\[.*?\]);", src, re.S).group(1)
    return set(json.loads(arr))


COUNTIES = counties()


def post(path, payload, tries=8):
    body = gzip.compress(json.dumps(payload).encode())
    for i in range(tries):
        try:
            req = urllib.request.Request(APP + path, data=body, method="POST", headers={
                "Content-Type": "application/json", "Content-Encoding": "gzip",
                "X-Cron-Token": TOKEN, "X-Requested-With": "tcd"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read() or b"{}")
        except Exception as e:  # app asleep / deploying / busy -> back off and retry
            if getattr(e, "code", None) == 403:
                sys.exit("App rejected SYNC_TOKEN (403) — check the GitHub secret.")
            wait = min(120, 10 * (i + 1))
            print(f"post {path} failed ({e}); retry in {wait}s", file=sys.stderr, flush=True)
            time.sleep(wait)
    sys.exit(f"Giving up posting to {path}")


def log(msg):
    print(msg, flush=True)
    try:
        post("/api/ingest/log", {"msg": msg}, tries=3)
    except SystemExit:
        pass


def rows():
    """CSV rows from stdin as dicts (PostgreSQL COPY csv with ESCAPE '\\')."""
    f = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", newline="")
    rd = csv.reader(f, quotechar='"', escapechar="\\", doublequote=False, strict=False)
    head = next(rd)
    return head, rd


def get(r, idx, name, default=""):
    i = idx.get(name)
    return r[i] if i is not None and i < len(r) else default


TAG = re.compile(r"<[^>]+>")
WS = re.compile(r"[ \t\r\f\v]+")
COA_RE = re.compile(r"^\s*(\d{1,2})-\d{2}-\d{3,6}")
APPEAL_COUNTY = re.compile(r"(?:appeal\w*|review)\s+from[^.;]{0,200}?\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+County", re.S)
ANY_COUNTY = re.compile(r"\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+County,\s*Texas")


def clean(h):
    t = TAG.sub(" ", h.replace("</p>", "\n\n").replace("<br>", "\n").replace("<br/>", "\n"))
    t = html.unescape(t)
    t = WS.sub(" ", t)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", t).strip()


def origin_county(text):
    head = text[:8000]
    for rx in (APPEAL_COUNTY, ANY_COUNTY):
        for m in rx.finditer(head):
            name = m.group(1).strip()
            for cand in (name, name.split()[-1]):  # "Hidalgo" or "of Hidalgo" style captures
                if cand in COUNTIES:
                    return cand
    return None


def step_dockets():
    head, rd = rows()
    idx = {h: i for i, h in enumerate(head)}
    log(f"dockets header: {head[:40]}")
    n = keep = 0
    with open("tx_dockets.tsv", "w", encoding="utf-8") as out:
        for r in rd:
            n += 1
            court = get(r, idx, "court_id")
            if court in TX_COURTS:
                keep += 1
                out.write(f"{get(r, idx, 'id')}\t{court}\t{get(r, idx, 'docket_number').replace(chr(9), ' ').replace(chr(10), ' ')}\n")
            if n % 5_000_000 == 0:
                log(f"dockets: read {n:,}, Texas {keep:,}")
    log(f"dockets done: read {n:,}, Texas dockets {keep:,}")


def load_dockets():
    d = {}
    for line in open("tx_dockets.tsv", encoding="utf-8"):
        i, court, dn = line.rstrip("\n").split("\t", 2)
        d[i] = (court, dn)
    return d


def step_clusters():
    dk = load_dockets()
    head, rd = rows()
    idx = {h: i for i, h in enumerate(head)}
    log(f"clusters header: {head[:40]} — cutoff {CUTOFF}, Texas dockets {len(dk):,}")
    n = keep = 0
    with open("tx_clusters.jsonl", "w", encoding="utf-8") as out:
        for r in rd:
            n += 1
            d = dk.get(get(r, idx, "docket_id"))
            filed = get(r, idx, "date_filed")
            if not d or not filed or filed < CUTOFF:
                continue
            court, dn = d
            m = COA_RE.match(dn or "")
            coa = int(m.group(1)) if (court == "texapp" and m and 1 <= int(m.group(1)) <= 15) else None
            name = get(r, idx, "case_name") or get(r, idx, "case_name_short") or get(r, idx, "case_name_full")
            try:
                cc = int(get(r, idx, "citation_count") or 0)
            except ValueError:
                cc = 0
            out.write(json.dumps({"id": get(r, idx, "id"), "court_id": court, "coa": coa, "docket_number": dn,
                                  "case_name": name[:500], "date_filed": filed[:10], "judges": get(r, idx, "judges")[:300],
                                  "cite_count": cc, "precedential": get(r, idx, "precedential_status")}) + "\n")
            keep += 1
            if n % 2_000_000 == 0:
                log(f"clusters: read {n:,}, kept {keep:,}")
    log(f"clusters done: read {n:,}, Texas decisions since {CUTOFF}: {keep:,}")


def load_clusters():
    return {c["id"]: c for c in (json.loads(l) for l in open("tx_clusters.jsonl", encoding="utf-8"))}


def step_citations():
    cl = load_clusters()
    head, rd = rows()
    idx = {h: i for i, h in enumerate(head)}
    log(f"citations header: {head[:20]}")
    cites = {}
    for r in rd:
        cid = get(r, idx, "cluster_id")
        if cid in cl:
            cites.setdefault(cid, []).append(f"{get(r, idx, 'volume')} {get(r, idx, 'reporter')} {get(r, idx, 'page')}".strip())
    with open("tx_clusters.jsonl", "w", encoding="utf-8") as out:
        for cid, c in cl.items():
            c["citations"] = ", ".join(cites.get(cid, []))[:300]
            out.write(json.dumps(c) + "\n")
    log(f"citations done: {len(cites):,} of {len(cl):,} decisions have reporter cites")


TEXT_FIELDS = ["html_with_citations", "html", "html_lawbox", "html_columbia", "xml_harvard", "html_anon_2020"]


def step_opinions():
    cl = load_clusters()
    head, rd = rows()
    idx = {h: i for i, h in enumerate(head)}
    log(f"opinions header: {head[:40]} — Texas decisions to match: {len(cl):,}")
    batch, size, sent, n, counties_found = [], 0, 0, 0, 0
    ids = open("tx_opinion_ids.txt", "w")
    for r in rd:
        n += 1
        c = cl.get(get(r, idx, "cluster_id"))
        if c:
            text = get(r, idx, "plain_text")
            if not text.strip():
                for f in TEXT_FIELDS:
                    v = get(r, idx, f)
                    if v.strip():
                        text = clean(v)
                        break
            text = text[:1_000_000]
            county = origin_county(text) if c["court_id"] == "texapp" else None
            counties_found += 1 if county else 0
            oid = get(r, idx, "id")
            batch.append({"opinion_id": int(oid), "cluster_id": int(c["id"]), "court_id": c["court_id"], "coa": c["coa"],
                          "origin_county": county, "docket_number": c["docket_number"], "case_name": c["case_name"],
                          "date_filed": c["date_filed"], "citations": c.get("citations", ""), "judges": c["judges"],
                          "cite_count": c["cite_count"], "precedential": c["precedential"], "op_type": get(r, idx, "type"), "text": text})
            ids.write(oid + "\n")
            size += len(text)
            if len(batch) >= 150 or size > 8_000_000:
                post("/api/ingest/opinions", {"rows": batch})
                sent += len(batch)
                batch, size = [], 0
                if sent % 3000 < 150:
                    log(f"opinions: scanned {n:,}, sent {sent:,} Texas opinions ({counties_found:,} with county of origin)")
    if batch:
        post("/api/ingest/opinions", {"rows": batch})
        sent += len(batch)
    ids.close()
    log(f"opinions done: scanned {n:,}, sent {sent:,} Texas opinions, county of origin found on {counties_found:,}")


def step_citemap():
    ids = set(l.strip() for l in open("tx_opinion_ids.txt"))
    head, rd = rows()
    idx = {h: i for i, h in enumerate(head)}
    log(f"citation-map header: {head} — Texas opinions: {len(ids):,}")
    batch, sent, n = [], 0, 0
    for r in rd:
        n += 1
        a, b = get(r, idx, "citing_opinion_id"), get(r, idx, "cited_opinion_id")
        if a in ids and b in ids:
            try:
                batch.append([int(a), int(b), int(get(r, idx, "depth") or 1)])
            except ValueError:
                continue
            if len(batch) >= 20000:
                post("/api/ingest/cites", {"rows": batch})
                sent += len(batch)
                batch = []
    if batch:
        post("/api/ingest/cites", {"rows": batch})
        sent += len(batch)
    log(f"citation map done: scanned {n:,}, Texas-to-Texas citations {sent:,}")
    post("/api/ingest/done", {"opinions": len(ids), "cites": sent})


if __name__ == "__main__":
    if not TOKEN:
        sys.exit("SYNC_TOKEN not set")
    {"dockets": step_dockets, "clusters": step_clusters, "citations": step_citations,
     "opinions": step_opinions, "citemap": step_citemap}[sys.argv[1]]()
