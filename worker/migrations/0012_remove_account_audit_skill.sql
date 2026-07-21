UPDATE tasks
SET enabled = 0,
    next_run_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE skill_id = (SELECT id FROM skills WHERE skill_key = 'account_audit');

UPDATE skills
SET enabled = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE skill_key = 'account_audit';
