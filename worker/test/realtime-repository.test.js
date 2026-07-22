import assert from "node:assert/strict";
import test from "node:test";

import {
  REALTIME_HANDOFF_DELAY_SECONDS,
  assertRealtimeTransitionAllowed,
  findRealtimeTransitionBlockingRun,
  prepareRealtimeTaskHandoff,
  withInspectionDispatchGuard,
} from "../src/realtime-repository.js";

function repositoryWithGuards({ inspection = false, realtime = false, pendingRun = true } = {}) {
  const calls = { reserve: 0, list: 0 };
  const state = {
    handoffs: new Map(),
    pausedAccounts: new Set(),
    snapshottedRuns: new Set(),
  };
  const repository = {
    db: {
      prepare(sqlValue) {
        const sql = String(sqlValue);
        return {
          bind(...bindings) {
            return {
              async first() {
                if (sql.includes("bot_inspections")) return inspection ? { active: 1 } : null;
                if (sql.includes("FROM realtime_task_handoffs h")) {
                  const [accountId, timestamp] = bindings;
                  const handoff = state.handoffs.get(accountId) || null;
                  return handoff && handoff.expires_at > timestamp ? handoff : null;
                }
                if (sql.includes("FROM realtime_rules r")) {
                  const [accountId] = bindings;
                  return realtime && !state.pausedAccounts.has(accountId) ? { active: 1 } : null;
                }
                if (sql.includes("SELECT r.id") && sql.includes("dispatch_status = 'pending'")) {
                  return pendingRun ? { id: `run-${bindings[0]}` } : null;
                }
                return null;
              },
              async run() {
                if (sql.startsWith("DELETE FROM realtime_task_handoffs")) {
                  const [accountId, timestamp] = bindings;
                  const handoff = state.handoffs.get(accountId);
                  if (handoff && handoff.expires_at <= timestamp) {
                    state.handoffs.delete(accountId);
                    state.pausedAccounts.delete(accountId);
                  }
                } else if (sql.includes("INSERT OR IGNORE INTO realtime_task_handoffs")) {
                  if (!state.handoffs.has(bindings[0])) {
                    state.handoffs.set(bindings[0], {
                      account_id: bindings[0],
                      task_run_id: bindings[1],
                      ready_at: bindings[2],
                      expires_at: bindings[3],
                    });
                  }
                } else if (sql.includes("INSERT OR IGNORE INTO realtime_task_handoff_rules")) {
                  state.snapshottedRuns.add(bindings[1]);
                } else if (sql.includes("UPDATE realtime_rules SET enabled = 0")) {
                  const runId = bindings[1];
                  const handoff = [...state.handoffs.values()].find((item) => item.task_run_id === runId);
                  if (handoff) state.pausedAccounts.add(handoff.account_id);
                }
                return { meta: { changes: 1 } };
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
  return { repository, calls, state };
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
            assert.deepEqual(bindings, ["account-1", "admin-1", "account-1"]);
            return { async first() { return activeRun; } };
          },
        };
      },
    },
  };
}

const BASE_TIME = "2026-07-22T16:00:00.000Z";
const READY_TIME = new Date(Date.parse(BASE_TIME) + (REALTIME_HANDOFF_DELAY_SECONDS + 1) * 1_000).toISOString();

function handoffFor(state, accountId = "account-1") {
  return state.handoffs.get(accountId) || null;
}

test("active inspection blocks ordinary account task reservation", async () => {
  const { repository, calls } = repositoryWithGuards({ inspection: true });
  const guarded = withInspectionDispatchGuard(repository);
  assert.equal(await guarded.reserveNextDispatch("account-1", BASE_TIME), null);
  assert.equal(calls.reserve, 0);
  assert.deepEqual(await guarded.listDispatchableAccountIds(BASE_TIME, 20), []);
  assert.equal(calls.list, 1);
});

test("realtime account stages a safe handoff instead of remaining queued forever", async () => {
  const { repository, calls, state } = repositoryWithGuards({ realtime: true });
  const guarded = withInspectionDispatchGuard(repository);

  assert.equal(await guarded.reserveNextDispatch("account-1", BASE_TIME), null);
  assert.equal(calls.reserve, 0);
  assert.equal(handoffFor(state)?.task_run_id, "run-account-1");
  assert.equal(state.snapshottedRuns.has("run-account-1"), true);
  assert.equal(state.pausedAccounts.has("account-1"), true);
  assert.equal(
    handoffFor(state).ready_at,
    new Date(Date.parse(BASE_TIME) + REALTIME_HANDOFF_DELAY_SECONDS * 1_000).toISOString(),
  );
});

test("realtime handoff permits GitHub dispatch after the Listener disconnect window", async () => {
  const { repository, calls } = repositoryWithGuards({ realtime: true });
  const guarded = withInspectionDispatchGuard(repository);

  await guarded.reserveNextDispatch("account-1", BASE_TIME);
  assert.deepEqual(await guarded.reserveNextDispatch("account-1", READY_TIME), { id: "run-account-1" });
  assert.equal(calls.reserve, 1);
});

test("dispatchable account listing hides staged handoffs and releases them when ready", async () => {
  const { repository, calls, state } = repositoryWithGuards({ realtime: true });
  const guarded = withInspectionDispatchGuard(repository);

  assert.deepEqual(await guarded.listDispatchableAccountIds(BASE_TIME, 20), []);
  assert.equal(calls.list, 1);
  assert.equal(state.pausedAccounts.has("account-1"), true);
  assert.equal(state.pausedAccounts.has("account-2"), true);
  assert.deepEqual(await guarded.listDispatchableAccountIds(READY_TIME, 20), ["account-1", "account-2"]);
  assert.equal(calls.list, 2);
});

test("normal task dispatch continues when no inspection or realtime rule is active", async () => {
  const { repository, calls } = repositoryWithGuards();
  const guarded = withInspectionDispatchGuard(repository);
  assert.deepEqual(await guarded.reserveNextDispatch("account-1", BASE_TIME), { id: "run-account-1" });
  assert.equal(calls.reserve, 1);
  assert.deepEqual(await guarded.listDispatchableAccountIds(BASE_TIME, 20), ["account-1", "account-2"]);
});

test("handoff preparation is idempotent while realtime rules are temporarily paused", async () => {
  const { repository, state } = repositoryWithGuards({ realtime: true });
  const first = await prepareRealtimeTaskHandoff(repository, "account-1", BASE_TIME);
  const second = await prepareRealtimeTaskHandoff(repository, "account-1", BASE_TIME);
  assert.equal(first.realtime, true);
  assert.equal(second.realtime, true);
  assert.equal(second.handoff?.task_run_id, first.handoff?.task_run_id);
  assert.equal(state.pausedAccounts.has("account-1"), true);
});

test("expired handoff restores realtime state before creating the next handoff", async () => {
  const { repository, state } = repositoryWithGuards({ realtime: true });
  await prepareRealtimeTaskHandoff(repository, "account-1", BASE_TIME);
  const oldRunId = handoffFor(state).task_run_id;
  handoffFor(state).expires_at = BASE_TIME;

  const next = await prepareRealtimeTaskHandoff(repository, "account-1", READY_TIME);
  assert.equal(next.realtime, true);
  assert.equal(next.handoff?.task_run_id, oldRunId);
  assert.equal(state.pausedAccounts.has("account-1"), true);
});

test("ordinary scheduled tasks without an active handoff do not block realtime transitions", async () => {
  const repository = repositoryForRealtimeTransition(null);
  assert.equal(await findRealtimeTransitionBlockingRun(repository, "account-1"), null);
  await assert.doesNotReject(() => assertRealtimeTransitionAllowed(repository, "account-1"));
  assert.equal(repository.calls.length, 2);
  assert.match(repository.calls[0], /dispatch_status IN \('dispatching', 'dispatched'\)/);
  assert.match(repository.calls[0], /realtime_task_handoffs/);
  assert.doesNotMatch(repository.calls[0], /COUNT\(\*\).*FROM tasks/i);
});

test("handoff, dispatching, dispatched, claimed, and running runs block realtime edits", async () => {
  const activeRuns = [
    { id: "run-handoff", status: "queued", dispatch_status: "pending" },
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
