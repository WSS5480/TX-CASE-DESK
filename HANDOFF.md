# TX Case Desk: HANDOFF

Start here. Read this before touching anything.

> **Status of this file:** started Nov 13, 2026 by a side session whose only job was to pass along David's notes. It did **not** change any app code. The build session should fill in the sections marked "to fill in" from its own history, then keep this file updated in the same commit as every change (Steve's standing rule).

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

### Questions for Steve / David before building

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
- _To fill in by the build session:_ deploy steps and whether Render auto-deploys from `main`, how to test locally, the developer PIN location, where the Decision Log lives in code, the review-agent routine.

## 4. Change log

| Date | Change |
|---|---|
| Nov 13, 2026 | HANDOFF.md started. David's Nov 6 / Nov 12 notes added under `docs/david-notes/`. No app code changed. |

_To fill in by the build session: earlier history._

## 5. Decisions

The Decision Log in the app is the record. Nothing was decided in the Nov 13 handoff.

## 6. Open items

- [ ] Get answers to questions A–G above, then build David's notes (section 1).
- [ ] Render upgrade: app server to Starter, database to Basic-256mb. Free database expires **Nov 30, 2026**.
- [ ] Fill in the "to fill in" parts of sections 3 and 4.
