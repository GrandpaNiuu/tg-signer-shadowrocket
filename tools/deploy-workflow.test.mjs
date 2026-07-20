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

test("migrations run before optional takeover audit and both deployment paths", async () => {
  const content = await workflow();
  const migration = content.indexOf("- name: Apply D1 migrations");
  const takeover = content.indexOf("- name: Verify legacy D1 takeover evidence");
  const bootstrapDeploy = content.indexOf("- name: Deploy Worker bootstrap");
  const configuredDeploy = content.indexOf("- name: Deploy Worker with configured secrets");
  const smoke = content.indexOf("- name: Smoke test deployed Worker");

  assert.ok(migration >= 0);
  assert.ok(takeover > migration);
  assert.ok(bootstrapDeploy > takeover);
  assert.ok(configuredDeploy > bootstrapDeploy);
  assert.ok(smoke > configuredDeploy);
  assert.match(content, /if: \$\{\{ env\.DEPLOYMENT_MODE == 'legacy_takeover' \}\}/);
});

test("bootstrap does not require or upload PASSWORD_PEPPER", async () => {
  const content = await workflow();
  assert.match(content, /if \[ "\$DEPLOYMENT_MODE" != "bootstrap" \] && \[ "\$\{#PASSWORD_PEPPER\}" -lt 16 \]/);
  assert.match(content, /- name: Deploy Worker bootstrap\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE == 'bootstrap' \}\}/);
  assert.match(content, /- name: Deploy Worker with configured secrets\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE != 'bootstrap' \}\}[\s\S]*?secrets: \|\s*\n\s*PASSWORD_PEPPER/);
});

test("bootstrap requires liveness while normal deployments require readiness", async () => {
  const content = await workflow();
  assert.match(content, /check_endpoint health/);
  assert.match(content, /if \[ "\$DEPLOYMENT_MODE" != "bootstrap" \]; then\s*\n\s*check_endpoint ready/);
  assert.match(content, /WORKER_URL: \$\{\{ vars\.WORKER_URL \}\}/);
});

test("smoke check can derive the Worker origin when WORKER_URL is absent", async () => {
  const content = await workflow();
  assert.match(content, /RUNNER_OIDC_AUDIENCE/);
  assert.match(content, /https:\/\/\*\/api\/runner\) base_url="\$\{audience%\/api\/runner\}"/);
  assert.match(content, /curl --fail-with-body/);
});
