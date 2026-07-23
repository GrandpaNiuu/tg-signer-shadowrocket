PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS account_dialog_syncs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'success', 'failed', 'expired')),
  claimed_by TEXT,
  claimed_at TEXT,
  finished_at TEXT,
  expires_at TEXT NOT NULL,
  dialog_count INTEGER NOT NULL DEFAULT 0 CHECK (dialog_count >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_dialog_syncs_claim
  ON account_dialog_syncs(status, expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_account_dialog_syncs_account
  ON account_dialog_syncs(user_id, account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS account_dialogs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  peer_id TEXT NOT NULL,
  target TEXT NOT NULL,
  peer_type TEXT NOT NULL
    CHECK (peer_type IN ('private', 'bot', 'group', 'supergroup', 'channel')),
  title TEXT NOT NULL,
  username TEXT,
  label TEXT NOT NULL,
  is_writable INTEGER NOT NULL DEFAULT 1 CHECK (is_writable IN (0, 1)),
  last_message_at TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (account_id, peer_id)
);

CREATE INDEX IF NOT EXISTS idx_account_dialogs_owner
  ON account_dialogs(user_id, account_id, peer_type, label);
CREATE INDEX IF NOT EXISTS idx_account_dialogs_target
  ON account_dialogs(user_id, account_id, target);
