import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../migrations/0106_realtime_task_handoff.sql", import.meta.url);
const repositoryUrl = new URL("../src/realtime-repository.js", import.meta.url);
const facadeUrl = new URL("../src/repository-facade.js", import.meta.url);
const listenerTaskUrl = new URL("../src/listener-task-api.js", import.meta.url);

test("migration stores handoffs and restores the exact realtime rules that were active", async () => {
  const source = await readFile(migrationUrl, "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS realtime_task_handoffs/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS realtime_task_handoff_rules/);
  assert.match(source, /restore_realtime_rules_before_handoff_delete/);
  assert.match(source, /SET enabled = 1/);
  assert.match(source, /DELETE FROM realtime_task_handoff_rules/);
  assert.match(source, /cleanup_realtime_handoff_after_terminal_run/);
  assert.match(source, /cleanup_realtime_handoff_after_dispatch_reset/);
});

test("dispatch guard snapshots and pauses realtime rules before fallback dispatch", async () => {
  const source = await readFile(repositoryUrl, "utf8");
  assert.match(source, /REALTIME_HANDOFF_DELAY_SECONDS = 45/);
  assert.match(source, /clearStaleRealtimeHandoff/);
  assert.match(source, /INSERT OR IGNORE INTO realtime_task_handoff_rules/);
  assert.match(source, /UPDATE realtime_rules SET enabled = 0/);
  assert.match(source, /prepareRealtimeTaskHandoff/);
  assert.match(source, /handoff\.realtime && !handoff\.ready/);
});

test("Listener may claim the staged task while the realtime rules are paused", async () => {
  const source = await readFile(listenerTaskUrl, "utf8");
  assert.match(source, /OR EXISTS \([\s\S]*FROM realtime_task_handoffs handoff/);
  assert.match(source, /handoff\.task_run_id = r\.id/);
  assert.match(source, /handoff\.expires_at > \?/);
  assert.match(source, /nextListenerRunId/);
});

test("runner completion cannot bypass the realtime handoff guard for the next queued task", async () => {
  const source = await readFile(facadeUrl, "utf8");
  assert.match(source, /runnerRepository[\s\S]*withInspectionDispatchGuard\(withDispatchErrorCodes/);
});
