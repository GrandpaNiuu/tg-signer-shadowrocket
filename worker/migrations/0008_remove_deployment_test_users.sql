-- Remove synthetic accounts created by deployment smoke tests. The reserved
-- example.invalid domain cannot be a real mailbox. Rate-limit buckets contain
-- no user data and are reset so smoke tests do not consume a visitor's quota.
DELETE FROM users
WHERE email_normalized LIKE 'codex-%@example.invalid';

DELETE FROM auth_rate_limits;
