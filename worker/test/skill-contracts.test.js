import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSkillParams, taskPresentation } from "../src/skill-contracts.js";

test("send_media validates explicit Worker-owned media parameters", () => {
  const media = normalizeSkillParams("send_media", {
    target: "-1001234567890",
    file_id: "media-asset-1234",
    media_type: "photo",
    caption: "海报",
    message_thread_id: null,
    delete_after: null,
  });
  assert.equal(media.target, "-1001234567890");
  assert.equal(media.file_id, "media-asset-1234");
  assert.equal(media.media_type, "photo");
});

test("legacy admin fields can create media tasks without arbitrary server paths", () => {
  const media = normalizeSkillParams("send_media", {}, {
    bot: "-1001234567890",
    command: JSON.stringify({ file_id: "media-asset-1234", media_type: "photo" }),
  });
  assert.equal(media.file_id, "media-asset-1234");
  assert.throws(
    () => normalizeSkillParams("send_media", {}, {
      bot: "@example_bot",
      command: JSON.stringify({ file_id: "/tmp/photo.jpg", media_type: "photo" }),
    }),
    (error) => error.status === 422,
  );
});

test("overlapping and retired Skills are rejected by the Worker allowlist", () => {
  for (const skill of ["account_audit", "bot_flow", "chat_snapshot"]) {
    assert.throws(
      () => normalizeSkillParams(skill, {}),
      (error) => error.status === 422 && error.code === "validation_failed",
    );
    assert.throws(
      () => taskPresentation(skill, {}),
      (error) => error.status === 422 && error.code === "validation_failed",
    );
  }
});

test("media presentation stores a human summary separately from canonical params", () => {
  const presentation = taskPresentation("send_media", {
    target: "@channel_name",
    file_id: "media-asset-1234",
    media_type: "video",
    caption: "新品视频",
    message_thread_id: null,
    delete_after: null,
  });
  assert.equal(presentation.bot, "@channel_name");
  assert.match(presentation.command, /video/);
  assert.match(presentation.command, /media-asset-1234/);
});
