-- The legacy GitHub-Secrets scheduler has been migrated and retired.
-- Keep the setting for API/health compatibility, but make D1 authoritative.
INSERT INTO settings (setting_key, value_json, description, updated_at)
VALUES (
  'scheduler_mode',
  '"d1"',
  'D1 is the only task scheduler; the legacy workflow has been retired.',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
ON CONFLICT(setting_key) DO UPDATE SET
  value_json = excluded.value_json,
  description = excluded.description,
  updated_at = excluded.updated_at;

UPDATE skills
SET display_name = 'Send Message',
    description = 'Send a Telegram message or bot command and optionally delete it later.',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE skill_key = 'send_text';
