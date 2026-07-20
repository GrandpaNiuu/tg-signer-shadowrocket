import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_RUN_STATUSES,
  ACCOUNT_STATUSES,
  DISPATCH_STATUSES,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  isAccountStatus,
  isDispatchStatus,
  isRunStatus,
  isTerminalRunStatus,
} from "./src/states.js";

test("run state groups are complete and disjoint", () => {
  const all = Object.values(RUN_STATUSES);
  assert.deepEqual(new Set([...ACTIVE_RUN_STATUSES, ...TERMINAL_RUN_STATUSES]), new Set(all));
  assert.equal(ACTIVE_RUN_STATUSES.some((status) => TERMINAL_RUN_STATUSES.includes(status)), false);
});

test("state validators reject unknown values", () => {
  assert.equal(isAccountStatus(ACCOUNT_STATUSES.LOGIN_PENDING), true);
  assert.equal(isAccountStatus(ACCOUNT_STATUSES.RECONNECT_REQUIRED), true);
  assert.equal(isAccountStatus("needs_reauth"), false);
  assert.equal(isRunStatus(RUN_STATUSES.QUEUED), true);
  assert.equal(isTerminalRunStatus(RUN_STATUSES.AMBIGUOUS), true);
  assert.equal(isRunStatus("unknown"), false);
  assert.equal(isTerminalRunStatus(RUN_STATUSES.RUNNING), false);
  assert.equal(isDispatchStatus(DISPATCH_STATUSES.DISPATCHING), true);
  assert.equal(isDispatchStatus("unknown"), false);
});

test("account and dispatch values match persisted database strings", () => {
  assert.deepEqual(Object.values(ACCOUNT_STATUSES), [
    "disconnected",
    "login_pending",
    "connected",
    "reconnect_required",
    "error",
  ]);
  assert.deepEqual(Object.values(DISPATCH_STATUSES), [
    "pending",
    "dispatching",
    "dispatched",
  ]);
});
