CREATE TABLE IF NOT EXISTS admin_oauth_states (
  state_hash TEXT PRIMARY KEY,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_oauth_states_expiry
  ON admin_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  github_user_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  github_name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions(expires_at);
