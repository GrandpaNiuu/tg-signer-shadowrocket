CREATE TABLE IF NOT EXISTS media_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content_kind TEXT NOT NULL CHECK (content_kind IN (
    'photo', 'video', 'audio', 'voice', 'animation', 'video_note', 'sticker', 'document'
  )),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  total_chunks INTEGER NOT NULL CHECK (total_chunks > 0 AND total_chunks <= 40),
  uploaded_chunks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'uploaded', 'queued', 'processing', 'ready', 'failed', 'ambiguous', 'cancelled', 'expired'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  source_chat_id TEXT,
  source_message_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_uploads_user_created
  ON media_uploads(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_uploads_listener_queue
  ON media_uploads(status, created_at);

CREATE TABLE IF NOT EXISTS media_upload_chunks (
  upload_id TEXT NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0 AND chunk_index < 40),
  plaintext_size INTEGER NOT NULL CHECK (plaintext_size > 0 AND plaintext_size <= 524288),
  algorithm TEXT NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  aad TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS media_upload_leases (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  upload_id TEXT NOT NULL UNIQUE REFERENCES media_uploads(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_upload_leases_expiry
  ON media_upload_leases(leased_until);
