PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN avatar_data_url TEXT;

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
