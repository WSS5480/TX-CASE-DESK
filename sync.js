// Runs county pulls for each attorney, under that attorney's own court login and bar number.
const { q } = require("./db");
const { CONNECTORS } = require("./counties");
const box = require("./crypto-box");
const MODULES = { odyssey: require("./connectors/odyssey") };

const running = new Set();

async function runSync(loginId, why = "manual", { watchOnly = false } = {}) {
  if (running.has(loginId)) return { skipped: "already running" };
  running.add(loginId);
  try {
    const { rows } = await q(`SELECT l.*, u.firm_id, u.name, u.bar_number, u.counties, u.active FROM court_logins l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [loginId]);
    const l = rows[0];
    if (!l || !l.active) return { skipped: "no login" };
    const conn = CONNECTORS[l.county];
    if (!conn) throw new Error(`No connector for ${l.county} yet.`);
    if (conn.status === "blocked") throw new Error(conn.note || `${l.county} portal is blocking automatic pulls.`);
    if (!(l.counties || []).includes(l.county)) throw new Error(`${l.county} isn't in this attorney's counties.`);
    if (!/^\d{8}$/.test(l.bar_number || "")) throw new Error("Attorney needs an 8-digit bar # on their account.");
    await q("UPDATE court_logins SET status='syncing' WHERE id=$1", [loginId]);
    const started = Date.now();
    const w = await q("SELECT cause_no, external_url AS url FROM cases WHERE firm_id=$1 AND county=$2 AND watch_dates AND external_url IS NOT NULL", [l.firm_id, l.county]);
    const out = await MODULES[conn.type].sync({
      baseUrl: conn.url, username: l.username || null, password: l.enc_password ? box.open(l.enc_password) : null,
      barNumber: l.bar_number, attorneyName: l.name, watchUrls: w.rows, watchOnly
    });
    let added = 0, updated = 0, dateChanges = 0;
    for (const c of out.cases) {
      // Court-date change detection (compare before we overwrite)
      const prev = (await q("SELECT id, next_setting, watch_dates FROM cases WHERE firm_id=$1 AND county=$2 AND cause_no=$3", [l.firm_id, l.county, c.cause_no])).rows[0];
      if (prev && c.next_setting && prev.next_setting !== c.next_setting) {
        await q("INSERT INTO case_changes(case_id, field, old_value, new_value) VALUES($1,'next_setting',$2,$3)", [prev.id, prev.next_setting, c.next_setting]);
        if (prev.watch_dates) {
          await q("UPDATE cases SET date_alert=$2, date_alert_at=now() WHERE id=$1", [prev.id, `${prev.next_setting || "No setting"} → ${c.next_setting}`]);
          dateChanges++;
        }
      }
      const r = await q(`INSERT INTO cases(firm_id,user_id,county,cause_no,court,style,case_type,filed_date,status,next_setting,external_url,source,last_synced)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'county_sync',now())
        ON CONFLICT(firm_id,county,cause_no) DO UPDATE SET
          court=COALESCE(EXCLUDED.court,cases.court), style=COALESCE(EXCLUDED.style,cases.style), case_type=COALESCE(EXCLUDED.case_type,cases.case_type),
          filed_date=COALESCE(EXCLUDED.filed_date,cases.filed_date), status=COALESCE(EXCLUDED.status,cases.status),
          next_setting=COALESCE(EXCLUDED.next_setting,cases.next_setting), external_url=COALESCE(EXCLUDED.external_url,cases.external_url), user_id=COALESCE(cases.user_id,EXCLUDED.user_id),
          last_synced=now(), updated_at=now()
        RETURNING (xmax = 0) AS inserted`,
        [l.firm_id, l.user_id, l.county, c.cause_no, c.court, c.style, c.case_type, c.filed_date, c.status, c.next_setting, c.external_url || null]);
      r.rows[0]?.inserted ? added++ : updated++;
    }
    if (watchOnly) { // light run: don't overwrite the full-pull summary
      await q("UPDATE court_logins SET status='ok', last_error=NULL, last_result = COALESCE(last_result,'{}'::jsonb) || $2 WHERE id=$1", [loginId, { last_watch_check: new Date().toISOString(), last_watch_changes: dateChanges }]);
      console.log(`[sync] hourly watch ${l.county} login ${loginId}: ${out.cases.length} checked, ${dateChanges} date change(s)`);
      return { watched: out.cases.length, date_changes: dateChanges };
    }
    const result = { why, found: out.cases.length, added, updated, date_changes: dateChanges, notes: out.notes, seconds: Math.round((Date.now() - started) / 1000) };
    await q("UPDATE court_logins SET status='ok', last_sync=now(), last_result=$2, last_error=NULL WHERE id=$1", [loginId, result]);
    await q("INSERT INTO audit_log(user_id, firm_id, action, detail) VALUES($1,$2,'county_sync',$3)", [l.user_id, l.firm_id, { county: l.county, ...result }]);
    console.log(`[sync] login ${loginId} ${l.county}: found ${out.cases.length}, +${added}, ~${updated}`, out.notes.join(" | "));
    return result;
  } catch (e) {
    console.error(`[sync] login ${loginId} failed: ${e.message}`, e.diag ? "\n  " + e.diag.join("\n  ") : "");
    await q("UPDATE court_logins SET status='error', last_sync=now(), last_error=$2 WHERE id=$1", [loginId, e.message.slice(0, 500)]).catch(() => {});
    return { error: e.message };
  } finally { running.delete(loginId); }
}

// Sync one attorney's logins if they're stale (called right after they sign in).
async function syncUserIfStale(userId, hours = 6) {
  const { rows } = await q("SELECT id FROM court_logins WHERE user_id=$1 AND (last_sync IS NULL OR last_sync < now() - ($2 || ' hours')::interval)", [userId, String(hours)]);
  for (const r of rows) await runSync(r.id, "login");
}

// In-process hourly timer.
function startScheduler() {
  // Runs while the server is awake; the free GitHub Actions ping (.github/workflows/hourly.yml) wakes it every hour.
  const tick = () => hourly().catch(e => console.error("[sync] scheduler", e.message));
  setInterval(tick, 60 * 60e3);
}

// Case-law watch: once a day per ticked case, look for new Texas opinions on its issues (1 search each).
async function lawWatch() {
  const analysis = require("./analysis");
  const { rows } = await q(`SELECT id, issues, law_checked_at, created_at FROM cases
    WHERE law_watch AND issues IS NOT NULL AND issues <> '' AND firm_id NOT IN (SELECT id FROM firms WHERE demo_until IS NOT NULL) AND (law_checked_at IS NULL OR law_checked_at < now() - interval '24 hours')
    ORDER BY law_checked_at NULLS FIRST LIMIT 20`);
  let n = 0;
  for (const c of rows) {
    const since = (c.law_checked_at || new Date(Date.now() - 7 * 864e5)).toISOString();
    try {
      const r = await analysis.newSince(c.issues, since);
      if (r.results.length) {
        const names = r.results.map(o => `${o.case_name} (${o.court}, ${o.date_filed})`).join("; ");
        await q("UPDATE cases SET law_alert=$2, law_alert_at=now() WHERE id=$1", [c.id, `${r.results.length} new Texas opinion(s) on your issues: ${names}`]);
      }
      await q("UPDATE cases SET law_checked_at=now() WHERE id=$1", [c.id]);
      n++;
    } catch (e) { console.error("[lawWatch]", c.id, e.message); if (e.status === 429) break; }
  }
  return n;
}

// Hourly: re-check court dates on watched cases (light), plus any full pull that's over 24h old.
let hourlyRunning = false;
async function hourly() {
  if (hourlyRunning) return { skipped: "already running" };
  hourlyRunning = true;
  const summary = { watch_checks: 0, full_pulls: 0 };
  try {
    await require("./demo").cleanup().catch(e => console.warn("[demo] cleanup:", e.message));   // the free server sleeps; the hourly ping also clears old demos
    const w = await q(`SELECT DISTINCT l.id FROM court_logins l JOIN users u ON u.id=l.user_id
      JOIN cases c ON c.firm_id=u.firm_id AND c.county=l.county AND c.watch_dates AND c.external_url IS NOT NULL
      WHERE u.active AND l.status <> 'syncing'`);
    for (const r of w.rows) { await runSync(r.id, "hourly", { watchOnly: true }); summary.watch_checks++; }
    const f = await q("SELECT l.id FROM court_logins l JOIN users u ON u.id=l.user_id WHERE u.active AND (l.last_sync IS NULL OR l.last_sync < now() - interval '24 hours') LIMIT 10");
    for (const r of f.rows) { await runSync(r.id, "scheduled"); summary.full_pulls++; }
    summary.law_checks = await lawWatch();
    try { const m = require("./mail"); summary.mailboxes = await m.syncAll(); summary.firms = await m.syncAllFirms(); } catch (e) { console.error("[mail] hourly", e.message); }
  } finally { hourlyRunning = false; }
  console.log("[sync] hourly done", JSON.stringify(summary));
  return summary;
}

module.exports = { hourly, runSync, syncUserIfStale, startScheduler, running, MODULES };
