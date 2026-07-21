import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFlowSteps,
  paramsFromLegacy,
  validateExpandedParams,
  __test,
} from "../src/skill-expansion.js";

test("normalizes bounded bot flow steps and requires timeouts", () => {
  const steps = normalizeFlowSteps([
    { action: "send", text: "/start", timeout: 10 },
    { action: "wait_message", match_any: "成功, 完成", timeout: 20 },
    { action: "click_button", button: "签到", timeout: 10 },
  ]);
  assert.deepEqual(steps[1].match_any, ["成功", "完成"]);
  assert.throws(() => normalizeFlowSteps([{ action: "send", text: "/start" }]), /超时/);
  assert.throws(() => normalizeFlowSteps(Array.from({ length: 21 }, () => ({ action: "read_buttons", timeout: 1 }))), /1–20/);
});

test("rejects unsupported actions and excessive flow budgets", () => {
  assert.throws(() => normalizeFlowSteps([{ action: "shell", timeout: 10 }]), /不受支持/);
  assert.throws(() => normalizeFlowSteps(Array.from({ length: 6 }, () => ({ action: "read_buttons", timeout: 120 }))), /600/);
  assert.equal(__test.FLOW_ACTIONS.has("shell"), false);
});

test("builds legacy-compatible params without accepting paths or URLs", () => {
  assert.deepEqual(paramsFromLegacy("chat_snapshot", {
    bot: "@example_group",
    command: JSON.stringify({ limit: 12, keyword: "订单" }),
  }), {
    target: "@example_group",
    limit: 12,
    keyword: "订单",
  });
  assert.throws(() => validateExpandedParams("send_media", {
    target: "@example_channel",
    file_id: "/tmp/file.jpg",
    media_type: "photo",
  }), /媒体资产/);
  assert.throws(() => validateExpandedParams("send_media", {
    target: "@example_channel",
    file_id: "https://example.com/file.jpg",
    media_type: "photo",
  }), /媒体资产/);
});

test("account audit accepts no parameters and snapshot limit is bounded", () => {
  assert.deepEqual(validateExpandedParams("account_audit", {}), {});
  assert.throws(() => validateExpandedParams("chat_snapshot", {
    target: "@example_group",
    limit: 51,
  }), /1–50/);
});
