PRAGMA foreign_keys = ON;

-- The browser API and repository facade already reject these conflicts. These
-- triggers close the final race between separate Worker requests and a Runner
-- that has been dispatched but has not established its account lease yet.

CREATE TRIGGER IF NOT EXISTS prevent_bot_inspection_during_active_run
BEFORE INSERT ON bot_inspections
WHEN EXISTS (
  SELECT 1
  FROM task_runs r
  LEFT JOIN tasks t ON t.id = r.task_id
  WHERE COALESCE(r.account_id_snapshot, t.account_id) = NEW.account_id
    AND (
      r.status IN ('claimed', 'running')
      OR (r.status = 'queued' AND r.dispatch_status IN ('dispatching', 'dispatched'))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'bot_inspection_account_busy');
END;

CREATE TRIGGER IF NOT EXISTS prevent_realtime_rule_for_task_account_insert
BEFORE INSERT ON realtime_rules
WHEN NEW.enabled = 1 AND EXISTS (
  SELECT 1 FROM tasks
  WHERE account_id = NEW.account_id AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'realtime_account_has_tasks');
END;

CREATE TRIGGER IF NOT EXISTS prevent_realtime_rule_for_task_account_update
BEFORE UPDATE OF account_id, enabled ON realtime_rules
WHEN NEW.enabled = 1 AND EXISTS (
  SELECT 1 FROM tasks
  WHERE account_id = NEW.account_id AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'realtime_account_has_tasks');
END;

CREATE TRIGGER IF NOT EXISTS prevent_task_for_realtime_account_insert
BEFORE INSERT ON tasks
WHEN NEW.enabled = 1 AND EXISTS (
  SELECT 1 FROM realtime_rules
  WHERE account_id = NEW.account_id AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'account_reserved_for_realtime_listener');
END;

CREATE TRIGGER IF NOT EXISTS prevent_task_for_realtime_account_update
BEFORE UPDATE OF account_id, enabled ON tasks
WHEN NEW.enabled = 1 AND EXISTS (
  SELECT 1 FROM realtime_rules
  WHERE account_id = NEW.account_id AND enabled = 1
)
BEGIN
  SELECT RAISE(ABORT, 'account_reserved_for_realtime_listener');
END;
