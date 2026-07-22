import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const healthUrl = new URL("../src/platform-account-health.js", import.meta.url);
const bootstrapUrl = new URL("../src/same-origin-write.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("platform account health module has valid JavaScript syntax", async () => {
  await execFileAsync(process.execPath, ["--check", fileURLToPath(healthUrl)]);
});

test("platform account health interface is administrator-only and support-safe", async () => {
  const source = await readFile(healthUrl, "utf8");
  assert.match(source, /isAdministrator\(\)/);
  assert.match(source, /全平台账号健康中心/);
  assert.match(source, /data-health-action=\"validate-selected\"/);
  assert.match(source, /MAX_BATCH = 20/);
  assert.match(source, /x-requested-with/);
  assert.match(source, /复制建议/);
  assert.match(source, /Session 已失效/);
  assert.doesNotMatch(source, /session_secret_id|proxy_secret_id|two_factor_password|login_code/);
});

test("account health remains a dedicated administrator workspace instead of a duplicate Skill", async () => {
  const source = await readFile(healthUrl, "utf8");
  assert.doesNotMatch(source, /account_connection_check|data-skill-hub-capability/);
  assert.match(source, /HEALTH_ROUTE/);
  assert.match(source, /全平台账号健康中心/);
});

test("health center loads as an isolated module and does not mutate the security bootstrap", async () => {
  const [bootstrap, index, health] = await Promise.all([
    readFile(bootstrapUrl, "utf8"),
    readFile(indexUrl, "utf8"),
    readFile(healthUrl, "utf8"),
  ]);
  assert.doesNotMatch(bootstrap, /import\("\.\/platform-account-health\.js"\)/);
  assert.match(bootstrap, /tg-checkin-admin/);
  assert.match(index, /src=\"\/src\/platform-account-health\.js\?v=/);
  assert.match(health, /viewObserver\.observe\(view, \{ childList: true \}\)/);
  assert.doesNotMatch(health, /observe\(document\.body/);
});
