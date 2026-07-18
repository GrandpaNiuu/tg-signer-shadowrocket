PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  display_name TEXT NOT NULL,
  email TEXT,
  email_normalized TEXT,
  email_verified_at TEXT,
  password_algorithm TEXT,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER CHECK (password_iterations IS NULL OR password_iterations >= 100000),
  github_user_id TEXT,
  github_login TEXT,
  github_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email_normalized) WHERE email_normalized IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id
  ON users(github_user_id) WHERE github_user_id IS NOT NULL;

INSERT OR IGNORE INTO users (
  id, role, status, display_name, created_at, updated_at
) VALUES (
  'legacy-admin', 'admin', 'active', 'GrandpaNiuu',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

ALTER TABLE accounts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-admin';
ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-admin';
ALTER TABLE task_runs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-admin';
ALTER TABLE login_flows ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-admin';
ALTER TABLE admin_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'legacy-admin';

UPDATE accounts SET user_id = 'legacy-admin';
UPDATE tasks SET user_id = COALESCE((SELECT user_id FROM accounts WHERE accounts.id = tasks.account_id), 'legacy-admin');
UPDATE task_runs SET user_id = COALESCE((SELECT user_id FROM tasks WHERE tasks.id = task_runs.task_id), 'legacy-admin');
UPDATE login_flows SET user_id = COALESCE((SELECT user_id FROM accounts WHERE accounts.id = login_flows.account_id), 'legacy-admin');
UPDATE admin_sessions SET user_id = 'legacy-admin';

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_user ON task_runs(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_login_flows_user ON login_flows(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'email')),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent_label TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user
  ON user_sessions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expiry
  ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL CHECK (token_type IN ('verify_email', 'password_reset')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_type
  ON auth_tokens(user_id, token_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expiry
  ON auth_tokens(expires_at);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  action TEXT NOT NULL,
  bucket_hash TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (action, bucket_hash, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_expiry
  ON auth_rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, setting_key)
);

CREATE TRIGGER IF NOT EXISTS accounts_require_valid_user_insert
BEFORE INSERT ON accounts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account user does not exist');
END;

CREATE TRIGGER IF NOT EXISTS accounts_require_valid_user_update
BEFORE UPDATE OF user_id ON accounts
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'account user does not exist');
END;

CREATE TRIGGER IF NOT EXISTS tasks_require_owned_account_insert
BEFORE INSERT ON tasks
WHEN NOT EXISTS (
  SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'task account ownership mismatch');
END;

CREATE TRIGGER IF NOT EXISTS tasks_require_owned_account_update
BEFORE UPDATE OF account_id, user_id ON tasks
WHEN NOT EXISTS (
  SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'task account ownership mismatch');
END;

CREATE TRIGGER IF NOT EXISTS runs_require_owned_task_insert
BEFORE INSERT ON task_runs
WHEN NEW.task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks WHERE id = NEW.task_id AND user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'run task ownership mismatch');
END;

CREATE TRIGGER IF NOT EXISTS login_flows_require_owned_account_insert
BEFORE INSERT ON login_flows
WHEN NOT EXISTS (
  SELECT 1 FROM accounts WHERE id = NEW.account_id AND user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'login flow account ownership mismatch');
END;
