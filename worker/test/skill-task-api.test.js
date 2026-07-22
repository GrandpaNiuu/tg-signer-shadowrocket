import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../src/skill-task-api.js";

test("media asset input accepts Telegram source references and rejects paths", () => {
  assert.deepEqual(__test.mediaAssetInput({
    name: "产品视频",
    media_type: "video",
    source_chat_id: "-1001234567890",
    source_message_id: 99,
  }), {
    name: "产品视频",
    media_type: "video",
    source_chat_id: "-1001234567890",
    source_message_id: 99,
  });
  assert.throws(
    () => __test.mediaAssetInput({
      name: "bad",
      media_type: "photo",
      source_chat_id: "/tmp/photo.jpg",
      source_message_id: 1,
    }),
    (error) => error.status === 422,
  );
});

test("stored task params are parsed without exposing malformed JSON", () => {
  assert.deepEqual(__test.safeParams('{"target":"@bot"}'), { target: "@bot" });
  assert.deepEqual(__test.safeParams("not-json"), {});
});

test("new arbitrary-content tasks do not query the legacy media registry", async () => {
  const repository = { db: { prepare() { assert.fail("media_assets must not be queried"); } } };
  const result = await __test.validateMediaAsset(repository, {
    target: "@target",
    source_chat_id: "me",
    source_message_id: 123,
  });
  assert.equal(result, null);
});
