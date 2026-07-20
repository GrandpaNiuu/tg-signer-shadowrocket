import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/realtime-automation.js";

const migrationUrl = new URL("../migrations/0100_realtime_automation.sql", import.meta.url);
const appUrl = new URL("../src/app.js", import.meta.url);
const apiUrl = new URL("../src/realtime-automation.js", import.meta.url);

test("Telegram targets accept usernames and numeric ids but wildcard is admin-only", () => {
  assert.equal(__test.normalizeTelegramTarget("@example_bot"), "@example_bot");
  assert.equal(__test.normalizeTelegramTarget("-1001234567890"), "-1001234567890");
  assert.throws(() => __test.normalizeTelegramTarget("*"), /@用户名/);
  assert.equal(__test.normalizeTelegramTarget("*", "chat_selector", { allowWildcard: true }), "*");
  assert.throws(() => __test.normalizeTelegramTarget("https://example.com"), /@用户名/);
});

test("keyword replies require both a keyword and fixed response", () => {
  assert.deepEqual(__test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "客服回复",
    chat_selector: "*",
    keyword: "价格",
    response_text: "请联系管理员。",
    enabled: true,
  }), {
    account_id: "account-1",
    kind: "keyword_reply",
    name: "客服回复",
    chat_selector: "*",
    keyword: "价格",
    response_text: "请联系管理员。",
    case_sensitive: false,
    enabled: true,
  });
  assert.throws(() => __test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "错误规则",
    chat_selector: "*",
    keyword: "",
    response_text: "回复",
  }), /必须填写关键词/);
  assert.throws(() => __test.ruleInput({
    account_id: "account-1",
    kind: "keyword_reply",
    name: "错误规则",
    chat_selector: "*",
    keyword: "价格",
    response_text: "",
  }), /必须填写回复内容/);
});

test("listener bearer comparison is deterministic without exposing the secret", async () => {
  assert.equal(await __test.secureEqual("same-secret", "same-secret"), true);
  assert.equal(await __test.secureEqual("same-secret", "other-secret"), false);
});

test("realtime migration keeps user inspections and administrator rules separate", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of ["bot_inspections", "realtime_rules", "listener_instances", "listener_events"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /kind TEXT NOT NULL CHECK \(kind IN \('keyword_reply', 'group_monitor'\)\)/);
  assert.match(sql, /user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
});

test("Worker routes listener traffic before browser workspace APIs", async () => {
  const app = await readFile(appUrl, "utf8");
  const listenerIndex = app.indexOf('url.pathname.startsWith("/api/listener/v1/")');
  const workspaceIndex = app.indexOf('url.pathname.startsWith("/api/v1/")');
  assert.ok(listenerIndex > 0 && workspaceIndex > listenerIndex);
  assert.match(app, /handleWorkspaceRealtimeApi/);
  assert.match(app, /realtime_listener/);
});

test("only administrators can configure continuous monitoring and account validation", async () => {
  const source = await readFile(apiUrl, "utf8");
  assert.match(source, /只有平台管理员可以使用实时监听功能/);
  assert.match(source, /只有平台管理员可以运行账号连接检测/);
  assert.match(source, /listener_account_has_tasks/);
  assert.match(source, /实时监听账号不能同时运行普通定时任务/);
  assert.match(source, /每天最多识别 20 次机器人操作/);
  assert.doesNotMatch(source, /child_process|eval\(|new Function/);
});
