import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("legacy takeover remains gated after migrations and before deployment", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");
  const migrations = workflow.indexOf("- name: Apply D1 migrations");
  const audit = workflow.indexOf("- name: Verify legacy D1 takeover evidence");
  const bootstrapDeploy = workflow.indexOf("- name: Deploy Worker bootstrap");
  const configuredDeploy = workflow.indexOf("- name: Deploy Worker with configured secrets");

  assert.ok(migrations > -1);
  assert.ok(audit > migrations);
  assert.ok(bootstrapDeploy > audit);
  assert.ok(configuredDeploy > bootstrapDeploy);
  assert.match(workflow, /if: \$\{\{ env\.DEPLOYMENT_MODE == 'legacy_takeover' \}\}/);
  assert.match(workflow, /connected_account_count/);
  assert.match(workflow, /connected_session_account_count/);
  assert.match(workflow, /EXISTS \(SELECT 1 FROM secret_values/);
  assert.match(workflow, /successful_run_count/);
  assert.match(workflow, /d1-takeover-audit\.mjs/);
});
