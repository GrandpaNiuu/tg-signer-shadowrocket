import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { errorResponse } from "../src/http.js";

const migrationUrl = new URL("../migrations/0101_realtime_account_exclusion.sql", import.meta.url);

test("D1 prevents inspections from racing dispatched or running tasks", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TRIGGER IF NOT EXISTS prevent_bot_inspection_during_active_run/);
  assert.match(sql, /r\.status IN \('claimed', 'running'\)/);
  assert.match(sql, /r\.status = 'queued' AND r\.dispatch_status IN \('dispatching', 'dispatched'\)/);
  assert.match(sql, /RAISE\(ABORT, 'bot_inspection_account_busy'\)/);
});

test("D1 enforces dedicated realtime accounts in both directions", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const name of [
    "prevent_realtime_rule_for_task_account_insert",
    "prevent_realtime_rule_for_task_account_update",
    "prevent_task_for_realtime_account_insert",
    "prevent_task_for_realtime_account_update",
  ]) {
    assert.match(sql, new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}`));
  }
  assert.match(sql, /RAISE\(ABORT, 'realtime_account_has_tasks'\)/);
  assert.match(sql, /RAISE\(ABORT, 'account_reserved_for_realtime_listener'\)/);
});

test("database trigger conflicts return clear 409 responses without SQL details", async () => {
  const cases = [
    ["SQLITE_CONSTRAINT: bot_inspection_account_busy", "account_busy"],
    ["D1_ERROR: realtime_account_has_tasks", "listener_account_has_tasks"],
    ["constraint failed: account_reserved_for_realtime_listener", "account_reserved_for_realtime_listener"],
  ];
  for (const [message, code] of cases) {
    const response = errorResponse(new Error(message), "request-1");
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error.code, code);
    assert.equal(payload.request_id, "request-1");
    assert.equal(JSON.stringify(payload).includes("SQLITE"), false);
    assert.equal(JSON.stringify(payload).includes("D1_ERROR"), false);
  }
});
