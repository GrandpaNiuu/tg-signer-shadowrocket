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

test("media task params are explicit and legacy-compatible", () => {
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
    file_id: "media-asset-1234",
    media_type: "photo",
    caption: "海报",
    message_thread_id: null,
    delete_after: null,
  }), {
    target: "@example_channel",
    file_id: "media-asset-1234",
    media_type: "photo",
    caption: "海报",
    message_thread_id: null,
    delete_after: null,
  });
});

test("media tasks reject arbitrary paths, URLs, and retired task types", () => {
  for (const fileId of ["/tmp/file.jpg", "https://example.com/file.jpg"]) {
    assert.throws(() => validateExpandedParams("send_media", {
      target: "@example_channel",
      file_id: fileId,
      media_type: "photo",
    }), /媒体资产/);
  }
  assert.throws(() => validateExpandedParams("bot_flow", {}), /不属于媒体发送任务/);
  assert.throws(() => validateExpandedParams("chat_snapshot", {}), /不属于媒体发送任务/);
});

test("media builder is inserted before schedule fields and exposes save errors", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /fieldContainer\(form, "#task-schedule-mode"\)/);
  assert.match(source, /scheduleAnchor\.insertAdjacentElement\("beforebegin", wrapper\)/);
  assert.match(source, /builder\.scrollIntoView/);
  assert.match(source, /请检查：/);
});
