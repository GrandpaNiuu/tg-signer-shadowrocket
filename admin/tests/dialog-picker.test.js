import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "../src/dialog-picker.js";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("dialog picker enhances ordinary tasks and the current realtime rule form", () => {
  assert.equal(__test.PICKERS.length, 2);
  assert.deepEqual(__test.PICKERS.map((picker) => picker.account), ["#task-account", "#hub-rule-account"]);
  assert.deepEqual(__test.PICKERS.map((picker) => picker.target), ["#task-bot", "#hub-rule-chat"]);
  assert.equal(__test.PICKERS[0].writableOnly, true);
  assert.equal(__test.PICKERS[1].form, "#skill-hub-realtime-form");
  assert.equal(__test.PICKERS[1].wildcard, true);
});

test("automatic reply picker supports one eligible conversation or all eligible conversations", () => {
  const presentation = __test.realtimePickerPresentation("keyword_reply");
  assert.equal(presentation.title, "选择自动回复对象");
  assert.equal(presentation.fieldLabel, "自动回复对象");
  assert.equal(presentation.writableOnly, true);
  assert.deepEqual(presentation.allowedTypes, ["private", "group", "supergroup"]);
  assert.match(presentation.wildcardLabel, /全部可回复会话/);
  assert.match(presentation.fieldHelp, /真人消息/);

  assert.equal(__test.dialogAllowed({ peer_type: "private", is_writable: true }, presentation), true);
  assert.equal(__test.dialogAllowed({ peer_type: "supergroup", is_writable: true }, presentation), true);
  assert.equal(__test.dialogAllowed({ peer_type: "bot", is_writable: true }, presentation), false);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: true }, presentation), false);
  assert.equal(__test.dialogAllowed({ peer_type: "group", is_writable: false }, presentation), false);
});

test("message monitoring picker keeps readable and read-only conversations available", () => {
  const presentation = __test.realtimePickerPresentation("group_monitor");
  assert.equal(presentation.title, "选择监听会话");
  assert.equal(presentation.writableOnly, false);
  assert.match(presentation.wildcardLabel, /全部会话/);
  assert.equal(__test.dialogAllowed({ peer_type: "channel", is_writable: false }, presentation), true);
});

test("picker uses account-scoped directory APIs and keeps manual entry as an advanced fallback", async () => {
  const content = await source("src/dialog-picker.js");
  assert.equal(__test.API_PATH, "/api/v1/account-dialogs");
  assert.equal(__test.REFRESH_PATH, "/api/v1/account-dialogs/refresh");
  assert.match(content, /搜索名称、@用户名或会话类型/);
  assert.match(content, /刷新好友与群组/);
  assert.match(content, /高级：手动输入用户名或 Chat ID/);
  assert.match(content, /一般用户无需查找或填写数字 ID/);
  assert.match(content, /credentials: "same-origin"/);
});

test("picker groups readable destinations without exposing numeric ids in labels", () => {
  assert.deepEqual(__test.TYPE_LABELS, {
    private: "好友",
    bot: "机器人",
    group: "群组",
    supergroup: "超级群组",
    channel: "频道",
  });
  assert.equal(__test.safeDialogLabel({
    label: "客户采购群（@buyers） · 超级群组",
    target: "-1001234567890",
    is_writable: true,
  }), "客户采购群（@buyers） · 超级群组");
  assert.equal(__test.safeDialogLabel({
    label: "行业资讯 · 频道",
    is_writable: false,
  }), "行业资讯 · 频道（只读）");
});

test("picker displays deterministic synchronization states", () => {
  assert.equal(__test.syncLabel({ status: "queued" }), "正在等待 Listener 同步…");
  assert.equal(__test.syncLabel({ status: "running" }), "正在读取该账号的好友和群组…");
  assert.equal(__test.syncLabel({ status: "success", dialog_count: 12 }), "已同步 12 个会话");
  assert.match(__test.syncLabel({ status: "failed", error_message: "网络异常" }), /网络异常/);
});

test("admin shell loads the picker stylesheet and refreshed module", async () => {
  const index = await source("index.html");
  assert.match(index, /assets\/dialog-picker\.css\?v=20260723-1/);
  assert.match(index, /src\/dialog-picker\.js\?v=20260723-2/);
  const app = index.indexOf('/src/app.js');
  const picker = index.indexOf('/src/dialog-picker.js');
  assert.ok(app >= 0 && picker > app);
});
