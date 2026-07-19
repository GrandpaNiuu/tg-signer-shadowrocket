import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_RUN_STATUSES,
  ACCOUNT_STATUSES,
  DISPATCH_STATUSES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isRunStatus,
  isTerminalRunStatus,
} from "./src/states.js";

test("run state groups are complete and disjoint", () => {
  const all = Object.values(RUN_STATUSES);
  assert.deepEqual(new Set([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]), new Set(all));
  assert.equal(ACTIVE_RUN_STATUSES.some((status) => TERMINAL_RUN_STATUSES.includes(status)), false);
});

test("state validators reject unknown values", () => {
  assert.equal(isRunStatus(RUN_STATUSES.QUEUED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUSES.AMBIGUOUS), true);
  assert.equal(isRunStatus("unknown"), false);
  assert.equal(isTerminalRunStatus(RUN_STATUSES.RUNNING), false);
});

test("account and dispatch values remain backward compatible", () => {
  assert.equal(ACCOUNT_STATUSES.CONNECTED, "connected");
  assert.equal(ACCOUNT_STATUSES.RECONNECT_REQUIRED, "reconnect_required");
  assert.equal(DISPATCH_STATUSES.PENDING, "pending");
  assert.equal(DISPATCH_STATUSES.DISPATCHING, "dispatching");
  assert.equal(DISPATCH_STATUSES.DISPATCHED, "dispatched");
});
