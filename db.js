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
CREATE INDEX IF NOT EXISTS cases_firm_county ON cases(firm_id, county);
CREATE INDEX IF NOT EXISTS audit_firm ON audit_log(firm_id, at DESC);
`;

async function migrate() { await pool.query(SCHEMA); }

module.exports = { pool, migrate, q: (text, params) => pool.query(text, params) };
