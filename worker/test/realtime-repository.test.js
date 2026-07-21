import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRealtimeTransitionAllowed,
  findRealtimeTransitionBlockingRun,
  withInspectionDispatchGuard,
} from "../src/realtime-repository.js";

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

function repositoryForRealtimeTransition(activeRun = null) {
  const calls = [];
  return {
    userId: "admin-1",
    calls,
    db: {
      prepare(sql) {
        calls.push(String(sql));
        return {
          bind(...bindings) {
            assert.deepEqual(bindings, ["account-1", "admin-1"]);
            return { async first() { return activeRun; } };
          },
        };
      },
    },
  };
}

test("active inspection blocks ordinary account task reservation", async () => {
  const { repository, calls } = repositoryWithGuards({ inspection: true });
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", new Date().toISOString()), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(new Date().toISOString(), 20), []);
  assert.equal(calls.list, 1);
});

test("realtime account tasks stay queued for the Listener instead of GitHub Actions", async () => {
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

test("ordinary scheduled tasks and queued pending Listener tasks do not block realtime transitions", async () => {
  const repository = repositoryForRealtimeTransition(null);
  assert.equal(await findRealtimeTransitionBlockingRun(repository, "account-1"), null);
  await assert.doesNotReject(() => assertRealtimeTransitionAllowed(repository, "account-1"));
  assert.equal(repository.calls.length, 2);
  assert.match(repository.calls[0], /dispatch_status IN \('dispatching', 'dispatched'\)/);
  assert.doesNotMatch(repository.calls[0], /COUNT\(\*\).*FROM tasks/i);
});

test("dispatching, dispatched, claimed, and running task runs block realtime transitions", async () => {
  const activeRuns = [
    { id: "run-dispatching", status: "queued", dispatch_status: "dispatching" },
    { id: "run-dispatched", status: "queued", dispatch_status: "dispatched" },
    { id: "run-claimed", status: "claimed", dispatch_status: "dispatched" },
    { id: "run-running", status: "running", dispatch_status: "dispatched" },
  ];
  for (const run of activeRuns) {
    const repository = repositoryForRealtimeTransition(run);
    await assert.rejects(
      () => assertRealtimeTransitionAllowed(repository, "account-1"),
      (error) => error?.status === 409 && error?.code === "listener_account_task_active",
      `${run.status}/${run.dispatch_status} should block the realtime transition`,
    );
  }
});

test("completed task runs allow realtime rules to be created, enabled, or modified", async () => {
  const repository = repositoryForRealtimeTransition(null);
  await assert.doesNotReject(() => assertRealtimeTransitionAllowed(repository, "account-1"));
});
