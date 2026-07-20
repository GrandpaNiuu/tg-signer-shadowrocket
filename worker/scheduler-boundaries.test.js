import assert from "node:assert/strict";
import test from "node:test";

import { createD1Repository } from "./src/repository.js";
import { enqueueAndDispatch, makeRun } from "./src/scheduler.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function task() {
  return {
    id: "task-1",
    account_id: "account-1",
    retry: 0,
  };
}

function statementDatabase() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        bindings: [],
        bind(...bindings) {
          this.bindings = bindings;
          return this;
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
      statements.push(statement);
      return statement;
    },
    async batch(items) {
      return items.map(() => ({ meta: { changes: 0 }, results: [] }));
    },
  };
}

test("scheduled runs use a stable dedupe key for the same task occurrence", () => {
  const first = makeRun(task(), {
    id: "run-1",
    triggerType: "schedule",
    scheduledFor: NOW.toISOString(),
    now: NOW,
  });
  const second = makeRun(task(), {
    id: "run-2",
    triggerType: "schedule",
    scheduledFor: NOW.toISOString(),
    now: NOW,
  });

  assert.equal(first.dedupe_key, `schedule:task-1:${NOW.toISOString()}`);
  assert.equal(second.dedupe_key, first.dedupe_key);
});

test("a duplicate enqueue returns the existing run without dispatching again", async () => {
  const existing = {
    id: "existing-run",
    dedupe_key: "manual:task-1:request-key",
    status: "queued",
  };
  let dispatchReservations = 0;
  const repository = {
    async enqueueRun() {
      return false;
    },
    async getRunByDedupeKey() {
      return existing;
    },
    async reserveNextDispatch() {
      dispatchReservations += 1;
      return null;
    },
  };

  const result = await enqueueAndDispatch(task(), {}, {
    repository,
    uuid: () => "new-run",
    now: () => NOW,
    fetch: async () => new Response(null, { status: 204 }),
  }, {
    triggerType: "manual",
    scheduledFor: NOW.toISOString(),
    nextRunAt: undefined,
    dedupeKey: existing.dedupe_key,
  });

  assert.equal(result.created, false);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, "duplicate");
  assert.equal(result.run, existing);
  assert.equal(dispatchReservations, 0);
});

test("reconciliation only resets queued dispatches and preserves ambiguous runs", async () => {
  const db = statementDatabase();
  const repository = createD1Repository(db);

  await repository.reconcileRuns(
    NOW.toISOString(),
    new Date(NOW.getTime() - 10 * 60_000).toISOString(),
  );

  const sql = db.statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /status = 'queued' AND dispatch_status = 'dispatching'/);
  assert.match(sql, /status = 'queued' AND dispatch_status = 'dispatched'/);
  assert.match(sql, /SET status = 'ambiguous'[\s\S]*status IN \('claimed', 'running'\)/);
  assert.doesNotMatch(sql, /WHERE status = 'ambiguous'/);
});

test("dispatchable account selection cannot select an ambiguous run", async () => {
  const db = statementDatabase();
  const repository = createD1Repository(db);

  assert.deepEqual(await repository.listDispatchableAccountIds(NOW.toISOString(), 20), []);

  const sql = db.statements[0].sql;
  assert.match(sql, /r\.status = 'queued' AND r\.dispatch_status = 'pending'/);
  assert.doesNotMatch(sql, /r\.status = 'ambiguous'/);
});
