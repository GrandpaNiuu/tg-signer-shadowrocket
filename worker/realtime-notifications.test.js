import assert from "node:assert/strict";
import test from "node:test";

import { encryptSecret } from "./src/crypto.js";
import {
  sendRealtimeMediaNotification,
  sendRealtimeNotification,
  __test,
} from "./src/realtime-notifications.js";

const ROOT_KEY = Buffer.alloc(32, 31).toString("base64");
const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_listener";
const CHAT_ID = "-1009988776655";

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

async function repository() {
  const secrets = new Map([
    ["bot_token", await secret("bot_token", BOT_TOKEN)],
    ["chat_id", await secret("chat_id", CHAT_ID)],
  ]);
  return {
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) {
      return secrets.get(purpose);
    },
  };
}

test("realtime receipt separates source content, match reason and processing status", async () => {
  let captured;
  const result = await sendRealtimeNotification(
    { SECRET_ROOT_KEY: ROOT_KEY },
    await repository(),
    async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return Response.json({ ok: true, result: { message_id: 321 } });
    },
    {
      event_kind: "message_observed",
      rule_name: "采购消息监听",
      rule_kind: "group_monitor",
      user_name: "管理员",
      account_name: "日本市场客服（@jp_sales）",
      chat_label: "东京采购交流群（@tokyo_buyers） · 超级群组",
      sender_label: "田中商事采购部（@tanaka_buyer）",
      original_text: "请提供新款睡衣目录",
      message_time: "2026-07-23T01:31:26.000Z",
      message_type: "图片",
      media_label: "图片",
      matched_keyword: "睡衣",
      match_source: "消息文字",
      auto_reply_status: "not_configured",
      media_feedback_status: "pending",
      action_summary: "命中监控规则「采购消息监听」",
      message_link: "https://t.me/tokyo_buyers/88",
    },
  );

  assert.deepEqual(result, { sent: true, reason: null, message_id: 321 });
  assert.match(captured.url, /sendMessage$/);
  assert.match(captured.body.text, /监听到新消息/);
  assert.match(captured.body.text, /监听账号：<\/b>日本市场客服（@jp_sales）/);
  assert.match(captured.body.text, /来源会话：<\/b>东京采购交流群/);
  assert.match(captured.body.text, /发送者：<\/b>田中商事采购部/);
  assert.match(captured.body.text, /收到时间：<\/b>2026-07-23 01:31:26 UTC/);
  assert.match(captured.body.text, /消息类型：<\/b>图片/);
  assert.match(captured.body.text, /原始文字：<\/b><code>请提供新款睡衣目录<\/code>/);
  assert.match(captured.body.text, /附件：<\/b>图片 1 个/);
  assert.match(captured.body.text, /命中关键词：<\/b>睡衣/);
  assert.match(captured.body.text, /命中位置：<\/b>消息文字/);
  assert.match(captured.body.text, /自动回复：未配置/);
  assert.match(captured.body.text, /通知回传：成功/);
  assert.match(captured.body.text, /媒体回传：处理中/);
  assert.doesNotMatch(captured.body.text, /收到内容/);
  assert.doesNotMatch(captured.body.text, /9988776655/);
  assert.deepEqual(captured.body.reply_markup, {
    inline_keyboard: [[{ text: "打开 Telegram 原消息", url: "https://t.me/tokyo_buyers/88" }]],
  });
});

test("generation citations and truncation markers never leak into receipts", () => {
  const input = "这是战绩截图。[[1]](https://en.wikipedia.org/wiki/Honor_of_Kings) ↩ [TRUNCATED]";
  const cleaned = __test.cleanDisplayText(input, [], 500, "未记录");
  assert.equal(cleaned, "这是战绩截图。");
  assert.doesNotMatch(cleaned, /wikipedia|TRUNCATED|↩|\[\[1\]\]/i);
});

test("media feedback uses the native Bot API method and confirms successful return", async () => {
  let captured;
  const file = new Blob([Buffer.from("video-bytes")], { type: "video/mp4" });
  const result = await sendRealtimeMediaNotification(
    { SECRET_ROOT_KEY: ROOT_KEY },
    await repository(),
    async (url, init) => {
      captured = { url: String(url), form: init.body };
      return Response.json({ ok: true, result: { message_id: 322 } });
    },
    {
      receipt_message_id: 321,
      media_kind: "video",
      media_file_name: "产品演示.mp4",
      account_name: "外贸客服",
      chat_label: "客户群",
      sender_label: "客户 A（@buyer_a）",
      original_text: "这是产品现场视频",
    },
    file,
  );

  assert.deepEqual(result, { sent: true, reason: null, message_id: 322 });
  assert.match(captured.url, /sendVideo$/);
  assert.ok(captured.form instanceof FormData);
  assert.equal(captured.form.get("chat_id"), CHAT_ID);
  assert.equal(captured.form.get("parse_mode"), "HTML");
  assert.deepEqual(JSON.parse(captured.form.get("reply_parameters")), {
    message_id: 321,
    allow_sending_without_reply: true,
  });
  assert.equal(captured.form.get("video").size, file.size);
  assert.match(captured.form.get("caption"), /视频 · 媒体回传成功/);
  assert.match(captured.form.get("caption"), /来源会话：<\/b>客户群/);
  assert.match(captured.form.get("caption"), /发送者：<\/b>客户 A/);
  assert.match(captured.form.get("caption"), /原始文字：<\/b>这是产品现场视频/);
});

test("media method table keeps images, videos and files distinct", () => {
  assert.equal(__test.MEDIA_METHODS.photo.method, "sendPhoto");
  assert.equal(__test.MEDIA_METHODS.video.method, "sendVideo");
  assert.equal(__test.MEDIA_METHODS.document.method, "sendDocument");
});
