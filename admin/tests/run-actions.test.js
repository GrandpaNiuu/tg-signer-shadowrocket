import test from "node:test";
import assert from "node:assert/strict";

import { rerunnableTaskId } from "../src/run-actions.js";

test("only completed runs with an existing task can be rerun", () => {
  for (const status of ["success", "failed", "ambiguous", "cancelled"]) {
    assert.equal(rerunnableTaskId({ status, task_id: "historical-task-1", current_task_id: "task-1" }), "task-1");
  }
  for (const status of ["queued", "claimed", "running"]) {
    assert.equal(rerunnableTaskId({ status, task_id: "task-1", current_task_id: "task-1" }), null);
  }
  assert.equal(rerunnableTaskId({ status: "failed", task_id: null }), null);
  assert.equal(rerunnableTaskId({ status: "failed", task_id: "deleted-task", current_task_id: null }), null);
});
