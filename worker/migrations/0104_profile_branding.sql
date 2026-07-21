PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO platform_settings (setting_key, value_json, updated_at, updated_by)
VALUES (
  'branding',
  '{"avatar_data_url":null}',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'legacy-admin'
);
