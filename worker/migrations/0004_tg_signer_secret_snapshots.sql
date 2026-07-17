ALTER TABLE task_runs
  ADD COLUMN tg_signer_import_secret_id_snapshot TEXT
  REFERENCES secret_values(id) ON DELETE SET NULL;

-- Runs created before this migration already have their public task context
-- snapshotted by 0002. Preserve the matching tg-signer import while the task
-- still exists so queued/active runs cannot observe a later task edit.
UPDATE task_runs
SET tg_signer_import_secret_id_snapshot = (
  SELECT t.tg_signer_import_secret_id FROM tasks t WHERE t.id = task_runs.task_id
)
WHERE context_snapshot_version IS NOT NULL
  AND task_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = task_runs.task_id);

CREATE INDEX IF NOT EXISTS idx_task_runs_signer_secret_status
  ON task_runs(tg_signer_import_secret_id_snapshot, status)
  WHERE tg_signer_import_secret_id_snapshot IS NOT NULL;
