import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0102_allow_realtime_scheduled_tasks.sql", import.meta.url);

test("D1 removes obsolete dedicated-account triggers for Listener-managed tasks", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const name of [
    "prevent_realtime_rule_for_task_account_insert",
    "prevent_realtime_rule_for_task_account_update",
    "prevent_task_for_realtime_account_insert",
    "prevent_task_for_realtime_account_update",
  ]) {
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${name}`));
  }
});
