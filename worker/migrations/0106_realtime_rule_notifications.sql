ALTER TABLE realtime_rules
  ADD COLUMN notify_on_match INTEGER NOT NULL DEFAULT 1
  CHECK (notify_on_match IN (0, 1));
