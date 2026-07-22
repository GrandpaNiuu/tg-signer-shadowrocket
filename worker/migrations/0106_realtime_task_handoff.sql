PRAGMA foreign_keys = ON;

-- A realtime Telegram client and a short-lived GitHub Runner must not use the
-- same Telegram authorization at the same moment. A handoff briefly hides the
-- enabled realtime rules from the Listener, waits for its normal config sync,
-- then permits the queued task to dispatch. The rules are restored automatically
-- after completion, dispatch rollback, expiry, or deletion.

CREATE TABLE IF NOT EXISTS realtime_task_handoffs (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id) ON DELETE CASCADE,
  ready_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_realtime_task_handoffs_expiry
  ON realtime_task_handoffs(expires_at, ready_at);

CREATE TABLE IF NOT EXISTS realtime_task_handoff_rules (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES realtime_rules(id) ON DELETE CASCADE,
  PRIMARY KEY(task_run_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_realtime_task_handoff_rules_account
  ON realtime_task_handoff_rules(account_id, task_run_id);

CREATE TRIGGER IF NOT EXISTS restore_realtime_rules_before_handoff_delete
BEFORE DELETE ON realtime_task_handoffs
BEGIN
  UPDATE realtime_rules
  SET enabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id IN (
    SELECT rule_id FROM realtime_task_handoff_rules
    WHERE task_run_id = OLD.task_run_id
  );
  DELETE FROM realtime_task_handoff_rules WHERE task_run_id = OLD.task_run_id;
END;

CREATE TRIGGER IF NOT EXISTS cleanup_realtime_handoff_after_terminal_run
AFTER UPDATE OF status ON task_runs
WHEN NEW.status IN ('success', 'failed', 'cancelled', 'ambiguous')
BEGIN
  DELETE FROM realtime_task_handoffs WHERE task_run_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS cleanup_realtime_handoff_after_dispatch_reset
AFTER UPDATE OF dispatch_status ON task_runs
WHEN NEW.status = 'queued' AND NEW.dispatch_status = 'pending'
  AND OLD.dispatch_status IN ('dispatching', 'dispatched')
BEGIN
  DELETE FROM realtime_task_handoffs WHERE task_run_id = NEW.id;
END;
