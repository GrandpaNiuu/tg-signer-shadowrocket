import assert from "node:assert/strict";
import test from "node:test";

import { encryptSecret } from "../src/crypto.js";
import { createWorker } from "../src/app.js";
import { executionLeaseSeconds } from "../src/runner-api.js";

test("scheduled task leases include the exact-second Runner wait", () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  assert.equal(executionLeaseSeconds({
    trigger_type: "schedule",
    scheduled_for: "2026-07-18T00:02:00.000Z",
    retry: 0,
    timeout_seconds: 120,
  }, now), 120 + 120 + 300);
  assert.equal(executionLeaseSeconds({
    trigger_type: "manual",
    scheduled_for: "2026-07-18T00:02:00.000Z",
    retry: 0,
    timeout_seconds: 120,
  }, now), 120 + 300);
});

test("OIDC-authenticated runner claims a one-time decrypted TaskSpec", async () => {
  const rootKey = Buffer.alloc(32, 4).toString("base64");
  const ownerId = "account-1";
  async function secret(id, purpose, value) {
    return { id, owner_id: ownerId, purpose, ...await encryptSecret(rootKey, value, { purpose, ownerId }) };
  }
  const secrets = new Map([
    ["session", await secret("session", "telegram_session", "session-value-that-is-long-enough")],
    ["api-id", await secret("api-id", "api_id", "123456")],
    ["api-hash", await secret("api-hash", "api_hash", "0123456789abcdef0123456789abcdef")],
  ]);
  let claims = 0;
  const execution = {
    id: "run-1", task_id: "task-1", task_name: "Morning check-in", trigger_type: "manual", scheduled_for: "2026-07-18T00:00:00.000Z",
    account_id: ownerId, account_name: "Primary", account_enabled: 1, account_status: "connected", task_enabled: 1, skill_enabled: 1,
    session_secret_id: "session", api_id_secret_id: "api-id", api_hash_secret_id: "api-hash",
    proxy_secret_id: null, tg_signer_import_secret_id: null, skill_key: "send_text", bot: "@example_bot",
    command: "/checkin", retry: 1, timeout_seconds: 120, thread_id: null, delete_after_seconds: 5,
  };
  const repository = {
    async getExecution() { return execution; },
    async claimRun(runId, githubRunId, timestamp, leaseUntil) {
      claims += 1;
      assert.equal(runId, "run-1");
      assert.equal(githubRunId, "9001");
      assert.equal(Date.parse(leaseUntil) - Date.parse(timestamp), (120 * 2 + 2 + 300) * 1_000);
      return execution;
    },
    getSecret: async (id) => secrets.get(id),
    getSecretByOwnerPurpose: async () => null,
  };
  const worker = createWorker({
    repositoryFactory: () => repository,
    verifyRunner: async () => ({ run_id: "9001" }),
    now: () => new Date("2026-07-18T00:00:00.000Z"),
    uuid: () => "request-id",
  });

  const response = await worker.fetch(new Request("https://worker.example/api/runner/runs/run-1/claim", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), { DB: {}, SECRET_ROOT_KEY: rootKey });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.run.id, "run-1");
  assert.equal(body.task.name, "Morning check-in");
  assert.equal(body.task.skill, "send_text");
  assert.deepEqual(body.task.params, { target: "@example_bot", text: "/checkin", message_thread_id: null, delete_after: 5 });
  assert.equal(body.account.secrets.session_string, "session-value-that-is-long-enough");
  assert.equal(body.account.secrets.api_id, 123456);
  assert.equal(body.account.name, "Primary");
  assert.equal(claims, 1);
});
