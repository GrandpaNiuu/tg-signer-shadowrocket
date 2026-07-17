PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS secret_values (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'task', 'login_flow', 'setting')),
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  aad TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  expires_at TEXT,
  consumed_at TEXT,
  delivered_to_run_id TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secret_values_owner ON secret_values(owner_type, owner_id, purpose);
CREATE INDEX IF NOT EXISTS idx_secret_values_expiry ON secret_values(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_masked TEXT NOT NULL,
  phone_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  api_id_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  api_hash_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  session_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  proxy_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'login_pending', 'connected', 'error')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_error TEXT,
  last_connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  skill_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config_schema_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  tg_signer_import_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  bot TEXT NOT NULL,
  command TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  retry INTEGER NOT NULL DEFAULT 0 CHECK (retry BETWEEN 0 AND 10),
  timeout_seconds INTEGER NOT NULL DEFAULT 120 CHECK (timeout_seconds BETWEEN 5 AND 900),
  thread_id INTEGER,
  delete_after_seconds INTEGER CHECK (delete_after_seconds IS NULL OR delete_after_seconds BETWEEN 0 AND 86400),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'manual', 'migration')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'running', 'success', 'failed', 'cancelled', 'ambiguous')),
  scheduled_for TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 11),
  github_run_id TEXT,
  dispatch_status TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_status IN ('pending', 'dispatching', 'dispatched')),
  dispatch_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempt_count >= 0),
  dispatch_reserved_at TEXT,
  dispatched_at TEXT,
  next_dispatch_at TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_time ON task_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_status_time ON task_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_dispatch ON task_runs(status, dispatch_status, next_dispatch_at, created_at);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'ambiguous')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_run_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(id) ON DELETE SET NULL,
  dedupe_key TEXT,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_logs_run ON task_logs(task_run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_logs_dedupe ON task_logs(task_run_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_flows (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('created', 'starting', 'code_required', 'code_submitted', 'password_required', 'password_submitted', 'connected', 'failed', 'cancelled', 'expired')),
  code_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  password_secret_id TEXT REFERENCES secret_values(id) ON DELETE SET NULL,
  github_run_id TEXT,
  claimed_at TEXT,
  expires_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_flows_expiry ON login_flows(status, expires_at);

CREATE TABLE IF NOT EXISTS account_leases (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id) ON DELETE CASCADE,
  github_run_id TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO skills (
  id, skill_key, display_name, version, description, config_schema_json, enabled, created_at, updated_at
) VALUES
  ('skill-send-text', 'send_text', 'Send Text', '1', 'Send one Telegram command and optionally delete it later.', '{"type":"object","required":["bot","command"]}', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('skill-tg-signer', 'tg_signer', 'tg-signer', '1', 'Run a registered tg-signer task configuration.', '{"type":"object","properties":{"task_name":{"type":"string"},"import_blob":{"type":"string","writeOnly":true},"import_encoding":{"enum":["auto","base64","plain"]},"num_of_dialogs":{"type":"integer","minimum":1,"maximum":500}},"required":["task_name"]}', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO settings (setting_key, value_json, description, updated_at) VALUES
  ('scheduler_mode', '"legacy"', 'legacy keeps the original daily workflow; d1 dispatches due D1 tasks.', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('default_timezone', '"Asia/Shanghai"', 'Default timezone for new tasks.', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('notifications_enabled', 'true', 'Whether the Worker should send sanitized run notifications.', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
