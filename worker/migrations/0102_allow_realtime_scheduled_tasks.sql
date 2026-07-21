PRAGMA foreign_keys = ON;

-- Realtime rules and ordinary scheduled tasks may share the same administrator
-- Telegram account. The Worker keeps those runs out of GitHub Actions and the
-- VPS Listener temporarily pauses the realtime client while executing a task,
-- then reconnects it after completion.
DROP TRIGGER IF EXISTS prevent_realtime_rule_for_task_account_insert;
DROP TRIGGER IF EXISTS prevent_realtime_rule_for_task_account_update;
DROP TRIGGER IF EXISTS prevent_task_for_realtime_account_insert;
DROP TRIGGER IF EXISTS prevent_task_for_realtime_account_update;
