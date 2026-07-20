import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { decryptSecret } from "../src/crypto.js";
import { makeRun } from "../src/scheduler.js";
import { createTestRepository } from "./d1-helper.js";

const ROOT_KEY = Buffer.alloc(32, 12).toString("base64");

function request(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "cf-ray": "test-request",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function harness({ dispatchStatus = 204, identity = { user_id: "legacy-admin", role: "admin", email: "admin@example.com" }, telegramUpdates = [] } = {}) {
  const { sqlite, db, repository } = createTestRepository();
  const dispatches = [];
  const telegramMessages = [];
  let githubRunId = "9001";
  let current = new Date("2026-07-18T00:01:00.000Z");
  let sequence = 0;
  const worker = createWorker({
    repositoryFactory: () => repository,
    verifyAdmin: async () => identity,
    verifyRunner: async () => ({ run_id: githubRunId, repository: "owner/repo" }),
    uuid: () => `id-${++sequence}`,
    now: () => current,
    fetch: async (url, init) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        if (String(url).endsWith("/getUpdates")) {
          return Response.json({ ok: true, result: telegramUpdates });
        }
        telegramMessages.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response(null, { status: 200 });
      }
      const inputs = JSON.parse(init.body).inputs;
      if (inputs.run_id) dispatches.push(inputs);
      return new Response(null, { status: dispatchStatus });
    },
  });
  const env = {
    DB: db,
    SECRET_ROOT_KEY: ROOT_KEY,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
    TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
  };
  return {
    sqlite,
    repository,
    dispatches,
    telegramMessages,
    worker,
    env,
    setGithubRunId: (value) => { githubRunId = value; },
    setNow: (value) => { current = new Date(value); },
  };
}

test("retired legacy migration writes are not exposed to task runners", async () => {
  const { worker, env } = harness();
  const response = await worker.fetch(request("/api/runner/migrations/legacy", {
    method: "POST",
    body: { schema_version: 1, dry_run: false },
  }), env);
  assert.equal(response.status, 404);
});

test("platform administrators can inspect users and disable access without exposing credentials", async () => {
  const { worker, env, repository, sqlite } = harness();
  const timestamp = "2026-07-18T00:00:00.000Z";
  sqlite.prepare(`INSERT INTO users
    (id, role, status, display_name, email, email_normalized, password_algorithm,
     password_hash, password_salt, password_iterations, created_at, updated_at)
    VALUES (?, 'user', 'active', ?, ?, ?, 'PBKDF2-SHA256', ?, ?, 210000, ?, ?)`)
    .run("user-1", "普通用户", "member@example.com", "member@example.com", "secret-password-hash", "secret-salt", timestamp, timestamp);
  sqlite.prepare(`INSERT INTO user_sessions
    (id, token_hash, user_id, provider, created_at, last_seen_at, expires_at, user_agent_label)
    VALUES (?, ?, ?, 'email', ?, ?, ?, ?)`)
    .run("session-1", "secret-session-token-hash", "user-1", timestamp, timestamp, "2026-08-18T00:00:00.000Z", "Chrome");
  await repository.forUser({ user_id: "user-1", role: "user" }).createAccount({
    account: {
      id: "member-account",
      name: "成员账号",
      phone_masked: "+86*******5678",
      status: "connected",
      enabled: 1,
      last_connected_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    },
    secrets: [],
  });

  let response = await worker.fetch(request("/api/v1/admin/users"), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const users = (await response.json()).data;
  const member = users.find((user) => user.id === "user-1");
  assert.deepEqual({
    status: member.status,
    accounts_count: member.accounts_count,
    active_sessions_count: member.active_sessions_count,
  }, { status: "active", accounts_count: 1, active_sessions_count: 1 });
  assert.equal(JSON.stringify(users).includes("secret-password-hash"), false);
  assert.equal(JSON.stringify(users).includes("secret-session-token-hash"), false);

  response = await worker.fetch(request("/api/v1/admin/users/user-1", {
    method: "PATCH",
    body: { status: "disabled" },
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal((await response.json()).data.status, "disabled");
  assert.ok(sqlite.prepare("SELECT revoked_at FROM user_sessions WHERE id = 'session-1'").get().revoked_at);

  response = await worker.fetch(request("/api/v1/admin/users/legacy-admin", {
    method: "PATCH",
    body: { status: "disabled" },
  }), env);
  assert.equal(response.status, 409);

  const userWorker = createWorker({
    repositoryFactory: () => repository,
    verifyAdmin: async () => ({ user_id: "user-1", role: "user", email: "member@example.com" }),
    uuid: () => "request-id",
    now: () => new Date("2026-07-18T00:05:00.000Z"),
  });
  response = await userWorker.fetch(request("/api/v1/admin/users"), env);
  assert.equal(response.status, 403);
});

async function createConnectedAccount(worker, env) {
  let response = await worker.fetch(request("/api/v1/accounts", {
    method: "POST",
    body: {
      name: "Primary",
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
      session: "session-value-that-is-long-enough-and-secret",
    },
  }), env);
  assert.equal(response.status, 201);
  const account = (await response.json()).data;
  assert.equal(account.status, "disconnected");
  response = await worker.fetch(request(`/api/v1/accounts/${account.id}/validate`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 202);
  const flow = (await response.json()).data;
  assert.equal(flow.mode, "session_validation");
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 200);
  const claim = await response.json();
  assert.equal(claim.flow.mode, "session_validation");
  assert.equal(claim.account.session_string, "session-value-that-is-long-enough-and-secret");
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
    method: "POST", body: { status: "connected" },
  }), env);
  assert.equal(response.status, 200);
  return (await worker.fetch(request(`/api/v1/accounts/${account.id}`), env).then((item) => item.json())).data;
}

async function createTask(worker, env, accountId, overrides = {}) {
  const response = await worker.fetch(request("/api/v1/tasks", {
    method: "POST",
    body: {
      name: "Daily check-in",
      account_id: accountId,
      skill_key: "send_text",
      bot: "@example_bot",
      command: "/checkin",
      cron: "0 * * * *",
      timezone: "UTC",
      retry: 1,
      timeout_seconds: 120,
      ...overrides,
    },
  }), env);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).data;
}

test("account owners can validate every enabled Session account across batches", async () => {
  const { worker, env } = harness();
  const createAccount = async (name, phone) => {
    const response = await worker.fetch(request("/api/v1/accounts", {
      method: "POST",
      body: {
        name,
        phone,
        api_id: "123456",
        api_hash: "0123456789abcdef0123456789abcdef",
        session: `session-value-${name}-that-is-long-enough`,
      },
    }), env);
    assert.equal(response.status, 201);
    return (await response.json()).data;
  };

  const enabled = [];
  for (let index = 0; index < 21; index += 1) {
    enabled.push(await createAccount(`Enabled ${index + 1}`, `+86${13800000000 + index}`));
  }
  const disabled = await createAccount("Disabled", "+8613912345678");
  let response = await worker.fetch(request(`/api/v1/accounts/${disabled.id}`, {
    method: "PATCH",
    body: { enabled: false },
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request("/api/v1/accounts/validate-all", {
    method: "POST",
    body: { cursor: 0 },
  }), env);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const firstBatch = (await response.json()).data;
  assert.equal(firstBatch.requested, 20);
  assert.equal(firstBatch.started, 20);
  assert.equal(firstBatch.next_cursor, 20);
  assert.deepEqual(firstBatch.failures, []);

  response = await worker.fetch(request("/api/v1/accounts/validate-all", {
    method: "POST",
    body: { cursor: firstBatch.next_cursor },
  }), env);
  const secondBatch = (await response.json()).data;
  assert.equal(secondBatch.requested, 1);
  assert.equal(secondBatch.started, 1);
  assert.equal(secondBatch.next_cursor, null);
  assert.deepEqual(new Set([...firstBatch.flows, ...secondBatch.flows].map((flow) => flow.account_id)), new Set(enabled.map((account) => account.id)));
  assert.equal(JSON.stringify([firstBatch, secondBatch]).includes("session-value"), false);
});

test("bulk account validation reports dispatch failures without stopping the batch", async () => {
  const { worker, env } = harness({ dispatchStatus: 500 });
  for (const [index, phone] of ["+8613812345678", "+8613912345678"].entries()) {
    const created = await worker.fetch(request("/api/v1/accounts", {
      method: "POST",
      body: {
        name: `Failure ${index + 1}`,
        phone,
        session: `session-value-${index}-that-is-long-enough`,
      },
    }), env);
    assert.equal(created.status, 201);
  }

  const response = await worker.fetch(request("/api/v1/accounts/validate-all", {
    method: "POST",
    body: { cursor: 0 },
  }), env);
  assert.equal(response.status, 202);
  const batch = (await response.json()).data;
  assert.equal(batch.requested, 2);
  assert.equal(batch.started, 0);
  assert.equal(batch.failures.length, 2);
  assert.deepEqual(new Set(batch.failures.map((failure) => failure.code)), new Set(["validation_dispatch_failed"]));
  assert.equal(JSON.stringify(batch).includes("session-value"), false);
});

test("Session validation synchronizes the Telegram identity and health timestamp", async () => {
  const { worker, env } = harness();
  let response = await worker.fetch(request("/api/v1/accounts", {
    method: "POST",
    body: {
      name: "Primary",
      phone: "+8613812345678",
      session: "session-value-that-is-long-enough-and-secret",
    },
  }), env);
  const account = (await response.json()).data;
  response = await worker.fetch(request(`/api/v1/accounts/${account.id}/validate`, {
    method: "POST", body: {},
  }), env);
  const flow = (await response.json()).data;
  await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST", body: {},
  }), env);
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
    method: "POST",
    body: {
      status: "connected",
      identity: {
        id: 424242,
        username: "alice",
        first_name: "Alice",
        last_name: "Example",
      },
    },
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));

  response = await worker.fetch(request(`/api/v1/accounts/${account.id}`), env);
  const connected = (await response.json()).data;
  assert.equal(connected.telegram_user_id, "424242");
  assert.equal(connected.telegram_username, "alice");
  assert.equal(connected.telegram_display_name, "Alice Example");
  assert.equal(connected.last_checked_at, "2026-07-18T00:01:00.000Z");
  assert.equal(connected.last_connected_at, connected.last_checked_at);
});

async function createLoginWaitingWithCode(worker, env, name = "Temporary login") {
  let response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: {
      name,
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
    },
  }), env);
  assert.equal(response.status, 202);
  const flow = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST", body: { state: "code_required" },
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/resend`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 202);
  const resendPath = `/api/runner/login-flows/${flow.id}/input/claim`;
  const resend = await (await worker.fetch(request(resendPath, {
    method: "POST", body: { expected: "resend" },
  }), env)).json();
  assert.deepEqual(resend, { kind: "resend", value: "requested" });
  const noRepeatedResend = await (await worker.fetch(request(resendPath, {
    method: "POST", body: { expected: "resend" },
  }), env)).json();
  assert.deepEqual(noRepeatedResend, { status: "waiting" });
  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/code`, {
    method: "POST", body: { code: "58321" },
  }), env);
  assert.equal(response.status, 200);
  return flow;
}

function assertLoginTemporarySecretsPurged(sqlite, flow, expectedAccountPurposes) {
  const row = sqlite.prepare(`SELECT code_secret_id, password_secret_id
    FROM login_flows WHERE id = ?`).get(flow.id);
  assert.equal(row.code_secret_id, null);
  assert.equal(row.password_secret_id, null);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'login_flow' AND owner_id = ?`).get(flow.id).count, 0);
  assert.deepEqual(sqlite.prepare(`SELECT purpose FROM secret_values
    WHERE owner_type = 'account' AND owner_id = ? ORDER BY purpose`).all(flow.account_id).map((item) => item.purpose), expectedAccountPurposes);
}

test("login runner can report a transient starting error and continue the same flow", async () => {
  const { worker, env } = harness();
  let response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: {
      name: "Transient login",
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
    },
  }), env);
  assert.equal(response.status, 202);
  const flow = (await response.json()).data;

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST",
    body: {
      state: "starting",
      error: {
        code: "telegram_transport",
        message: "Telegram is temporarily unavailable; retrying.",
      },
    },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: "starting" });

  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}`), env);
  const waiting = (await response.json()).data;
  assert.equal(waiting.status, "starting");
  assert.equal(waiting.last_error, "Telegram is temporarily unavailable; retrying.");

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST", body: { state: "code_required" },
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "code_required");
  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}`), env);
  assert.equal((await response.json()).data.last_error, null);
});

test("tg_signer import is encrypted per task, never echoed, and only decrypted into a runner claim", async () => {
  const { sqlite, worker, env } = harness();
  const account = await createConnectedAccount(worker, env);
  const importBlob = '{"task":{"bot":"@private_bot","command":"/sign"}}';
  let task = await createTask(worker, env, account.id, {
    skill_key: "tg_signer",
    bot: "tg_signer",
    command: "private_daily_sign",
    tg_signer_import: importBlob,
  });
  assert.equal(task.has_tg_signer_import, true);
  assert.equal(JSON.stringify(task).includes(importBlob), false);

  const stored = sqlite.prepare(`SELECT owner_type, owner_id, purpose, ciphertext
    FROM secret_values WHERE owner_type = 'task'`).get();
  assert.deepEqual({ owner_type: stored.owner_type, owner_id: stored.owner_id, purpose: stored.purpose }, {
    owner_type: "task",
    owner_id: task.id,
    purpose: "tg_signer_import",
  });
  assert.equal(stored.ciphertext.includes("private_bot"), false);

  let response = await worker.fetch(request(`/api/v1/tasks/${task.id}`, {
    method: "PATCH",
    body: { name: "Renamed" },
  }), env);
  task = (await response.json()).data;
  assert.equal(task.has_tg_signer_import, true);

  response = await worker.fetch(request(`/api/v1/tasks/${task.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "signer-run-0001" },
  }), env);
  const run = (await response.json()).data;
  assert.equal(run.dispatch_status, "dispatched");

  response = await worker.fetch(request(`/api/runner/runs/${run.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  const claim = await response.json();
  assert.equal(claim.task.params.task_name, "private_daily_sign");
  assert.equal(claim.task.params.import_blob, importBlob);
  assert.equal(claim.task.params.import_encoding, "auto");

  response = await worker.fetch(request(`/api/v1/tasks/${task.id}`, {
    method: "PATCH",
    body: { tg_signer_import: null },
  }), env);
  task = (await response.json()).data;
  assert.equal(task.has_tg_signer_import, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM secret_values WHERE owner_type = 'task'").get().count, 1);

  response = await worker.fetch(request(`/api/runner/runs/${run.id}/complete`, {
    method: "POST",
    body: {
      run_id: run.id,
      status: "success",
      duration_ms: 50,
      attempts: 1,
      result: { ok: true },
      logs: [],
    },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM secret_values WHERE owner_type = 'task'").get().count, 0);
});

test("terminal callback wakes the next run for the account and retrying completion does not duplicate logs", async () => {
  const { sqlite, worker, env, dispatches } = harness();
  const account = await createConnectedAccount(worker, env);
  const firstTask = await createTask(worker, env, account.id, { name: "First" });
  const secondTask = await createTask(worker, env, account.id, { name: "Second" });

  let response = await worker.fetch(request(`/api/v1/tasks/${firstTask.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "first-run-0001" },
  }), env);
  const firstRun = (await response.json()).data;
  response = await worker.fetch(request(`/api/v1/tasks/${secondTask.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "second-run-0001" },
  }), env);
  const secondRun = (await response.json()).data;
  assert.equal(dispatches.length, 1);
  assert.equal(secondRun.dispatch_status, "pending");

  response = await worker.fetch(request(`/api/runner/runs/${firstRun.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  const completion = {
    run_id: firstRun.id,
    status: "success",
    duration_ms: 50,
    attempts: 1,
    result: { ok: true },
    logs: [{ level: "info", message: "session_string=must-not-survive" }],
  };
  response = await worker.fetch(request(`/api/runner/runs/${firstRun.id}/complete`, { method: "POST", body: completion }), env);
  assert.equal(response.status, 200);
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[1].run_id, secondRun.id);

  response = await worker.fetch(request(`/api/runner/runs/${firstRun.id}/complete`, { method: "POST", body: completion }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).idempotent, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_logs WHERE task_run_id = ?").get(firstRun.id).count, 1);
  const message = sqlite.prepare("SELECT message FROM task_logs WHERE task_run_id = ?").get(firstRun.id).message;
  assert.equal(message.includes("must-not-survive"), false);
});

test("manual run requires a bounded Idempotency-Key and repeated requests reuse one run", async () => {
  const { sqlite, worker, env, dispatches } = harness();
  const account = await createConnectedAccount(worker, env);
  const task = await createTask(worker, env, account.id);
  const path = `/api/v1/tasks/${task.id}/runs`;

  let response = await worker.fetch(request(path, { method: "POST", body: {} }), env);
  assert.equal(response.status, 422);
  response = await worker.fetch(request(path, {
    method: "POST", body: {}, headers: { "idempotency-key": "bad key" },
  }), env);
  assert.equal(response.status, 422);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 0);

  const headers = { "idempotency-key": "manual-request-0001" };
  response = await worker.fetch(request(path, { method: "POST", body: {}, headers }), env);
  assert.equal(response.status, 202);
  const first = (await response.json()).data;
  response = await worker.fetch(request(path, { method: "POST", body: {}, headers }), env);
  assert.equal(response.status, 202);
  const repeated = (await response.json()).data;
  assert.equal(repeated.id, first.id);
  assert.equal(dispatches.length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 1);
  assert.equal(sqlite.prepare("SELECT dedupe_key FROM task_runs WHERE id = ?").get(first.id).dedupe_key,
    `manual:${task.id}:manual-request-0001`);
});

test("task deletion cancels queued runs but refuses to orphan an active runner", async () => {
  const { sqlite, worker, env } = harness();
  const account = await createConnectedAccount(worker, env);
  const task = await createTask(worker, env, account.id);

  let response = await worker.fetch(request(`/api/v1/tasks/${task.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "delete-active-run-01" },
  }), env);
  const run = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/runs/${run.id}/claim`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request(`/api/v1/tasks/${task.id}`, { method: "DELETE" }), env);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "task_running");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id = ?").get(task.id).count, 1);

  response = await worker.fetch(request(`/api/runner/runs/${run.id}/complete`, {
    method: "POST",
    body: { status: "success", duration_ms: 10, attempts: 1, result: {}, logs: [] },
  }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/v1/tasks/${task.id}`, { method: "DELETE" }), env);
  assert.equal(response.status, 204);
  assert.equal((await worker.fetch(request(`/api/v1/task-runs/${run.id}`), env).then((item) => item.json())).data.task_name, task.name);
});

test("enqueue and claim reject an account disabled or disconnected after task lookup", async () => {
  const { sqlite, worker, env, dispatches } = harness();
  const account = await createConnectedAccount(worker, env);
  const task = await createTask(worker, env, account.id);
  const path = `/api/v1/tasks/${task.id}/runs`;

  let response = await worker.fetch(request(`/api/v1/accounts/${account.id}`, {
    method: "PATCH", body: { enabled: false },
  }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(path, {
    method: "POST", body: {}, headers: { "idempotency-key": "disabled-account-01" },
  }), env);
  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM task_runs").get().count, 0);
  assert.equal(dispatches.length, 0);

  await worker.fetch(request(`/api/v1/accounts/${account.id}`, {
    method: "PATCH", body: { enabled: true },
  }), env);
  response = await worker.fetch(request(path, {
    method: "POST", body: {}, headers: { "idempotency-key": "claim-race-account-01" },
  }), env);
  const run = (await response.json()).data;
  assert.equal(dispatches.length, 1);
  await worker.fetch(request(`/api/v1/accounts/${account.id}`, {
    method: "PATCH", body: { enabled: false },
  }), env);
  response = await worker.fetch(request(`/api/runner/runs/${run.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 409);
  assert.equal((await worker.fetch(request(`/api/v1/task-runs/${run.id}`), env).then((item) => item.json())).data.status, "cancelled");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM account_leases").get().count, 0);

  await worker.fetch(request(`/api/v1/accounts/${account.id}`, {
    method: "PATCH", body: { enabled: true, session: null },
  }), env);
  response = await worker.fetch(request(path, {
    method: "POST", body: {}, headers: { "idempotency-key": "disconnected-account-01" },
  }), env);
  assert.equal(response.status, 409);
});

test("reserve refuses a queued run after its account is disabled and reconciliation terminates it", async () => {
  const { repository, worker, env } = harness();
  const account = await createConnectedAccount(worker, env);
  const task = await createTask(worker, env, account.id);
  const now = new Date("2026-07-18T00:01:00.000Z");
  const run = makeRun(task, {
    id: "reserve-race-run",
    triggerType: "manual",
    scheduledFor: now.toISOString(),
    now,
    dedupeKey: `manual:${task.id}:reserve-race-0001`,
  });
  assert.equal(await repository.enqueueRun({ run, nextRunAt: undefined }), true);
  await worker.fetch(request(`/api/v1/accounts/${account.id}`, {
    method: "PATCH", body: { enabled: false },
  }), env);
  assert.equal(await repository.reserveNextDispatch(account.id, now.toISOString()), null);
  await repository.reconcileRuns(now.toISOString(), "2026-07-17T23:51:00.000Z");
  assert.equal((await repository.getRun(run.id)).status, "cancelled");
});

test("login code and password claims are retry-safe only for the authenticated workflow run", async () => {
  const { sqlite, worker, env } = harness();
  let response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: {
      name: "Web login",
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
    },
  }), env);
  assert.equal(response.status, 202);
  const flow = (await response.json()).data;

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST", body: { state: "code_required" },
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/code`, {
    method: "POST", body: { code: "58321" },
  }), env);
  assert.equal(response.status, 200);
  const codePath = `/api/runner/login-flows/${flow.id}/input/claim`;
  const firstCode = await (await worker.fetch(request(codePath, { method: "POST", body: { expected: "code" } }), env)).json();
  const retriedCode = await (await worker.fetch(request(codePath, { method: "POST", body: { expected: "code" } }), env)).json();
  assert.deepEqual(firstCode, { kind: "code", value: "58321" });
  assert.deepEqual(retriedCode, firstCode);

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST",
    body: { state: "code_required", error: { code: "code_invalid", message: "Telegram rejected the verification code." } },
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "code_required");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'login_flow' AND owner_id = ?`).get(flow.id).count, 0);
  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/code`, {
    method: "POST", body: { code: "77442" },
  }), env);
  assert.equal(response.status, 200);
  const replacementCode = await (await worker.fetch(request(codePath, {
    method: "POST", body: { expected: "code" },
  }), env)).json();
  assert.deepEqual(replacementCode, { kind: "code", value: "77442" });

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/events`, {
    method: "POST", body: { state: "password_required" },
  }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/password`, {
    method: "POST", body: { password: "private-2fa" },
  }), env);
  assert.equal(response.status, 200);
  const passwordPath = `/api/runner/login-flows/${flow.id}/input/claim`;
  const firstPassword = await (await worker.fetch(request(passwordPath, { method: "POST", body: { expected: "password" } }), env)).json();
  const retriedPassword = await (await worker.fetch(request(passwordPath, { method: "POST", body: { expected: "password" } }), env)).json();
  assert.deepEqual(firstPassword, { kind: "password", value: "private-2fa" });
  assert.deepEqual(retriedPassword, firstPassword);

  const delivered = sqlite.prepare(`SELECT purpose, consumed_at, delivered_to_run_id, ciphertext
    FROM secret_values WHERE owner_type = 'login_flow' ORDER BY purpose`).all();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].purpose, "two_factor_password");
  assert.equal(delivered.every((item) => item.consumed_at && item.delivered_to_run_id === "9001"), true);
  assert.equal(JSON.stringify(delivered).includes("private-2fa"), false);
  assert.equal(JSON.stringify(delivered).includes("58321"), false);

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
    method: "POST",
    body: { status: "connected", session_string: "new-connected-session-value-that-is-secret" },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes("new-connected-session"), false);

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
    method: "POST",
    body: { status: "connected", session_string: "new-connected-session-value-that-is-secret" },
  }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).idempotent, true);
  const terminalFlow = sqlite.prepare(`SELECT code_secret_id, password_secret_id
    FROM login_flows WHERE id = ?`).get(flow.id);
  assert.equal(terminalFlow.code_secret_id, null);
  assert.equal(terminalFlow.password_secret_id, null);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'login_flow' AND owner_id = ?`).get(flow.id).count, 0);
  assert.deepEqual(sqlite.prepare(`SELECT purpose FROM secret_values
    WHERE owner_type = 'account' AND owner_id = ? ORDER BY purpose`).all(flow.account_id).map((row) => row.purpose), [
    "api_hash",
    "api_id",
    "phone",
    "telegram_session",
  ]);
});

test("failed, cancelled, and expired login terminals purge temporary secrets without deleting account API secrets", async (t) => {
  await t.test("failed completion", async () => {
    const { sqlite, worker, env } = harness();
    const flow = await createLoginWaitingWithCode(worker, env, "Failed login");
    const response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
      method: "POST",
      body: { status: "failed", error: { code: "bad_code", message: "Telegram rejected the code." } },
    }), env);
    assert.equal(response.status, 200);
    assertLoginTemporarySecretsPurged(sqlite, flow, ["api_hash", "api_id", "phone"]);
  });

  await t.test("administrator cancellation", async () => {
    const { sqlite, worker, env } = harness();
    const flow = await createLoginWaitingWithCode(worker, env, "Cancelled login");
    const response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}/cancel`, {
      method: "POST",
      body: {},
    }), env);
    assert.equal(response.status, 200);
    const tombstone = (await response.json()).data;
    assert.equal(tombstone.status, "cancelled");
    assert.equal(tombstone.deleted, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM login_flows WHERE id = ?").get(flow.id).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = ?").get(flow.account_id).count, 0);
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
      WHERE (owner_type = 'login_flow' AND owner_id = ?) OR (owner_type = 'account' AND owner_id = ?)`)
      .get(flow.id, flow.account_id).count, 0);
  });

  await t.test("expiry reconciliation", async () => {
    const { sqlite, worker, env, setNow } = harness();
    const flow = await createLoginWaitingWithCode(worker, env, "Expired login");
    setNow("2026-07-18T00:17:00.000Z");
    const response = await worker.fetch(request(`/api/v1/login-flows/${flow.id}`), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.status, "expired");
    assertLoginTemporarySecretsPurged(sqlite, flow, ["api_hash", "api_id", "phone"]);
  });
});

test("first login workflow dispatch failure atomically removes the provisional account and secrets", async () => {
  const { sqlite, worker, env } = harness({ dispatchStatus: 503 });
  const response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: {
      name: "Dispatch failure",
      phone: "+8613812345678",
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
    },
  }), env);
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error.code, "login_dispatch_failed");
  assert.equal(JSON.stringify(payload).includes("0123456789abcdef"), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM login_flows").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM secret_values").get().count, 0);
});

test("deleting an account purges temporary secrets before login-flow cascade deletion", async () => {
  const { sqlite, worker, env } = harness();
  const flow = await createLoginWaitingWithCode(worker, env, "Deleted account login");
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'login_flow' AND owner_id = ?`).get(flow.id).count, 1);

  const response = await worker.fetch(request(`/api/v1/accounts/${flow.account_id}`, { method: "DELETE" }), env);
  assert.equal(response.status, 204);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM login_flows WHERE id = ?").get(flow.id).count, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'login_flow' AND owner_id = ?`).get(flow.id).count, 0);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'account' AND owner_id = ?`).get(flow.account_id).count, 0);
});

test("admin can import and validate an existing Session without API credentials", async () => {
  const { worker, env } = harness();
  const session = "manually-imported-session-that-must-stay-secret";
  let response = await worker.fetch(request("/api/v1/accounts", {
    method: "POST",
    body: {
      name: "Imported account",
      phone: "+8613812345678",
      session,
      enabled: true,
    },
  }), env);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const account = (await response.json()).data;

  response = await worker.fetch(request(`/api/v1/accounts/${account.id}/validate`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 202);
  const flow = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const claim = await response.json();
  assert.equal(claim.account.session_string, session);
  assert.equal("api_id" in claim.account, false);
  assert.equal("api_hash" in claim.account, false);
});

test("admin notification settings replace, retain, and clear encrypted secrets without echoing them", async () => {
  const { sqlite, repository, worker, env } = harness();
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
  const replacement = "987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_dcba";
  const chatId = "-1001234567890";

  let response = await worker.fetch(request("/api/v1/settings"), env);
  assert.equal(response.status, 200);
  let data = (await response.json()).data;
  assert.equal(data.notification_bot_token_configured, false);
  assert.equal(data.notification_chat_id_configured, false);

  response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH",
    body: { bot_token: token, chat_id: chatId },
  }), env);
  assert.equal(response.status, 200);
  const firstBody = await response.json();
  assert.deepEqual(firstBody.data, {
    notification_bot_token_configured: true,
    notification_chat_id_configured: true,
  });
  assert.equal(JSON.stringify(firstBody).includes(token), false);
  assert.equal(JSON.stringify(firstBody).includes(chatId), false);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'setting' AND owner_id = 'telegram_notification'`).get().count, 2);

  response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH",
    body: { bot_token: replacement },
  }), env);
  assert.equal(response.status, 200);
  const storedToken = await repository.getSecretByOwnerPurpose("setting", "telegram_notification", "bot_token");
  const storedChat = await repository.getSecretByOwnerPurpose("setting", "telegram_notification", "chat_id");
  assert.equal(await decryptSecret(ROOT_KEY, storedToken, { purpose: "bot_token", ownerId: "telegram_notification" }), replacement);
  assert.equal(await decryptSecret(ROOT_KEY, storedChat, { purpose: "chat_id", ownerId: "telegram_notification" }), chatId);
  assert.equal(sqlite.prepare(`SELECT COUNT(*) AS count FROM secret_values
    WHERE owner_type = 'setting' AND owner_id = 'telegram_notification'`).get().count, 2);

  response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH",
    body: { chat_id: null },
  }), env);
  assert.equal(response.status, 200);
  data = (await response.json()).data;
  assert.equal(data.notification_bot_token_configured, true);
  assert.equal(data.notification_chat_id_configured, false);
  assert.equal(await repository.getSecretByOwnerPurpose("setting", "telegram_notification", "chat_id"), null);

  response = await worker.fetch(request("/api/v1/settings/notifications", { method: "PATCH", body: {} }), env);
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).error.details.fields, ["body"]);

  const invalidSecret = "invalid-notification-token";
  response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH", body: { bot_token: invalidSecret },
  }), env);
  assert.equal(response.status, 422);
  assert.equal(JSON.stringify(await response.json()).includes(invalidSecret), false);
});

test("admin can discover a notification destination and send a test message", async () => {
  const { worker, env, telegramMessages } = harness({ telegramUpdates: [
    { update_id: 1, message: { chat: { id: 12345, type: "private", first_name: "GrandpaNiu" } } },
  ] });
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
  let response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH", body: { bot_token: token, chat_id: "12345" },
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request("/api/v1/settings/notifications/chats"), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual((await response.json()).data, [{ id: "12345", label: "GrandpaNiu", type: "private" }]);

  response = await worker.fetch(request("/api/v1/settings/notifications/test", {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual((await response.json()).data, { sent: true });
  assert.equal(telegramMessages.length, 1);
  assert.match(telegramMessages[0].body.text, /通知配置成功/);
  assert.match(telegramMessages[0].body.text, /所有用户的任务结果/);
  assert.equal(telegramMessages[0].body.parse_mode, "HTML");
  assert.equal(JSON.stringify(await worker.fetch(request("/api/v1/settings"), env).then((item) => item.json())).includes(token), false);
});

test("admin can configure one encrypted Telegram application without exposing its credentials", async () => {
  const { repository, worker, env } = harness();
  const apiId = "123456";
  const apiHash = "0123456789abcdef0123456789abcdef";

  let response = await worker.fetch(request("/api/v1/settings"), env);
  assert.equal(response.status, 200);
  let data = (await response.json()).data;
  assert.equal(data.telegram_application_configured, false);

  response = await worker.fetch(request("/api/v1/settings/telegram", {
    method: "PATCH",
    body: { api_id: apiId, api_hash: apiHash },
  }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, {
    telegram_api_id_configured: true,
    telegram_api_hash_configured: true,
    telegram_application_configured: true,
  });
  assert.equal(JSON.stringify(body).includes(apiId), false);
  assert.equal(JSON.stringify(body).includes(apiHash), false);

  const storedId = await repository.getSecretByOwnerPurpose("setting", "telegram_application", "api_id");
  const storedHash = await repository.getSecretByOwnerPurpose("setting", "telegram_application", "api_hash");
  assert.equal(await decryptSecret(ROOT_KEY, storedId, { purpose: "api_id", ownerId: "telegram_application" }), apiId);
  assert.equal(await decryptSecret(ROOT_KEY, storedHash, { purpose: "api_hash", ownerId: "telegram_application" }), apiHash);

  response = await worker.fetch(request("/api/v1/settings"), env);
  data = (await response.json()).data;
  assert.equal(data.telegram_application_configured, true);
});

test("phone login without platform credentials returns an actionable setup response without residue", async () => {
  const { sqlite, worker, env } = harness();
  const response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: { phone: "+8613812345678" },
  }), env);
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.deepEqual(payload.error, {
    code: "telegram_application_not_configured",
    message: "请先完成 Telegram 应用初始化，再添加账号。",
    details: {
      action: "configure_telegram_application",
      settings_path: "#/settings",
      documentation_url: "https://my.telegram.org/apps",
    },
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM login_flows").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM secret_values").get().count, 0);
});

test("phone-only login uses the global Telegram application credentials", async () => {
  const { sqlite, worker, env } = harness();
  const apiId = "123456";
  const apiHash = "0123456789abcdef0123456789abcdef";
  let response = await worker.fetch(request("/api/v1/settings/telegram", {
    method: "PATCH",
    body: { api_id: apiId, api_hash: apiHash },
  }), env);
  assert.equal(response.status, 200);

  response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: { phone: "+8613812345678" },
  }), env);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const flow = (await response.json()).data;
  const account = sqlite.prepare(`SELECT name, api_id_secret_id, api_hash_secret_id
    FROM accounts WHERE id = ?`).get(flow.account_id);
  assert.equal(account.name, "Telegram ••••5678");
  assert.equal(account.api_id_secret_id, null);
  assert.equal(account.api_hash_secret_id, null);

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST",
    body: {},
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const claim = await response.json();
  assert.equal(claim.account.phone, "+8613812345678");
  assert.equal(claim.account.api_id, Number(apiId));
  assert.equal(claim.account.api_hash, apiHash);
});

test("tasks created for a phone-only account reuse the global Telegram application", async () => {
  const { worker, env } = harness();
  const apiId = "123456";
  const apiHash = "0123456789abcdef0123456789abcdef";
  let response = await worker.fetch(request("/api/v1/settings/telegram", {
    method: "PATCH",
    body: { api_id: apiId, api_hash: apiHash },
  }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: { phone: "+8613812345678" },
  }), env);
  const flow = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/complete`, {
    method: "POST",
    body: { status: "connected", session_string: "phone-only-account-session-value-is-secret" },
  }), env);
  assert.equal(response.status, 200);

  const task = await createTask(worker, env, flow.account_id);
  response = await worker.fetch(request(`/api/v1/tasks/${task.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "phone-only-run-0001" },
  }), env);
  assert.equal(response.status, 202);
  const run = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/runs/${run.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const claim = await response.json();
  assert.equal(claim.account.secrets.api_id, Number(apiId));
  assert.equal(claim.account.secrets.api_hash, apiHash);
});

test("phone-only login automatically reuses one legacy account credential pair", async () => {
  const { worker, env } = harness();
  const apiId = "654321";
  const apiHash = "fedcba9876543210fedcba9876543210";
  let response = await worker.fetch(request("/api/v1/accounts", {
    method: "POST",
    body: {
      name: "Existing account",
      phone: "+8613900001111",
      api_id: apiId,
      api_hash: apiHash,
      session: "existing-session-value-that-is-long-enough",
    },
  }), env);
  assert.equal(response.status, 201);

  response = await worker.fetch(request("/api/v1/login-flows", {
    method: "POST",
    body: { phone: "+8613812345678" },
  }), env);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const flow = (await response.json()).data;

  response = await worker.fetch(request(`/api/runner/login-flows/${flow.id}/claim`, {
    method: "POST",
    body: {},
  }), env);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const claim = await response.json();
  assert.equal(claim.account.api_id, Number(apiId));
  assert.equal(claim.account.api_hash, apiHash);

  response = await worker.fetch(request("/api/v1/settings"), env);
  const settings = (await response.json()).data;
  assert.equal(settings.telegram_application_configured, true);
  assert.equal(settings.telegram_application_source, "legacy_account");
});

test("configured notification secrets are decrypted only to send a completed run summary", async () => {
  const { sqlite, worker, env, telegramMessages } = harness();
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
  const chatId = "-1001234567890";
  let response = await worker.fetch(request("/api/v1/settings/notifications", {
    method: "PATCH",
    body: { bot_token: token, chat_id: chatId },
  }), env);
  assert.equal(response.status, 200);
  const account = await createConnectedAccount(worker, env);
  sqlite.prepare("UPDATE accounts SET status = 'connected' WHERE id = ?").run(account.id);
  const task = await createTask(worker, env, account.id);
  response = await worker.fetch(request(`/api/v1/tasks/${task.id}/runs`, {
    method: "POST", body: {}, headers: { "idempotency-key": "notification-run-0001" },
  }), env);
  assert.equal(response.status, 202, JSON.stringify(await response.clone().json()));
  const run = (await response.json()).data;
  response = await worker.fetch(request(`/api/runner/runs/${run.id}/claim`, { method: "POST", body: {} }), env);
  assert.equal(response.status, 200);
  response = await worker.fetch(request(`/api/runner/runs/${run.id}/complete`, {
    method: "POST",
    body: {
      run_id: run.id,
      status: "success",
      duration_ms: 55,
      attempts: 1,
      logs: [{ level: "info", message: "API_HASH=must-not-leak" }, { level: "info", message: "check-in done" }],
    },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(telegramMessages.length, 1);
  assert.equal(telegramMessages[0].body.chat_id, chatId);
  assert.match(telegramMessages[0].body.text, /任务执行成功/);
  assert.match(telegramMessages[0].body.text, /任务：<\/b>/);
  assert.match(telegramMessages[0].body.text, /用户：<\/b>GrandpaNiuu/);
  assert.match(telegramMessages[0].body.text, /耗时：<\/b>/);
  assert.doesNotMatch(telegramMessages[0].body.text, /账号：|方式：|GitHub Actions|check-in done|查看执行详情/);
  assert.deepEqual(telegramMessages[0].body.reply_markup, {
    inline_keyboard: [[{
      text: "查看执行详情",
      url: "https://github.com/owner/repo/actions/runs/9001",
    }]],
  });
  assert.equal(telegramMessages[0].body.text.includes("must-not-leak"), false);
  assert.equal(telegramMessages[0].body.text.includes(token), false);
});
