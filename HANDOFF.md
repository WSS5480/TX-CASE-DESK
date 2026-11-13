# TX Case Desk: HANDOFF

Start here. Read this before touching anything.

> **Status of this file:** complete as of Nov 13, 2026. Steve answered David's questions (section 1), and the build session filled in sections 3 and 4. **Next:** build section 1 to those answers. Keep this file updated in the same commit as every change (Steve's standing rule).

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
- The free Render database is not where real SSNs should live. This ties to the pending Render upgrade.

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
- In every update, remind him the Render upgrade is still pending: app server to Starter and database to Basic-256mb. **The free database expires Nov 30, 2026.** He wants to do it once the build is complete.
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
- Server: `server.js` (routes), `db.js` (schema, all `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT EXISTS`, so migrations run on boot), `practice.js`, `mail.js`, `mailbox.js`, `inbound.js`, `discovery.js`, `analysis.js`, `lawdb.js`, `courtlistener.js`, `deadlines.js`, `activity.js`, `convos.js`, `access.js`, `dictate.js`, `crypto-box.js`, `myapps.js`, `terms.js`.
- Front end: `public/index.html`, `public/app.js`, `public/practice.js`, `public/mail.js`, service worker `public/sw.js`.
- GitHub Actions: `hourly.yml` (the free hourly court-date ping), `load-texas.yml` (case-law load).
- **Deploy:** pushing to `main` auto-deploys on Render (service `srv-dbinok49v7es7384ckr0`, workspace `tea-dbinoeflk1mc73f873f0`). Put `[skip render]` in the commit message for docs-only commits. After a push, confirm with Render `list_deploys` (status `live`, matching commit) and `list_logs` (no errors). The repo is **public**: never commit secrets, PINs, keys or Decision Log content.
- **Database:** Render Postgres `dpg-dbinogtg1s2s73dopoog-a` (free, **deleted Nov 30, 2026** unless upgraded). Its IP allowlist is empty, so it can't be queried from outside; check things through the app or the logs.
- **Migrations:** run on boot from `db.js` SCHEMA (idempotent). Big indexes go in `LATE_INDEXES` (built CONCURRENTLY after start). One-time data moves use the `tcd_once` table.
- **Email sending:** free Render web services block SMTP ports 25/465/587, so IMAP/SMTP mailboxes (David's) can't send until the app server is on Starter. Microsoft/Google mailboxes send over HTTPS and aren't affected.
- **Local testing:** Postgres 16 at `/tmp/pg/data` (start: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pg/data -l /tmp/pg/log start"`), database `txcd4`. Run the server on port 3999 with `DATABASE_URL=postgres://postgres@localhost/txcd4 PGSSLMODE=disable SESSION_SECRET=… CRED_KEY=$(cat /tmp/ck) DEVELOPER_PIN=dev-pin-12345` (a test-only PIN). Mocks: mail `/tmp/mailmock/restart.sh` (run from another directory), discovery AI `/tmp/disc/aimock.js` (:4777), dictation AI `/tmp/dictmock/mock.js` (:4778). Playwright suites in `/tmp/uitest/` (`activity.js`, `convo.js`, `dict.js`, `closed.js`, `disc.js`), phone and desktop. Sign-ups are rate-limited (20 per 15 min): restart the server between suites. These live in the session VM, not the repo; a new session recreates them.
- **Developer PIN:** a Render environment variable (`DEVELOPER_PIN`). Steve knows it; never write it in the repo or chat logs.
- **Decision Log:** a Claude artifact database, slug `ededf58c-76dd-4b49-ad62-7e7aa9f2c388`. Write with `db_write`, path `decisions/<date>-<topic>`, fields `{date, ts, area, decision, why, by}`. Never record secrets.
- **Review routine (every change, before shipping):** snapshot the working tree (`md5sum` of changed files, `git rev-parse HEAD`, stash count), then run an independent **read-only** review agent covering security, legal soundness, phone and desktop. Afterwards, verify the snapshot is unchanged and report any reviewer that broke protocol. Fix the findings, re-run the tests, and run a short verification review for anything non-trivial. Then commit, push and confirm the deploy.

## 4. Change log

| Date | Change |
|---|---|
| Nov 13, 2026 | HANDOFF.md started. David's Nov 6 / Nov 12 notes added under `docs/david-notes/`. No app code changed. |
| Nov 13, 2026 | Steve answered questions A–G (section 1). No app code changed. |
| Nov 13, 2026 | Attorney AI assistant planned (section 7) and logged in the Decision Log: assistant, firm Claude key in Firm Settings, Demo firm. No app code changed. |

Earlier (newest first):

| Date | Change |
|---|---|
| Nov 11, 2026 | Activity log tab (one timeline, category filter buttons, search, sort); database trigger records case changes and who made them; deletions/sharing audited; paralegals never get billing data. |
| Nov 11, 2026 | Conversations log on every case (type, who, direction, minutes, notes, optional billing with a neutral description, follow-up task); dictation now cleans up grammar with AI before inserting (User Agreement 2026-11-11). |
| Nov 8, 2026 | Court settings emails put hearings on every attorney's calendar; discovery responses (split, AI draft, attorney approves, one-click serve); auto-close on final disposition with a Closed cases view; case stages with PRE- numbers; Word-style notes; dictation mic; password-only sign-in for David (`MFA_OFF_EMAILS`); email provider dropdown and full-history email scan. |

## 5. Decisions

The Decision Log in the app is the record. Nov 13: Steve's answers A–G (section 1) logged there, plus the assistant, firm Claude key and Demo firm decisions (section 7).

## 6. Open items

- [x] Get answers to questions A–G (Steve, Nov 13).
- [ ] Build David's notes (section 1) to those answers.
- [ ] Render upgrade: app server to Starter, database to Basic-256mb. Free database expires **Nov 30, 2026**.
- [x] Fill in sections 3 and 4 (Nov 13).
- [ ] Offered, not yet accepted: export the Activity log (PDF/Excel); Client box on the Add case form (now covered by David's notes); read hearing dates from PDF orders; detect discovery requests in incoming email.
- [ ] `ANTHROPIC_API_KEY`: Steve says a key is set on the Render service (Nov 13; not visible from here). Per the Demo firm decision it becomes the Demo firm's key; remove the Render setting only after the in-app key is tested working.
- [ ] Attorney assistant (section 7): open decisions listed in the plan, first one is who may approve (attorney only, or paralegals for some items).

## 7. Next big build: attorney AI assistant (planned Nov 13, 2026)

Full plan (Claude Doc): https://claude.ai/artifact/Vr8G8HVskMUGGaiMBHCtSp . Decision Log entries `2026-11-13-ai-assistant`, `2026-11-13-firm-claude-key`, `2026-11-13-demo-firm`.

- Claude API from the Node server (`@anthropic-ai/sdk`, tool runner), not the Agent SDK. Tools are read tools plus propose tools that only write to an Approvals queue; approved items run through the app's normal code under the approver's permissions. Audit who proposed/approved what and when.
- Every tool filters by firm and by `access.js` visibility. No SSNs to AI. No assistant in developer view. Court email text is passed as data, never instructions.
- Firm Settings "AI (Claude)": admin enters/replaces the firm key, encrypted with `crypto-box.js`, masked, Test key, audited. One key per firm; usage logged per person with optional limits. Dictation and discovery move to the firm key. No key = no AI (no fallback to Steve's key).
- Demo firm on Steve's key: sample data only, per-visitor and monthly caps, 24-hour reset per visitor, Sign up button.
- Floating assistant button on every page (phone first): on/off remembered per attorney, opens with the current page as context, never covers tabs/buttons/cards. Named as TX Case Desk's own (e.g. "Case Desk Assistant"), not "Claude Duet"; check Anthropic's brand rules before any "powered by Claude" wording. Decision Log `2026-11-13-assistant-button`.
- Models: Haiku 5.5 for email reading, Sonnet 5.5 for chat/brief/proposals, Opus 5.5 for drafting (switchable).
- Phases: 0 Render upgrade, 1 firm key + Approvals + audit, 2 chat + brief + Demo firm, 3 proposals, 4 drafting, 5 case-law research, 6 limits/subscription. New User Agreement version naming Anthropic before phase 2 ships.
