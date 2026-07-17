import assert from "node:assert/strict";
import test from "node:test";

import { runScheduler } from "../src/scheduler.js";
import { createTestRepository, seedAccount, seedTask } from "./d1-helper.js";

const ENV = {
  GITHUB_OWNER: "owner",
  GITHUB_REPO: "repo",
  GITHUB_TOKEN: "token",
  GITHUB_REF: "main",
  TASK_RUNNER_WORKFLOW_FILE: "task-runner.yml",
};

test("D1 scheduler serializes two due tasks for one account and eventually dispatches both", async () => {
  const { repository } = createTestRepository();
  await seedAccount(repository);
  await seedTask(repository, { id: "task-1" });
  await seedTask(repository, { id: "task-2" });
  await repository.updateSettings({ scheduler_mode: "d1" }, "2026-07-18T00:00:00.000Z");

  const dispatched = [];
  let current = new Date("2026-07-18T00:01:00.000Z");
  let sequence = 0;
  const dependencies = {
    repository,
    fetch: async (_url, init) => {
      dispatched.push(JSON.parse(init.body).inputs.run_id);
      return new Response(null, { status: 204 });
    },
    now: () => current,
    uuid: () => `run-${++sequence}`,
  };

  const firstTick = await runScheduler(ENV, dependencies);
  assert.deepEqual(firstTick, { mode: "d1", due: 2, queued: 2, dispatched: 1, failed: 0 });
  assert.equal(dispatched.length, 1);

  const firstRun = dispatched[0];
  assert.ok(await repository.claimRun(
    firstRun,
    "9001",
    "2026-07-18T00:01:01.000Z",
    "2026-07-18T00:10:00.000Z",
  ));
  assert.equal(await repository.completeRun(firstRun, "9001", {
    status: "success",
    started_at: "2026-07-18T00:01:01.000Z",
    finished_at: "2026-07-18T00:01:02.000Z",
    duration_ms: 1_000,
    attempts: 1,
    error_code: null,
    error_message: null,
    result_json: "{}",
    updated_at: "2026-07-18T00:01:02.000Z",
  }), true);

  current = new Date("2026-07-18T00:02:00.000Z");
  const secondTick = await runScheduler(ENV, dependencies);
  assert.equal(secondTick.due, 0);
  assert.equal(secondTick.dispatched, 1);
  assert.equal(dispatched.length, 2);
  assert.notEqual(dispatched[0], dispatched[1]);
});

test("scheduler reconciliation makes a stale dispatched run claimable again", async () => {
  const { repository } = createTestRepository();
  await seedAccount(repository);
  await seedTask(repository);
  await repository.updateSettings({ scheduler_mode: "d1" }, "2026-07-18T00:00:00.000Z");

  let current = new Date("2026-07-18T00:01:00.000Z");
  let dispatches = 0;
  const dependencies = {
    repository,
    fetch: async () => { dispatches += 1; return new Response(null, { status: 204 }); },
    now: () => current,
    uuid: () => "run-1",
  };
  await runScheduler(ENV, dependencies);
  assert.equal(dispatches, 1);

  current = new Date("2026-07-18T00:12:00.000Z");
  await runScheduler(ENV, dependencies);
  assert.equal(dispatches, 2);
  const run = await repository.getRun("run-1");
  assert.equal(run.dispatch_attempt_count, 2);
  assert.equal(run.status, "queued");
});
