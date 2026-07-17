import test from "node:test";
import assert from "node:assert/strict";

import { buildNotificationSettingsPatch, validateNotificationSettings } from "../src/notification-settings.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcd";

test("blank notification secrets are retained and explicit clears use null", () => {
  assert.deepEqual(buildNotificationSettingsPatch({ bot_token: "", chat_id: "" }), {});
  assert.deepEqual(buildNotificationSettingsPatch({}, { clearBotToken: true, clearChatId: true }), {
    bot_token: null,
    chat_id: null,
  });
});

test("notification replacements are validated without reflecting secret input", () => {
  assert.deepEqual(validateNotificationSettings({ bot_token: TOKEN, chat_id: "-1001234567890" }), {});
  assert.deepEqual(buildNotificationSettingsPatch({ bot_token: ` ${TOKEN} `, chat_id: " @daily_updates " }), {
    bot_token: TOKEN,
    chat_id: "@daily_updates",
  });

  const errors = validateNotificationSettings({ bot_token: "token-secret", chat_id: "private chat" });
  assert.deepEqual(Object.keys(errors).sort(), ["bot_token", "chat_id"]);
  assert.equal(JSON.stringify(errors).includes("token-secret"), false);
  assert.equal(JSON.stringify(errors).includes("private chat"), false);
});

test("notification replacement and clear cannot target the same field", () => {
  const errors = validateNotificationSettings({ bot_token: TOKEN, chat_id: "12345" }, {
    clearBotToken: true,
    clearChatId: true,
  });
  assert.deepEqual(Object.keys(errors).sort(), ["bot_token", "chat_id"]);
});
