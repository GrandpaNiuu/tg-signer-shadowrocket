import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hubUrl = new URL("../src/automation-skill-hub.js", import.meta.url);
const catalogUrl = new URL("../src/automation-catalog.js", import.meta.url);
const realtimeUrl = new URL("../src/realtime-automation.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("Skill task hub JavaScript passes Node syntax validation", () => {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(hubUrl)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the automation catalog exposes only distinct user-facing capabilities", async () => {
  const source = `${await readFile(catalogUrl, "utf8")}\n${await readFile(hubUrl, "utf8")}`;
  for (const marker of [
    "24 小时自动回复",
    "实时消息监控",
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /audience: "admin"/);
  assert.match(source, /isAdministrator\(\)/);
  assert.doesNotMatch(source, /bot_inspection|account_connection_check/);
  assert.doesNotMatch(source, /内部标识|Registry Key|Schema|查看使用方法|VPS Listener/);
  assert.match(source, /每次命中都会由通知机器人汇报/);
});

test("Skill cards open task creation instead of storing business rules in Settings", async () => {
  const source = `${await readFile(catalogUrl, "utf8")}\n${await readFile(hubUrl, "utf8")}`;
  assert.match(source, /data-skill-hub-action="create-scheduled"/);
  assert.match(source, /data-skill-hub-action="create-realtime"/);
  assert.match(source, /skill-hub-realtime-form/);
  assert.match(source, /\/api\/v1\/admin\/realtime-rules/);
  assert.match(source, /data-skill-hub-realtime-tasks/);
  assert.match(source, /新建自动回复规则/);
  assert.match(source, /新建消息监控规则/);
  assert.match(source, /trigger_mode/);
  assert.match(source, /回复我发送的消息/);
  assert.match(source, /关键词或回复我的消息/);
});

test("Settings only exposes Listener infrastructure status", async () => {
  const source = await readFile(realtimeUrl, "utf8");
  assert.match(source, /Listener 基础设施/);
  assert.match(source, /设置页只显示服务状态/);
  assert.doesNotMatch(source, /realtime-rule-form/);
  assert.doesNotMatch(source, /创建实时规则/);
});

test("production shell loads the Skill hub after the supporting task scripts", async () => {
  const html = await readFile(indexUrl, "utf8");
  const guidance = html.indexOf("/src/skill-guidance.js");
  const inspection = html.indexOf("/src/bot-inspection.js");
  const hub = html.indexOf("/src/automation-skill-hub.js");
  assert.ok(guidance > 0 && inspection > guidance && hub > inspection);
});
