import assert from "node:assert/strict";
import test from "node:test";

import { encryptSecret } from "../src/crypto.js";
import { discoverNotificationChats, sendRunNotification, sendTestNotification, __test } from "../src/notifications.js";

const ROOT_KEY = Buffer.alloc(32, 23).toString("base64");
const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";
const CHAT_ID = "-1001234567890";

async function secret(purpose, plaintext) {
  return {
    id: purpose,
    owner_type: "setting",
    owner_id: "telegram_notification",
    purpose,
    algorithm: "AES-256-GCM",
    ...await encryptSecret(ROOT_KEY, plaintext, {
      purpose,
      ownerId: "telegram_notification",
      keyVersion: 1,
    }),
  };
}

test("failed run notification identifies user, Telegram account, content, and problem", async () => {
  const secrets = new Map([
    ["bot_token", await secret("bot_token", BOT_TOKEN)],
    ["chat_id", await secret("chat_id", CHAT_ID)],
  ]);
  const repository = {
    async getSettings() { return { notifications_enabled: true }; },
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) { return secrets.get(purpose); },
    async getUser() { return { display_name: "小明", email: "user@example.com" }; },
    async getAccount() {
      return {
        id: "account-1",
        name: "主账号",
        telegram_username: "xiaoming_tg",
        telegram_display_name: "小明 Telegram",
        phone_masked: "+86*******1234",
      };
    },
    async getRun() {
      return {
        id: "run-1-audit-20260721",
        user_id: "user-1",
        account_id: "account-1",
        task_name: "音乐积分签到",
        account_name: "主账号",
        bot: "@music_points_bot",
        command: "/checkin",
        status: "failed",
        trigger_type: "scheduled",
        duration_ms: 8313,
        attempt_count: 1,
        github_run_id: "987654321",
        error_message: "机器人暂时没有响应",
        logs: [
          { level: "warning", message: "TgCrypto is missing! Pyrogram will work the same, but at a much slower speed." },
          { level: "info", message: JSON.stringify({ event: "task_started" }) },
          { level: "error", message: `accidental token ${BOT_TOKEN}` },
        ],
      };
    },
  };
  let captured;
  const result = await sendRunNotification({
    SECRET_ROOT_KEY: ROOT_KEY,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
  }, repository, async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return new Response(null, { status: 200 });
  }, "run-1-audit-20260721");

  assert.deepEqual(result, { sent: true, reason: null });
  assert.match(captured.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(captured.body.chat_id, CHAT_ID);
  assert.equal(captured.body.parse_mode, "HTML");
  assert.equal(captured.body.disable_web_page_preview, true);
  assert.match(captured.body.text, /任务执行失败/);
  assert.match(captured.body.text, /任务：<\/b>音乐积分签到/);
  assert.match(captured.body.text, /用户：<\/b>小明/);
  assert.match(captured.body.text, /Telegram：<\/b>主账号（@xiaoming_tg）/);
  assert.doesNotMatch(captured.body.text, /执行编号|run-1-audit-20260721/);
  assert.match(captured.body.text, /目标：<\/b>@music_points_bot/);
  assert.match(captured.body.text, /任务消息：<\/b><code>\/checkin<\/code>/);
  assert.match(captured.body.text, /耗时：<\/b>8\.3 秒/);
  assert.match(captured.body.text, /原因：<\/b>机器人暂时没有响应/);
  assert.doesNotMatch(captured.body.text, /GitHub Actions|TgCrypto|task_started|accidental token/);
  assert.equal(captured.body.text.includes(BOT_TOKEN), false);
  assert.equal(captured.body.text.includes(CHAT_ID), false);
  assert.deepEqual(captured.body.reply_markup, {
    inline_keyboard: [[{
      text: "查看执行详情",
      url: "https://github.com/owner/repo/actions/runs/987654321",
    }]],
  });
});

test("successful task broadcasts show the Telegram account instead of an execution UUID", async () => {
  const secrets = new Map([
    ["bot_token", await secret("bot_token", BOT_TOKEN)],
    ["chat_id", await secret("chat_id", CHAT_ID)],
  ]);
  const repository = {
    async getSettings() { return { notifications_enabled: true }; },
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) { return secrets.get(purpose); },
    async getUser() { return { display_name: "小红", email: "red@example.com" }; },
    async getAccount() {
      return {
        id: "account-2",
        name: "备用账号",
        telegram_username: null,
        telegram_display_name: "小红",
        phone_masked: "+86*******5678",
      };
    },
    async getRun() {
      return {
        id: "run-2-audit-20260721",
        user_id: "user-2",
        account_id: "account-2",
        task_name: "开户积分签到",
        account_name: "备用账号",
        bot: "@points_bot",
        command: "领取今日积分",
        status: "success",
        trigger_type: "manual",
        duration_ms: 8373,
        github_run_id: "123456789",
        logs: [{ level: "info", message: "very long success log" }],
      };
    },
  };
  let message;
  await sendRunNotification({
    SECRET_ROOT_KEY: ROOT_KEY,
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
  }, repository, async (_url, init) => {
    message = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  }, "run-2-audit-20260721");

  assert.match(message.text, /任务执行成功/);
  assert.match(message.text, /任务：<\/b>开户积分签到/);
  assert.match(message.text, /用户：<\/b>小红/);
  assert.match(message.text, /Telegram：<\/b>备用账号（\+86\*{7}5678）/);
  assert.doesNotMatch(message.text, /执行编号|run-2-audit-20260721/);
  assert.match(message.text, /目标：<\/b>@points_bot/);
  assert.match(message.text, /任务消息：<\/b><code>领取今日积分<\/code>/);
  assert.match(message.text, /耗时：<\/b>8\.4 秒/);
  assert.doesNotMatch(message.text, /手动执行|very long success log|日志|https:\/\/|查看执行详情/);
  assert.deepEqual(message.reply_markup, {
    inline_keyboard: [[{
      text: "查看执行详情",
      url: "https://github.com/owner/repo/actions/runs/123456789",
    }]],
  });
});

test("Telegram account labels prefer username, then masked phone, then display name", () => {
  assert.equal(__test.telegramAccountLabel({ telegram_username: "@grandpa" }, { account_name: "主账号" }), "主账号（@grandpa）");
  assert.equal(__test.telegramAccountLabel({ phone_masked: "+86*******0001" }, { account_name: "备用账号" }), "备用账号（+86*******0001）");
  assert.equal(__test.telegramAccountLabel({ telegram_display_name: "Grandpa" }, {}), "Grandpa");
  assert.equal(__test.telegramAccountLabel(null, { account_name: "历史账号" }), "历史账号");
});

test("long task messages show both ends, length, and redacted sensitive values", () => {
  const advertisingTail = "立即联系 @spam_shop 购买推广服务";
  const input = `正常开头 ${"A".repeat(700)} password=private-value ${advertisingTail}`;
  const preview = __test.taskMessageAudit(input, []);
  assert.equal(preview.truncated, true);
  assert.ok(preview.length > 700);
  assert.match(preview.text, /^正常开头/);
  assert.match(preview.text, /省略 \d+ 字/);
  assert.match(preview.text, /\[REDACTED\]/);
  assert.match(preview.text, /立即联系 @spam_shop 购买推广服务$/);
  assert.equal(preview.text.includes("private-value"), false);
});

test("disabled notifications do not read secrets or call Telegram", async () => {
  const repository = {
    async getSettings() { return { notifications_enabled: false }; },
    async getSecretByOwnerPurpose() { assert.fail("secret must not be read"); },
  };
  const result = await sendRunNotification({}, repository, async () => {
    assert.fail("Telegram must not be called");
  }, "run-1");
  assert.deepEqual(result, { sent: false, reason: "disabled" });
});

test("notification setup discovers deduplicated Telegram chats without exposing the token", async () => {
  const secrets = new Map([["bot_token", await secret("bot_token", BOT_TOKEN)]]);
  const repository = {
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) { return secrets.get(purpose); },
  };
  let requestedUrl;
  const result = await discoverNotificationChats({ SECRET_ROOT_KEY: ROOT_KEY }, repository, async (url, init) => {
    requestedUrl = String(url);
    assert.equal(init.method, "POST");
    return Response.json({ ok: true, result: [
      { update_id: 1, message: { chat: { id: 12345, type: "private", first_name: "Grandpa", username: "grandpa" } } },
      { update_id: 2, message: { chat: { id: 12345, type: "private", first_name: "Grandpa", username: "grandpa" } } },
      { update_id: 3, channel_post: { chat: { id: -100987654321, type: "channel", title: "运行通知" } } },
    ] });
  });

  assert.match(requestedUrl, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(JSON.stringify(result).includes(BOT_TOKEN), false);
  assert.deepEqual(result, { ok: true, reason: null, chats: [
    { id: "-100987654321", label: "运行通知", type: "channel" },
    { id: "12345", label: "Grandpa (@grandpa)", type: "private" },
  ] });
});

test("test notification explains platform-wide account audit fields", async () => {
  const secrets = new Map([
    ["bot_token", await secret("bot_token", BOT_TOKEN)],
    ["chat_id", await secret("chat_id", CHAT_ID)],
  ]);
  const repository = {
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) { return secrets.get(purpose); },
  };
  let message;
  const result = await sendTestNotification({ SECRET_ROOT_KEY: ROOT_KEY }, repository, async (_url, init) => {
    message = JSON.parse(init.body);
    return new Response(null, { status: 200 });
  });
  assert.deepEqual(result, { sent: true, reason: null });
  assert.equal(message.chat_id, CHAT_ID);
  assert.equal(message.parse_mode, "HTML");
  assert.match(message.text, /所有用户的任务结果/);
  assert.match(message.text, /Telegram 账号/);
  assert.match(message.text, /任务消息摘要/);
  assert.doesNotMatch(message.text, /执行编号/);
  assert.match(message.text, /脱敏/);
  assert.equal(message.text.includes(BOT_TOKEN), false);
});
