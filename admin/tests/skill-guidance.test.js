import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { skillPresentation } from "../src/skill-guidance.js";

const sourceUrl = new URL("../src/skill-guidance.js", import.meta.url);
const indexUrl = new URL("../index.html", import.meta.url);

test("built-in skills have beginner-friendly Chinese names and explanations", () => {
  const sendText = skillPresentation("send_text");
  assert.equal(sendText.name, "发送消息或机器人命令");
  assert.match(sendText.description, /机器人、用户、群组或频道/);
  assert.match(sendText.formHelp, /大多数用户选择/);

  const signer = skillPresentation("tg_signer");
  assert.equal(signer.name, "高级自动签到流程");
  assert.match(signer.description, /多步骤签到/);
  assert.match(signer.formHelp, /没有.*配置|只有已经准备好/);
});

test("unknown skill keys fail safe with a Chinese administrator warning", () => {
  const unknown = skillPresentation("custom_future_skill");
  assert.equal(unknown.name, "其他已部署任务类型");
  assert.match(unknown.formHelp, /不清楚用途时请不要选择/);
});

test("task forms and skill cards are translated without changing internal keys", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /内部标识（无需修改）/);
  assert.match(source, /label\[for=\"task-skill\"\]/);
  assert.match(source, /任务类型/);
  assert.match(source, /发送给谁（机器人 \/ 用户 \/ 群组 \/ 频道）/);
  assert.match(source, /要发送的消息或命令/);
  assert.match(source, /signerField\.hidden = select\.value !== \"tg_signer\"/);
  assert.match(source, /适合：/);
  assert.match(source, /typeof MutationObserver === \"undefined\"/);
});

test("production page loads Chinese task type guidance", async () => {
  const index = await readFile(indexUrl, "utf8");
  assert.match(index, /data-route=\"skills\"><span[^>]*>◇<\/span>任务类型<\/a>/);
  assert.match(index, /\/src\/skill-guidance\.js\?v=20260721-1/);
});
