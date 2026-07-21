import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function apply(sqlite, filename) {
  sqlite.exec(readFileSync(new URL(`../migrations/${filename}`, import.meta.url), "utf8"));
}

test("Telegram Skill migrations keep media sending and retire duplicate capabilities", () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const filename of [
    "0001_initial.sql",
    "0002_task_run_snapshots.sql",
    "0003_login_flow_modes.sql",
    "0004_tg_signer_secret_snapshots.sql",
    "0005_github_admin_auth.sql",
    "0006_admin_oauth_pkce.sql",
    "0007_public_users.sql",
  ]) apply(sqlite, filename);
  apply(sqlite, "0011_expand_telegram_skills.sql");
  apply(sqlite, "0012_remove_account_audit_skill.sql");

  const timestamp = "2026-07-22T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO accounts
    (id, user_id, name, phone_masked, status, enabled, created_at, updated_at)
    VALUES (?, 'legacy-admin', ?, ?, 'connected', 1, ?, ?)` ).run(
    "account-skill", "Skill account", "+86*******0001", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO tasks
    (id, user_id, name, account_id, skill_id, bot, command, params_json, cron, timezone,
     retry, timeout_seconds, enabled, created_at, updated_at)
    VALUES (?, 'legacy-admin', ?, ?, 'skill-bot-flow', ?, ?, ?, ?, 'UTC', 0, 120, 1, ?, ?)` ).run(
    "task-flow", "Flow", "account-skill", "@example_bot", "通用机器人流程 · 1 步",
    JSON.stringify({ target: "@example_bot", steps: [{ action: "send", text: "/start", timeout: 10 }] }),
    "0 * * * *", timestamp, timestamp,
  );
  sqlite.prepare(`INSERT INTO task_runs
    (id, user_id, task_id, trigger_type, status, scheduled_for, dedupe_key, max_attempts, created_at, updated_at)
    VALUES (?, 'legacy-admin', ?, 'manual', 'queued', ?, ?, 1, ?, ?)` ).run(
    "run-flow", "task-flow", timestamp, "manual:run-flow", timestamp, timestamp,
  );

  const before = sqlite.prepare("SELECT params_json_snapshot FROM task_runs WHERE id = ?").get("run-flow");
  assert.equal(JSON.parse(before.params_json_snapshot).steps[0].action, "send");

  apply(sqlite, "0013_retire_overlapping_skills.sql");

  assert.deepEqual(
    sqlite.prepare("SELECT skill_key FROM skills WHERE enabled = 1 AND skill_key IN ('bot_flow','send_media','chat_snapshot','account_audit') ORDER BY skill_key")
      .all().map((row) => row.skill_key),
    ["send_media"],
  );
  assert.equal(sqlite.prepare("SELECT enabled FROM tasks WHERE id = 'task-flow'").get().enabled, 0);
  const retiredRun = sqlite.prepare("SELECT status, error_code FROM task_runs WHERE id = 'run-flow'").get();
  assert.equal(retiredRun.status, "cancelled");
  assert.equal(retiredRun.error_code, "skill_retired");

  sqlite.prepare(`INSERT INTO media_assets
    (id, user_id, name, media_type, source_chat_id, source_message_id, created_at, updated_at)
    VALUES (?, 'legacy-admin', ?, 'photo', ?, 99, ?, ?)` ).run(
    "media-asset-1", "Catalog", "-1001234567890", timestamp, timestamp,
  );
  assert.equal(sqlite.prepare("SELECT media_type FROM media_assets WHERE id = ?").get("media-asset-1").media_type, "photo");
});
