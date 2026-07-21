import test from "node:test";
import assert from "node:assert/strict";

import {
  TaskTransferError,
  buildTaskExport,
  copyTaskDraft,
  parseTaskImport,
} from "../src/task-transfer.js";

const account = { id: "account-1", name: "主账号", session: "never-export-this" };
const skills = [
  { key: "bot_flow", enabled: true },
  { key: "send_media", enabled: true },
  { key: "chat_snapshot", enabled: true },
  { key: "account_audit", enabled: true },
];

function task(skillKey, params, overrides = {}) {
  return {
    id: `task-${skillKey}`,
    name: `测试 ${skillKey}`,
    account_id: account.id,
    account_name: account.name,
    skill_key: skillKey,
    bot: params.target || "",
    command: "兼容显示字段",
    params,
    cron: "0 8 * * *",
    timezone: "Asia/Shanghai",
    retry: 0,
    timeout_seconds: 120,
    thread_id: params.message_thread_id ?? null,
    delete_after_seconds: params.delete_after ?? null,
    enabled: true,
    ...overrides,
  };
}

test("expanded Skill parameters round-trip without account secrets", () => {
  const source = task("bot_flow", {
    target: "@example_bot",
    steps: [
      { action: "send", text: "/start", timeout: 20 },
      { action: "wait_message", match_any: ["成功", "完成"], timeout: 30 },
    ],
    message_thread_id: null,
  });
  const document = buildTaskExport([source], [account], {
    now: () => new Date("2026-07-22T00:00:00.000Z"),
  });
  assert.deepEqual(document.tasks[0].params, source.params);
  assert.doesNotMatch(JSON.stringify(document), /never-export-this|task-bot_flow/);

  const imported = parseTaskImport(document, { accounts: [account], skills });
  assert.equal(imported.tasks[0].enabled, false);
  assert.deepEqual(imported.tasks[0].params, source.params);
});

test("media task copies keep the Worker asset reference but never inherit task ids", () => {
  const source = task("send_media", {
    target: "@example_channel",
    file_id: "asset-telegram-0001",
    media_type: "photo",
    caption: "每日海报",
    message_thread_id: 10,
    delete_after: 60,
  });
  const draft = copyTaskDraft(source);
  assert.equal(draft.skill_key, "send_media");
  assert.deepEqual(draft.params, source.params);
  assert.equal(draft.bot, "@example_channel");
  assert.equal(draft.thread_id, 10);
  assert.equal(draft.delete_after_seconds, 60);
  assert.equal(draft.enabled, false);
  assert.equal(Object.hasOwn(draft, "id"), false);
});

test("expanded import rejects malformed and oversized params", () => {
  const source = buildTaskExport([task("account_audit", {})], [account]);
  source.tasks[0].params = ["not-an-object"];
  assert.throws(
    () => parseTaskImport(source, { accounts: [account], skills }),
    (error) => error instanceof TaskTransferError && /Skill 参数/.test(error.message),
  );

  const oversized = buildTaskExport([task("chat_snapshot", {
    target: "@example_group",
    limit: 20,
    keyword: "订单",
  })], [account]);
  oversized.tasks[0].params = { target: "@example_group", payload: "x".repeat(210_000) };
  assert.throws(
    () => parseTaskImport(oversized, { accounts: [account], skills }),
    (error) => error instanceof TaskTransferError && /过大/.test(error.message),
  );
});
