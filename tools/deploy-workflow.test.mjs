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
  const smoke = content.indexOf("- name: Resolve deployed Worker URL");

  assert.ok(migration >= 0);
  assert.ok(takeover > migration);
  assert.ok(bootstrapDeploy > takeover);
  assert.ok(configuredDeploy > bootstrapDeploy);
  assert.ok(smoke > configuredDeploy);
  assert.match(content, /if: \$\{\{ env\.DEPLOYMENT_MODE == 'legacy_takeover' \}\}/);
});

test("bootstrap does not require or upload application secrets", async () => {
  const content = await workflow();
  assert.match(content, /if \[ "\$DEPLOYMENT_MODE" != "bootstrap" \] && \[ "\$\{#PASSWORD_PEPPER\}" -lt 16 \]/);
  assert.match(content, /- name: Deploy Worker bootstrap\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE == 'bootstrap' \}\}/);
  assert.match(content, /DEPLOYMENT_MODE"\] == "bootstrap"[\s\S]*configured=false/);
  assert.match(content, /- name: Deploy Worker with configured secrets\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE != 'bootstrap' \}\}[\s\S]*--secrets-file \.deploy-secrets\.json/);
});

test("verified email authentication must be fully configured or safely disabled", async () => {
  const content = await workflow();
  for (const name of ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY", "RESEND_API_KEY", "AUTH_EMAIL_FROM"]) {
    assert.match(content, new RegExp(name));
  }
  assert.match(content, /Verified email authentication is only partially configured/);
  assert.match(content, /registration remains safely closed/);
  assert.match(content, /wrangler\.deploy\.toml/);
  assert.match(content, /\.deploy-secrets\.json/);
  assert.doesNotMatch(content, /echo\s+"?\$\{?(?:TURNSTILE_SECRET_KEY|RESEND_API_KEY)\}?/);
});

test("normal deployment verifies health, readiness, and email authentication separately", async () => {
  const content = await workflow();
  const resolve = content.indexOf("- name: Resolve deployed Worker URL");
  const health = content.indexOf("- name: Verify deployed Worker health");
  const readiness = content.indexOf("- name: Verify deployed Worker readiness");
  const authentication = content.indexOf("- name: Verify deployed email authentication state");
  const cleanup = content.indexOf("- name: Remove temporary deployment secrets");

  assert.ok(resolve >= 0);
  assert.ok(health > resolve);
  assert.ok(readiness > health);
  assert.ok(authentication > readiness);
  assert.ok(cleanup > authentication);
  assert.match(content, /\$BASE_URL\/health/);
  assert.match(content, /\$BASE_URL\/ready/);
  assert.match(content, /\$BASE_URL\/api\/auth\/config/);
  assert.match(content, /- name: Verify deployed Worker readiness\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE != 'bootstrap' \}\}/);
  assert.match(content, /- name: Verify deployed email authentication state\s*\n\s*if: \$\{\{ env\.DEPLOYMENT_MODE != 'bootstrap' \}\}/);
  assert.match(content, /email_verification_required/);
  assert.match(content, /password_reset_enabled/);
  assert.match(content, /Unverified email registration was not safely closed/);
});

test("smoke check can derive the Worker origin when WORKER_URL is absent", async () => {
  const content = await workflow();
  assert.match(content, /RUNNER_OIDC_AUDIENCE/);
  assert.match(content, /https:\/\/\*\/api\/runner\) base_url="\$\{audience%\/api\/runner\}"/);
  assert.match(content, /curl --silent --show-error --retry 6/);
});

test("temporary deployment credentials are removed even after failure", async () => {
  const content = await workflow();
  assert.match(content, /- name: Remove temporary deployment secrets\s*\n\s*if: always\(\)/);
  assert.match(content, /rm -f worker\/\.deploy-secrets\.json worker\/wrangler\.deploy\.toml/);
});
