import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  paramsFromLegacy,
  validateExpandedParams,
  __test,
} from "../src/skill-expansion.js";

const sourceUrl = new URL("../src/skill-expansion.js", import.meta.url);

test("only media sending remains as an expanded non-overlapping task type", () => {
  assert.deepEqual([...__test.EXPANDED_SKILLS], ["send_media"]);
  assert.equal(__test.PRESENTATIONS.bot_flow, undefined);
  assert.equal(__test.PRESENTATIONS.chat_snapshot, undefined);
});

test("arbitrary Telegram content links are parsed without a media registry", () => {
  assert.deepEqual(__test.parseTelegramMessageLink("https://t.me/source_channel/123"), {
    source_chat_id: "@source_channel",
    source_message_id: 123,
  });
  assert.deepEqual(__test.parseTelegramMessageLink("https://t.me/c/1234567890/9/456"), {
    source_chat_id: "-1001234567890",
    source_message_id: 456,
  });
  assert.deepEqual(__test.parseTelegramMessageLink("tg://privatepost?channel=1234567890&post=789"), {
    source_chat_id: "-1001234567890",
    source_message_id: 789,
  });
});

test("content task params are explicit and legacy-compatible", () => {
  assert.deepEqual(paramsFromLegacy("send_media", {
    bot: "@example_channel",
    command: JSON.stringify({ file_id: "media-asset-1234", media_type: "photo", caption: "海报" }),
    threadId: 9,
    deleteAfter: 60,
  }), {
    target: "@example_channel",
    file_id: "media-asset-1234",
    media_type: "photo",
    caption: "海报",
    message_thread_id: 9,
    delete_after: 60,
  });

  assert.deepEqual(validateExpandedParams("send_media", {
    target: "@example_channel",
    source_link: "https://t.me/source_channel/123",
    caption: "",
    message_thread_id: null,
    delete_after: null,
  }), {
    target: "@example_channel",
    source_chat_id: "@source_channel",
    source_message_id: 123,
    caption: "",
    message_thread_id: null,
    delete_after: null,
  });
});

test("content tasks reject non-Telegram links and retired task types", () => {
  for (const sourceLink of ["/tmp/file.jpg", "https://example.com/file.jpg"]) {
    assert.throws(() => validateExpandedParams("send_media", {
      target: "@example_channel",
      source_link: sourceLink,
    }), /Telegram 消息链接/);
  }
  assert.throws(() => validateExpandedParams("bot_flow", {}), /不属于任意内容发送任务/);
  assert.throws(() => validateExpandedParams("chat_snapshot", {}), /不属于任意内容发送任务/);
});

test("media builder is inserted before schedule fields and exposes save errors", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /fieldContainer\(form, "#task-schedule-mode"\)/);
  assert.match(source, /scheduleAnchor\.insertAdjacentElement\("beforebegin", wrapper\)/);
  assert.match(source, /builder\.scrollIntoView/);
  assert.match(source, /请检查：/);
  assert.doesNotMatch(source, /register-media|media-assets\?/);
});

test("task type copy is idempotent so mutation observers cannot trigger each other forever", () => {
  let writes = 0;
  const option = {
    value: "send_media",
    _textContent: __test.PRESENTATIONS.send_media.name,
    get textContent() { return this._textContent; },
    set textContent(value) { writes += 1; this._textContent = value; },
  };

  assert.equal(__test.updateSkillOptionCopy(option), false);
  assert.equal(writes, 0);

  option._textContent = "旧名称";
  assert.equal(__test.updateSkillOptionCopy(option), true);
  assert.equal(option.textContent, __test.PRESENTATIONS.send_media.name);
  assert.equal(writes, 1);
});

test("content task help text is not rewritten when it is already current", () => {
  let writes = 0;
  const help = {
    _textContent: __test.PRESENTATIONS.send_media.formHelp,
    get textContent() { return this._textContent; },
    set textContent(value) { writes += 1; this._textContent = value; },
  };

  assert.equal(__test.setTextContentIfChanged(help, __test.PRESENTATIONS.send_media.formHelp), false);
  assert.equal(writes, 0);
});
