import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { __test } from "./src/listener-event-api.js";

const {
  cleanObservedText,
  mediaMetadata,
  readableChat,
  readableSender,
  safeEventTime,
  safeMessageLink,
} = __test;

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
  assert.equal(readableChat({ chat_id: "-100123", chat_type: "supergroup" }), "超级群组（名称未公开）");
  assert.equal(readableSender({ sender_id: "9988", sender_type: "user" }), "Telegram 用户（名称未公开）");
  assert.doesNotMatch(readableChat({ chat_id: "-100123", chat_type: "supergroup" }), /100123/);
  assert.doesNotMatch(readableSender({ sender_id: "9988", sender_type: "user" }), /9988/);
});

test("listener media metadata has human-readable labels", () => {
  assert.deepEqual(mediaMetadata({
    media_kind: "video",
    media_file_name: "现场.mp4",
    media_mime_type: "video/mp4",
    media_size_bytes: 4096,
  }), {
    media_kind: "video",
    media_label: "视频",
    media_file_name: "现场.mp4",
    media_mime_type: "video/mp4",
    media_size_bytes: 4096,
  });
  assert.equal(mediaMetadata({}), null);
});

test("listener content removes generated references and uses an ellipsis instead of internal markers", () => {
  const source = "战绩截图说明。[[1]](https://example.com/source) ↩ 第二行 [TRUNCATED]";
  assert.equal(cleanObservedText(source, 100), "战绩截图说明。\n第二行");
  assert.equal(cleanObservedText("123456789", 6), "12345…");
});

test("Telegram message time is normalized to ISO and invalid values are ignored", () => {
  assert.equal(safeEventTime("2026-07-23T09:31:26+08:00"), "2026-07-23T01:31:26.000Z");
  assert.equal(safeEventTime("not-a-time"), null);
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
