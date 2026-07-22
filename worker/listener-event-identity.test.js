import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "./src/listener-event-api.js";

const { readableChat, readableSender, safeMessageLink } = __test;

test("realtime notifications prefer readable conversation labels over numeric ids", () => {
  assert.equal(readableChat({
    chat_id: "-1001234567890",
    chat_title: "客户售后群",
    chat_username: "support_group",
    chat_type: "supergroup",
    chat_label: "客户售后群（@support_group）",
  }), "客户售后群（@support_group） · 超级群组");
});

test("realtime notifications show the sender name and username", () => {
  assert.equal(readableSender({
    sender_id: "998877",
    sender_name: "张 三",
    sender_username: "zhangsan",
    sender_type: "user",
    sender_label: "张 三（@zhangsan）",
  }), "张 三（@zhangsan）");

  assert.equal(readableSender({
    sender_name: "Service Bot",
    sender_username: "service_bot",
    sender_type: "bot",
  }), "Service Bot（@service_bot）（机器人）");
});

test("anonymous and unavailable identities remain explanatory instead of bare ids", () => {
  assert.equal(readableSender({
    sender_id: "-10088",
    sender_type: "anonymous_admin",
    sender_label: "匿名管理员：运营群",
  }), "匿名管理员：运营群");

  assert.equal(readableChat({ chat_label: "频道（名称未公开）", chat_type: "channel" }), "频道（名称未公开）");
});

test("only Telegram message links are accepted", () => {
  assert.equal(safeMessageLink("https://t.me/support_group/88"), "https://t.me/support_group/88");
  assert.equal(safeMessageLink("https://example.com/88"), null);
});

test("listener event identity migration stores readable source metadata", async () => {
  const migration = await readFile(new URL("./migrations/0107_listener_event_identity.sql", import.meta.url), "utf8");
  for (const column of [
    "chat_title", "chat_username", "chat_type", "chat_label",
    "sender_name", "sender_username", "sender_type", "sender_label", "message_link",
  ]) {
    assert.match(migration, new RegExp(`ADD COLUMN ${column} TEXT`));
  }
});

test("Worker routes Listener events through the identity-aware endpoint", async () => {
  const source = await readFile(new URL("./src/app.js", import.meta.url), "utf8");
  assert.match(source, /handleListenerEventApi/);
  assert.match(source, /url\.pathname === "\/api\/listener\/v1\/events"/);
});
