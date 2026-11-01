// Database connection + schema (runs automatically on boot)
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(1); }
const local = /localhost|127\.0\.0\.1|\/tmp\//.test(url) || url.includes("host=/");
const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });

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
CREATE INDEX IF NOT EXISTS audit_firm ON audit_log(firm_id, at DESC);
`;

async function migrate() { await pool.query(SCHEMA); }

module.exports = { pool, migrate, q: (text, params) => pool.query(text, params) };
