// Database connection + schema (runs automatically on boot)
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const local = /localhost|127\.0\.0\.1|\/tmp\//.test(url) || url.includes("host=/");
// If the database restarts (plan change, maintenance), stale connections are dropped and new ones made:
// a connection attempt gives up after 10 s instead of hanging, keep-alive checks start after 10 s so a vanished
// database is noticed on a busy connection, and a dropped idle connection is logged instead of crashing the app.
const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, keepAlive: true, keepAliveInitialDelayMillis: 10000 });
pool.on("error", e => console.warn("[db] idle connection dropped:", e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS firms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE firms ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'pro';
ALTER TABLE firms ADD COLUMN IF NOT EXISTS plan_expires DATE;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS plan_source TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS plan_checked TIMESTAMPTZ;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS disabled BOOLEAN DEFAULT false;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS demo_until TIMESTAMPTZ;   -- set = a "Try the demo" copy, deleted after this time
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  bar_number TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','attorney','paralegal')),
  pw_hash TEXT NOT NULL,
  must_change_pw BOOLEAN DEFAULT false,
  totp_secret TEXT,
  totp_enabled BOOLEAN DEFAULT false,
  counties TEXT[] DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  county TEXT NOT NULL,
  cause_no TEXT NOT NULL,
  court TEXT,
  style TEXT,
  case_type TEXT,
  filed_date DATE,
  status TEXT,
  next_setting TEXT,
  notes TEXT,
  source TEXT DEFAULT 'manual',
  tracked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (firm_id, county, cause_no)
);
CREATE TABLE IF NOT EXISTS opinions (
  cluster_id BIGINT PRIMARY KEY,
  opinion_id BIGINT,
  case_name TEXT,
  citations TEXT,
  court TEXT,
  court_id TEXT,
  date_filed DATE,
  judges TEXT,
  text TEXT,
  absolute_url TEXT,
  fetched_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cl_calls (at TIMESTAMPTZ NOT NULL DEFAULT now());   -- CourtListener lookups (free limits: 5/min, 50/hr, 125/day), kept across restarts
CREATE INDEX IF NOT EXISTS cl_calls_at ON cl_calls(at);
CREATE TABLE IF NOT EXISTS cl_state (k TEXT PRIMARY KEY, v BIGINT);
CREATE TABLE IF NOT EXISTS api_cache (
  key TEXT PRIMARY KEY,
  body JSONB NOT NULL,
  at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saved_research (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  cluster_id BIGINT NOT NULL,
  case_name TEXT,
  citation TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT,
  firm_id INT,
  action TEXT NOT NULL,
  detail JSONB,
  ip TEXT,
  at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS court_logins (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  county TEXT NOT NULL,
  username TEXT,
  enc_password TEXT,
  status TEXT DEFAULT 'new',
  last_sync TIMESTAMPTZ,
  last_result JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, county)
);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS external_url TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS stage TEXT;   -- the firm's own stage (Intake, Pre-litigation, Discovery...); status stays the court's
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_synced TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS watch_dates BOOLEAN DEFAULT false;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS date_alert TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS date_alert_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS issues TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS law_watch BOOLEAN DEFAULT false;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS law_checked_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS law_alert TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS law_alert_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS analyses (
  id SERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id INT,
  issues TEXT,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS case_changes (
  id BIGSERIAL PRIMARY KEY,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  at TIMESTAMPTZ DEFAULT now()
);
-- re:SearchTX alert emails forwarded by each attorney (via Postmark inbound)
ALTER TABLE users ADD COLUMN IF NOT EXISTS inbox_token TEXT UNIQUE;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS filing_alert TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS filing_alert_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS inbound_emails (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,
  firm_id INT,
  from_addr TEXT,
  subject TEXT,
  body TEXT,
  kind TEXT,                -- research_alert | forward_confirm | other
  causes TEXT[],            -- cause numbers found in the email
  matched_case_ids INT[],
  confirm_code TEXT,
  received_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbound_user ON inbound_emails(user_id, received_at DESC);
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS html TEXT;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS ext_id TEXT;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'forward';
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS parsed JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_ext ON inbound_emails(user_id, ext_id) WHERE ext_id IS NOT NULL;
-- attorneys' connected mailboxes (Outlook / Gmail), read-only, court senders only
CREATE TABLE IF NOT EXISTS mailboxes (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,          -- microsoft | google
  email TEXT,
  enc_refresh TEXT NOT NULL,
  enc_access TEXT,
  access_expires TIMESTAMPTZ,
  status TEXT DEFAULT 'ok',
  last_sync TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,           -- newest email time already processed
  last_error TEXT,
  stats JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, provider)
);
-- firm-wide email connection (Microsoft 365 admin consent / Google Workspace domain-wide delegation)
CREATE TABLE IF NOT EXISTS firm_mail (
  firm_id INT PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,          -- microsoft | google
  tenant TEXT,                     -- Microsoft tenant id
  domain TEXT NOT NULL,            -- e.g. garzalaw.com
  status TEXT DEFAULT 'ok',
  last_sync TIMESTAMPTZ,
  last_error TEXT,
  stats JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS key_source TEXT DEFAULT 'app';   -- app = TX Case Desk's Microsoft keys, firm = the firm's own
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS scope_req TEXT;   -- scopes asked for at connect (refresh asks for the same)
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS scope_got TEXT;   -- scopes Microsoft granted (full mail needs Mail.ReadWrite + Mail.Send)
-- Shared court inbox: one firm address that receives court emails (efile@firm.com). Admins or chosen staff assign what can't be matched.
ALTER TABLE mailboxes ADD COLUMN IF NOT EXISTS shared_firm INT REFERENCES firms(id) ON DELETE CASCADE;   -- set = this is the firm's shared court inbox
-- ROLLBACK NOTE: code from before Nov 1, 2026 needs the old constraint back. Run this first, then deploy the old code:
--   DELETE FROM mailboxes WHERE shared_firm IS NOT NULL;
--   ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_user_id_provider_key UNIQUE (user_id, provider);
ALTER TABLE mailboxes DROP CONSTRAINT IF EXISTS mailboxes_user_id_provider_key;
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_personal ON mailboxes(user_id, provider) WHERE shared_firm IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_shared ON mailboxes(shared_firm) WHERE shared_firm IS NOT NULL;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS court_mode TEXT DEFAULT 'each';   -- each (every attorney's own email) | shared | both
ALTER TABLE firms ADD COLUMN IF NOT EXISTS court_email TEXT;                 -- shared address read through the firm-wide Microsoft/Google connection
ALTER TABLE firms ADD COLUMN IF NOT EXISTS court_seen TIMESTAMPTZ;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS court_stats JSONB;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS court_token TEXT;                 -- forwarding tag for the shared inbox
ALTER TABLE users ADD COLUMN IF NOT EXISTS court_handler BOOLEAN DEFAULT false;   -- works the firm's unassigned court notices
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS shared BOOLEAN DEFAULT false;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS routed TEXT;            -- case | attorney | manual
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS assigned_by INT;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE inbound_emails ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_shared_ext ON inbound_emails(firm_id, ext_id) WHERE shared AND ext_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_queue ON inbound_emails(firm_id, received_at DESC) WHERE shared AND user_id IS NULL;
ALTER TABLE firm_mail ADD COLUMN IF NOT EXISTS key_source TEXT DEFAULT 'app';
-- a firm's own Microsoft (Azure) app, entered by the firm admin in Firm Seats
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_client_id TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_tenant TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_secret_enc TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_secret_hint TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_keys_at TIMESTAMPTZ;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ms_keys_by TEXT;
CREATE TABLE IF NOT EXISTS mail_cursor (
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen TIMESTAMPTZ
);
-- Texas case law loaded from CourtListener bulk files (one row per opinion; a cluster = one decision)
CREATE TABLE IF NOT EXISTS tx_opinions (
  opinion_id BIGINT PRIMARY KEY,
  cluster_id BIGINT NOT NULL,
  court_id TEXT NOT NULL,            -- tex | texapp | texcrimapp
  coa SMALLINT,                      -- court of appeals district 1-15 (from docket number, e.g. 13-24-00123-CV)
  origin_county TEXT,                -- trial-court county the appeal came from
  docket_number TEXT,
  case_name TEXT,
  date_filed DATE,
  citations TEXT,
  judges TEXT,
  cite_count INT DEFAULT 0,
  precedential TEXT,
  op_type TEXT,
  text TEXT,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', left(coalesce(case_name,'') || ' ' || coalesce(text,''), 400000))) STORED
);
CREATE INDEX IF NOT EXISTS tx_op_tsv ON tx_opinions USING GIN (tsv);
CREATE INDEX IF NOT EXISTS tx_op_cluster ON tx_opinions(cluster_id);
CREATE INDEX IF NOT EXISTS tx_op_court ON tx_opinions(court_id, coa, date_filed);
CREATE INDEX IF NOT EXISTS tx_op_county ON tx_opinions(origin_county);
CREATE TABLE IF NOT EXISTS tx_cites (
  citing BIGINT NOT NULL,
  cited BIGINT NOT NULL,
  depth INT DEFAULT 1,
  PRIMARY KEY (citing, cited)
);
CREATE INDEX IF NOT EXISTS tx_cites_cited ON tx_cites(cited);
-- ===== Practice management (calendar, clients, documents, tasks, billing, trust, portal) =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS rate NUMERIC(10,2);           -- default hourly rate
ALTER TABLE users ADD COLUMN IF NOT EXISTS cal_token TEXT;               -- private calendar feed (Outlook/Google subscribe)
ALTER TABLE cases ADD COLUMN IF NOT EXISTS rate NUMERIC(10,2);           -- case rate override
ALTER TABLE cases ADD COLUMN IF NOT EXISTS billing TEXT DEFAULT 'hourly'; -- hourly | flat | contingency
ALTER TABLE firms ADD COLUMN IF NOT EXISTS closed_days JSONB DEFAULT '[]'; -- extra days the courts/clerk are closed
ALTER TABLE firms ADD COLUMN IF NOT EXISTS stripe_enc TEXT;              -- firm's own Stripe secret key (encrypted)
ALTER TABLE firms ADD COLUMN IF NOT EXISTS stripe_hint TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS card_fee_pct NUMERIC(5,2);    -- shown up front on invoices
ALTER TABLE firms ADD COLUMN IF NOT EXISTS card_fee_fixed NUMERIC(6,2);
ALTER TABLE firms ADD COLUMN IF NOT EXISTS invoice_seq INT DEFAULT 1000;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS setup_help_at TIMESTAMPTZ;      -- firm asked for developer-assisted Microsoft setup (one-time fee)
ALTER TABLE firms ADD COLUMN IF NOT EXISTS setup_help_note TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS setup_help_done BOOLEAN DEFAULT false;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS address TEXT;                -- firm profile: shown on drafts, invoices and the client page
ALTER TABLE firms ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS fax TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS firm_email TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo BYTEA;                  -- PNG or JPG, up to 1 MB
ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo_mime TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo_w INT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo_h INT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo_token TEXT UNIQUE;      -- random; the logo is served at /brand/<token>
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;                  -- attorney profile: shown in signature blocks
ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_email TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;          -- roles: admin, partner, manager, attorney, paralegal
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','partner','manager','attorney','paralegal'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS access TEXT;                 -- own | team | firm (admins and managers always see the firm)
ALTER TABLE users ADD COLUMN IF NOT EXISTS works_with INT[] DEFAULT '{}';  -- attorneys whose cases a "team" person sees
ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_access BOOLEAN DEFAULT false;
UPDATE users SET access = CASE WHEN role = 'attorney' THEN 'own' ELSE 'firm' END WHERE access IS NULL;
UPDATE users SET trust_access = true WHERE role = 'admin' AND NOT trust_access;
ALTER TABLE users ADD COLUMN IF NOT EXISTS prefs JSONB DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS licensed_on DATE;            -- bar card: date licensed in Texas
ALTER TABLE users ADD COLUMN IF NOT EXISTS bar_card_at TIMESTAMPTZ;      -- when a bar card was put on file (the file lives in bar_cards)
CREATE TABLE IF NOT EXISTS bar_cards (                                     -- bar card photo or PDF, kept apart from users so sign-in stays light
  user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data BYTEA NOT NULL,
  mime TEXT NOT NULL,
  at TIMESTAMPTZ DEFAULT now()
);   -- per person: which cards show on Today
ALTER TABLE firms ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'firm';     -- solo | firm
CREATE TABLE IF NOT EXISTS case_team (                                   -- people added to a case beyond its lead attorney
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by INT REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'event',      -- hearing | deadline | meeting | event
  title TEXT NOT NULL,
  on_date DATE NOT NULL,
  at_time TEXT,                            -- '10:00 AM' or null (all day)
  location TEXT,
  notes TEXT,
  rule TEXT, cite TEXT,                    -- deadline calculator rule + citation
  done BOOLEAN DEFAULT false,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_firm_date ON events(firm_id, on_date);
ALTER TABLE events ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS confirmed_by INT REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'client',     -- client | opposing | witness | other
  name TEXT NOT NULL,
  company TEXT, email TEXT, phone TEXT, address TEXT, notes TEXT,
  portal_token TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_firm ON contacts(firm_id, lower(name));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_by INT;   -- who added it; contacts on no case are seen by them (and whole-firm roles)
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;          -- User Agreement version this person accepted
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;        -- each 2FA code works once
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_fails INT DEFAULT 0;     -- wrong 2FA codes in the current hour
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_fail_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS reset_attempts (email TEXT PRIMARY KEY, day DATE NOT NULL, n INT NOT NULL);   -- forgot-password tries per email per day
CREATE TABLE IF NOT EXISTS case_contacts (
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'client',     -- client | opposing party | opposing counsel | witness | other
  PRIMARY KEY (case_id, contact_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT, size INT,
  data BYTEA,
  shared BOOLEAN DEFAULT false,            -- visible in the client portal
  uploaded_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_case ON documents(case_id);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  assignee INT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date DATE,
  done BOOLEAN DEFAULT false, done_at TIMESTAMPTZ,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_firm ON tasks(firm_id, done, due_date);
CREATE TABLE IF NOT EXISTS task_templates (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_type TEXT NOT NULL,                 -- a case type, or '*' for every new case
  title TEXT NOT NULL,
  due_days INT,                            -- days after the case is added
  sort INT DEFAULT 0
);
CREATE TABLE IF NOT EXISTS time_entries (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  on_date DATE NOT NULL DEFAULT CURRENT_DATE,
  minutes INT NOT NULL DEFAULT 0,
  rate NUMERIC(10,2) DEFAULT 0,
  amount NUMERIC(12,2),                    -- flat amount (expense or flat fee) instead of minutes x rate
  description TEXT,
  billable BOOLEAN DEFAULT true,
  invoice_id INT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_firm ON time_entries(firm_id, on_date);
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE SET NULL,
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  number TEXT NOT NULL,
  issued DATE DEFAULT CURRENT_DATE,
  due DATE,
  status TEXT DEFAULT 'draft',             -- draft | sent | paid | void
  total NUMERIC(12,2) DEFAULT 0,
  paid NUMERIC(12,2) DEFAULT 0,
  pay_token TEXT UNIQUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id SERIAL PRIMARY KEY,
  invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  time_id INT,
  description TEXT, qty NUMERIC(10,2), rate NUMERIC(10,2), amount NUMERIC(12,2)
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  invoice_id INT REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  method TEXT,                             -- card | bank | check | cash | trust | other
  ref TEXT,
  on_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (invoice_id, ref)
);
CREATE TABLE IF NOT EXISTS trust_tx (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  contact_id INT NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  case_id INT REFERENCES cases(id) ON DELETE SET NULL,
  on_date DATE NOT NULL DEFAULT CURRENT_DATE,
  amount NUMERIC(12,2) NOT NULL,           -- + deposit, - disbursement
  memo TEXT, ref TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trust_firm ON trust_tx(firm_id, contact_id);
CREATE TABLE IF NOT EXISTS trust_recon (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  as_of DATE NOT NULL, bank_balance NUMERIC(12,2) NOT NULL, book_balance NUMERIC(12,2) NOT NULL, ledgers_total NUMERIC(12,2) NOT NULL,
  ok BOOLEAN, created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cases_firm_county ON cases(firm_id, county);
-- Discovery responses: the other side's requests, split into items; AI drafts, the attorney approves, then it's served.
CREATE TABLE IF NOT EXISTS discovery_sets (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                     -- "Plaintiff's First Set of Interrogatories"
  response_title TEXT,                     -- "Defendant's Responses to ..."
  served_on DATE, served_by TEXT DEFAULT 'email', due_on DATE,
  source_doc INT REFERENCES documents(id) ON DELETE SET NULL,
  event_id INT REFERENCES events(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'draft',             -- draft | sent
  ai_status TEXT, ai_error TEXT, ai_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ, sent_to TEXT, sent_doc INT REFERENCES documents(id) ON DELETE SET NULL, sent_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS discovery_items (
  id SERIAL PRIMARY KEY,
  set_id INT NOT NULL REFERENCES discovery_sets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'rog',        -- rog | rfp | rfa | rfd | other
  n INT NOT NULL,
  request TEXT NOT NULL,
  objections TEXT[] DEFAULT '{}',
  objection_note TEXT,
  answer TEXT,                             -- Word-style (cleaned HTML)
  ai_answer TEXT, ai_confirm TEXT,         -- what the AI drafted and the facts it says the attorney must confirm
  approved_by INT REFERENCES users(id) ON DELETE SET NULL, approved_at TIMESTAMPTZ,
  added_by_hand BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS discovery_items_set ON discovery_items(set_id, kind, n);
-- Closed cases: a final disposition in the court's own record moves the case to stage Closed (off the active list).
ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS closed_why TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS stage_before_close TEXT;
CREATE OR REPLACE FUNCTION tcd_case_close() RETURNS trigger AS $$
BEGIN
  -- the court status turned final (Disposed, Dismissed, Final judgment, Nonsuit, Closed) -> Closed, remembering the stage it had
  IF NEW.status IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND NEW.status ~* '(dispos|dismiss|final judgment|judgment (signed|entered|rendered)|non-?suit|\\mclosed\\M)'
     AND NEW.status !~* '(reopen|re-open|not |pending|motion|proposed|undispos|in part|partial|as to|interlocutory|docket|intent|hearing|reinstat)'
     AND NEW.stage IS DISTINCT FROM 'Closed' THEN
    NEW.stage_before_close := NEW.stage; NEW.stage := 'Closed'; NEW.closed_at := now(); NEW.closed_why := 'Court status: ' || NEW.status;
  ELSIF TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    IF NEW.stage = 'Closed' THEN NEW.closed_at := COALESCE(NEW.closed_at, now()); NEW.stage_before_close := COALESCE(NEW.stage_before_close, OLD.stage);
      IF NEW.closed_why IS NOT DISTINCT FROM OLD.closed_why THEN NEW.closed_why := 'Marked closed'; END IF;
    ELSIF OLD.stage = 'Closed' THEN NEW.closed_at := NULL; NEW.closed_why := NULL; NEW.stage_before_close := NULL; END IF;   -- reopened
  ELSIF TG_OP = 'INSERT' AND NEW.stage = 'Closed' THEN NEW.closed_at := COALESCE(NEW.closed_at, now()); NEW.closed_why := COALESCE(NEW.closed_why, 'Marked closed');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tcd_case_close ON cases;
CREATE TRIGGER tcd_case_close BEFORE INSERT OR UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION tcd_case_close();
-- once: cases whose court status was already final before this existed move to Closed (a reopened case is never re-closed by this)
CREATE TABLE IF NOT EXISTS tcd_once (k TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now());
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM tcd_once WHERE k = 'close_final_v2') THEN
    INSERT INTO tcd_once(k) VALUES ('close_final_v2') ON CONFLICT DO NOTHING;
    UPDATE cases SET stage_before_close = stage, stage = 'Closed', closed_at = now(), closed_why = 'Court status: ' || status
      WHERE stage IS DISTINCT FROM 'Closed' AND status ~* '(dispos|dismiss|final judgment|judgment (signed|entered|rendered)|non-?suit|\\mclosed\\M)'
        AND status !~* '(reopen|re-open|not |pending|motion|proposed|undispos|in part|partial|as to|interlocutory|docket|intent|hearing|reinstat)';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS audit_firm ON audit_log(firm_id, at DESC);
-- Conversations: a dated log on each case of calls, meetings, emails and texts (who, how, what was said), Word-style notes
CREATE TABLE IF NOT EXISTS case_convos (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  case_id INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when the conversation happened
  kind TEXT NOT NULL DEFAULT 'call',       -- call | meeting | voicemail | email | text | court | note
  contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
  with_name TEXT,                          -- who it was with (kept even if the contact is removed)
  body TEXT,                               -- Word-style (cleaned HTML)
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ, updated_by INT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS case_convos_case ON case_convos(case_id, at DESC);
ALTER TABLE case_convos ADD COLUMN IF NOT EXISTS direction TEXT;          -- in | out (who reached out)
ALTER TABLE case_convos ADD COLUMN IF NOT EXISTS minutes INT;             -- how long it took
ALTER TABLE case_convos ADD COLUMN IF NOT EXISTS time_id INT REFERENCES time_entries(id) ON DELETE SET NULL;   -- billed as time
ALTER TABLE case_convos ADD COLUMN IF NOT EXISTS task_id INT REFERENCES tasks(id) ON DELETE SET NULL;         -- follow-up task
-- Activity log: case changes (stage, court status, court, type, style, cause #, lead attorney) are recorded by the database itself,
-- whoever or whatever made them (a person, a court email, a portal sync). The app fills in "by" for changes a person made.
ALTER TABLE case_changes ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_by INT REFERENCES users(id) ON DELETE SET NULL;   -- who checked it off
CREATE INDEX IF NOT EXISTS case_changes_case ON case_changes(case_id, at DESC);
CREATE OR REPLACE FUNCTION tcd_case_log() RETURNS trigger AS $$
DECLARE uid INT := NULLIF(current_setting('tcd.uid', true), '')::int;   -- set by the app when a person made the change
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'stage', OLD.stage, NEW.stage, uid); END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'status', OLD.status, NEW.status, uid); END IF;
  IF NEW.court IS DISTINCT FROM OLD.court THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'court', OLD.court, NEW.court, uid); END IF;
  IF NEW.case_type IS DISTINCT FROM OLD.case_type THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'case_type', OLD.case_type, NEW.case_type, uid); END IF;
  IF NEW.style IS DISTINCT FROM OLD.style THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'style', OLD.style, NEW.style, uid); END IF;
  IF NEW.cause_no IS DISTINCT FROM OLD.cause_no THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'cause_no', OLD.cause_no, NEW.cause_no, uid); END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN INSERT INTO case_changes(case_id, field, old_value, new_value, user_id) VALUES (NEW.id, 'attorney', OLD.user_id::text, NEW.user_id::text, uid); END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS tcd_case_log ON cases;
CREATE TRIGGER tcd_case_log AFTER UPDATE ON cases FOR EACH ROW EXECUTE FUNCTION tcd_case_log();
-- AI (Claude): the firm's own key (encrypted with CRED_KEY, shown only as its last 4), every call's cost, per-person monthly limits
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ai_key_enc TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ai_key_last4 TEXT;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ai_key_at TIMESTAMPTZ;
ALTER TABLE firms ADD COLUMN IF NOT EXISTS ai_key_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_limit_usd NUMERIC(10,2);   -- optional monthly AI limit for this person (null = none)
CREATE TABLE IF NOT EXISTS ai_usage (                                   -- one row per AI call; kept after a demo firm is deleted so the demo's monthly cap holds
  id BIGSERIAL PRIMARY KEY,
  firm_id INT REFERENCES firms(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  feature TEXT NOT NULL,                   -- dictation | discovery | assistant | brief | key_test
  model TEXT NOT NULL,
  input_tokens INT DEFAULT 0, output_tokens INT DEFAULT 0, cache_read_tokens INT DEFAULT 0, cache_write_tokens INT DEFAULT 0,
  cost_usd NUMERIC(12,6) DEFAULT 0,
  demo BOOLEAN DEFAULT false,
  ok BOOLEAN DEFAULT true,
  error TEXT,                              -- a short code (BAD_KEY, NO_CREDIT, RATE…), never message text
  at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_user ON ai_usage(user_id, at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_firm ON ai_usage(firm_id, at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_demo ON ai_usage(at) WHERE demo;
-- Case Desk Assistant: saved conversations per person (and per case), and the daily brief (one per person per day)
CREATE TABLE IF NOT EXISTS assistant_threads (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_threads_user ON assistant_threads(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS assistant_messages (
  id BIGSERIAL PRIMARY KEY,
  thread_id INT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  links JSONB,                             -- cases the answer links to [{id, label}]
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assistant_messages_thread ON assistant_messages(thread_id, id);
-- date changes the assistant proposes; nothing changes until the person taps Confirm (Steve, Nov 13 2026)
CREATE TABLE IF NOT EXISTS assistant_proposals (
  id SERIAL PRIMARY KEY,
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id INT REFERENCES assistant_threads(id) ON DELETE SET NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('event','task')),
  item_id INT NOT NULL,
  case_id INT REFERENCES cases(id) ON DELETE CASCADE,
  item_type TEXT, title TEXT,
  old_date DATE, old_time TEXT, new_date DATE NOT NULL, new_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled','expired')),
  created_at TIMESTAMPTZ DEFAULT now(), decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS assistant_proposals_case ON assistant_proposals(case_id, decided_at DESC) WHERE status='applied';
CREATE INDEX IF NOT EXISTS assistant_proposals_user ON assistant_proposals(user_id, status);
ALTER TABLE assistant_messages ADD COLUMN IF NOT EXISTS proposals JSONB;
-- natural voices (Kokoro via DeepInfra): characters read aloud per firm per day, for the daily cap
CREATE TABLE IF NOT EXISTS voice_usage (
  firm_id INT NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  chars INT NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, day)
);
CREATE TABLE IF NOT EXISTS assistant_briefs (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  text TEXT NOT NULL,
  links JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
ALTER TABLE assistant_briefs ADD COLUMN IF NOT EXISTS lang TEXT;   -- the assistant language it was written in (null = English)
`;

async function migrate() { await pool.query(SCHEMA); }
// Larger indexes are built in the background after start (CONCURRENTLY: never blocks the app writing to these tables).
const LATE_INDEXES = [
  ["audit_case", `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_case ON audit_log(firm_id, (COALESCE(detail->>'case', detail->>'case_id')), at DESC) WHERE action IN ('case_team_added','case_team_removed','convo_edit','convo_delete','document_shared','document_deleted','event_deleted','task_deleted','discovery_set_deleted')`],
  ["audit_case_added", `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_case_added ON audit_log(firm_id, (detail->>'id')) WHERE action='case_added'`],
  ["tasks_case", `CREATE INDEX CONCURRENTLY IF NOT EXISTS tasks_case ON tasks(case_id)`],
  ["events_case", `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_case ON events(case_id)`],
  ["time_case", `CREATE INDEX CONCURRENTLY IF NOT EXISTS time_case ON time_entries(case_id)`],
  ["documents_case", `CREATE INDEX CONCURRENTLY IF NOT EXISTS documents_case ON documents(case_id)`],
];
async function lateIndexes() {
  for (const [name, sql] of LATE_INDEXES) {
    try {   // a build that was interrupted leaves an unusable index under the same name: drop it and build again
      if ((await pool.query("SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=$1 AND NOT i.indisvalid", [name])).rowCount) await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      await pool.query(sql);
    } catch (e) { console.warn("[db] index", name + ":", e.message); }
  }
}

module.exports = { pool, migrate, lateIndexes, q: (text, params) => pool.query(text, params) };
