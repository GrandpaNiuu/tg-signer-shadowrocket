import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const healthUrl = new URL("../src/platform-account-health.js", import.meta.url);
const bootstrapUrl = new URL("../src/same-origin-write.js", import.meta.url);

test("platform account health interface is administrator-only and support-safe", async () => {
  const source = await readFile(healthUrl, "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /isAdministrator\(\)/);
  assert.match(source, /全平台账号健康中心/);
  assert.match(source, /data-health-action="validate-selected"/);
  assert.match(source, /MAX_BATCH = 20/);
  assert.match(source, /x-requested-with/);
  assert.doesNotMatch(source, /session_secret_id|proxy_secret_id|two_factor_password|login_code/);
});

test("account connection Skill opens the health center instead of a private-account modal", async () => {
  const source = await readFile(healthUrl, "utf8");
  assert.match(source, /account_connection_check/);
  assert.match(source, /stopImmediatePropagation/);
  assert.match(source, /location\.hash = HEALTH_ROUTE/);
  assert.match(source, /打开健康中心/);
});

test("security bootstrap loads the health center asset", async () => {
  const source = await readFile(bootstrapUrl, "utf8");
  assert.match(source, /import\("\.\/platform-account-health\.js"\)/);
  assert.match(source, /tg-checkin-admin/);
});
