import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("task run snapshot migration backfills an existing D1 database", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const timestamp = "2026-07-18T00:00:00.000Z";

  sqlite.prepare(`INSERT INTO accounts
    (id, name, phone_masked, status, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'connected', 1, ?, ?)`).run("account-old", "Old account", "+86*******5678", timestamp, timestamp);
  sqlite.prepare(`INSERT INTO tasks
    (id, name, account_id, skill_id, bot, command, cron, timezone, retry, timeout_seconds,
     enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'skill-send-text', ?, ?, ?, 'UTC', 2, 180, 1, ?, ?)`).run(
    "task-old", "Old task", "account-old", "@old_bot", "/old", "15 * * * *", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO task_runs
    (id, task_id, trigger_type, status, scheduled_for, dedupe_key, max_attempts, created_at, updated_at)
    VALUES (?, ?, 'schedule', 'success', ?, ?, 3, ?, ?)`).run(
    "run-old", "task-old", timestamp, `schedule:task-old:${timestamp}`, timestamp, timestamp,
  );

  sqlite.exec(readFileSync(new URL("../migrations/0002_task_run_snapshots.sql", import.meta.url), "utf8"));

  const snapshot = sqlite.prepare(`SELECT task_id_snapshot, task_name_snapshot, account_id_snapshot,
    account_name_snapshot, skill_key_snapshot, bot_snapshot, command_snapshot, cron_snapshot,
    timezone_snapshot, retry_snapshot, timeout_seconds_snapshot FROM task_runs WHERE id = ?`).get("run-old");
  assert.deepEqual({ ...snapshot }, {
    task_id_snapshot: "task-old",
    task_name_snapshot: "Old task",
    account_id_snapshot: "account-old",
    account_name_snapshot: "Old account",
    skill_key_snapshot: "send_text",
    bot_snapshot: "@old_bot",
    command_snapshot: "/old",
    cron_snapshot: "15 * * * *",
    timezone_snapshot: "UTC",
    retry_snapshot: 2,
    timeout_seconds_snapshot: 180,
  });
});

test("tg-signer secret snapshot migration backfills non-terminal runs", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const timestamp = "2026-07-18T00:00:00.000Z";

  sqlite.prepare(`INSERT INTO accounts
    (id, name, phone_masked, status, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'connected', 1, ?, ?)`).run(
    "account-signer", "Signer account", "+86*******0002", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO secret_values
    (id, owner_type, owner_id, purpose, algorithm, ciphertext, nonce, aad, key_version, created_at, updated_at)
    VALUES (?, 'task', ?, 'tg_signer_import', 'AES-256-GCM', 'ciphertext', 'nonce', 'aad', 1, ?, ?)`)
    .run("secret-signer-old", "task-signer", timestamp, timestamp);
  sqlite.prepare(`INSERT INTO tasks
    (id, name, account_id, skill_id, tg_signer_import_secret_id, bot, command, cron, timezone,
     retry, timeout_seconds, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'skill-tg-signer', ?, '', ?, ?, 'UTC', 0, 120, 1, ?, ?)`).run(
    "task-signer", "Signer task", "account-signer", "secret-signer-old", "daily", "0 * * * *",
    timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO task_runs
    (id, task_id, trigger_type, status, scheduled_for, dedupe_key, max_attempts, created_at, updated_at)
    VALUES (?, ?, 'manual', 'queued', ?, ?, 1, ?, ?)`).run(
    "run-signer", "task-signer", timestamp, "manual:run-signer", timestamp, timestamp,
  );

  sqlite.exec(readFileSync(new URL("../migrations/0002_task_run_snapshots.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0004_tg_signer_secret_snapshots.sql", import.meta.url), "utf8"));

  const snapshot = sqlite.prepare(`SELECT tg_signer_import_secret_id_snapshot
    FROM task_runs WHERE id = ?`).get("run-signer");
  assert.equal(snapshot.tg_signer_import_secret_id_snapshot, "secret-signer-old");
});

test("GitHub administrator auth migration preserves an existing control-plane database", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  const timestamp = "2026-07-18T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO accounts
    (id, name, phone_masked, status, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'connected', 1, ?, ?)`).run(
    "account-existing", "Existing account", "+86*******5678", timestamp, timestamp,
  );

  sqlite.exec(readFileSync(new URL("../migrations/0005_github_admin_auth.sql", import.meta.url), "utf8"));
  sqlite.prepare(`INSERT INTO admin_oauth_states
    (state_hash, return_to, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .run("old-state-hash", "/#/dashboard", "2026-07-18T00:10:00.000Z", timestamp);
  sqlite.prepare(`INSERT INTO admin_sessions
    (token_hash, github_user_id, github_login, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run("session-hash", "225517310", "GrandpaNiuu", timestamp, "2026-07-25T00:00:00.000Z");

  sqlite.exec(readFileSync(new URL("../migrations/0006_admin_oauth_pkce.sql", import.meta.url), "utf8"));
  sqlite.prepare(`INSERT INTO admin_oauth_states
    (state_hash, code_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("pkce-state-hash", "a".repeat(43), "/#/dashboard", "2026-07-18T00:10:00.000Z", timestamp);

  assert.equal(sqlite.prepare("SELECT name FROM accounts WHERE id = ?").get("account-existing").name, "Existing account");
  assert.equal(sqlite.prepare("SELECT github_login FROM admin_sessions WHERE token_hash = ?").get("session-hash").github_login, "GrandpaNiuu");
  assert.equal(sqlite.prepare("SELECT code_verifier FROM admin_oauth_states WHERE state_hash = ?")
    .get("old-state-hash").code_verifier, null);
  assert.equal(sqlite.prepare("SELECT code_verifier FROM admin_oauth_states WHERE state_hash = ?")
    .get("pkce-state-hash").code_verifier, "a".repeat(43));
});

test("public-user migration assigns every legacy record and session to the preserved administrator", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of [
    "0001_initial.sql",
    "0002_task_run_snapshots.sql",
    "0003_login_flow_modes.sql",
    "0004_tg_signer_secret_snapshots.sql",
    "0005_github_admin_auth.sql",
    "0006_admin_oauth_pkce.sql",
  ]) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const timestamp = "2026-07-18T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO accounts
    (id, name, phone_masked, status, enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'connected', 1, ?, ?)`).run(
    "legacy-account", "Legacy account", "+86*******5678", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO tasks
    (id, name, account_id, skill_id, bot, command, cron, timezone, retry, timeout_seconds,
     enabled, created_at, updated_at)
    VALUES (?, ?, ?, 'skill-send-text', ?, ?, ?, 'UTC', 0, 120, 1, ?, ?)`).run(
    "legacy-task", "Legacy task", "legacy-account", "@legacy_bot", "/checkin", "0 * * * *", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO task_runs
    (id, task_id, trigger_type, status, scheduled_for, dedupe_key, max_attempts, created_at, updated_at)
    VALUES (?, ?, 'manual', 'success', ?, ?, 1, ?, ?)`).run(
    "legacy-run", "legacy-task", timestamp, "manual:legacy-run", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO admin_sessions
    (token_hash, github_user_id, github_login, github_name, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    "legacy-session", "225517310", "GrandpaNiuu", "Grandpa Niu", timestamp, "2026-07-25T00:00:00.000Z",
  );

  sqlite.exec(readFileSync(new URL("../migrations/0007_public_users.sql", import.meta.url), "utf8"));

  assert.deepEqual({ ...sqlite.prepare("SELECT id, role, status, display_name FROM users WHERE id = 'legacy-admin'").get() }, {
    id: "legacy-admin",
    role: "admin",
    status: "active",
    display_name: "GrandpaNiuu",
  });
  assert.equal(sqlite.prepare("SELECT user_id FROM accounts WHERE id = 'legacy-account'").get().user_id, "legacy-admin");
  assert.equal(sqlite.prepare("SELECT user_id FROM tasks WHERE id = 'legacy-task'").get().user_id, "legacy-admin");
  assert.equal(sqlite.prepare("SELECT user_id FROM task_runs WHERE id = 'legacy-run'").get().user_id, "legacy-admin");
  assert.equal(sqlite.prepare("SELECT user_id FROM admin_sessions WHERE token_hash = 'legacy-session'").get().user_id, "legacy-admin");
});

test("deployment cleanup removes only synthetic users and resets temporary auth throttles", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of [
    "0001_initial.sql",
    "0002_task_run_snapshots.sql",
    "0003_login_flow_modes.sql",
    "0004_tg_signer_secret_snapshots.sql",
    "0005_github_admin_auth.sql",
    "0006_admin_oauth_pkce.sql",
    "0007_public_users.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${filename}`, import.meta.url), "utf8"));
  }
  const timestamp = "2026-07-18T00:00:00.000Z";
  const insert = sqlite.prepare(`INSERT INTO users
    (id, role, status, display_name, email, email_normalized, created_at, updated_at)
    VALUES (?, 'user', 'active', ?, ?, ?, ?, ?)`);
  insert.run("synthetic", "Synthetic", "codex-health-1@example.invalid", "codex-health-1@example.invalid", timestamp, timestamp);
  insert.run("real", "Real", "person@example.com", "person@example.com", timestamp, timestamp);
  sqlite.prepare(`INSERT INTO auth_rate_limits
    (action, bucket_hash, window_started_at, attempt_count, expires_at)
    VALUES ('register_ip', 'bucket', ?, 3, ?)`).run(timestamp, "2026-07-18T01:00:00.000Z");

  sqlite.exec(readFileSync(new URL("../migrations/0008_remove_deployment_test_users.sql", import.meta.url), "utf8"));

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'synthetic'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE id = 'real'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM auth_rate_limits").get().count, 0);
});

test("scheduler retirement migration makes D1 authoritative", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  assert.equal(JSON.parse(sqlite.prepare("SELECT value_json FROM settings WHERE setting_key = 'scheduler_mode'").get().value_json), "legacy");

  sqlite.exec(readFileSync(new URL("../migrations/0010_retire_legacy_scheduler.sql", import.meta.url), "utf8"));

  assert.equal(JSON.parse(sqlite.prepare("SELECT value_json FROM settings WHERE setting_key = 'scheduler_mode'").get().value_json), "d1");
  assert.equal(sqlite.prepare("SELECT display_name FROM skills WHERE skill_key = 'send_text'").get().display_name, "Send Message");
});
