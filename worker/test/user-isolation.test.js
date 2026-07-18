import assert from "node:assert/strict";
import test from "node:test";

import { createWorker } from "../src/app.js";
import { createTestRepository } from "./d1-helper.js";

const ROOT_KEY = Buffer.alloc(32, 19).toString("base64");

function request(path, userId, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
      "cf-ray": `request-${userId}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function harness() {
  const { sqlite, db, repository } = createTestRepository();
  const timestamp = "2026-07-18T00:00:00.000Z";
  for (const user of [
    { id: "user-a", display_name: "User A" },
    { id: "user-b", display_name: "User B" },
  ]) sqlite.prepare(`INSERT INTO users
    (id, role, status, display_name, created_at, updated_at)
    VALUES (?, 'user', 'active', ?, ?, ?)`).run(user.id, user.display_name, timestamp, timestamp);

  let sequence = 0;
  const worker = createWorker({
    repositoryFactory: () => repository,
    verifyAdmin: async (incoming) => ({
      authenticated: true,
      user_id: incoming.headers.get("x-test-user"),
      role: incoming.headers.get("x-test-user") === "legacy-admin" ? "admin" : "user",
      provider: "github",
    }),
    uuid: () => `id-${++sequence}`,
    now: () => new Date(timestamp),
    fetch: async () => new Response(null, { status: 204 }),
  });
  const env = {
    DB: db,
    SECRET_ROOT_KEY: ROOT_KEY,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_TOKEN: "token",
    RUNNER_OIDC_AUDIENCE: "https://worker.example/api/runner",
    TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
  };
  return { sqlite, worker, env };
}

async function createAccount(worker, env, userId, suffix) {
  const response = await worker.fetch(request("/api/v1/accounts", userId, {
    method: "POST",
    body: {
      name: `Account ${suffix}`,
      phone: `+86138123456${suffix}`,
      api_id: "123456",
      api_hash: "0123456789abcdef0123456789abcdef",
      session: `session-${suffix}-value-that-is-long-enough`,
    },
  }), env);
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  return (await response.json()).data;
}

test("authenticated users can only read and mutate their own Telegram workspace", async () => {
  const { sqlite, worker, env } = harness();
  const accountA = await createAccount(worker, env, "user-a", "1");
  const accountB = await createAccount(worker, env, "user-b", "2");

  assert.equal(sqlite.prepare("SELECT user_id FROM accounts WHERE id = ?").get(accountA.id).user_id, "user-a");
  assert.equal(sqlite.prepare("SELECT user_id FROM accounts WHERE id = ?").get(accountB.id).user_id, "user-b");

  const listA = await worker.fetch(request("/api/v1/accounts", "user-a"), env).then((response) => response.json());
  assert.deepEqual(listA.data.map((account) => account.id), [accountA.id]);

  const crossRead = await worker.fetch(request(`/api/v1/accounts/${accountB.id}`, "user-a"), env);
  assert.equal(crossRead.status, 404);
  const crossDelete = await worker.fetch(request(`/api/v1/accounts/${accountB.id}`, "user-a", { method: "DELETE" }), env);
  assert.equal(crossDelete.status, 404);
  assert.ok(sqlite.prepare("SELECT id FROM accounts WHERE id = ?").get(accountB.id));

  const crossTask = await worker.fetch(request("/api/v1/tasks", "user-a", {
    method: "POST",
    body: {
      name: "Cross-user task",
      account_id: accountB.id,
      skill_key: "send_text",
      bot: "@example_bot",
      command: "/checkin",
      cron: "0 * * * *",
      timezone: "UTC",
      retry: 0,
      timeout_seconds: 120,
    },
  }), env);
  assert.equal(crossTask.status, 422);

  const ownTaskResponse = await worker.fetch(request("/api/v1/tasks", "user-a", {
    method: "POST",
    body: {
      name: "User A daily task",
      account_id: accountA.id,
      skill_key: "send_text",
      bot: "@example_bot",
      command: "/checkin",
      cron: "0 * * * *",
      timezone: "UTC",
      retry: 0,
      timeout_seconds: 120,
    },
  }), env);
  assert.equal(ownTaskResponse.status, 201);
  const ownTask = (await ownTaskResponse.json()).data;
  const tasksB = await worker.fetch(request("/api/v1/tasks", "user-b"), env).then((response) => response.json());
  assert.equal(tasksB.data.some((task) => task.id === ownTask.id), false);

  const dashboardA = await worker.fetch(request("/api/v1/dashboard?date=2026-07-18", "user-a"), env)
    .then((response) => response.json());
  assert.deepEqual(dashboardA.data.workspace, {
    accounts: 1,
    tasks: 1,
    all_runs: 0,
    failed_runs: 0,
  });
  assert.deepEqual(dashboardA.data.upcoming_tasks.map((task) => task.id), [ownTask.id]);
  assert.deepEqual(dashboardA.data.account_health.map((account) => account.id), [accountA.id]);
  assert.deepEqual(dashboardA.data.health, {
    database: "ok",
    github: "ok",
    scheduler: "legacy",
  });

  const dashboardB = await worker.fetch(request("/api/v1/dashboard?date=2026-07-18", "user-b"), env)
    .then((response) => response.json());
  assert.deepEqual(dashboardB.data.workspace, {
    accounts: 1,
    tasks: 0,
    all_runs: 0,
    failed_runs: 0,
  });
  assert.deepEqual(dashboardB.data.upcoming_tasks, []);
  assert.deepEqual(dashboardB.data.account_health.map((account) => account.id), [accountB.id]);

  sqlite.prepare("UPDATE accounts SET status = 'connected' WHERE id = ?").run(accountA.id);
  const runResponse = await worker.fetch(request(`/api/v1/tasks/${ownTask.id}/runs`, "user-a", {
    method: "POST",
    body: {},
    headers: { "idempotency-key": "user-a-manual-run" },
  }), env);
  assert.equal(runResponse.status, 202, JSON.stringify(await runResponse.clone().json()));
  const run = (await runResponse.json()).data;
  assert.equal(sqlite.prepare("SELECT user_id FROM task_runs WHERE id = ?").get(run.id).user_id, "user-a");
  const crossRun = await worker.fetch(request(`/api/v1/task-runs/${run.id}`, "user-b"), env);
  assert.equal(crossRun.status, 404);
  const runsB = await worker.fetch(request("/api/v1/task-runs", "user-b"), env).then((response) => response.json());
  assert.equal(runsB.data.some((item) => item.id === run.id), false);
});

test("only the preserved administrator can replace platform Telegram credentials", async () => {
  const { worker, env } = harness();
  const credentials = {
    api_id: "123456",
    api_hash: "0123456789abcdef0123456789abcdef",
  };
  const denied = await worker.fetch(request("/api/v1/settings/telegram", "user-a", {
    method: "PATCH",
    body: credentials,
  }), env);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "administrator_required");

  const allowed = await worker.fetch(request("/api/v1/settings/telegram", "legacy-admin", {
    method: "PATCH",
    body: credentials,
  }), env);
  assert.equal(allowed.status, 200);
});

test("a public user's application credentials never become the platform fallback", async () => {
  const { worker, env } = harness();
  await createAccount(worker, env, "user-a", "3");

  const settingsResponse = await worker.fetch(request("/api/v1/settings", "legacy-admin"), env);
  assert.equal(settingsResponse.status, 200);
  const settings = (await settingsResponse.json()).data;
  assert.equal(settings.telegram_application_configured, false);
  assert.equal(settings.telegram_application_source, "missing");

  const loginResponse = await worker.fetch(request("/api/v1/login-flows", "user-b", {
    method: "POST",
    body: { phone: "+8613812345699" },
  }), env);
  assert.equal(loginResponse.status, 409);
  assert.equal((await loginResponse.json()).error.code, "telegram_application_not_configured");
});
