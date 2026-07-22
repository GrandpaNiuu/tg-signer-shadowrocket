import assert from "node:assert/strict";
import test from "node:test";

import { __test, withRealtimeMaintenance } from "../src/realtime-repository.js";

test("realtime retention uses the documented seven and thirty day cutoffs", () => {
  assert.equal(__test.cutoff("2026-07-21T00:00:00.000Z", 7), "2026-07-14T00:00:00.000Z");
  assert.equal(__test.cutoff("2026-07-21T00:00:00.000Z", 30), "2026-06-21T00:00:00.000Z");
  assert.throws(() => __test.cutoff("invalid", 7), /Invalid realtime cleanup timestamp/);
});

test("scheduler cleanup runs only at the top of an hour", async () => {
  const statements = [];
  const repository = {
    db: {
      prepare(sql) {
        const statement = {
          sql,
          values: [],
          bind(...values) { this.values = values; return this; },
        };
        statements.push(statement);
        return statement;
      },
      async batch(values) {
        assert.equal(values.length, 4);
        return values;
      },
    },
    async reconcileRuns() { return { expired_runs: 0 }; },
  };
  const wrapped = withRealtimeMaintenance(repository);

  await wrapped.reconcileRuns("2026-07-21T00:15:00.000Z", "2026-07-20T23:00:00.000Z");
  assert.equal(statements.length, 0);

  await wrapped.reconcileRuns("2026-07-21T01:00:00.000Z", "2026-07-21T00:00:00.000Z");
  assert.equal(statements.length, 4);
  assert.match(statements[0].sql, /DELETE FROM listener_events/);
  assert.equal(statements[0].values[0], "2026-06-21T01:00:00.000Z");
  assert.match(statements[1].sql, /DELETE FROM bot_inspections/);
  assert.equal(statements[1].values[0], "2026-07-14T01:00:00.000Z");
  assert.match(statements[2].sql, /DELETE FROM listener_instances/);
  assert.match(statements[3].sql, /DELETE FROM realtime_task_handoffs/);
  assert.equal(statements[3].values[0], "2026-07-21T01:00:00.000Z");
});

test("scheduler maintenance preserves repository method binding", async () => {
  const repository = {
    marker: "bound",
    db: { prepare() { throw new Error("must not run outside top of hour"); } },
    async reconcileRuns() { return this.marker; },
  };
  const wrapped = withRealtimeMaintenance(repository);
  assert.equal(await wrapped.reconcileRuns("2026-07-21T01:01:00.000Z", "unused"), "bound");
});
