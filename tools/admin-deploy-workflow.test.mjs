import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/deploy-admin.yml", import.meta.url);

async function workflow() {
  return readFile(workflowUrl, "utf8");
}

test("Pages deploy job installs the runtimes used by its scripts", async () => {
  const content = await workflow();
  const deployJob = content.slice(content.indexOf("  deploy:"));
  assert.match(deployJob, /actions\/setup-python@/);
  assert.match(deployJob, /python-version: "3\.11"/);
  assert.match(deployJob, /actions\/setup-node@/);
  assert.match(deployJob, /node-version: "22"/);
});

test("Pages deployment is followed by root and Service Binding smoke checks", async () => {
  const content = await workflow();
  const deploy = content.indexOf("- name: Deploy Pages project");
  const smoke = content.indexOf("- name: Smoke test deployed Pages Admin");
  assert.ok(deploy >= 0);
  assert.ok(smoke > deploy);
  assert.match(content, /\$base_url\/api\/auth\/config/);
  assert.match(content, /Pages Service Binding did not return the expected auth configuration/);
  assert.match(content, /curl --fail-with-body/);
});

test("Pages smoke check can derive the production origin", async () => {
  const content = await workflow();
  assert.match(content, /ADMIN_URL: \$\{\{ vars\.ADMIN_URL \}\}/);
  assert.match(content, /CANONICAL_HOST/);
  assert.match(content, /base_url="https:\/\/\$canonical_host"/);
});
