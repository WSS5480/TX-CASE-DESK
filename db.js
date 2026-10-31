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
CREATE INDEX IF NOT EXISTS cases_firm_county ON cases(firm_id, county);
CREATE INDEX IF NOT EXISTS audit_firm ON audit_log(firm_id, at DESC);
`;

async function migrate() { await pool.query(SCHEMA); }

module.exports = { pool, migrate, q: (text, params) => pool.query(text, params) };
