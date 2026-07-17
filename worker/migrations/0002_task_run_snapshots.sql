ALTER TABLE task_runs ADD COLUMN context_snapshot_version INTEGER;
ALTER TABLE task_runs ADD COLUMN task_id_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN task_name_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN account_id_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN account_name_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN skill_key_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN skill_name_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN bot_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN command_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN cron_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN timezone_snapshot TEXT;
ALTER TABLE task_runs ADD COLUMN retry_snapshot INTEGER;
ALTER TABLE task_runs ADD COLUMN timeout_seconds_snapshot INTEGER;
ALTER TABLE task_runs ADD COLUMN thread_id_snapshot INTEGER;
ALTER TABLE task_runs ADD COLUMN delete_after_seconds_snapshot INTEGER;

-- Existing runs can be backfilled while their task still exists. Runs whose task
-- was deleted before this migration remain readable with the legacy fallback,
-- but their already-lost labels cannot be reconstructed.
UPDATE task_runs
SET task_id_snapshot = task_id,
    task_name_snapshot = (SELECT t.name FROM tasks t WHERE t.id = task_runs.task_id),
    account_id_snapshot = (SELECT t.account_id FROM tasks t WHERE t.id = task_runs.task_id),
    account_name_snapshot = (SELECT a.name FROM tasks t JOIN accounts a ON a.id = t.account_id
      WHERE t.id = task_runs.task_id),
    skill_key_snapshot = (SELECT s.skill_key FROM tasks t JOIN skills s ON s.id = t.skill_id
      WHERE t.id = task_runs.task_id),
    skill_name_snapshot = (SELECT s.display_name FROM tasks t JOIN skills s ON s.id = t.skill_id
      WHERE t.id = task_runs.task_id),
    bot_snapshot = (SELECT t.bot FROM tasks t WHERE t.id = task_runs.task_id),
    command_snapshot = (SELECT t.command FROM tasks t WHERE t.id = task_runs.task_id),
    cron_snapshot = (SELECT t.cron FROM tasks t WHERE t.id = task_runs.task_id),
    timezone_snapshot = (SELECT t.timezone FROM tasks t WHERE t.id = task_runs.task_id),
    retry_snapshot = (SELECT t.retry FROM tasks t WHERE t.id = task_runs.task_id),
    timeout_seconds_snapshot = (SELECT t.timeout_seconds FROM tasks t WHERE t.id = task_runs.task_id),
    thread_id_snapshot = (SELECT t.thread_id FROM tasks t WHERE t.id = task_runs.task_id),
    delete_after_seconds_snapshot = (SELECT t.delete_after_seconds FROM tasks t WHERE t.id = task_runs.task_id),
    context_snapshot_version = 1
WHERE task_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_runs.task_id);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_snapshot_time
  ON task_runs(task_id_snapshot, created_at DESC);
