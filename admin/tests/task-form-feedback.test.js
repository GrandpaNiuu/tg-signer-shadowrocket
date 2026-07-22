import assert from "node:assert/strict";
import test from "node:test";

import { taskValidationSummary } from "../src/task-form-feedback.js";

test("task save validation gives a concise visible summary and first invalid field", () => {
  const result = taskValidationSummary({
    account_id: "请选择账号。",
    bot: "请输入接收方。",
  });

  assert.equal(result.title, "任务还不能保存");
  assert.equal(result.firstField, "account_id");
  assert.match(result.message, /Telegram 账号/);
  assert.match(result.message, /接收方/);
});

test("task save validation maps implementation field names to user-facing labels", () => {
  const result = taskValidationSummary({
    skill_key: "请选择任务类型。",
    timeout_seconds: "超时无效。",
    tg_signer_import: "需要按钮签到配置。",
  });

  assert.equal(result.message, "任务类型、超时时间、按钮签到配置需要检查。");
});
