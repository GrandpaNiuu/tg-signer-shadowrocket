import assert from "node:assert/strict";
import test from "node:test";

import { withInspectionDispatchGuard, withRealtimeTaskGuard } from "../src/realtime-repository.js";

function repositoryWithInspection(active) {
  const calls = { reserve: 0, list: 0 };
  const repository = {
    db: {
      prepare() {
        return {
          bind() {
            return {
              async first() { return active ? { active: 1 } : null; },
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

function repositoryWithRealtimeRule(active) {
  const calls = { create: 0, update: 0 };
  const repository = {
    db: {
      prepare(sql) {
        assert.match(sql, /realtime_rules/);
        return {
          bind(accountId) {
            return {
              async first() { return active && accountId === "realtime-account" ? { active: 1 } : null; },
            };
          },
        };
      },
    },
    async getTask(id) {
      return { id, account_id: "realtime-account", enabled: false };
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
  const { repository, calls } = repositoryWithInspection(true);
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), []);
  assert.equal(calls.list, 1);
});

test("normal task dispatch continues when no inspection is active", async () => {
  const { repository, calls } = repositoryWithInspection(false);
  const guarded = withInspectionDispatchGuard(repository);
  assert.deepEqual(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), { id: "run-account-1" });
  assert.equal(calls.reserve, 1);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), ["account-1", "account-2"]);
});

test("enabled normal tasks cannot use an account reserved by a realtime rule", async () => {
  const { repository, calls } = repositoryWithRealtimeRule(true);
  const guarded = withRealtimeTaskGuard(repository);

  await assert.rejects(
    () => guarded.createTask({ id: "task-1", account_id: "realtime-account", enabled: 1 }),
    (error) => error?.status === 409 && error?.code === "account_reserved_for_realtime_listener",
  );
  await assert.rejects(
    () => guarded.updateTask("task-2", { enabled: 1 }),
    (error) => error?.status === 409 && error?.code === "account_reserved_for_realtime_listener",
  );
  assert.equal(calls.create, 0);
  assert.equal(calls.update, 0);
});

test("disabled tasks and tasks on other accounts remain editable", async () => {
  const { repository, calls } = repositoryWithRealtimeRule(true);
  const guarded = withRealtimeTaskGuard(repository);

  await guarded.createTask({ id: "task-1", account_id: "realtime-account", enabled: 0 });
  await guarded.createTask({ id: "task-2", account_id: "normal-account", enabled: 1 });
  await guarded.updateTask("task-3", { enabled: 0 });
  assert.equal(calls.create, 2);
  assert.equal(calls.update, 1);
});
