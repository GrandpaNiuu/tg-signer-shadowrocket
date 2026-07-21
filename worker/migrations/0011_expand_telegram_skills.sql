ALTER TABLE tasks ADD COLUMN params_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE task_runs ADD COLUMN params_json_snapshot TEXT;

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'document', 'video')),
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL CHECK (source_message_id > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_user_created
  ON media_assets(user_id, created_at DESC);

INSERT OR IGNORE INTO skills (
  id, skill_key, display_name, version, description, config_schema_json, enabled, created_at, updated_at
) VALUES
  ('skill-bot-flow', 'bot_flow', 'Bot Flow', '1', 'Run a validated multi-step Telegram bot interaction flow.',
   '{"type":"object","required":["target","steps"],"properties":{"target":{"type":"string"},"steps":{"type":"array","minItems":1,"maxItems":20},"message_thread_id":{"type":["integer","null"]}}}',
   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('skill-send-media', 'send_media', 'Send Media', '1', 'Copy a Worker-approved Telegram photo, document, or video to a target chat.',
   '{"type":"object","required":["target","file_id","media_type"],"properties":{"target":{"type":"string"},"file_id":{"type":"string"},"media_type":{"enum":["photo","document","video"]},"caption":{"type":["string","null"]},"message_thread_id":{"type":["integer","null"]},"delete_after":{"type":["integer","null"]}}}',
   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('skill-chat-snapshot', 'chat_snapshot', 'Chat Snapshot', '1', 'Collect recent Telegram message text for later analysis without calling AI.',
   '{"type":"object","required":["target"],"properties":{"target":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50},"keyword":{"type":["string","null"]}}}',
   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('skill-account-audit', 'account_audit', 'Account Audit', '1', 'Check Session validity, Telegram identity, proxy connectivity, and observed FloodWait state.',
   '{"type":"object","additionalProperties":false}',
   1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER IF NOT EXISTS trg_task_runs_params_snapshot
AFTER INSERT ON task_runs
WHEN NEW.params_json_snapshot IS NULL
BEGIN
  UPDATE task_runs
  SET params_json_snapshot = (SELECT params_json FROM tasks WHERE id = NEW.task_id)
  WHERE id = NEW.id;
END;
