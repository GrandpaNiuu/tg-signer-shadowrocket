PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN avatar_data_url TEXT;

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_at, updated_by)
VALUES (
  'branding',
  '{"platform_name":"Telegram 自动消息","platform_avatar_data_url":null}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'legacy-admin'
);
