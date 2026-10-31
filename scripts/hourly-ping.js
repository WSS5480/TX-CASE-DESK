// Render cron job (hourly): wakes the web app and starts the court-date check on watched cases.
const URL_ = (process.env.APP_URL || "https://tx-case-desk.onrender.com") + "/api/cron/hourly";
(async () => {
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(URL_, { method: "POST", headers: { "X-Cron-Token": process.env.SYNC_TOKEN || "", "X-Requested-With": "tcd" }, signal: AbortSignal.timeout(90000) });
      const body = await r.text();
      console.log(`attempt ${i}: ${r.status} ${body}`);
      if (r.ok) process.exit(0);
      if (r.status === 403) process.exit(1); // wrong token — retrying won't help
    } catch (e) { console.log(`attempt ${i}: ${e.message}`); }
    await new Promise(r => setTimeout(r, 20000));
  }
  process.exit(1);
})();
