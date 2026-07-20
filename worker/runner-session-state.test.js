import assert from "node:assert/strict";
import test from "node:test";

import { withRunnerSessionState } from "./src/runner-repository.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function repository(overrides = {}) {
  const updates = [];
  const execution = {
    id: "run-1",
    account_id: "account-1",
    github_run_id: "12345",
    status: "claimed",
    error_code: null,
    error_message: null,
  };
  return {
    updates,
    execution,
    async completeRun(runId, githubRunId, completion) {
      execution.id = runId;
      execution.github_run_id = String(githubRunId);
      execution.status = completion.status;
      execution.error_code = completion.error_code;
      execution.error_message = completion.error_message;
      return true;
    },
    async getExecution() {
      return { ...execution };
    },
    async updateAccount(id, input) {
      updates.push({ id, input });
      return { id, ...input.changes };
    },
    async getSettings() {
      return { notifications_enabled: false };
    },
    ...overrides,
  };
}

function sessionInvalidCompletion(overrides = {}) {
  return {
    status: "failed",
    error_code: "session_invalid",
    error_message: "The authorization key was revoked.",
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

test("session_invalid completion moves the account to reconnect_required", async () => {
  const raw = repository();
  const wrapped = withRunnerSessionState(raw, () => NOW);

  const completed = await wrapped.completeRun("run-1", "12345", sessionInvalidCompletion());

  assert.equal(completed, true);
  assert.deepEqual(raw.updates, [{
    id: "account-1",
    input: {
      changes: {
        status: "reconnect_required",
        last_error: "The authorization key was revoked.",
        last_connected_at: null,
        updated_at: NOW.toISOString(),
      },
      secrets: [],
      clearSecrets: [],
    },
  }]);
});

test("ordinary task failures do not change the account connection state", async () => {
  const raw = repository();
  const wrapped = withRunnerSessionState(raw, () => NOW);

  await wrapped.completeRun("run-1", "12345", sessionInvalidCompletion({
    error_code: "telegram_error",
  }));

  assert.deepEqual(raw.updates, []);
});

test("idempotent finalizer retries still repair a missing reconnect transition", async () => {
  const raw = repository({
    async completeRun() {
      return false;
    },
    async getExecution() {
      return {
        account_id: "account-1",
        github_run_id: "12345",
        status: "failed",
        error_code: "session_invalid",
        error_message: "Session revoked.",
      };
    },
  });
  const wrapped = withRunnerSessionState(raw, () => NOW);

  const completed = await wrapped.completeRun("run-1", "12345", sessionInvalidCompletion({
    error_message: "Session revoked.",
  }));

  assert.equal(completed, false);
  assert.equal(raw.updates.length, 1);
  assert.equal(raw.updates[0].input.changes.status, "reconnect_required");
});

test("a completion from a different GitHub run cannot change account state", async () => {
  const raw = repository({
    async completeRun() {
      return false;
    },
    async getExecution() {
      return {
        account_id: "account-1",
        github_run_id: "different-run",
        status: "failed",
        error_code: "session_invalid",
      };
    },
  });
  const wrapped = withRunnerSessionState(raw, () => NOW);

  await wrapped.completeRun("run-1", "12345", sessionInvalidCompletion());

  assert.deepEqual(raw.updates, []);
});

test("other repository methods retain their original this binding", async () => {
  const raw = repository();
  const wrapped = withRunnerSessionState(raw, () => NOW);

  assert.deepEqual(await wrapped.getSettings(), { notifications_enabled: false });
});
