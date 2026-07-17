ALTER TABLE login_flows
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'interactive_login'
  CHECK (mode IN ('interactive_login', 'session_validation'));

ALTER TABLE login_flows ADD COLUMN resend_requested_at TEXT;
ALTER TABLE login_flows ADD COLUMN resend_consumed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_login_flows_account_status
  ON login_flows(account_id, status, created_at DESC);
