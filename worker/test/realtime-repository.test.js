import assert from "node:assert/strict";
import test from "node:test";

import { withInspectionDispatchGuard, withRealtimeTaskGuard } from "../src/realtime-repository.js";

function repositoryWithGuards({ inspection = false, realtime = false } = {}) {
  const calls = { reserve: 0, list: 0 };
  const repository = {
    db: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (String(sql).includes("bot_inspections")) return inspection ? { active: 1 } : null;
                if (String(sql).includes("realtime_rules")) return realtime ? { active: 1 } : null;
                return null;
              },
            };
          },
        };
      },
    },
    async reserveNextDispatch(accountId) {
      calls.reserve += 1;
      return { id: `run-${accountId}` };
    },
    async listDispatchableAccountIds() {
      calls.list += 1;
      return ["account-1", "account-2"];
    },
  };
  return { repository, calls };
}

function repositoryForTaskCompatibility() {
  const calls = { create: 0, update: 0 };
  const repository = {
    db: {
      prepare() {
        return {
          bind() {
            return { async first() { return { total: 9 }; } };
          },
        };
      },
    },
    async createTask(task) {
      calls.create += 1;
      return task;
    },
    async updateTask(id, values) {
      calls.update += 1;
      return { id, ...values };
    },
  };
  return { repository, calls };
}

test("active inspection blocks reservation for the same Telegram account", async () => {
  const { repository, calls } = repositoryWithGuards({ inspection: true });
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), []);
  assert.equal(calls.list, 1);
});

test("realtime accounts stay queued for the Listener instead of GitHub Actions", async () => {
  const { repository, calls } = repositoryWithGuards({ realtime: true });
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), []);
  assert.equal(calls.list, 1);
});

test("normal task dispatch continues when no inspection or realtime rule is active", async () => {
  const { repository, calls } = repositoryWithGuards();
  const guarded = withInspectionDispatchGuard(repository);
  assert.deepEqual(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), { id: "run-account-1" });
  assert.equal(calls.reserve, 1);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), ["account-1", "account-2"]);
});

test("realtime accounts may create and enable ordinary scheduled tasks", async () => {
  const { repository, calls } = repositoryForTaskCompatibility();
  const compatible = withRealtimeTaskGuard(repository);

  await compatible.createTask({ id: "task-1", account_id: "realtime-account", enabled: 1 });
  await compatible.updateTask("task-1", { enabled: 1 });
  const dedicatedCheck = await compatible.db.prepare(
    "SELECT COUNT(*) AS total FROM tasks WHERE account_id = ? AND enabled = 1",
  ).bind("realtime-account").first();

  assert.equal(calls.create, 1);
  assert.equal(calls.update, 1);
  assert.equal(dedicatedCheck.total, 0);
});
