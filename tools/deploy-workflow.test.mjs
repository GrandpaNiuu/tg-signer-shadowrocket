import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/deploy-worker.yml", import.meta.url);

async function workflow() {
  return readFile(workflowUrl, "utf8");
}

test("Worker deployment exposes explicit bootstrap, fresh, and legacy modes", async () => {
  const content = await workflow();
  assert.match(content, /options:\s*\n\s*- bootstrap\s*\n\s*- fresh_install\s*\n\s*- legacy_takeover/);
  assert.match(content, /inputs\.deployment_mode \|\| 'fresh_install'/);
  assert.match(content, /bootstrap\|fresh_install\|legacy_takeover/);
});

test("migrations run before optional takeover audit and deployment", async () => {
  const content = await workflow();
  const migration = content.indexOf("- name: Apply D1 migrations");
  const takeover = content.indexOf("- name: Verify legacy D1 takeover evidence");
  const deploy = content.indexOf("- name: Deploy Worker");
  const smoke = content.indexOf("- name: Smoke test deployed Worker");

  assert.ok(migration >= 0);
  assert.ok(takeover > migration);
  assert.ok(deploy > takeover);
  assert.ok(smoke > deploy);
  assert.match(content, /if: \$\{\{ env\.DEPLOYMENT_MODE == 'legacy_takeover' \}\}/);
});

test("bootstrap requires liveness while normal deployments require readiness", async () => {
  const content = await workflow();
  assert.match(content, /check_endpoint health/);
  assert.match(content, /if \[ "\$DEPLOYMENT_MODE" != "bootstrap" \]; then\s*\n\s*check_endpoint ready/);
  assert.match(content, /WORKER_URL: \$\{\{ vars\.WORKER_URL \}\}/);
});
