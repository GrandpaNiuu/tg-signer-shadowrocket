import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("legacy retirement is gated by a read-only D1 inventory and successful canary", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  const audit = workflow.indexOf("Verify D1 takeover before retiring legacy configuration");
  const migrations = workflow.indexOf("Apply D1 migrations");
  assert.ok(audit > -1 && migrations > audit);
  assert.match(workflow, /connected_account_count/);
  assert.match(workflow, /connected_session_account_count/);
  assert.match(workflow, /EXISTS \(SELECT 1 FROM secret_values/);
  assert.match(workflow, /successful_run_count/);
  assert.match(workflow, /D1 retirement blocked/);
});
