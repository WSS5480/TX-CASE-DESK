# TX Case Desk

Pending cases by county + Texas case law for attorneys. Node/Express + Postgres, built for Render.

## What's in it
- **Firm accounts & attorney logins** – bcrypt passwords, required 2FA (authenticator app), 8-hour sessions, login rate limiting, audit log of every sign-in and change.
- **Firm seats** – admins add attorneys/paralegals (temp password shown once → user sets own password + 2FA), reset, disable.
- **County rule** – each user picks counties (all 254); they only see/add cases in those counties, plus cases they explicitly track.
- **Pending cases** – add/edit, CSV import, track, appellate court mapping. County auto-feeds are added one county at a time (`counties.js` → `CONNECTORS`).
- **Case law** – live search of public Texas opinions (Supreme Court, Courts of Appeals, Court of Criminal Appeals) via CourtListener API v4, full opinion text, our own citator (citing references + negative-treatment flag), save research to a case. Everything is cached in Postgres.

## Render setup
1. Postgres: create a database, copy its **Internal Database URL**.
2. Web service from this repo: build `npm install`, start `npm start`.
3. Environment variables:
   - `DATABASE_URL` – internal DB URL
   - `SESSION_SECRET` – long random string
   - `NODE_ENV` – `production`
   - `COURTLISTENER_TOKEN` – free token from courtlistener.com → Profile → API
4. Open the site → **Create firm account** → scan the 2FA QR.

## Notes
- Free CourtListener accounts are limited (~125 requests/day as of May 2026). Results are cached; for scale, load Texas opinions from CourtListener's free bulk files or get a Free Law Project membership.
- Opinions are public domain. Do not import Lexis/Westlaw headnotes, summaries or citator data.
- The free Render database expires after 30 days — upgrade before real attorneys use it.
