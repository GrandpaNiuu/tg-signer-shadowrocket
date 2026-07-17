import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createD1Repository } from "../src/repository.js";

class D1StatementAdapter {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new D1StatementAdapter(this.database, this.sql, bindings); }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) || null; }
  async all() { return { success: true, results: this.database.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  execute() {
    return /^\s*(SELECT|WITH|PRAGMA)\b/i.test(this.sql) ? this.all() : this.run();
  }
}

class D1Adapter {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1StatementAdapter(this.database, sql); }
  async batch(statements) {
    if (this.beforeBatch) await this.beforeBatch(statements);
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.execute());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function repositoryHarness() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(filename, directory), "utf8"));
  }
  const db = new D1Adapter(sqlite);
  return { sqlite, db, repository: createD1Repository(db) };
}

function testSecret(id, ownerId, purpose, timestamp, ownerType = "account") {
  return {
    id,
    owner_type: ownerType,
    owner_id: ownerId,
    purpose,
    algorithm: "AES-256-GCM",
    ciphertext: "ciphertext",
    nonce: "nonce",
    aad: "aad",
    key_version: 1,
    expires_at: null,
    consumed_at: null,
    delivered_to_run_id: null,
    delivered_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

async function seedSessionValidationExecution(repository, {
  accountId,
  flowId,
  githubRunId,
  timestamp,
  expiresAt,
}) {
  const accountSecrets = [
    [`${accountId}-api-id`, "api_id"],
    [`${accountId}-api-hash`, "api_hash"],
    [`${accountId}-session`, "telegram_session"],
  ].map(([id, purpose]) => testSecret(id, accountId, purpose, timestamp));
  await repository.createAccount({
    account: {
      id: accountId,
      name: "Validation",
      phone_masked: "+86*******0003",
      status: "connected",
      enabled: 1,
      last_connected_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
    secrets: accountSecrets,
  });
  await repository.createSessionValidationFlow(accountId, {
    id: flowId,
    expires_at: expiresAt,
    created_at: timestamp,
    updated_at: timestamp,
  });
  assert.ok(await repository.claimLoginFlow(flowId, githubRunId, timestamp));
}

test("D1 repository persists accounts, tasks, and an idempotent task run", async () => {
  const { sqlite, repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";

  await repository.createAccount({
    account: {
      id: "account-1", name: "Primary", phone_masked: "+86••••5678", status: "connected", enabled: 1,
      last_connected_at: timestamp, created_at: timestamp, updated_at: timestamp,
    },
    secrets: [],
  });
  const skill = await repository.getSkillByKey("send_text");
  const task = await repository.createTask({
    id: "task-1", name: "Check in", account_id: "account-1", skill_id: skill.id, bot: "@example_bot",
    command: "/checkin", cron: "0 * * * *", timezone: "UTC", retry: 1, timeout_seconds: 120,
    thread_id: null, delete_after_seconds: null, enabled: 1, next_run_at: timestamp,
    created_at: timestamp, updated_at: timestamp,
  });
  assert.equal(task.skill_key, "send_text");

  const run = {
    id: "run-1", task_id: "task-1", trigger_type: "schedule", scheduled_for: timestamp,
    dedupe_key: `schedule:task-1:${timestamp}`, max_attempts: 2, claim_expires_at: "2026-07-18T00:20:00.000Z",
    created_at: timestamp, updated_at: timestamp,
  };
  assert.equal(await repository.enqueueRun({ run, nextRunAt: "2026-07-18T01:00:00.000Z" }), true);
  assert.equal(await repository.enqueueRun({ run: { ...run, id: "run-duplicate" }, nextRunAt: "2026-07-18T01:00:00.000Z" }), false);
  const stored = await repository.getRun("run-1");
  assert.equal(stored.status, "queued");
  assert.equal(stored.max_attempts, 2);
  assert.deepEqual({
    task_id: stored.task_id,
    task_name: stored.task_name,
    account_id: stored.account_id,
    account_name: stored.account_name,
    skill_key: stored.skill_key,
    bot: stored.bot,
    command: stored.command,
  }, {
    task_id: "task-1",
    task_name: "Check in",
    account_id: "account-1",
    account_name: "Primary",
    skill_key: "send_text",
    bot: "@example_bot",
    command: "/checkin",
  });

  await repository.createAccount({
    account: {
      id: "account-2", name: "Secondary", phone_masked: "+86••••9999", status: "connected", enabled: 1,
      last_connected_at: timestamp, created_at: timestamp, updated_at: timestamp,
    },
    secrets: [],
  });
  const signerSkill = await repository.getSkillByKey("tg_signer");

  sqlite.prepare(`UPDATE tasks SET name = 'Edited task', bot = '@edited_bot', command = '/edited',
    retry = 4, timeout_seconds = 300, account_id = 'account-2', skill_id = ? WHERE id = 'task-1'`)
    .run(signerSkill.id);
  sqlite.prepare("UPDATE accounts SET name = 'Edited account' WHERE id = 'account-1'").run();
  const afterEdit = await repository.getRun("run-1");
  assert.equal(afterEdit.task_name, "Check in");
  assert.equal(afterEdit.account_name, "Primary");
  assert.equal(afterEdit.bot, "@example_bot");
  assert.equal(afterEdit.command, "/checkin");
  assert.equal(afterEdit.retry, 1);
  assert.equal(afterEdit.timeout_seconds, 120);

  const execution = await repository.getExecution("run-1");
  assert.equal(execution.task_name, "Check in");
  assert.equal(execution.account_id, "account-1");
  assert.equal(execution.account_name, "Primary");
  assert.equal(execution.skill_key, "send_text");
  assert.equal(execution.bot, "@example_bot");
  assert.equal(execution.command, "/checkin");
  assert.equal(execution.retry, 1);
  assert.equal(execution.timeout_seconds, 120);
  assert.deepEqual(await repository.listDispatchableAccountIds(timestamp, 10), ["account-1"]);

  await repository.appendLogs("run-1", [{
    attempt_id: null,
    dedupe_key: "history-log",
    level: "info",
    message: "completed",
    created_at: timestamp,
  }]);

  assert.deepEqual(await repository.deleteTask("task-1", "2026-07-18T00:10:00.000Z"), {
    deleted: true,
    blocked: false,
  });
  assert.deepEqual(await repository.deleteAccount("account-1"), { deleted: true, blocked: false });
  const historical = await repository.getRun("run-1");
  assert.equal(historical.status, "cancelled");
  assert.equal(historical.error_code, "task_deleted");
  assert.equal(historical.task_id, "task-1");
  assert.equal(historical.task_name, "Check in");
  assert.equal(historical.account_id, "account-1");
  assert.equal(historical.account_name, "Primary");
  assert.equal(historical.skill_key, "send_text");
  assert.equal(historical.bot, "@example_bot");
  assert.equal(historical.command, "/checkin");
  const filtered = await repository.listRuns({ limit: 10, offset: 0, taskId: "task-1", status: null });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].task_name, "Check in");
  const dashboard = await repository.dashboard("2026-07-18T00:00:00.000Z");
  assert.equal(dashboard.recent_runs[0].task_name, "Check in");
  assert.equal(dashboard.recent_logs[0].task_name, "Check in");
});

test("deleteTask blocks when a queued run is claimed immediately before deletion", async () => {
  const { db, repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";

  await repository.createAccount({
    account: {
      id: "account-race", name: "Race", phone_masked: "+86*******0001", status: "connected", enabled: 1,
      last_connected_at: timestamp, created_at: timestamp, updated_at: timestamp,
    },
    secrets: [],
  });
  const skill = await repository.getSkillByKey("send_text");
  await repository.createTask({
    id: "task-race", name: "Race task", account_id: "account-race", skill_id: skill.id,
    bot: "@example_bot", command: "/checkin", cron: "0 * * * *", timezone: "UTC", retry: 0,
    timeout_seconds: 120, thread_id: null, delete_after_seconds: null, enabled: 1,
    next_run_at: timestamp, created_at: timestamp, updated_at: timestamp,
  });
  await repository.enqueueRun({
    run: {
      id: "run-race", task_id: "task-race", trigger_type: "manual", scheduled_for: timestamp,
      dedupe_key: "manual:run-race", max_attempts: 1, claim_expires_at: "2026-07-18T01:00:00.000Z",
      created_at: timestamp, updated_at: timestamp,
    },
  });

  db.beforeBatch = async () => {
    db.beforeBatch = null;
    assert.ok(await repository.claimRun(
      "run-race",
      "9001",
      "2026-07-18T00:00:01.000Z",
      "2026-07-18T00:10:00.000Z",
    ));
  };

  assert.deepEqual(await repository.deleteTask("task-race", "2026-07-18T00:00:02.000Z"), {
    deleted: false,
    blocked: true,
  });
  assert.ok(await repository.getTask("task-race"));
  assert.equal((await repository.getRun("run-race")).status, "claimed");
});

test("queued tg-signer run keeps its import secret through task edits and releases it at completion", async () => {
  const { repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";

  await repository.createAccount({
    account: {
      id: "account-signer", name: "Signer", phone_masked: "+86*******0002", status: "connected", enabled: 1,
      last_connected_at: timestamp, created_at: timestamp, updated_at: timestamp,
    },
    secrets: [],
  });
  const signerSkill = await repository.getSkillByKey("tg_signer");
  const oldSecret = testSecret(
    "secret-signer-old", "task-signer", "tg_signer_import", timestamp, "task",
  );
  await repository.createTask({
    id: "task-signer", name: "Signer task", account_id: "account-signer", skill_id: signerSkill.id,
    bot: "", command: "daily", cron: "0 * * * *", timezone: "UTC", retry: 0, timeout_seconds: 120,
    thread_id: null, delete_after_seconds: null, enabled: 1, next_run_at: timestamp,
    created_at: timestamp, updated_at: timestamp,
  }, oldSecret);
  await repository.enqueueRun({
    run: {
      id: "run-signer", task_id: "task-signer", trigger_type: "manual", scheduled_for: timestamp,
      dedupe_key: "manual:run-signer", max_attempts: 1, claim_expires_at: "2026-07-18T01:00:00.000Z",
      created_at: timestamp, updated_at: timestamp,
    },
  });
  await repository.enqueueRun({
    run: {
      id: "run-signer-second", task_id: "task-signer", trigger_type: "manual", scheduled_for: timestamp,
      dedupe_key: "manual:run-signer-second", max_attempts: 1,
      claim_expires_at: "2026-07-18T01:00:00.000Z", created_at: timestamp, updated_at: timestamp,
    },
  });

  const sendTextSkill = await repository.getSkillByKey("send_text");
  await repository.updateTask("task-signer", {
    skill_id: sendTextSkill.id,
    bot: "@example_bot",
    command: "/new",
    updated_at: "2026-07-18T00:00:01.000Z",
  }, { clearSignerImport: true });

  const queuedExecution = await repository.getExecution("run-signer");
  assert.equal(queuedExecution.skill_key, "tg_signer");
  assert.equal(queuedExecution.command, "daily");
  assert.equal(queuedExecution.tg_signer_import_secret_id, oldSecret.id);
  assert.ok(await repository.getSecret(oldSecret.id));

  assert.ok(await repository.claimRun(
    "run-signer",
    "9002",
    "2026-07-18T00:00:02.000Z",
    "2026-07-18T00:10:00.000Z",
  ));
  assert.equal(await repository.completeRun("run-signer", "9002", {
    status: "success",
    started_at: "2026-07-18T00:00:02.000Z",
    finished_at: "2026-07-18T00:00:03.000Z",
    duration_ms: 1_000,
    attempts: 1,
    error_code: null,
    error_message: null,
    result_json: "{}",
    updated_at: "2026-07-18T00:00:03.000Z",
  }), true);
  assert.ok(await repository.getSecret(oldSecret.id));

  assert.ok(await repository.claimRun(
    "run-signer-second",
    "9003",
    "2026-07-18T00:00:04.000Z",
    "2026-07-18T00:10:00.000Z",
  ));
  assert.equal(await repository.completeRun("run-signer-second", "9003", {
    status: "success",
    started_at: "2026-07-18T00:00:04.000Z",
    finished_at: "2026-07-18T00:00:05.000Z",
    duration_ms: 1_000,
    attempts: 1,
    error_code: null,
    error_message: null,
    result_json: "{}",
    updated_at: "2026-07-18T00:00:05.000Z",
  }), true);
  assert.equal(await repository.getSecret(oldSecret.id), null);
});

test("late session-validation completion cannot reconnect an account after cancellation", async () => {
  const { db, repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";
  await seedSessionValidationExecution(repository, {
    accountId: "account-validation",
    flowId: "flow-validation",
    githubRunId: "9003",
    timestamp,
    expiresAt: "2026-07-18T00:15:00.000Z",
  });

  db.beforeBatch = async () => {
    db.beforeBatch = null;
    const cancelled = await repository.deleteProvisionalLoginFlow(
      "flow-validation",
      ["starting"],
      "2026-07-18T00:00:02.000Z",
    );
    assert.equal(cancelled.status, "cancelled");
  };

  assert.equal(await repository.completeLoginFlow("flow-validation", "9003", {
    status: "connected",
    error: null,
    sessionSecret: null,
    updated_at: "2026-07-18T00:00:03.000Z",
  }), null);
  assert.equal((await repository.getLoginFlow("flow-validation")).status, "cancelled");
  assert.equal((await repository.getAccount("account-validation")).status, "disconnected");
});

test("late session-validation completion cannot overwrite an expired flow", async () => {
  const { db, repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";
  await seedSessionValidationExecution(repository, {
    accountId: "account-expired",
    flowId: "flow-expired",
    githubRunId: "9005",
    timestamp,
    expiresAt: "2026-07-18T00:01:00.000Z",
  });

  db.beforeBatch = async () => {
    db.beforeBatch = null;
    const expired = await repository.expireLoginFlow(
      "flow-expired",
      "2026-07-18T00:02:00.000Z",
    );
    assert.equal(expired.status, "expired");
  };

  assert.equal(await repository.completeLoginFlow("flow-expired", "9005", {
    status: "connected",
    error: null,
    sessionSecret: null,
    updated_at: "2026-07-18T00:02:01.000Z",
  }), null);
  assert.equal((await repository.getLoginFlow("flow-expired")).status, "expired");
  assert.equal((await repository.getAccount("account-expired")).status, "error");
});

test("late interactive-login completion cannot retain a session secret after cancellation", async () => {
  const { db, repository } = repositoryHarness();
  const timestamp = "2026-07-18T00:00:00.000Z";
  const provisionalSecrets = [
    ["secret-phone-new", "phone"],
    ["secret-api-id-new", "api_id"],
    ["secret-api-hash-new", "api_hash"],
  ].map(([id, purpose]) => testSecret(id, "account-new", purpose, timestamp));
  await repository.createLoginFlow({
    account: {
      id: "account-new",
      name: "New account",
      phone_masked: "+86*******0004",
      created_at: timestamp,
      updated_at: timestamp,
    },
    secrets: provisionalSecrets,
    flow: {
      id: "flow-new",
      expires_at: "2026-07-18T00:15:00.000Z",
      created_at: timestamp,
      updated_at: timestamp,
    },
  });
  assert.ok(await repository.claimLoginFlow("flow-new", "9004", "2026-07-18T00:00:01.000Z"));
  const completedSession = testSecret(
    "secret-session-new", "account-new", "telegram_session", "2026-07-18T00:00:03.000Z",
  );

  db.beforeBatch = async () => {
    db.beforeBatch = null;
    const cancelled = await repository.deleteProvisionalLoginFlow(
      "flow-new",
      ["starting"],
      "2026-07-18T00:00:02.000Z",
    );
    assert.equal(cancelled.deleted, true);
  };

  assert.equal(await repository.completeLoginFlow("flow-new", "9004", {
    status: "connected",
    error: null,
    sessionSecret: completedSession,
    updated_at: "2026-07-18T00:00:03.000Z",
  }), null);
  assert.equal(await repository.getAccount("account-new"), null);
  assert.equal(await repository.getSecret(completedSession.id), null);
});
