import assert from "node:assert/strict";
import test from "node:test";

import { runScheduler } from "./src/scheduler.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");

function repository(overrides = {}) {
  return {
    async reconcileRuns() {
      return {
        cancelled_unavailable: 2,
        reset_dispatches: 3,
        expired_runs: 1,
        expired_queued: 4,
      };
    },
    async getDueTasks() {
      return [];
    },
    async listDispatchableAccountIds() {
      return [];
    },
    ...overrides,
  };
}

test("scheduler returns structured reconciliation counters", async () => {
  const summary = await runScheduler({}, {
    repository: repository(),
    now: () => NOW,
    uuid: () => "unused",
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.deepEqual(summary.reconciliation, {
    cancelled_unavailable: 2,
    reset_dispatches: 3,
    expired_runs: 1,
    expired_queued: 4,
  });
  assert.equal(summary.due, 0);
  assert.equal(summary.dispatched, 0);
});

test("scheduler supplies zero counters when reconciliation is unavailable", async () => {
  const repo = repository();
  delete repo.reconcileRuns;

  const summary = await runScheduler({}, {
    repository: repo,
    now: () => NOW,
    uuid: () => "unused",
    fetch: async () => new Response(null, { status: 204 }),
  });

  assert.deepEqual(summary.reconciliation, {
    cancelled_unavailable: 0,
    reset_dispatches: 0,
    expired_runs: 0,
    expired_queued: 0,
  });
});
