import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { guidedFlowConfiguration, skillPresentation } from "../src/skill-guidance.js";

const sourceUrl = new URL("../src/skill-guidance.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("built-in task types have beginner-friendly Chinese names and explanations", () => {
  const sendText = skillPresentation("send_text");
  assert.equal(sendText.name, "发送一次消息或命令");
  assert.match(sendText.description, /发送一段文字或命令/);
  assert.match(sendText.formHelp, /不等待机器人回复/);

  const signer = skillPresentation("tg_signer");
  assert.equal(signer.name, "机器人按钮签到");
  assert.match(signer.description, /等待回复.*按钮/);
  assert.match(signer.formHelp, /自动生成并加密保存/);
});

test("guided sign-in configuration is generated from simple Chinese form fields", () => {
  assert.deepEqual(guidedFlowConfiguration({
    target: "@points_bot",
    text: "/start",
    buttonText: "签到",
    successKeywords: "签到成功，已签到\n获得积分",
    waitSeconds: 45,
    messageThreadId: "123",
  }), {
    kind: "telegram_guided_signin",
    version: 1,
    target: "@points_bot",
    text: "/start",
    button_text: "签到",
    success_keywords: ["签到成功", "已签到", "获得积分"],
    wait_seconds: 45,
    message_thread_id: 123,
  });
});

test("guided wait time is bounded and blank optional values stay simple", () => {
  assert.deepEqual(guidedFlowConfiguration({
    target: "@bot",
    text: "/checkin",
    waitSeconds: 999,
  }), {
    kind: "telegram_guided_signin",
    version: 1,
    target: "@bot",
    text: "/checkin",
    button_text: "",
    success_keywords: [],
    wait_seconds: 120,
  });
});

test("unknown task type keys fail safe with a Chinese administrator warning", () => {
  const unknown = skillPresentation("custom_future_skill");
  assert.equal(unknown.name, "其他已部署任务类型");
  assert.match(unknown.formHelp, /不清楚用途时请不要选择/);
});

test("task forms use a guided builder and keep legacy imports only as a collapsed compatibility path", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /不用填写 JSON/);
  assert.match(source, /需要点击的按钮文字/);
  assert.match(source, /成功回复包含/);
  assert.match(source, /最长等待时间/);
  assert.match(source, /已有旧版 tg-signer 配置（仅高级用户）/);
  assert.match(source, /syncGuidedConfiguration/);
  assert.match(source, /telegram_guided_signin/);
  assert.match(source, /document\.addEventListener\("submit"/);
  assert.match(source, /typeof MutationObserver === "undefined"/);
});

test("production page loads Chinese task type guidance", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /data-route="skills"><span[^>]*>◇<\/span>任务类型<\/a>/);
  assert.match(index, /\/src\/skill-guidance\.js\?v=20260722-3/);
});
