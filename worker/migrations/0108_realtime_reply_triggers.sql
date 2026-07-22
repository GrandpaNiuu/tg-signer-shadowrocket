ALTER TABLE realtime_rules
  ADD COLUMN trigger_mode TEXT NOT NULL DEFAULT 'keyword'
  CHECK (trigger_mode IN ('keyword', 'reply_to_own', 'keyword_or_reply_to_own'));
