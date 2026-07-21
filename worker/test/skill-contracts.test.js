import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSkillParams, taskPresentation } from "../src/skill-contracts.js";

test("bot_flow validates bounded steps and rejects code execution actions", () => {
  const params = normalizeSkillParams("bot_flow", {
    target: "@example_bot",
    steps: [
      { action: "send", text: "/start", timeout: 10 },
      { action: "wait_message", match_any: ["成功", "完成"], timeout: 30 },
    ],
  });
  assert.equal(params.steps.length, 2);
  assert.throws(
    () => normalizeSkillParams("bot_flow", {
      target: "@example_bot",
      steps: [{ action: "shell", timeout: 10 }],
    }),
    (error) => error.status === 422,
  );
  assert.throws(
    () => normalizeSkillParams("bot_flow", {
      target: "@example_bot",
      steps: [{ action: "send", text: "/start" }],
    }),
    (error) => error.status === 422,
  );
});

test("legacy admin fields can create new skills without arbitrary server paths", () => {
  const flow = normalizeSkillParams("bot_flow", {}, {
    bot: "@example_bot",
    command: JSON.stringify({ steps: [{ action: "send", text: "/start", timeout: 10 }] }),
  });
  assert.equal(flow.target, "@example_bot");

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

test("retired account audit is rejected by the Worker allowlist", () => {
  assert.throws(
    () => normalizeSkillParams("account_audit", {}),
    (error) => error.status === 422 && error.code === "validation_failed",
  );
  assert.throws(
    () => taskPresentation("account_audit", {}),
    (error) => error.status === 422 && error.code === "validation_failed",
  );
});

test("task presentation keeps canonical params separate from human summaries", () => {
  const presentation = taskPresentation("chat_snapshot", {
    target: "@group_name",
    limit: 20,
    keyword: "订单",
  });
  assert.equal(presentation.bot, "@group_name");
  assert.match(presentation.command, /20/);
  assert.match(presentation.command, /订单/);
});
