import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("admin shell loads secure authentication and platform broadcast guidance", async () => {
  const index = await source("index.html");
  assert.match(index, /src="\/src\/auth-security\.js"/);
  assert.match(index, /src="\/src\/notification-guidance\.js"/);
});

test("registration guidance fails closed when secure services are incomplete", async () => {
  const content = await source("src/auth-security.js");
  assert.match(content, /registration_enabled/);
  assert.match(content, /邮箱新注册暂时关闭/);
  assert.match(content, /邮件验证和人机验证配置完成后开放/);
  assert.match(content, /已有邮箱账号可以继续登录/);
});

test("notification guidance explains the administrator-wide broadcast scope", async () => {
  const content = await source("src/notification-guidance.js");
  assert.match(content, /全平台任务结果通知/);
  assert.match(content, /所有用户工作区的任务结果/);
  assert.match(content, /查看执行详情/);
  assert.match(content, /成功消息保持简洁/);
});
