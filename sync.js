// Runs county pulls for each attorney, under that attorney's own court login and bar number.
const { q } = require("./db");
const { CONNECTORS } = require("./counties");
const box = require("./crypto-box");
const MODULES = { odyssey: require("./connectors/odyssey") };

const running = new Set();

async function runSync(loginId, why = "manual") {
  if (running.has(loginId)) return { skipped: "already running" };
  running.add(loginId);
  try {
    const { rows } = await q(`SELECT l.*, u.firm_id, u.name, u.bar_number, u.counties, u.active FROM court_logins l JOIN users u ON u.id=l.user_id WHERE l.id=$1`, [loginId]);
    const l = rows[0];
    if (!l || !l.active) return { skipped: "no login" };
    const conn = CONNECTORS[l.county];
    if (!conn) throw new Error(`No connector for ${l.county} yet.`);
    if (!(l.counties || []).includes(l.county)) throw new Error(`${l.county} isn't in this attorney's counties.`);
    if (!/^\d{8}$/.test(l.bar_number || "")) throw new Error("Attorney needs an 8-digit bar # on their account.");
    await q("UPDATE court_logins SET status='syncing' WHERE id=$1", [loginId]);
    const started = Date.now();
    const w = await q("SELECT cause_no, external_url AS url FROM cases WHERE firm_id=$1 AND county=$2 AND watch_dates AND external_url IS NOT NULL", [l.firm_id, l.county]);
    const out = await MODULES[conn.type].sync({
      baseUrl: conn.url, username: l.username || null, password: l.enc_password ? box.open(l.enc_password) : null,
      barNumber: l.bar_number, attorneyName: l.name, watchUrls: w.rows
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

// Nightly sweep: every 30 min, sync any login not synced in the last 24h, one at a time.
function startScheduler() {
  const tick = async () => {
    try {
      const { rows } = await q("SELECT l.id FROM court_logins l JOIN users u ON u.id=l.user_id WHERE u.active AND (l.last_sync IS NULL OR l.last_sync < now() - interval '24 hours') ORDER BY l.last_sync NULLS FIRST LIMIT 10");
      for (const r of rows) await runSync(r.id, "scheduled");
    } catch (e) { console.error("[sync] scheduler", e.message); }
  };
  setTimeout(tick, 60e3);
  setInterval(tick, 30 * 60e3);
}

module.exports = { runSync, syncUserIfStale, startScheduler, running, MODULES };
