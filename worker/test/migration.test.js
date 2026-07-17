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
