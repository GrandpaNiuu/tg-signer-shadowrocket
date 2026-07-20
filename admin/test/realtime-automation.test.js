import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/realtime-automation.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("user task form offers safe bot operation inspection", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /自动识别机器人操作/);
  assert.match(source, /不会自动点击/);
  assert.match(source, /\/api\/v1\/bot-inspections/);
  assert.match(source, /use-inspected-button/);
  assert.doesNotMatch(source, /message\.click|click\(actual_text\)/);
});

test("continuous monitoring controls are rendered only for administrators", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /if \(!isAdministrator\(\)\) return/);
  assert.match(source, /24 小时关键词自动回复/);
  assert.match(source, /全天候群消息监听/);
  assert.match(source, /实时监听账号不能同时启用普通定时任务/);
  assert.match(source, /data-admin-realtime-section/);
  assert.match(source, /只有平台管理员|仅平台管理员/);
});

test("non-administrators cannot see account connection detection controls", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /validate-account/);
  assert.match(source, /validate-all-accounts/);
  assert.match(source, /button\.hidden = true/);
});

test("production page loads the realtime automation module", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /\/src\/realtime-automation\.js\?v=20260721-1/);
});
