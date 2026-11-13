# TX Case Desk: HANDOFF

Start here. Read this before touching anything.

> **Status of this file:** updated Nov 13, 2026 (assistant plan Phases 1 and 2 built in the working tree, **not yet reviewed, committed or shipped**: see the change log and open items). **Next:** independent review of the AI build (section 3, review routine), then ship; then build section 1 (David's notes) to Steve's answers. Keep this file updated in the same commit as every change (Steve's standing rule).

## 1. Incoming work: David's case-management notes (handed off Nov 13, 2026)

Steve sent in attorney David Solis's "Case Management Software: Development Notes" (Nov 6, updated Nov 12, 2026).

- Full text: `docs/david-notes/2026-11-12-case-management-notes.md`
- Original PDF: `docs/david-notes/2026-11-12-case-management-development-notes.pdf`

**Nothing in the notes is built yet** (checked against `main` at `0417325`, Nov 11). Nothing has been decided either: the 13 open questions in David's notes are unanswered. Don't log any of this in the Decision Log as decided until Steve or David says so.

### What the notes ask for, against the code as it stands

| David's ask | Where it lands today | Gap |
|---|---|---|
| Case module opens to a list only; click opens the matter | `casesView()` / `caseCard()` in `public/app.js`; matter is `caseHub()` in `public/practice.js` | Check what else shows on open and strip it to the list |
| Sort: most recently opened first | List sorts by stage order today (`STAGES` in `server.js`) | New sort. "Opened" is ambiguous, see question A |
| Row shows client name + style + file number; search by client and style | `cases` has `style` and `cause_no` only | No `client_name`, no internal file number. New columns, add to `CASE_COLS`, list row, search |
| Keep cause number, add separate internal file number | `cause_no` is part of `UNIQUE (firm_id, county, cause_no)`; pre-filing cases get a `PRE-…` number | Add `file_no` beside it. Decide numbering (typed by hand or auto) |
| Appeals tab can go if short on room | "Appeals to" shows in `caseCard()`; look for an Appeals tab in the case hub | Optional. Only remove if space is actually tight |
| Notes renamed Synopsis, with set fields | Case hub has a "Notes" box using `richEditor("notes", …)` (`practice.js` ~line 668); `cases.notes` is one text column | New fields: date of loss, SOL date, summary (multi-line), total medicals / damages, insurance info, client DOB + SSN |
| Summary keeps Enter = new line | `richEditor` already does this | Keep it when the box is renamed |
| SOL deadline field | `deadlines.js` and `events` exist | Add the SOL date to the case, and it should feed the deadline calendar and alerts. Missing an SOL is the worst thing this app could let happen |
| 2–3 ticklers under Notes | `tasks` and `events` tables exist | Show the next 2–3 upcoming deadlines/tasks under the Synopsis |
| Status dropdown: Intake, Property Damage, Treating, Demand Sent, Negotiating, Review for Suit, Suit Filed, Discovery, Mediation, Trial | The app has two things: `status` (what the court says) and `stage` (the firm's own, 12 values in `STAGES`, with `PRE_FILING`, `closed_at`, `stage_before_close` hanging off it) | David's list is a personal-injury list and has no Settled/Closed. It replaces or sits beside `stage`, see question B |
| Dictation on every typing line | `dictate.js` + the mic in `public/app.js`; fields can opt out with `data-nomic` | Sweep for inputs that don't have the mic. **SSN and DOB fields must opt out** (see below) |
| Notes "more than free text" | `case_convos` and `activity.js` (the Nov 11 activity timeline) already give dated, authored entries | May already be covered. Ask David before building, question C |
| Contacts get DOB and SSN | `contacts` table: no such columns | New columns, SSN encrypted |
| Contact types: Client, Opposing Party / Defendant, Attorney, Witness, Medical Provider, Litigation Support, Other | `contacts.kind` is `client / opposing / witness / other`; `case_contacts.role` is `client / opposing party / opposing counsel / witness / other` | Widen both lists and migrate old values. Conflict check (`practice.js` ~line 431) must keep working across the new types |

### Social security numbers: handle with care

This is the one part that can hurt someone if it's done loosely. Recommended (not yet approved by Steve):

- **Encrypt at rest.** `crypto-box.js` already does AES-256-GCM with `CRED_KEY` for court passwords. Use the same approach; never store an SSN in a plain column.
- **Mask on screen** (`•••-••-1234`), with a deliberate "show" action limited by role (`access.js`).
- **Audit every reveal and every change** in `audit_log`.
- **Keep it out of everything else:** search indexes, the activity timeline, `case_changes`, CSV exports, the client portal, server logs, error messages, and any AI call.
- **No dictation on SSN/DOB fields.** `dictate.js` sends dictated text to the Anthropic API for cleanup. Mark those inputs `data-nomic`.
- **Conflict checks by SSN** should compare without displaying the number (e.g. a keyed hash stored beside the encrypted value).
- David wants the SSN in two places (the contact and the Synopsis). Store it once, on the client contact, and have the Synopsis read it from there.
- The database is now on a paid plan (Nov 13), so real SSNs can be stored once the encryption above is built.

### Answers (Steve, Nov 13, 2026): build to these

| Q | Answer |
|---|---|
| A. List order | **Last clicked, per person.** Each user sees the cases *they* opened most recently at the top. |
| B. Status list | **Per practice area.** Personal-injury cases (case type "Civil – Personal Injury") use David's list **plus Settled and Closed** at the end: Intake, Property Damage, Treating, Demand Sent, Negotiating, Review for Suit, Suit Filed, Discovery, Mediation, Trial, Settled, Closed. Other case types keep the current 12 stages. Closed still moves a case to Closed cases. |
| C. Running notes | **Conversations log** (dated, authored, searchable, in the Activity log; "Note to file" type). Rename the tab "Notes & conversations". Synopsis is the fixed snapshot. |
| D. SSN | Encrypted at rest, masked `•••-••-1234`, every reveal/change audited, no dictation, never in search / activity / exports / AI / logs. Full number revealed by **attorneys and firm admins only**; paralegals see last 4. Stored once on the contact; Synopsis reads the client's. Conflict check by keyed hash. |
| E. File number | **Auto-assigned, editable** (e.g. 2026-0042). |
| F. Synopsis money / insurance | **Two figures** (total medicals, total damages). Insurance: company, claim #, adjuster name / phone / email, policy limits, for **both** the client's and the defendant's carriers. |
| G. Contact types | **Opposing Counsel and Co-Counsel as separate types**; a contact can hold **several types**. Role on each case stays one pick. Types: Client, Opposing Party / Defendant, Opposing Counsel, Co-Counsel, Witness, Medical Provider, Litigation Support, Other. |

### Questions for Steve / David before building (answered above)

Don't guess on these. David's full list of 13 is in the notes file; these are the ones that block the build:

- **A. "Most recently opened"**: the date the firm opened the file, or the case someone last clicked into?
- **B. Status list**: does David's list replace the 12 firm stages for every firm, or is it a per-practice-area list (this one for personal injury)? What happens to Settled / Closed, and how do existing cases map over?
- **C. Running notes**: now that Notes becomes Synopsis, is the activity timeline + conversations log where dated notes go, or does he want a separate notes list?
- **D. SSN**: confirm the handling above, and who may reveal a full number (attorneys only? paralegals?).
- **E. File number**: typed by the firm, or auto-numbered by the app?
- **F. Medicals vs damages**: one figure or two? Which insurance fields (company, claim #, adjuster, policy limits)?
- **G. Attorney contact type**: one type for co-counsel and opposing counsel, or two? Can a contact hold more than one type?

David's question 4 (where it runs) is already answered by the app: it's a web app that installs to the phone home screen, and dictation is built.

## 2. How Steve works (his standing rules for this app)

- He writes short and informal, often by voice. Give concise, practical answers with the reasoning.
- End every reply with only the app link: https://tx-case-desk.onrender.com (not the repo, Render or demo links).
- Render upgrade: **done Nov 13, 2026** (app server Starter, database Basic-256mb). No more reminders needed.
- Keep a Decision Log of every decision with date and reason, so nothing gets built against an earlier decision. It must update itself from code (no manual republish) and be easy to copy, text or email.
- Independent agents double-check all work before anything ships: every screen on phone and desktop, the code, the features. No regressions on the live app.
- Review agents may change code only if they tell the main session and it verifies before shipping. Reviewers never push. After each review, check whether the reviewer changed anything and tell Steve if a reviewer broke that protocol.
- UI rules, every app: wrap information (dropdown pickers, wrapped cards) instead of sideways-scrolling tables, especially on phones; table headers line up with their columns (numbers right, text left); summary numbers and tiles drill down to the detail behind them, with a back button.
- Values he has to copy (tokens, keys, names) each go in their own copy box with no stray spaces.
- AI may be used for whatever the app needs, as long as an attorney approves before anything is used or sent (decided Nov 8, 2026).
- Keep this HANDOFF.md current in the same commit as every change, and hand off to a fresh session when the current one gets long.

## 3. How the app is built, run and shipped

- Node/Express + Postgres on Render, workspace "TX CASE DESK". Live at https://tx-case-desk.onrender.com. See `README.md` for environment variables.
- Repo: `WSS5480/TX-CASE-DESK`, branch `main`.
- Demo firm: `demo.js` (seed, guard, cleanup). Demo firms are `firms.demo_until IS NOT NULL`; any new route that sends, connects, publishes or calls an outside service must be added to `demo.js` BLOCK and checked in the route. The one exception is AI: demo firms may use it, only through `ai.js`, on the Render key with the demo caps (decided Nov 13).
- Server: `server.js` (routes), `db.js` (schema, all `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT EXISTS`, so migrations run on boot), `practice.js`, `mail.js`, `mailbox.js`, `inbound.js`, `discovery.js`, `analysis.js`, `lawdb.js`, `courtlistener.js`, `deadlines.js`, `activity.js`, `convos.js`, `access.js`, `dictate.js`, `crypto-box.js`, `myapps.js`, `terms.js`, `ai.js`, `assistant.js`.
- **AI:** every AI call goes through `ai.js` (`ai.call`). It picks the key (a real firm: only its own key from Firm Settings → AI (Claude), encrypted with `CRED_KEY`; a demo firm: only the Render `ANTHROPIC_API_KEY`; a real firm with no key gets "Add your firm's Claude key in Firm Settings." and never falls back), checks the demo caps / per-person limits, adds prompt caching, strips SSN-shaped numbers, records each call in `ai_usage` (tokens and USD from the price table in `ai.js`), and turns failures into the plain messages (`ai.MSG`). Never call the Anthropic API anywhere else. Models: Haiku 5.5 (dictation, Test key), Sonnet 5.5 (assistant chat, daily brief, discovery).
- **Assistant:** `assistant.js` (routes under `/api/assistant`, read-only tools using `access.js` and `practice.SHARED` access helpers) and `public/assistant.js` (top-bar button, side panel / phone sheet, daily brief card on Today). It has no tool that changes anything; Phase 3 adds proposals through an Approvals queue.
- Front end: `public/index.html`, `public/app.js`, `public/practice.js`, `public/mail.js`, `public/assistant.js`, service worker `public/sw.js`.
- GitHub Actions: `hourly.yml` (the free hourly court-date ping), `load-texas.yml` (case-law load).
- **Deploy:** pushing to `main` auto-deploys on Render (service `srv-dbinok49v7es7384ckr0`, workspace `tea-dbinoeflk1mc73f873f0`). Put `[skip render]` in the commit message for docs-only commits. After a push, confirm with Render `list_deploys` (status `live`, matching commit) and `list_logs` (no errors). The repo is **public**: never commit secrets, PINs, keys or Decision Log content.
- **Database:** Render Postgres `dpg-dbinogtg1s2s73dopoog-a` (Basic-256mb since Nov 13, 2026). Its IP allowlist is empty, so it can't be queried from outside; check things through the app or the logs.
- **Migrations:** run on boot from `db.js` SCHEMA (idempotent). Big indexes go in `LATE_INDEXES` (built CONCURRENTLY after start). One-time data moves use the `tcd_once` table.
- **Email sending:** free Render web services block SMTP ports 25/465/587; the app server is on Starter since Nov 13, so IMAP/SMTP mailboxes (David's) can send. Microsoft/Google mailboxes send over HTTPS and aren't affected.
- **Local testing:** Postgres 16 at `/tmp/pg/data` (start: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -l /tmp/pg/log start"`), database `txcd4`. Run the server on port 3999 with `DATABASE_URL=postgres://postgres@localhost/txcd4 PGSSLMODE=disable SESSION_SECRET=… CRED_KEY=$(cat /tmp/ck) DEVELOPER_PIN=dev-pin-12345` (a test-only PIN), `AI_URL=http://127.0.0.1:4779/v1/messages` and a fake `ANTHROPIC_API_KEY` (the demo key; tests check it never leaks). `/tmp/uitest/restart-ai2.sh` does all of that. **Never call the real Anthropic API in tests.** Mocks: mail `/tmp/mailmock/restart.sh` (run from another directory); AI `/tmp/aimock/mock.js` (one mock for every AI feature on :4777/:4778/:4779: dictation, discovery, assistant tool rounds, brief, Test key; `POST /mode` with ok / err / chatty / 401 / 402 / 429 / 529; keys containing bad / nocredit / ratelimited / overloaded fail the same way; `GET /calls?n=` and `/count`; modes also `429once`, `529once`, `manytools`, `slowbody`). It replaces the old `/tmp/disc/aimock.js` and `/tmp/dictmock/mock.js`. Playwright suites in `/tmp/uitest/` (`activity.js`, `convo.js`, `dict.js`, `closed.js`, `disc.js`, `demo.js`, `p1.js` AI key + demo key, `p2.js` assistant + brief), phone and desktop, helpers in `ailib.js`; run one with `/tmp/uitest/run-suite.sh <suite>.js` (fresh server each time). Sign-ups are rate-limited (20 per 15 min): restart the server between suites. These live in the session VM, not the repo; a new session recreates them.
- **Developer PIN:** a Render environment variable (`DEVELOPER_PIN`). Steve knows it; never write it in the repo or chat logs.
- **Decision Log:** a Claude artifact database, slug `ededf58c-76dd-4b49-ad62-7e7aa9f2c388`. Write with `db_write`, path `decisions/<date>-<topic>`, fields `{date, ts, area, decision, why, by}`. Never record secrets.
- **Review routine (every change, before shipping):** snapshot the working tree (`md5sum` of changed files, `git rev-parse HEAD`, stash count), then run an independent **read-only** review agent covering security, legal soundness, phone and desktop. Afterwards, verify the snapshot is unchanged and report any reviewer that broke protocol. Fix the findings, re-run the tests, and run a short verification review for anything non-trivial. Then commit, push and confirm the deploy.

## 4. Change log

| Date | Change |
|---|---|
| Nov 13, 2026 | HANDOFF.md started. David's Nov 6 / Nov 12 notes added under `docs/david-notes/`. No app code changed. |
| Nov 13, 2026 | Steve answered questions A–G (section 1). No app code changed. |
| Nov 13, 2026 | Final fixes before shipping Phases 1–2: SSN filter also catches Unicode minus, soft hyphens, zero-width characters, underscores, JSON escapes and more keyword spellings (S.S.N., SS#, SSNs); 9 digits right after "cause/case/docket/file/No./#" are kept as cause numbers (Harris County style); contact/party/document names are scrubbed too. A deliberate 503 ("AI isn't on") now shows its plain message instead of "Server error". Independent tester suites: /tmp/qa-p12 (run.sh). |
| Nov 13, 2026 | Database connection recovers after a database restart (connect timeout, keep-alive, idle-error handler; the missing handler used to crash the app). `/healthz` now checks the database (503 if down). After the Basic-256mb upgrade restarted the database, the app hung until it was restarted. |
| Nov 13, 2026 | **AI (Claude) per firm + demo key (assistant plan Phase 1)**, working tree only, not shipped. Firm Settings → AI (Claude): admin pastes the firm's Claude key (encrypted with `CRED_KEY`, shown only as `•••• last4`), Replace / Remove, Test key (one 1-token Haiku call: Working / Key not valid / Out of credit (add credit in the Anthropic Console) / Too many requests, try again shortly), every change audited with last 4 only. Estimated cost table (Steve's exact figures and sentence; headers over their columns, cards on phones). AI spend this month per person (tiles → that person's calls, back button) and an optional monthly limit per person. Everyone else sees AI status on Account. New `ai.js` runs every AI call (key choice with no fallback for real firms, usage + cost per call in `ai_usage`, plain errors, prompt caching, SSNs stripped). Dictation cleanup and discovery drafting moved onto it. Demo firms use the Render key with caps ($50 a month across all demo firms, $2 per demo firm per day, 20 calls per 10 minutes per demo firm) and a plain message with a Sign up button; their AI section reads "Using the demo key" (masked, read-only). `demo.js` no longer blocks dictation / discovery drafting; every sending and outside-service block stays. User Agreement 2026-11-13 names Anthropic as the AI provider and describes the assistant; everyone re-accepts once. |
| Nov 13, 2026 | **Case Desk Assistant, read-only (assistant plan Phase 2)**, working tree only, not shipped. Assistant button in the top bar on every screen (its own space, so it never covers tabs, buttons or cards); opens knowing the page (the open case, or a calendar item via "Ask the assistant about this"): side panel on desktop (the page moves over, nothing under it), full-screen sheet on phones (below the demo/developer banner). Open/closed remembered per person (desktop reopens it; phones start on the page). Ask-anything chat with read-only tools over the person's own data (cases, case details, calendar, to-dos, conversations, court emails, document names, contacts; billing for non-paralegals only), all using the existing access rules and per-firm walls; court-email / notes / conversation text goes in as marked untrusted data; answers link to each case (only cases the person can open). Conversations saved per person and per case (History, delete one or all; admins delete the whole firm's in Firm Settings → AI). Daily brief card on Today (Generate / Refresh, cached for the day): court dates, deadlines, overdue to-dos, new court emails since yesterday. No assistant in developer view. Models: Sonnet 5.5 for chat and the brief. |
| Nov 13, 2026 | **Review fixes to the AI build** (working tree, not shipped). SSN filter: 3-2-4 digits with any dash (hyphen, en/em dash), dot or spaces between, 9 digits run together, a letter right before ("ssn123-45-6789"), and a 9-digit run shortly after SSN / social / soc sec; applied to every string in every AI request (tool ids left alone) and to a typed question before it's saved or used as a conversation title. Phones, cause numbers and ZIP+4 are left alone (separators on both sides or neither). User Agreement now says SSN-shaped numbers are removed before anything is sent to the AI provider. Caps: each call's estimate is reserved before any database check, so parallel calls can't overrun the demo caps or a person's limit; blank / bad cap settings fall back to the defaults; evicting the rate table keeps the all-demo counter; cost estimate uses 2.5 characters per token. One retry on 429 / 529 honoring retry-after (5 s max). Demo visitors never see firm-admin key messages (bad key / no credit on the demo key → "The demo's AI isn't available right now."). Assistant: static system prompt (cached), page context goes first in the newest question inside `<page_context>`; parties, contacts and document names marked untrusted; every tool_use gets a tool_result (extras: "Too many lookups at once."); tool output capped at 120,000 characters per question ("Ask a narrower question"; `AI_MAX_TOOL_CHARS`); the conversation list hides the name of a case the person can no longer open and saved links are re-checked; newest 200 conversations per person and 200 messages per conversation kept; AI usage older than 13 months pruned hourly. Desktop 1000–1199 px: the panel sits over the page instead of squeezing it. |
| Nov 13, 2026 | **Verification-review fixes** (working tree, not shipped). SSN filter: text is NFKC-normalized (full-width digits), separators also include JSON escapes (\n \r \t) so an SSN split across lines can't hide, and after SSN / social / soc sec any 9 digits with up to 3 separators between each are removed ("SSN 123 456 789", "1 2 3-4 5-6 7 8 9"); `ai.scrubDeep` now runs on data BEFORE it becomes JSON in tool results, page context, the brief data and the discovery case file + requests. Phones, cause numbers, ZIP+4, ISO dates and money stay intact (tested). Case styles (court emails create them), calendar titles and locations go to the AI marked untrusted (list/case refs, calendar tool, brief, page-context event), and the system prompt says so. An answer that stalls mid-body is recorded as a timeout, not a $0 success. Demo firms see the demo's AI-off message in discovery. The conversation list hides the case id (not just the name) of a case the person can no longer open. Test-only setting `AI_TIMEOUT_MS`. |
| Nov 13, 2026 | **Demo firm** ("Try the demo" on the sign-in page, `demo.js`): each visitor gets their own copy of "Little Joe Demo Attorney at Law" (sample PI cases, clients, court notices, calendar, conversations, time), signed straight in, deleted after 24 hours. Nothing leaves the app: mail send/connect, discovery serve, AI calls, case-law/CourtListener, court portals, client portal links, calendar feeds, imports, staff logins and passwords are blocked (path-normalized guard in `requireAuth` plus checks inside the routes); public token pages never serve demo firms; documents 1 MB / 10 per demo. Demo firms skip My Apps, are hidden from the My Apps firm list and developer view, and are cleaned up hourly. AI stays off in the demo until the assistant ships with Steve's key and caps (assistant plan, Phase 2). |

Earlier (newest first):

| Date | Change |
|---|---|
| Nov 11, 2026 | Activity log tab (one timeline, category filter buttons, search, sort); database trigger records case changes and who made them; deletions/sharing audited; paralegals never get billing data. |
| Nov 11, 2026 | Conversations log on every case (type, who, direction, minutes, notes, optional billing with a neutral description, follow-up task); dictation now cleans up grammar with AI before inserting (User Agreement 2026-11-11). |
| Nov 8, 2026 | Court settings emails put hearings on every attorney's calendar; discovery responses (split, AI draft, attorney approves, one-click serve); auto-close on final disposition with a Closed cases view; case stages with PRE- numbers; Word-style notes; dictation mic; password-only sign-in for David (`MFA_OFF_EMAILS`); email provider dropdown and full-history email scan. |

## 5. Decisions

The Decision Log in the app is the record. Nov 13: Steve's answers A–G (section 1) logged there.

## 6. Open items

- [x] Get answers to questions A–G (Steve, Nov 13).
- [ ] Build David's notes (section 1) to those answers.
- [x] Render upgrade done Nov 13, 2026: app server on Starter, database on Basic-256mb (no expiry). Stop reminding Steve about it.
- [x] Fill in sections 3 and 4 (Nov 13).
- [ ] Offered, not yet accepted: export the Activity log (PDF/Excel); Client box on the Add case form (now covered by David's notes); read hearing dates from PDF orders; detect discovery requests in incoming email.
- [ ] **Review and ship the AI build (Phases 1 and 2, Nov 13 working tree).** Run the independent review (section 3), then commit and push. Local results after the verification-review fixes: activity 58/58, convo 50/50, closed 36/36, dict 48/48, disc 40/40, demo 95/95, devview 36/36, p1 157/157, p2 129/129 (`run-suite.sh` runs p1 with `AI_TIMEOUT_MS=4000` and p2 with `AI_MAX_TOOL_CHARS=4000 DEMO_AI_RATE=60`). (`roles.js` is an older suite that no longer runs: it signs up without picking "Law firm", so it gets a solo practice and can't add people; not related to this build.) Review findings fixed: SSN filter (critical), cap race, tool_result per tool_use, page context out of the system prompt, untrusted contact / document names, thread list and saved links re-checked against access, demo key messages, storage caps and pruning, cap setting parsing, tool output cap, rate-table eviction, estimate, retry, narrow-desktop overlay. Before shipping, Steve must know: real firms (David's included) have **no AI at all** until their admin saves a key in Firm Settings → AI (Claude) (no fallback to the Render key, by decision).
- [ ] Log in the Decision Log (not done by the build session): demo AI caps as built ($50/month all demo firms, $2/day per demo firm, 20 calls per 10 min per demo firm); assistant button in the top bar rather than floating over the page (**approved by Steve, Nov 13**: it can never cover tabs, buttons or cards); phone sheet doesn't reopen by itself after a reload; demo AI section shows no characters of the Render key.
- [ ] Phase 3 (proposals + Approvals queue), then drafting, case-law research (plan). Still open from the plan: who approves (decision 1), today's automatic updates (2), demo plain link vs email sign-up (3), pricing (4), per-firm model choice (5), e-filing (6).
- [x] **AI (Claude) setup page** in Firm Settings (assistant plan, Phase 1), built Nov 13 (see the change log; not yet shipped): firm key entry (encrypted, masked, Test key, plain errors, audited). It must show the estimated monthly cost per active attorney, exactly: daily brief (22 workdays) $1; questions, to-dos, case updates (about 10 a day) $5 to $8; reading court emails under $0.50; drafts (about 10 motions or letters) $5 to $10; **total $12 to $20**; "These are estimates before real usage; a light user runs about $5. Reusing the case file between questions (prompt caching) keeps repeat questions cheap." **Build every assistant call with prompt caching** (cache the system prompt, tools and case file with `cache_control`) so that last sentence is true (Steve, Nov 13).
- [x] **Build with Phase 1 (decided Nov 13): demo AI on Steve's key.** Built Nov 13 (not yet shipped). `ANTHROPIC_API_KEY` in Render is used **only by demo firms** (`firms.demo_until IS NOT NULL`); real firms use only their own Firm Settings key and never fall back. Caps: **$50 a month for the whole demo, $2 per visitor (demo firm) per day**, plus a rate limit; track cost per call (tokens × model price) and, when a cap is hit, show a plain message with a Sign up button. The demo's Firm Settings → AI (Claude) page shows "Using the demo key" (masked, read-only). Then remove the AI blocks in `demo.js` BLOCK (dictation, discovery draft, assistant) for demo firms, keeping every *sending* block. Still open: plain link vs quick email sign-up for the demo (plan, open decision 3). Plan: https://claude.ai/artifact/Vr8G8HVskMUGGaiMBHCtSp
- [ ] Anthropic API key (`ANTHROPIC_API_KEY`) not yet set in Render. After this build it is used **only by demo firms**; until it's set the demo's AI shows "The demo's AI isn't switched on yet." Real firms need their own key in Firm Settings.
