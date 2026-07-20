PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bot_inspections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  start_command TEXT NOT NULL DEFAULT '/start',
  wait_seconds INTEGER NOT NULL DEFAULT 30 CHECK (wait_seconds BETWEEN 5 AND 60),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed', 'expired', 'cancelled')),
  claimed_by TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_inspections_user_time
  ON bot_inspections(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_inspections_queue
  ON bot_inspections(status, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_bot_inspections_account_active
  ON bot_inspections(account_id, status)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS realtime_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('keyword_reply', 'group_monitor')),
  name TEXT NOT NULL,
  chat_selector TEXT NOT NULL DEFAULT '*',
  keyword TEXT NOT NULL DEFAULT '',
  response_text TEXT,
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_realtime_rules_owner
  ON realtime_rules(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_realtime_rules_enabled
  ON realtime_rules(enabled, account_id, kind);

CREATE TABLE IF NOT EXISTS listener_instances (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'online', 'degraded', 'stopping', 'offline')),
  active_accounts INTEGER NOT NULL DEFAULT 0 CHECK (active_accounts >= 0),
  active_rules INTEGER NOT NULL DEFAULT 0 CHECK (active_rules >= 0),
  last_error TEXT,
  started_at TEXT,
  last_heartbeat_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listener_instances_heartbeat
  ON listener_instances(last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS listener_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT REFERENCES realtime_rules(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('message_observed', 'keyword_replied', 'listener_error', 'inspection_completed')),
  chat_id TEXT,
  sender_id TEXT,
  message_id TEXT,
  message_preview TEXT,
  action_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listener_events_time
  ON listener_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listener_events_rule_time
  ON listener_events(rule_id, created_at DESC);
