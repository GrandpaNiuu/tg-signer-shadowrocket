UPDATE task_runs
SET status = 'cancelled',
    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    error_code = 'skill_retired',
    error_message = 'Account audit was removed; use Telegram account validation instead.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE status = 'queued'
  AND task_id IN (
    SELECT t.id
    FROM tasks t
    JOIN skills s ON s.id = t.skill_id
    WHERE s.skill_key = 'account_audit'
  );

UPDATE tasks
SET enabled = 0,
    next_run_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE skill_id = (SELECT id FROM skills WHERE skill_key = 'account_audit');

UPDATE skills
SET enabled = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE skill_key = 'account_audit';
