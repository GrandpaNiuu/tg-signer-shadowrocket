UPDATE settings
SET value_json = 'true', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE setting_key = 'notifications_enabled';

UPDATE realtime_rules
SET notify_on_match = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE notify_on_match <> 1;
