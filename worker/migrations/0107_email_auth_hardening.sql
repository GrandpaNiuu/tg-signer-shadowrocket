PRAGMA foreign_keys = ON;

-- Verification attempts must be bounded by the active token itself, not only by
-- an IP-derived rate-limit bucket. This prevents changing IP addresses from
-- resetting the six-digit code attempt budget.
ALTER TABLE auth_tokens ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_auth_tokens_active_verification
  ON auth_tokens(user_id, token_type, consumed_at, expires_at, created_at);
