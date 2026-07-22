import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSkillParams } from "../../worker/src/skill-contracts.js";
import { taskInput, validateTaskRuntime } from "../../worker/src/validation.js";

const common = Object.freeze({
  account_id: "account-1",
  cron: "17 30 8 * * *",
  timezone: "Asia/Shanghai",
  retry: 1,
  timeout_seconds: 120,
  enabled: true,
});

function accept(payload) {
  const input = taskInput(payload);
  validateTaskRuntime(input);
  return normalizeSkillParams(input.skill_key, input.params, input);
}

test("all three scheduled forms produce payloads accepted by the Worker contract", () => {
  assert.deepEqual(accept({
    ...common,
    name: "每日命令",
    skill_key: "send_text",
    bot: "@example_bot",
    command: "/checkin",
  }), {
    target: "@example_bot",
    text: "/checkin",
    message_thread_id: null,
    delete_after: null,
  });

  assert.deepEqual(accept({
    ...common,
    name: "按钮签到",
    skill_key: "tg_signer",
    command: "daily-signin",
    tg_signer_import: "{\"tasks\":{}}",
  }), {
    task_name: "daily-signin",
    num_of_dialogs: 50,
  });

  assert.deepEqual(accept({
    ...common,
    name: "发送任意内容",
    skill_key: "send_media",
    params: {
      target: "-1001234567890",
      source_chat_id: "me",
      source_message_id: 88,
      caption: null,
      message_thread_id: null,
      delete_after: null,
    },
  }), {
    target: "-1001234567890",
    source_chat_id: "me",
    source_message_id: 88,
    caption: null,
    message_thread_id: null,
    delete_after: null,
  });
});
