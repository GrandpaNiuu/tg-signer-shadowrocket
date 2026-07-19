PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN telegram_user_id TEXT;
ALTER TABLE accounts ADD COLUMN telegram_username TEXT;
ALTER TABLE accounts ADD COLUMN telegram_display_name TEXT;
ALTER TABLE accounts ADD COLUMN last_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_health
  ON accounts(user_id, enabled, last_checked_at);
