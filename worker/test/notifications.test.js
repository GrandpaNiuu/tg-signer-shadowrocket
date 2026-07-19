import assert from "node:assert/strict";
import test from "node:test";

import { encryptSecret } from "../src/crypto.js";
import { discoverNotificationChats, sendRunNotification, sendTestNotification } from "../src/notifications.js";

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

test("run notification includes Actions URL and only a redacted log tail", async () => {
  const secrets = new Map([
    ["bot_token", await secret("bot_token", BOT_TOKEN)],
    ["chat_id", await secret("chat_id", CHAT_ID)],
  ]);
  const repository = {
    async getSettings() { return { notifications_enabled: true }; },
    async getSecretByOwnerPurpose(_ownerType, _ownerId, purpose) { return secrets.get(purpose); },
    async getRun() {
      return {
        id: "run-1",
        task_name: "Daily check-in",
        status: "failed",
        duration_ms: 1234,
        github_run_id: "987654321",
        error_message: "API_HASH=top-secret",
        logs: [
          { level: "info", message: "old log outside tail" },
          { level: "info", message: "tail one" },
          { level: "warning", message: `accidental token ${BOT_TOKEN}` },
          { level: "error", message: "API_HASH=another-secret" },
          { level: "info", message: `chat target ${CHAT_ID}` },
          { level: "info", message: "tail five" },
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
  }, "run-1");

  assert.deepEqual(result, { sent: true, reason: null });
  assert.match(captured.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(captured.body.chat_id, CHAT_ID);
  assert.equal(captured.body.disable_web_page_preview, true);
  assert.match(captured.body.text, /GitHub Actions：https:\/\/github\.com\/owner\/repo\/actions\/runs\/987654321/);
  assert.match(captured.body.text, /日志尾部：/);
  assert.match(captured.body.text, /tail one/);
  assert.doesNotMatch(captured.body.text, /old log outside tail/);
  assert.doesNotMatch(captured.body.text, /top-secret|another-secret/);
  assert.equal(captured.body.text.includes(BOT_TOKEN), false);
  assert.equal(captured.body.text.includes(CHAT_ID), false);
  assert.match(captured.body.text, /\[REDACTED\]/);
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

test("test notification sends a harmless message only with configured credentials", async () => {
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
  assert.match(message.text, /测试通知/);
  assert.equal(message.text.includes(BOT_TOKEN), false);
});
