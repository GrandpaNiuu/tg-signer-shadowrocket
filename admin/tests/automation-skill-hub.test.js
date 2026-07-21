import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hubUrl = new URL("../src/automation-skill-hub.js", import.meta.url);
const realtimeUrl = new URL("../src/realtime-automation.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("all business automation capabilities are presented through Skills", async () => {
  const source = await readFile(hubUrl, "utf8");
  for (const marker of [
    "自动识别机器人操作",
    "24 小时关键词自动回复",
    "全天候群消息监听",
    "账号连接检测",
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /audience: "all"/);
  assert.match(source, /audience: "admin"/);
  assert.match(source, /isAdministrator\(\)/);
});

test("Skill cards open task creation instead of storing business rules in Settings", async () => {
  const source = await readFile(hubUrl, "utf8");
  assert.match(source, /data-skill-hub-action="create-scheduled"/);
  assert.match(source, /data-skill-hub-action="create-realtime"/);
  assert.match(source, /skill-hub-realtime-form/);
  assert.match(source, /\/api\/v1\/admin\/realtime-rules/);
  assert.match(source, /data-skill-hub-realtime-tasks/);
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
